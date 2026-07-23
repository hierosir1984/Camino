// WP-108 quarantine intake — squash-and-rebuild (CAM-EXEC-04, design §5.1).
//
// The control plane owns a PRISTINE, hooks-disabled clone and pulls ONLY the
// worker's final head into it via a shallow fetch (`--depth=1`). Worker history
// — intermediate commits and any object reachable only through them — never
// enters the pristine store, so reachable-history carry-in is excluded
// STRUCTURALLY, not filtered after the fact. Policy checks then run on the
// final tree within registry-item-11 fetch budgets; a clean tree is re-authored
// as a fresh Camino commit onto the assigned base, with a worker-attribution
// trailer, and the quarantined final diff (@camino/shared) is emitted for
// WP-111 re-classification and WP-116 evidence.
//
// All git runs credential-free in the pristine repo only; the worker repo is
// read solely as a fetch source (git.ts). See README for the boundaries.
import { quarantinedDiffProblems, workerAttributionTrailer } from "@camino/shared";
import type { ContractRef, QuarantinedDiff } from "@camino/shared";
import {
  changedPaths,
  changedPathsWithStatus,
  commitCandidate,
  distinctObjectCount,
  fetchTip,
  fsckTree,
  initPristineRepo,
  parentShas,
  QuarantineGitError,
  subjectOf,
  symlinkTargetBytes,
  treeLeaves,
  treeObjectCount,
  treeOf,
} from "./git.js";
import {
  checkBudgets,
  checkDotGitPaths,
  checkFetchBudget,
  checkNameAliases,
  checkPathCollisions,
  checkScopeAndProtected,
  checkSubmodules,
  checkSymlinks,
  SYMLINK_TARGET_MAX_BYTES,
} from "./policy.js";
import {
  DEFAULT_BUDGETS,
  type QuarantineAssignment,
  type QuarantineResult,
  type Rejection,
  type TreeEntry,
} from "./types.js";

export { objectExists, cleanupPristineRepos, removePristineRepo } from "./git.js";

/** Optional intake wiring — the trusted source of the assigned base. */
export interface IntakeOptions {
  /**
   * The trusted repo the assigned base is fetched from. Defaults to
   * `workerRepo` (the WP-003 corpus fixtures put base + head in one repo). In
   * production this is the control-plane origin, NEVER the worker clone — the
   * assigned base is a trusted commit, and the diff is the worker head applied
   * onto it. Passing the worker repo here would let the worker also supply the
   * base, which production must not do.
   */
  baseRepo?: string;
}

/** Read the stored targets of every in-bounds symlink leaf (never an oversized one). */
function symlinkTargets(dir: string, entries: readonly TreeEntry[]): Map<string, string> {
  const targets = new Map<string, string>();
  for (const e of entries) {
    if (e.mode !== "120000") continue;
    // Never read an oversized "symlink" blob — checkSymlinks rejects it on size
    // alone, and reading it would blow the subprocess buffer (WP-003 r3).
    if (e.size != null && e.size > SYMLINK_TARGET_MAX_BYTES) continue;
    targets.set(e.path, symlinkTargetBytes(dir, e.sha));
  }
  return targets;
}

/** Sum of blob byte sizes across the final tree (gitlinks/oversized handled elsewhere). */
function totalTreeBytes(entries: readonly TreeEntry[]): number {
  let total = 0;
  for (const e of entries) total += e.size ?? 0;
  return total;
}

/**
 * Run the quarantine intake for one worker head.
 *
 * @param workerRepo path to the worker's (untrusted) repo — a fetch source only
 * @param workerRef  ref or sha of the worker's final head inside that repo
 * @param assignment assigned base + allowed-path scope + budgets + contract binding
 * @param options    trusted base source (defaults to workerRepo; see IntakeOptions)
 */
export function runIntake(
  workerRepo: string,
  workerRef: string,
  assignment: QuarantineAssignment,
  options: IntakeOptions = {},
): QuarantineResult {
  const budgets = { ...DEFAULT_BUDGETS, ...assignment.budgets };
  const baseRepo = options.baseRepo ?? workerRepo;

  // Pristine control-plane repo: trusted base first (shallow — only its tree is
  // needed for the diff and as the rebuild parent), then the worker's final
  // head shallow. Nothing else crosses the boundary.
  const pristineDir = initPristineRepo();
  fetchTip(pristineDir, baseRepo, assignment.base, true);
  const workerHead = fetchTip(pristineDir, workerRepo, workerRef, true);

  const rejections: Rejection[] = [];

  // Worker merge commits are rejected outright (design §5.1). Read from the RAW
  // commit object so the shallow graft does not hide a second parent.
  if (parentShas(pristineDir, workerHead).length > 1) {
    rejections.push({
      code: "worker-merge-commit",
      detail: `worker head ${workerHead.slice(0, 12)} is a merge commit`,
    });
  }

  const treeSha = treeOf(pristineDir, workerHead);
  // Leaves (blobs, symlinks, gitlinks) for the path/content checks. Paths that
  // are not valid UTF-8 decode to U+FFFD and are rejected by checkNameAliases,
  // so they cannot be silently deduped/collapsed (WP-003 r2).
  const entries = treeLeaves(pristineDir, treeSha);
  // …and ALL objects (subtrees + leaves + root) for the object-count budgets.
  const objectCount = treeObjectCount(pristineDir, treeSha);
  const totalBytes = totalTreeBytes(entries);
  const targets = symlinkTargets(pristineDir, entries);
  const changed = changedPaths(pristineDir, assignment.base, workerHead);
  const changedSet = new Set(changed);

  // Delegate the malformed-object/path class to git's own hardened fsck first
  // (WP-003 r3); our hand-rolled checks then add the cross-platform aliases git
  // PERMITS (GIT~1, case-spelled protected paths, etc.).
  const fsckErr = fsckTree(pristineDir, treeSha);
  if (fsckErr) {
    rejections.push({
      code: "fsck-violation",
      detail: `git fsck rejected the worker tree: ${fsckErr}`,
    });
  }

  rejections.push(
    // Registry-item-11 fetch budget: a HARD outer cap on the shallow-fetch
    // footprint, independent of the per-issue tree-size policy budget below.
    ...checkFetchBudget(objectCount, totalBytes),
    ...checkScopeAndProtected(changed, assignment.allowedPaths),
    ...checkPathCollisions(entries),
    ...checkNameAliases(entries),
    ...checkDotGitPaths(entries),
    ...checkSubmodules(entries, changedSet),
    ...checkSymlinks(entries, targets),
    ...checkBudgets(entries, budgets, objectCount),
  );

  const accepted = rejections.length === 0;
  let rebuilt: QuarantineResult["rebuilt"] = null;
  let diff: QuarantinedDiff | null = null;
  if (accepted) {
    const subject = subjectOf(pristineDir, workerHead);
    const attributionTrailer = workerAttributionTrailer(workerHead);
    const message = `${subject}\n\n${attributionTrailer}\n`;
    const candidateSha = commitCandidate(pristineDir, treeSha, assignment.base, message);
    rebuilt = {
      sha: candidateSha,
      parents: parentShas(pristineDir, candidateSha),
      treeSha,
      attributionTrailer,
    };
    const contractRef: ContractRef | null = assignment.contractRef ?? null;
    const candidate: QuarantinedDiff = {
      candidateSha,
      baseSha: assignment.base,
      treeSha,
      workerHeadSha: workerHead,
      attributionTrailer,
      contractRef,
      changedPaths: changedPathsWithStatus(pristineDir, assignment.base, candidateSha),
    };
    // Emit only a well-formed artifact: an internal inconsistency (a bad
    // contractRef the caller supplied, a mis-keyed sha) fails closed rather than
    // handing a malformed diff to WP-111/WP-116 (the WP-110 validator precedent).
    const problems = quarantinedDiffProblems(candidate);
    if (problems.length > 0) {
      throw new QuarantineGitError(
        `emitted quarantined diff is malformed (refused): ${problems.join("; ")}`,
      );
    }
    diff = candidate;
  }

  return {
    accepted,
    rejections,
    rebuilt,
    workerHead,
    diff,
    fetchedObjectCount: distinctObjectCount(pristineDir),
    pristineDir,
  };
}
