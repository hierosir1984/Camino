// PRD §5 registry item 11 — quota values — as ONE frozen source of truth
// (the WP-105 pattern: policy constants live in @camino/shared so every
// enforcing package consults the same object and none can drift).
//
// Registry item 11, verbatim: "fetch ≤5,000 objects / 500 MB; workspace
// ≤2 GB; archive ≤500 MB compressed per attempt, retained 90 days or last 10
// attempts per issue (whichever more)."
//
// Consumers: the WP-107 worker module (workspace / archive / retention),
// WP-108 quarantine intake (fetch budgets), WP-115 retention (CAM-SEC-08).
//
// Unit interpretation, stated: "MB"/"GB" are read as SI decimal units
// (500 MB = 500,000,000 bytes; 2 GB = 2,000,000,000 bytes). For a LIMIT the
// decimal reading is the stricter of the two common readings (smaller than
// the binary MiB/GiB values), so ambiguity resolves fail-closed.
//
// Every object is frozen at every level (barrel-immutability sweep + the
// PR-53/54 depth lesson): a first-party importer cannot widen a quota by
// assignment.

/** PRD §5 registry item 11, resolved to bytes/counts. Frozen at depth. */
export const REGISTRY_ITEM_11_QUOTAS = Object.freeze({
  /** Quarantine shallow-fetch budgets (CAM-EXEC-04; enforced by WP-108). */
  fetch: Object.freeze({
    maxObjects: 5_000,
    maxBytes: 500_000_000,
  }),
  /** Worker workspace size cap (CAM-EXEC-02/03; enforced by WP-107). */
  workspace: Object.freeze({
    maxBytes: 2_000_000_000,
  }),
  /** Per-attempt archive cap + retention (CAM-EXEC-05; enforced by WP-107). */
  archive: Object.freeze({
    maxCompressedBytes: 500_000_000,
    /**
     * Retention is the UNION of the two windows — an archive is retained
     * while it is within 90 days OR among the newest 10 attempts of its
     * issue ("whichever is more"); it may be deleted only when BOTH have
     * been exceeded.
     */
    retainDays: 90,
    retainLastAttemptsPerIssue: 10,
  }),
});

export type RegistryItem11Quotas = typeof REGISTRY_ITEM_11_QUOTAS;
