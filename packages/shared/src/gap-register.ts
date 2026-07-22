/**
 * Gap-register types (WP-122, CAM-CANON-05 / CAM-CORE-09).
 *
 * The gap register is a DERIVED surface: a register row exists for every
 * requirement whose accepted-family intent is not yet demonstrably
 * delivered in the register's context (design §3.4). Rows are never
 * stored — they are projected from the intent ledger, the canon facts,
 * and the gap-disposition event log (`@camino/core` gap-register.ts owns
 * the projection; the daemon's GapDispositionsStore owns durability).
 *
 * TWO DISPOSITION VOCABULARIES, deliberately separate (the design uses
 * the same word for both):
 *
 *  - INTENT disposition (canon.ts, CAM-CANON-03): what the user wants —
 *    `proposed` / `accepted` / `disputed` / … / `descoped`. Lives in the
 *    intent ledger; only user actions move it.
 *  - GAP disposition (this file, design §3.4 verbatim): what the user
 *    decided about one register row — `open` | `fix-queued` | `disputed`
 *    | `false-positive-waived`. Lives in the gap-disposition log.
 *
 * A register row's `disputed` GAP disposition says "David contests this
 * gap finding"; it does not touch requirement intent. Descoping is NOT a
 * gap disposition — it is the intent-ledger action (CAM-CANON-05: real
 * unmet requirements stay open or are descoped BY THE USER through the
 * ledger), which closes the row by removing the requirement from
 * accepted-family intent.
 */

/** Design §3.4 verbatim, plus `open` (the default: "requirements stay open"). */
export const GAP_DISPOSITIONS = Object.freeze([
  "open",
  "fix-queued",
  "disputed",
  "false-positive-waived",
] as const);
export type GapDisposition = (typeof GAP_DISPOSITIONS)[number];

/**
 * The gap-disposition log's CLOSED event vocabulary: exactly the user's
 * register actions (CAM-CORE-04 lists "disposition gap entries" among the
 * v1 actions; every action is an event with actor + timestamp). The
 * `gap-` prefix keeps these names disjoint from the intent-ledger event
 * vocabulary — a gap disposition can never be mistaken for (or replayed
 * as) an intent mutation (CAM-CANON-01).
 */
export const GAP_DISPOSITION_EVENTS = Object.freeze([
  "gap-fix-queued",
  "gap-disputed",
  "gap-false-positive-waived",
  "gap-reopened",
] as const);
export type GapDispositionEventName = (typeof GAP_DISPOSITION_EVENTS)[number];

/**
 * Detector actor namespace (CAM-VAL-05 seam). Detector runs (WP-116)
 * record their findings as `absence-suspected` canon facts under a
 * `camino:detector:<name>` actor; the register derives WAIVABILITY from
 * that provenance — a row is waivable exactly when every outstanding
 * suspicion behind it is detector-authored (CAM-CANON-05: waivers exist
 * only for detector false positives). Provenance-derived, not a stored
 * flag: nothing else can mark a row waivable.
 */
export const DETECTOR_ACTOR_PREFIX = "camino:detector:";

export function isDetectorActor(actor: string): boolean {
  return typeof actor === "string" && actor.startsWith(DETECTOR_ACTOR_PREFIX);
}

/** What a writer submits; the store assigns `seq` and `recordedAt`. */
export interface GapDispositionAppendInput {
  readonly requirementId: string;
  readonly event: GapDispositionEventName;
  /** Always the user: every gap disposition records a user action (CAM-CORE-04). */
  readonly actor: string;
  /**
   * Closed per-event schema, validated in @camino/core: every event
   * carries `tuple` (the register row's status tuple at action time — the
   * basis the disposition binds to) and single-line `reason` text;
   * `gap-false-positive-waived` additionally carries `waivedThroughSeq`
   * (the highest canon-fact seq among the detector findings it waives).
   */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** A persisted gap-disposition row. `seq` is strictly increasing, append order. */
export interface GapDispositionRecord extends GapDispositionAppendInput {
  readonly seq: number;
  /** ISO-8601 UTC timestamp assigned at append time. */
  readonly recordedAt: string;
}

export interface GapDispositionReadFilter {
  readonly requirementId?: string;
  readonly afterSeq?: number;
}
