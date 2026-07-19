/**
 * Event-log envelope and store interface (WP-101, CAM-STATE-01).
 *
 * Every state transition of every entity (mission / issue / attempt) is
 * recorded as one immutable event row carrying actor, cause, and payload.
 * Rejected transition attempts are recorded too — illegal transitions are
 * rejected AND logged (CAM-STATE-05) — with `outcome: "rejected"` and a
 * `null` toState, so replay skips them while the record survives.
 *
 * The store is append-only by contract (and by construction in the SQLite
 * implementation, packages/daemon): no update, no delete. Derived views are
 * projections over `read()` in `seq` order and must be rebuildable from the
 * log alone.
 */

export const ENTITY_KINDS = ["mission", "issue", "attempt"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export type EventOutcome = "applied" | "rejected";

/** Why a transition attempt was rejected (recorded on `outcome: "rejected"` rows). */
export type RejectionCode =
  | "illegal-transition" // no Appendix A row matches (state, event)
  | "guard-rejected" // rows matched but every guard refused the payload
  | "unknown-entity" // event for an entity with no creation record
  | "already-exists" // creation event for an entity that already exists
  | "malformed-payload"; // reserved fields ("type"/"actor") or non-JSON payload

/** What a caller submits for appending; the store assigns `seq` and `recordedAt`. */
export interface EventInput {
  readonly entityKind: EntityKind;
  readonly entityId: string;
  /** Machine event name (e.g. "plan-approved"); the domain unions live in @camino/core. */
  readonly event: string;
  /** Who caused the transition (e.g. "david", "camino:scheduler", "worker:codex-cli"). */
  readonly actor: string;
  /** Why — free text or a structured reference (e.g. "mission:m1 re-routed per A.1b"). */
  readonly cause: string;
  /** Guard inputs and transition data. Must be JSON-serializable. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** State before the transition; null on creation rows. */
  readonly fromState: string | null;
  /** State after the transition; null on rejected rows (state unchanged). */
  readonly toState: string | null;
  readonly outcome: EventOutcome;
  /** Present exactly when `outcome` is "rejected". */
  readonly rejectionCode?: RejectionCode;
}

/** A persisted event row. `seq` is strictly increasing and never reused (append order). */
export interface EventRecord extends EventInput {
  readonly seq: number;
  /** ISO-8601 UTC timestamp assigned at append time. */
  readonly recordedAt: string;
}

export interface EventFilter {
  readonly entityKind?: EntityKind;
  readonly entityId?: string;
  /** Return only rows with seq strictly greater than this. */
  readonly afterSeq?: number;
}

/**
 * The store contract the daemon's SQLite log implements (WP-101) and every
 * derived view consumes. Append-only: there is deliberately no update or
 * delete surface.
 */
export interface EventStore {
  append(input: EventInput): EventRecord;
  /** All matching rows in ascending `seq` order. */
  read(filter?: EventFilter): EventRecord[];
}
