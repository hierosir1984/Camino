// WP-108 quarantine module — shared types (CAM-EXEC-04, design §5.1).
//
// Product promotion of the WP-003 spike (spikes/quarantine, closed #5): the
// squash-and-rebuild intake, at product grade, running against the issue's
// frozen WP-110 contract, within registry-item-11 fetch budgets, emitting the
// quarantined final diff (@camino/shared) for WP-111 re-classification and
// WP-116 evidence.
import type { ContractRef } from "@camino/shared";

/** A parsed `git ls-tree -r -l -z` record from the worker's final tree. */
export interface TreeEntry {
  /** "100644" | "100755" | "120000" (symlink) | "160000" (gitlink/submodule). */
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  /** Blob byte size; null for a gitlink (commit) entry. */
  size: number | null;
  /** Repo-root-relative POSIX path exactly as stored in the tree. */
  path: string;
}

/**
 * The FINAL-TREE size/count budget — a policy check on the vetted tree.
 * Distinct from the registry-item-11 FETCH budget (see FetchBudget): this is
 * the per-issue tree-size cap the design's policy list calls "tree size
 * budget", contract-overridable and defaulting stricter than the fetch cap.
 */
export interface Budgets {
  /** Max total bytes across all blobs in the final tree. */
  maxTreeBytes: number;
  /** Max bytes for any single blob (single-file size budget). */
  maxBlobBytes: number;
  /** Max number of tree objects (trees + leaves; the object-count proxy). */
  maxEntries: number;
}

/**
 * Default final-tree policy budget. Kept at the WP-003 spike values so the
 * rejection corpus trips them with modest fixtures (a 2 MB blob > 1 MB per-blob
 * cap; a deep tree > the object-count cap). A per-issue contract may set
 * stricter values; it can never exceed the registry-item-11 FETCH cap, which
 * is enforced independently and is not contract-overridable.
 */
export const DEFAULT_BUDGETS: Budgets = Object.freeze({
  maxTreeBytes: 5 * 1024 * 1024,
  maxBlobBytes: 1 * 1024 * 1024,
  maxEntries: 2000,
});

/**
 * The effective tree-size budget for one intake: each field is the STRICTER of
 * the default and any per-issue override (review r1 finding 7). A contract can
 * only TIGHTEN the cap, never widen it — so a supplied `maxBlobBytes` of 10 MB
 * cannot loosen the 1 MB default. (Widening was possible before this clamp,
 * contradicting the "stricter-only" documentation.)
 */
export function effectiveBudgets(overrides?: Partial<Budgets>): Budgets {
  return {
    maxTreeBytes: Math.min(DEFAULT_BUDGETS.maxTreeBytes, overrides?.maxTreeBytes ?? Infinity),
    maxBlobBytes: Math.min(DEFAULT_BUDGETS.maxBlobBytes, overrides?.maxBlobBytes ?? Infinity),
    maxEntries: Math.min(DEFAULT_BUDGETS.maxEntries, overrides?.maxEntries ?? Infinity),
  };
}

/**
 * A single stored path longer than this is rejected as `path-too-long` BEFORE
 * the accept branch, so no policy-passing tree can carry a path the durable
 * QuarantinedDiff schema would refuse (which would make the emitter throw rather
 * than reject — review r1 finding 10). 4096 is a generous single-path bound
 * (POSIX PATH_MAX territory) and well under the schema's 8192-code-unit cap.
 */
export const MAX_STORED_PATH_LENGTH = 4096;

/**
 * The registry-item-11 FETCH budget (PRD §5 item 11: "fetch ≤5,000 objects /
 * 500 MB"). A HARD outer cap on the shallow-fetch footprint — the object count
 * and total byte size of the worker's final head — enforced by the intake and
 * NOT contract-overridable. The single source of the numbers is
 * `@camino/shared` REGISTRY_ITEM_11_QUOTAS.fetch; this shape names them for the
 * intake's admission check.
 */
export interface FetchBudget {
  maxObjects: number;
  maxBytes: number;
}

/**
 * The issue's scope + assignment for one intake run. The FROZEN WP-110 contract
 * (ContractTerms) carries NEITHER a path-scope NOR the assigned base — those are
 * dispatch/assignment facts, not hashed terms — so they arrive here as the
 * assignment. `contractRef` binds the emitted candidate to the frozen contract
 * it was produced under (CAM-PLAN-04); it is stamped onto the quarantined diff
 * and never drives a policy decision. See the README "contract binding" note.
 */
export interface QuarantineAssignment {
  /** Assigned base commit sha; the rebuilt candidate's sole parent. */
  base: string;
  /**
   * Allowed path globs (`**` spans `/`, `*`/`?` do not). A CHANGED path outside
   * every glob is out-of-scope. Empty ⇒ nothing is in scope (rejects any diff).
   */
  allowedPaths: readonly string[];
  /** Per-issue final-tree policy budget overrides (never widens the fetch cap). */
  budgets?: Partial<Budgets>;
  /** WP-110 contract binding for the emitted diff; null/omitted ⇒ diff carries none. */
  contractRef?: ContractRef | null;
}

export type RejectionCode =
  | "worker-merge-commit"
  | "out-of-scope"
  | "protected-path"
  | "path-collision-case"
  | "path-collision-unicode"
  | "reserved-name"
  | "trailing-dot-or-space"
  | "submodule-gitlink"
  | "symlink-escape"
  | "dotgit-path"
  | "windows-alias"
  | "fsck-violation"
  | "blob-size-budget"
  | "tree-size-budget"
  | "entry-budget"
  | "path-too-long"
  // Registry-item-11 FETCH-budget breaches (product additions over the spike):
  | "fetch-object-budget"
  | "fetch-size-budget";

export interface Rejection {
  code: RejectionCode;
  /** Offending path, when the finding is path-scoped. */
  path?: string;
  detail: string;
}

/** The Camino-authored candidate — present iff the intake accepted. */
export interface RebuiltCandidate {
  sha: string;
  /** Exactly [assignment.base] — a squash-rebuild has a single, assigned parent. */
  parents: string[];
  treeSha: string;
  /** The worker-attribution trailer line recorded in the commit message. */
  attributionTrailer: string;
}

export interface QuarantineResult {
  accepted: boolean;
  /** All findings (collect-all, not fail-fast), most useful for the report. */
  rejections: Rejection[];
  /** The Camino-authored candidate — present iff accepted. */
  rebuilt: RebuiltCandidate | null;
  /** The worker head sha that was intake'd (post shallow-fetch). */
  workerHead: string;
  /**
   * The emitted quarantined final diff (@camino/shared schema) — present iff
   * accepted. The durable artifact consumed by WP-111 re-classification and
   * WP-116 evidence; carries candidate identity (sha, base_sha) + changed paths.
   */
  diff: import("@camino/shared").QuarantinedDiff | null;
  /** Distinct object shas the shallow-fetch pulled into the pristine store. */
  fetchedObjectCount: number;
  /**
   * The pristine, hooks-disabled repo the shallow-fetch landed in. Exposed so a
   * caller can prove a carried-in object is absent from it (reachable-history
   * exclusion is structural: the object was never fetched, not merely
   * unreferenced by the rebuilt commit) and so the caller owns its teardown.
   */
  pristineDir: string;
}
