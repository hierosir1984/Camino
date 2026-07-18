// WP-003 quarantine spike — shared types.
//
// Prototype evidence toward CAM-EXEC-04 (design §5.1 "quarantine v2:
// squash-and-rebuild"). The product-grade module is WP-108; this suite's attack
// corpus is designed to run against that module unchanged.

/** A parsed `git ls-tree -r -l` record from the worker's final tree. */
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

/** Transfer + tree budgets (registry item 11 shapes the product values). */
export interface Budgets {
  /** Max total bytes across all blobs in the final tree. */
  maxTreeBytes: number;
  /** Max bytes for any single blob (single-file size bomb). */
  maxBlobBytes: number;
  /** Max number of tree entries (object-count proxy). */
  maxEntries: number;
}

/** Spike defaults — small so fixtures can trip them without giant files. */
export const DEFAULT_BUDGETS: Budgets = {
  maxTreeBytes: 5 * 1024 * 1024,
  maxBlobBytes: 1 * 1024 * 1024,
  maxEntries: 2000,
};

/**
 * The issue's frozen scope contract (product source: WP-110). For the spike:
 * the assigned base the candidate must be rebuilt onto, plus the allowed-path
 * globs that bound what the worker may change.
 */
export interface Contract {
  /** Assigned base commit sha; the rebuilt candidate's sole parent. */
  base: string;
  /**
   * Allowed path globs (minimatch-style, `**` and `*`). A CHANGED path outside
   * every glob is out-of-scope. Empty ⇒ nothing is in scope (rejects any diff).
   */
  allowedPaths: string[];
  budgets?: Partial<Budgets>;
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
  | "blob-size-budget"
  | "tree-size-budget"
  | "entry-budget";

export interface Rejection {
  code: RejectionCode;
  /** Offending path, when the finding is path-scoped. */
  path?: string;
  detail: string;
}

export interface RebuiltCandidate {
  sha: string;
  /** Exactly [contract.base] — a squash-rebuild has a single, assigned parent. */
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
  /** Distinct object shas the shallow-fetch pulled into the pristine store. */
  fetchedObjectCount: number;
  /**
   * The pristine, hooks-disabled repo the shallow-fetch landed in. Exposed so a
   * test can prove a smuggled object is absent from it (reachable-history
   * neutralization is structural: the object was never fetched, not merely
   * unreferenced by the rebuilt commit).
   */
  pristineDir: string;
}
