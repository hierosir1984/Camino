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
  /**
   * When true, a null/absent `contractRef` is REFUSED — the emitted diff must
   * carry a WP-110 contract binding. Production dispatch (WP-114) sets this so
   * every downstream artifact resolves the exact frozen contract (CAM-PLAN-04 /
   * CONTRACT_REFERENCE_OBLIGATIONS); the WP-003 corpus fixtures, which have no
   * contract, leave it false and emit the null (no-binding) form (review r8
   * finding 4). Default false.
   */
  requireContractRef?: boolean;
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
 * PRECONDITION (custody, owned by the caller — review r7 findings 1/4): the
 * caller invokes this ONLY against a STOPPED worker whose `workerRepo` git dir is
 * quiescent (the WP-107 container has exited; nothing writes it concurrently),
 * and WP-107 has provisioned that clone self-contained. No pair of filesystem
 * scans WP-108 runs can be proof against a source mutated DURING the fetch, so
 * this quiescence is the guarantee; the pre-/post-fetch attestations here are
 * best-effort defense in depth. See git.ts `assertSelfContainedObjectStore`.
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
  // SNAPSHOT the assignment ONCE at entry (review r6 finding 6): capture every
  // worker-influenced field into an immutable local up front. A malformed or
  // STATEFUL assignment (a side-effecting getter, a Proxy) that returned a
  // DIFFERENT base on a later read could otherwise split the DIFF (computed vs
  // one base) from the REBUILD (parented on another) — admitting protected
  // content while reporting an empty base-relative diff. Every use below reads
  // these locals, never `assignment.*` again.
  const base = assignment.base;
  const allowedPaths: readonly string[] = Object.freeze([...assignment.allowedPaths]);
  // SNAPSHOT the contractRef as OWNED PRIMITIVES via a JSON round-trip (review r7
  // finding 7, r8 finding 3): a field-by-field copy still captured a value that
  // was itself a live object with a `toJSON()` (it passed the round-trip
  // validator at emit, then mutated to malformed after return). JSON round-trip
  // resolves getters/`toJSON` to plain primitives detached from the live object,
  // so the emitted artifact is stable; a non-serializable ref fails closed.
  const rawRef = assignment.contractRef ?? null;
  let contractRef: ContractRef | null = null;
  if (rawRef != null) {
    try {
      contractRef = JSON.parse(JSON.stringify(rawRef)) as ContractRef;
    } catch {
      throw new QuarantineGitError(
        "assignment.contractRef is not JSON-serializable — refused (fail-closed; review r8 finding 3)",
      );
    }
  }
  // Production provenance: WP-114 sets requireContractRef so an unbound candidate
  // is refused (review r8 finding 4). The corpus fixtures leave it false.
  if (options.requireContractRef === true && contractRef == null) {
    throw new QuarantineGitError(
      "a contract binding (contractRef) is required but the assignment supplied none — refused " +
        "(CAM-PLAN-04 provenance; review r8 finding 4)",
    );
  }
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
  fetchOid(pristineDir, baseRepo, base, true);
  // Store size AFTER the base fetch, BEFORE the worker fetch: the delta after the
  // worker fetch bounds the fetch by its on-disk store footprint — the compressed
  // pack (a conservative proxy for the wire transfer, not exact wire bytes;
  // review r3 finding 4, r4 finding 6), never the uncompressed content.
  const bytesBeforeWorker = storeSizeBytes(pristineDir);
  const workerHead = fetchOid(pristineDir, workerRepo, workerHeadOid, true);
  const fetchBytes = storeSizeBytes(pristineDir) - bytesBeforeWorker;
  // Re-attest the source AFTER the fetch (review r6 finding 1): cheap defence in
  // depth against an alternates/borrowing store that appeared or persisted around
  // the fetch window. The custody model (the worker dir is quiescent by intake
  // time — see git.ts boundary note) is the guarantee; this narrows the residual
  // TOCTOU window. A borrowed store now throws → fail-closed, before any policy.
  assertSelfContainedObjectStore(workerRepo);

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
      fetchedObjectCount: fetchObjects,
      pristineDir,
    };
  }

  // Delegate the malformed-object/path class to git's own hardened fsck FIRST —
  // BEFORE any path-bearing read (review r6 finding 7). A type-confused entry (a
  // `120000` "symlink" whose object is actually a tree) makes the symlink-target
  // read throw, and the broad catch below would otherwise MISLABEL that integrity
  // violation as `path-too-long`. Running fsck first records the TRUTHFUL
  // `fsck-violation`; the catch then attributes an overflow only when fsck found
  // the tree clean. (WP-003 r3: fsck also covers `.git` equivalents incl.
  // HFS-ignorable chars, mode/type mismatches, broken links.)
  const fsckErr = fsckTree(pristineDir, treeSha);
  if (fsckErr) {
    // `git fsck <tree>` sanity-checks other objects in the pristine store too, so
    // the violation is not PROVABLY the worker's (the trusted base shares the
    // store); report it honestly as an integrity error in the pristine store
    // reachable while validating the worker tree (review r7 finding 12). Still
    // fail-closed — a corrupt store never yields an accepted candidate.
    rejections.push({
      code: "fsck-violation",
      detail: `git fsck reported an object-integrity violation in the pristine store while validating the worker tree: ${fsckErr}`,
    });
  }

  // Within the object-count cap the leaves are read WITH paths for the path/
  // content checks. The object count bounds the NUMBER of paths but not a single
  // ENORMOUS entry NAME (or an enormous DELETED base path in the diff), which
  // would overrun the read buffer (review r5 findings 3, 4). Wrap the path-
  // bearing reads: any overflow/malformed-output failure becomes a clean
  // rejection, never a thrown ENOBUFS. Paths that are not valid UTF-8 decode to
  // U+FFFD and are rejected by checkNameAliases (WP-003 r2).
  let entries: TreeEntry[];
  let targets: Map<string, string>;
  let changed: string[];
  try {
    entries = treeLeaves(pristineDir, treeSha);
    targets = symlinkTargets(pristineDir, entries);
    changed = changedPaths(pristineDir, base, workerHead);
  } catch {
    // If fsck already explained the tree is malformed, THAT is the truthful
    // rejection — do not also relabel a read that failed on the corruption as a
    // path overflow (review r6 finding 7). Attribute path-too-long only when the
    // tree fscks clean (⇒ the failure really is an over-long path/name).
    if (!fsckErr) {
      rejections.push({
        code: "path-too-long",
        detail: "a tree/diff path-bearing read exceeded processing bounds (an over-long path/name)",
      });
    }
    return {
      accepted: false,
      rejections,
      rebuilt: null,
      workerHead,
      diff: null,
      fetchedObjectCount: fetchObjects,
      pristineDir,
    };
  }
  const changedSet = new Set(changed);

  rejections.push(
    ...checkScopeAndProtected(changed, allowedPaths),
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
    const candidateSha = commitCandidate(pristineDir, treeSha, base, message);
    rebuilt = {
      sha: candidateSha,
      parents: parentShas(pristineDir, candidateSha),
      treeSha,
      attributionTrailer,
    };
    const candidate: QuarantinedDiff = {
      candidateSha,
      baseSha: base,
      treeSha,
      workerHeadSha: workerHead,
      attributionTrailer,
      contractRef,
      changedPaths: changedPathsWithStatus(pristineDir, base, candidateSha),
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
    fetchedObjectCount: fetchObjects,
    pristineDir,
  };
}
