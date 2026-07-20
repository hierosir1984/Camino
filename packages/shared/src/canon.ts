/**
 * Living Canon types (WP-109, CAM-CANON-01/02/03): the intent ledger's
 * event vocabulary, the canon-fact observation vocabulary, and the
 * per-requirement status tuple.
 *
 * NAMING NOTE — two different "intents" exist in this codebase and they
 * are deliberately separate:
 *
 *  - The WP-104 intent JOURNAL (`external-ops.ts`, `intent-journal.ts`)
 *    records Camino's intents to perform EXTERNAL OPERATIONS (pushes, PR
 *    creation) for the §4.4 idempotency contract.
 *  - The WP-109 intent LEDGER (this file, `canon-*.ts`) records the
 *    user's REQUIREMENT INTENT — what David asked the software to do —
 *    per design §3.1. "Intent ledger" is the design's own name.
 *
 * The two never share a store, a lifecycle, or an event vocabulary.
 */

/**
 * Intent dispositions (CAM-CANON-03, verbatim grammar):
 * `proposed` → `accepted` | `disputed` → (`resolved-accepted` | `assumed`
 * | `descoped`), plus the CAM-CANON-10 rule that an accepted-family
 * requirement can be explicitly descoped by the user. The full transition
 * table (with each row's design citation) is
 * `DISPOSITION_TRANSITIONS` in @camino/core.
 */
export const INTENT_DISPOSITIONS = [
  "proposed",
  "accepted",
  "disputed",
  "resolved-accepted",
  "assumed",
  "descoped",
] as const;
export type IntentDisposition = (typeof INTENT_DISPOSITIONS)[number];

/**
 * The dispositions that count as ACCEPTED INTENT — what canon text
 * renders (design §3.1: "canon text = the rendered projection of accepted
 * intent"). `assumed` is accepted intent with a documented assumption the
 * user signed off.
 */
export const ACCEPTED_FAMILY = ["accepted", "resolved-accepted", "assumed"] as const;

/**
 * The intent ledger's CLOSED event vocabulary (CAM-CANON-01): exactly the
 * user actions the design names — intake submissions/confirmations,
 * dispute answers, descope approvals. There is deliberately NO event for
 * anything that happens to code: merge, revert, abandonment, external
 * edits, and probe results have no name here and therefore no way in.
 * Those are observations; they belong to `CANON_FACT_KINDS`.
 */
export const LEDGER_EVENTS = [
  /** PRD intake surfaced this requirement from the user's own text (design invariant 6). */
  "requirement-proposed",
  /** Intake confirmation: the user confirmed the checklist item (CAM-PLAN-02). */
  "requirement-accepted",
  /** Intake surfaced a contradiction with existing canon; the user's answer is pending. */
  "requirement-disputed",
  /** Dispute answer: the user resolved the dispute, keeping the requirement. */
  "dispute-resolved-accepted",
  /** Dispute answer: the user signed off a documented assumption (§3.1). */
  "dispute-assumed",
  /** Descope approval: the user explicitly removed the requirement from intent. */
  "requirement-descoped",
] as const;
export type LedgerEventName = (typeof LEDGER_EVENTS)[number];

/** What a ledger writer submits; the store assigns `seq` and `recordedAt`. */
export interface LedgerAppendInput {
  readonly requirementId: string;
  readonly event: LedgerEventName;
  /** Always the user (DAVID_ACTOR): every ledger row records a user action. */
  readonly actor: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** A persisted intent-ledger row. `seq` is strictly increasing, append order. */
export interface LedgerEventRecord extends LedgerAppendInput {
  readonly seq: number;
  /** ISO-8601 UTC timestamp assigned at append time. */
  readonly recordedAt: string;
}

export interface LedgerReadFilter {
  readonly requirementId?: string;
  readonly afterSeq?: number;
}

/**
 * Canon facts (WP-109): the OBSERVATION vocabulary the status projection
 * folds — what happened to code and to verification, per requirement.
 * Facts are recorded by Camino components (merge machinery, the
 * reconciler, the validation runner — later WPs emit them; this WP defines
 * the seam and stores them durably). Facts NEVER carry intent: the
 * projection derives implementation-state and evidence-state from facts,
 * and intent-disposition exclusively from ledger records (CAM-CANON-01).
 */
export const CANON_FACT_KINDS = [
  /** Branch B's changes touch requirement R (drives the no-inheritance rule). */
  "requirement-touched",
  /** R's implementation is present on branch B at a SHA (issue merge into the mission branch). */
  "implementation-recorded",
  /** A confirmed landing put R's implementation on main (CAM-CANON-10: only confirmed pushes). */
  "landed-on-main",
  /** A revert removed R's implementing change in a context (main or a branch). */
  "revert-recorded",
  /** An external edit or failing probe suggests R's implementation no longer exists (§3.1). */
  "absence-suspected",
  /** A rescan resolved an outstanding suspicion: present or absent. */
  "absence-resolved",
  /** A verification run bound to (head SHA, base SHA) passed or failed (invariant 7). */
  "verification-verdict",
  /** R's verification is currently impossible in a context (probe quarantined / infra, §3.6). */
  "verification-blocked",
  /** A previously recorded verification block cleared. */
  "verification-unblocked",
] as const;
export type CanonFactKind = (typeof CANON_FACT_KINDS)[number];

/** What a fact writer submits; the store assigns `seq` and `recordedAt`. */
export interface CanonFactInput {
  readonly requirementId: string;
  readonly kind: CanonFactKind;
  /** The observing component (e.g. "camino:merge", "camino:reconciler"). */
  readonly actor: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** A persisted canon-fact row. `seq` is strictly increasing, append order. */
export interface CanonFactRecord extends CanonFactInput {
  readonly seq: number;
  readonly recordedAt: string;
}

export interface CanonFactReadFilter {
  readonly requirementId?: string;
  readonly afterSeq?: number;
}

/**
 * Implementation-state per branch context (CAM-CANON-03, verbatim values):
 * `absent` | `present-on(<branch>)` | `on-main` | `suspected-absent`.
 */
export type ImplementationState =
  | { readonly kind: "absent" }
  | { readonly kind: "present-on"; readonly branch: string }
  | { readonly kind: "on-main" }
  | { readonly kind: "suspected-absent" };

/** Evidence-state (CAM-CANON-03, verbatim values). */
export const EVIDENCE_STATES = ["unverified", "verified-live", "stale", "blocked"] as const;
export type EvidenceState = (typeof EVIDENCE_STATES)[number];

/**
 * The CAM-CANON-03 status tuple: intent-disposition × implementation-state
 * (per branch context) × evidence-state. Derived, never stored: the
 * projection recomputes it from the ledger and the facts for a reader's
 * context (design §3.1 "reverts, external edits, and probe regressions
 * recompute projections; nothing hand-maintains reverse transitions").
 */
export interface StatusTuple {
  readonly disposition: IntentDisposition;
  readonly implementation: ImplementationState;
  readonly evidence: EvidenceState;
}

/**
 * The reader's context: main at a known head, or a branch at a known head.
 * The caller (context-pack builder, GUI) supplies the head SHA it is
 * rendering for — evidence liveness is a comparison between a verdict's
 * recorded binding and THIS head (invariant 7: evidence binds to SHAs and
 * expires rather than rebinding).
 */
export type StatusContext =
  | { readonly kind: "main"; readonly headSha: string }
  | { readonly kind: "branch"; readonly branch: string; readonly headSha: string };
