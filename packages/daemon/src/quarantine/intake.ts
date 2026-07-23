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
  assertSelfContainedObjectStore,
  changedPaths,
  changedPathsWithStatus,
  commitCandidate,
  distinctObjectCount,
  fetchedObjectCount,
  fetchOid,
  fsckTree,
  initPristineRepo,
  objectSize,
  parentShas,
  QuarantineGitError,
  storeSizeBytes,
  subjectOf,
  symlinkTargetBytes,
  treeEntryCount,
  treeLeaves,
  treeOf,
} from "./git.js";
import {
  checkBudgets,
  checkChangedPathValidity,
  checkDotGitPaths,
  checkFetchBudget,
  checkNameAliases,
  checkPathCollisions,
  checkPathLength,
  checkScopeAndProtected,
  checkSubmodules,
  checkSymlinks,
  REGISTRY_ITEM_11_FETCH_BUDGET,
  SYMLINK_TARGET_MAX_BYTES,
} from "./policy.js";
import {
  effectiveBudgets,
  MAX_CANDIDATE_SUBJECT_LENGTH,
  MAX_COMMIT_OBJECT_BYTES,
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

/**
 * Run the quarantine intake for one worker head.
 *
 * @param workerRepo path to the worker's (untrusted) repo — a fetch source only
 * @param workerHeadOid EXACT object id (40/64-hex) of the worker's final head —
 *   never a ref string (refspec-injection guard; see fetchOid)
 * @param assignment assigned base OID + allowed-path scope + budgets + contract binding
 * @param options    trusted base source (defaults to workerRepo; see IntakeOptions)
 */
export function runIntake(
  workerRepo: string,
  workerHeadOid: string,
  assignment: QuarantineAssignment,
  options: IntakeOptions = {},
): QuarantineResult {
  // Overrides may only TIGHTEN the default tree-size budget, never widen it
  // (review r1 finding 7) — a per-issue contract cannot loosen the policy cap.
  const budgets = effectiveBudgets(assignment.budgets);
  const baseRepo = options.baseRepo ?? workerRepo;

  // The worker repo must be self-contained: an alternates-borrowing store would
  // let its upload-pack serve objects from an external store into the candidate
  // (review r1 finding 4). Re-attested here (WP-107 also provisions it so).
  assertSelfContainedObjectStore(workerRepo);

  // Pristine control-plane repo: trusted base first (shallow — only its tree is
  // needed for the diff and as the rebuild parent), then the worker's final
  // head shallow. Both are fetched BY EXACT OID (no refspec/wildcard surface),
  // so nothing but those two commits' trees crosses the boundary.
  const pristineDir = initPristineRepo();
  fetchOid(pristineDir, baseRepo, assignment.base, true);
  // Store size AFTER the base fetch, BEFORE the worker fetch: the delta after the
  // worker fetch bounds the fetch by its on-disk store footprint — the compressed
  // pack (a conservative proxy for the wire transfer, not exact wire bytes;
  // review r3 finding 4, r4 finding 6), never the uncompressed content.
  const bytesBeforeWorker = storeSizeBytes(pristineDir);
  const workerHead = fetchOid(pristineDir, workerRepo, workerHeadOid, true);
  const fetchBytes = storeSizeBytes(pristineDir) - bytesBeforeWorker;

  const rejections: Rejection[] = [];

  // Bound worker-controlled commit METADATA before reading it: an unbounded
  // commit message would blow the argv/buffer path in merge-detection and
  // candidate authoring (review r2 finding 6). A commit object over the cap is
  // rejected, and the full-object reads below are then bounded to ≤ the cap.
  const commitBytes = objectSize(pristineDir, workerHead);
  const oversizeCommit = commitBytes > MAX_COMMIT_OBJECT_BYTES;
  if (oversizeCommit) {
    rejections.push({
      code: "commit-metadata-budget",
      detail: `worker head commit object is ${commitBytes} bytes (budget ${MAX_COMMIT_OBJECT_BYTES}) — unbounded metadata`,
    });
  }

  // Worker merge commits are rejected outright (design §5.1). Read from the RAW
  // commit object so the shallow graft does not hide a second parent. Skipped
  // when the commit is over-cap (it is rejected regardless, and reading it could
  // overrun the buffer).
  if (!oversizeCommit && parentShas(pristineDir, workerHead).length > 1) {
    rejections.push({
      code: "worker-merge-commit",
      detail: `worker head ${workerHead.slice(0, 12)} is a merge commit`,
    });
  }

  const treeSha = treeOf(pristineDir, workerHead);

  // OBJECT COUNTS FIRST, via PATH-FREE reads, so a pathological tree (huge
  // object count or very-long paths) is rejected on its count BEFORE any
  // path-bearing read overruns its buffer (review r4 finding 3). The
  // registry-item-11 fetch object cap is also the PROCESSING cap: a tree over it
  // is refused without materializing its leaves, which — for a tree within the
  // cap — are bounded (≤5,000 objects ⇒ ≤5,000 path components ⇒ a few MB).
  let fetchObjects: number;
  let entryCount: number;
  try {
    fetchObjects = fetchedObjectCount(pristineDir, workerHead, treeSha);
    entryCount = treeEntryCount(pristineDir, treeSha);
  } catch {
    // Even the path-free object-count read overran its buffer ⇒ an absurd object
    // count, far over the fetch cap. Reject cleanly rather than throw.
    rejections.push({
      code: "fetch-object-budget",
      detail: "worker tree object count exceeds processing bounds",
    });
    return {
      accepted: false,
      rejections,
      rebuilt: null,
      workerHead,
      diff: null,
      fetchedObjectCount: 0,
      pristineDir,
    };
  }
  rejections.push(...checkFetchBudget(fetchObjects, fetchBytes));
  if (fetchObjects > REGISTRY_ITEM_11_FETCH_BUDGET.maxObjects) {
    // Over the hard processing cap: do NOT read the leaves (their combined path
    // bytes are unbounded — the ENOBUFS route). Report the count-only findings
    // (fetch-object-budget already pushed; add entry-budget if it also applies)
    // and stop. The per-issue entry-budget below handles the within-cap case.
    if (entryCount > budgets.maxEntries) {
      rejections.push({
        code: "entry-budget",
        detail: `final tree has ${entryCount} objects, trees + leaves (budget ${budgets.maxEntries})`,
      });
    }
    return {
      accepted: false,
      rejections,
      rebuilt: null,
      workerHead,
      diff: null,
      fetchedObjectCount: distinctObjectCount(pristineDir),
      pristineDir,
    };
  }

  // Within the processing cap (≤5,000 objects): reading the leaves — with paths,
  // for the path/content checks — is now bounded. Paths that are not valid UTF-8
  // decode to U+FFFD and are rejected by checkNameAliases (WP-003 r2).
  const entries = treeLeaves(pristineDir, treeSha);
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
    ...checkScopeAndProtected(changed, assignment.allowedPaths),
    ...checkChangedPathValidity(changed),
    ...checkPathCollisions(entries),
    ...checkNameAliases(entries),
    ...checkPathLength(entries),
    ...checkDotGitPaths(entries),
    ...checkSubmodules(entries, changedSet),
    ...checkSymlinks(entries, targets),
    ...checkBudgets(entries, budgets, entryCount),
  );

  const accepted = rejections.length === 0;
  let rebuilt: QuarantineResult["rebuilt"] = null;
  let diff: QuarantinedDiff | null = null;
  if (accepted) {
    // The candidate subject is the worker's, but BOUNDED: accept implies the
    // commit object was ≤ the metadata cap, and we further clip the subject to a
    // display length so the authored message can never be pathological.
    const subject = subjectOf(pristineDir, workerHead).slice(0, MAX_CANDIDATE_SUBJECT_LENGTH);
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
