/**
 * Attempt state machine — Appendix A §A.3, transcribed row by row, plus the
 * A.4 item-5 archival step: every terminal state is followed by exactly one
 * archival transition to `archived`, whose guard enforces the strict
 * sub-step order (archive written → ledger row referencing it → workspace
 * destroyed). `archived` has no outgoing rows, so a second archival attempt
 * is an illegal transition — rejected and logged (archival happens exactly
 * once).
 */
import type { MachineDef, TransitionRow } from "./machine.js";
import { attested, nonEmptyString } from "./machine.js";

export const ATTEMPT_ACTIVE_STATES = ["running", "submitted"] as const;

/** The six A.3 terminal states; each is followed by the single archival step. */
export const ATTEMPT_TERMINAL_STATES = [
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "killed-budget",
  "quota-blocked",
] as const;

/** Post-archival absorbing state (A.4#5). */
export const ATTEMPT_ARCHIVED_STATE = "archived" as const;

export type AttemptState =
  | (typeof ATTEMPT_ACTIVE_STATES)[number]
  | (typeof ATTEMPT_TERMINAL_STATES)[number]
  | typeof ATTEMPT_ARCHIVED_STATE;

export const ATTEMPT_STATES = [
  ...ATTEMPT_ACTIVE_STATES,
  ...ATTEMPT_TERMINAL_STATES,
  ATTEMPT_ARCHIVED_STATE,
] as const;

export type AttemptEvent =
  // A.3#1 — dispatch | lease granted (generation g)
  | { type: "attempt-dispatched"; leaseGranted: boolean; leaseGeneration: number }
  // A.3#2 — heartbeat lapse > TTL | kill-confirm executed
  | { type: "heartbeat-lapsed"; killConfirmed: boolean }
  // A.3#3 — worker completes | final head fetched
  | { type: "worker-completed"; finalHeadFetched: boolean }
  // A.3#4 — cancel (David / urgent preemption / pause / edit) | safe checkpoint or kill-confirm
  | {
      type: "attempt-cancel-requested";
      actor?: string;
      reason: "david" | "urgent-preemption" | "pause" | "edit";
      settledBy: "checkpoint" | "kill-confirm";
      summaryWritten: boolean;
    }
  // A.3#5 — budget breach | kill-confirm
  | { type: "attempt-budget-breached"; killConfirmed: boolean }
  // A.3#6 — provider rate limit
  | { type: "rate-limited" }
  // A.3#7 — quarantine + validation verdict
  | {
      type: "verdict-recorded";
      quarantineAndValidationComplete: boolean;
      verdict: "pass" | "fail";
      failureClass?: string;
    }
  // A.4#5 — single archival step: archive written → ledger row → workspace destroyed
  | {
      type: "archival-completed";
      quotasEnforced: boolean;
      ledgerRowReferencesArchive: boolean; // the ledger row references the written archive
      archiveWrittenAt: string; // ISO-8601, strictly ordered
      ledgerRowAt: string;
      workspaceDestroyedAt: string;
    };

type AttemptRow = TransitionRow<AttemptState, AttemptEvent>;

function row<T extends AttemptEvent["type"]>(def: {
  ref: string;
  from: readonly AttemptState[] | null;
  event: T;
  guard?: {
    name: string;
    check: (event: Extract<AttemptEvent, { type: T }>) => boolean;
  };
  to: AttemptState;
  note?: string;
}): AttemptRow {
  return {
    ref: def.ref,
    from: def.from,
    eventType: def.event,
    guard: def.guard as AttemptRow["guard"],
    to: def.to,
    note: def.note,
  };
}

/** ISO-8601 strings must be present and strictly increasing (A.4#5 ordering). */
function strictlyOrdered(...timestamps: readonly string[]): boolean {
  if (timestamps.some((t) => !nonEmptyString(t))) return false;
  const millis = timestamps.map((t) => Date.parse(t));
  if (millis.some(Number.isNaN)) return false;
  return millis.every((t, i) => i === 0 || (millis[i - 1] as number) < t);
}

const attemptRows: readonly AttemptRow[] = [
  // A.3#1 — — | dispatch | lease granted (generation g) | running
  row({
    ref: "A.3#1",
    from: null,
    event: "attempt-dispatched",
    guard: {
      name: "lease-granted-with-generation",
      check: (e) =>
        attested(e.leaseGranted) && Number.isInteger(e.leaseGeneration) && e.leaseGeneration >= 1,
    },
    to: "running",
    note: "Lease generations are monotonic per environment (registry item 5, CAM-STATE-04); monotonicity is enforced by the lease store (WP-114), the machine records the granted generation.",
  }),
  // A.3#2 — running | heartbeat lapse > TTL | kill-confirm executed | expired
  row({
    ref: "A.3#2",
    from: ["running"],
    event: "heartbeat-lapsed",
    guard: { name: "kill-confirm-executed", check: (e) => attested(e.killConfirmed) },
    to: "expired",
  }),
  // A.3#3 — running | worker completes | final head fetched | submitted
  row({
    ref: "A.3#3",
    from: ["running"],
    event: "worker-completed",
    guard: { name: "final-head-fetched", check: (e) => attested(e.finalHeadFetched) },
    to: "submitted",
  }),
  // A.3#4 — running | cancel | safe checkpoint or kill-confirm | cancelled
  row({
    ref: "A.3#4",
    from: ["running"],
    event: "attempt-cancel-requested",
    guard: {
      name: "listed-reason-settled-and-summary-written",
      check: (e) =>
        ["david", "urgent-preemption", "pause", "edit"].includes(e.reason) &&
        (e.reason !== "david" || e.actor === "david") &&
        (e.settledBy === "checkpoint" || e.settledBy === "kill-confirm") &&
        attested(e.summaryWritten),
    },
    to: "cancelled",
    note: "Only the four listed cancellation reasons are legal at runtime; a David-reason cancel must carry David as the envelope actor. The structured summary is part of the appendix's target cell; the issue transitions per A.2#12/A.2#7a under the same cancellation.",
  }),
  // A.3#5 — running | budget breach | kill-confirm | killed-budget
  row({
    ref: "A.3#5",
    from: ["running"],
    event: "attempt-budget-breached",
    guard: { name: "kill-confirm-executed", check: (e) => attested(e.killConfirmed) },
    to: "killed-budget",
  }),
  // A.3#6 — running | provider rate limit | — | quota-blocked
  row({
    ref: "A.3#6",
    from: ["running"],
    event: "rate-limited",
    to: "quota-blocked",
    note: "The issue moves to queued-quota under the same signal (A.2#11) and the wait never counts as a failure.",
  }),
  // A.3#7 — submitted | quarantine + validation verdict | — | succeeded / failed
  row({
    ref: "A.3#7a",
    from: ["submitted"],
    event: "verdict-recorded",
    guard: {
      name: "verdict-pass",
      check: (e) => attested(e.quarantineAndValidationComplete) && e.verdict === "pass",
    },
    to: "succeeded",
  }),
  row({
    ref: "A.3#7b",
    from: ["submitted"],
    event: "verdict-recorded",
    guard: {
      name: "verdict-fail-classified",
      check: (e) =>
        attested(e.quarantineAndValidationComplete) &&
        e.verdict === "fail" &&
        nonEmptyString(e.failureClass),
    },
    to: "failed",
    note: "One appendix row, guard-split on the verdict; failures are classified per the done-problem taxonomy (CAM-OBS-04).",
  }),
  // A.3#8 / A.4#5 — any terminal | single archival step | strictly in that order | archived
  row({
    ref: "A.3#8",
    from: ATTEMPT_TERMINAL_STATES,
    event: "archival-completed",
    guard: {
      name: "quotas-reference-and-strict-substep-order",
      check: (e) =>
        attested(e.quotasEnforced) &&
        attested(e.ledgerRowReferencesArchive) &&
        strictlyOrdered(e.archiveWrittenAt, e.ledgerRowAt, e.workspaceDestroyedAt),
    },
    to: "archived",
    note: "A.4#5: archive written under quota → ledger row REFERENCING that archive → workspace destroyed; out-of-order, missing, or unreferenced sub-steps reject. archived has no outgoing rows, so archival happens exactly once.",
  }),
];

export const attemptMachine: MachineDef<AttemptState, AttemptEvent> = {
  name: "attempt (A.3)",
  states: ATTEMPT_STATES,
  terminalStates: [...ATTEMPT_TERMINAL_STATES, ATTEMPT_ARCHIVED_STATE],
  rows: attemptRows,
};

export const ATTEMPT_CREATION_EVENTS: readonly string[] = ["attempt-dispatched"];
