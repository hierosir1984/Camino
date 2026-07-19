/**
 * Issue state machine — Appendix A §A.2, transcribed row by row. Refs
 * "A.2#n" number the table rows top to bottom; letter suffixes mark one
 * appendix row encoded as guard-split code rows. The mission-level repair
 * row ("fast subset fails after an issue merge") and A.1's repair rows
 * create issues rather than transition one, so they appear here as the
 * creation row A.2#1c.
 *
 * Failure counting (retry policy): `failureCount` is recorded context —
 * the recorder enriches it from the derived view's per-issue counter, which
 * increments on attempt failures and validation failures and NEVER on quota
 * waits (the A.2 queued-quota row's clause). Family switch after 2 failures
 * is routing advice, not a state change — see retryPolicy.
 */
import type { EnrichmentSpec, MachineDef, TransitionRow } from "./machine.js";
import { attested } from "./machine.js";

export const ISSUE_ACTIVE_STATES = [
  "waiting-deps",
  "ready",
  "queued-quota",
  "claimed",
  "implementing",
  "validating",
  "merge-pending",
  "blocked",
  "escalated",
  "replanning",
] as const;

export const ISSUE_TERMINAL_STATES = ["merged", "cancelled"] as const;

export type IssueState =
  (typeof ISSUE_ACTIVE_STATES)[number] | (typeof ISSUE_TERMINAL_STATES)[number];

export const ISSUE_STATES = [...ISSUE_ACTIVE_STATES, ...ISSUE_TERMINAL_STATES] as const;

export type IssueEvent =
  // A.2#1 — plan approved → ready / waiting-deps; A.2#1c — repair issue created ready
  | {
      type: "issue-created";
      origin: "plan-approval" | "repair";
      unmetDependencies: number;
    }
  // A.2#2 — dependency merged into mission branch
  | { type: "dependency-merged"; allDepsMerged: boolean }
  // A.2#3 — scheduler dispatches
  | { type: "dispatched"; sequentialSlotFree: boolean; missionExecuting: boolean }
  // A.2#4 — provider window exhausted
  | { type: "provider-window-exhausted" }
  // A.2#5 — quota window frees (CAM-ROUTE-06)
  | { type: "quota-window-freed" }
  // A.2#6 — worker starts
  | { type: "worker-started"; leaseValid: boolean }
  // A.2#7 — attempt reaches a terminal state before the worker starts
  | {
      type: "attempt-pre-start-terminal";
      attemptTerminal: "expired" | "cancelled" | "quota-blocked";
      recorded: boolean;
    }
  // A.2#8 — worker submits final head
  | { type: "final-head-submitted"; quarantinePassed: boolean }
  // A.2#9 — attempt fails (failureCount is recorded context)
  | { type: "attempt-failed"; failureCount?: number }
  // A.2#10 — attempt budget breach
  | { type: "attempt-budget-breached"; killConfirmed: boolean }
  // A.2#11 — attempt quota-blocked
  | { type: "attempt-quota-blocked" }
  // A.2#12 — attempt cancelled by preemption/pause
  | { type: "attempt-cancelled"; reason: "urgent-preemption" | "pause"; summaryWritten: boolean }
  // A.2#13 — gates green at candidate
  | { type: "validation-green"; freshnessHolds: boolean }
  // A.2#14 — validation fails (failureCount is recorded context; see retry-policy audit note)
  | { type: "validation-failed"; repairPolicyAllows: boolean; failureCount?: number }
  // A.2#15 — infra-blocked
  | { type: "infra-blocked" }
  // A.2#16 — merge approval
  | {
      type: "merge-approved";
      actor?: string;
      authority: "david" | "tier-1";
      target: "mission-branch" | "main-candidate";
      baseCheckPassed: boolean;
    }
  // A.2#17 — mission branch advanced since validation
  | { type: "mission-branch-advanced" }
  // A.2#19 — contract edited, incompatible
  | { type: "contract-edited-incompatible" }
  // A.2#20 — replan complete under contract v(n+1)
  | { type: "replan-complete"; contractVersionAdvanced: boolean; unmetDependencies: number }
  // A.2#21 — David answers an escalation
  | { type: "escalation-answered"; actor?: string; resolution: "retry" | "cancel" }
  // A.2#22 — David cancels
  | { type: "issue-cancelled"; actor?: string }
  // A.2#23 — resource restored / question answered
  | { type: "block-resolved" }
  // A.2#24 — cleanup failure during teardown
  | { type: "cleanup-failed"; recorded: boolean };

/** Recorded-context contract (see mission.ts): recorder-enriched fields. */
export const ISSUE_CONTEXT_ENRICHMENT: Readonly<Record<string, readonly EnrichmentSpec[]>> = {
  "attempt-failed": [{ field: "failureCount", source: "next-issue-failure-count" }],
  "validation-failed": [{ field: "failureCount", source: "next-issue-failure-count" }],
};

/**
 * Retry policy per A.2#9: retriable until the 4th failure escalates; family
 * switch after 2 failures (the 3rd and 4th attempts run on a different
 * family). Quota waits never feed this counter (A.2#5).
 */
export function retryPolicy(failureCount: number): {
  escalate: boolean;
  familySwitch: boolean;
} {
  return { escalate: failureCount >= 4, familySwitch: failureCount >= 2 };
}

type IssueRow = TransitionRow<IssueState, IssueEvent>;

function row<T extends IssueEvent["type"]>(def: {
  ref: string;
  from: readonly IssueState[] | null;
  event: T;
  guard?: {
    name: string;
    check: (event: Extract<IssueEvent, { type: T }>) => boolean;
  };
  to: IssueState;
  note?: string;
}): IssueRow {
  return {
    ref: def.ref,
    from: def.from,
    eventType: def.event,
    guard: def.guard as IssueRow["guard"],
    to: def.to,
    note: def.note,
  };
}

const issueRows: readonly IssueRow[] = [
  // A.2#1 — — | plan approved | — | ready (no unmet dependencies) else waiting-deps
  row({
    ref: "A.2#1a",
    from: null,
    event: "issue-created",
    guard: {
      name: "plan-approval-no-unmet-deps",
      check: (e) =>
        e.origin === "plan-approval" &&
        Number.isInteger(e.unmetDependencies) &&
        e.unmetDependencies === 0,
    },
    to: "ready",
  }),
  row({
    ref: "A.2#1b",
    from: null,
    event: "issue-created",
    guard: {
      name: "plan-approval-unmet-deps",
      check: (e) =>
        e.origin === "plan-approval" &&
        Number.isInteger(e.unmetDependencies) &&
        e.unmetDependencies > 0,
    },
    to: "waiting-deps",
    note: "One appendix row, guard-split on unmet dependencies.",
  }),
  // A.2#1c — repair issues created ready within mission scope (A.1#8, A.1#11, A.2#18 mission-level row)
  row({
    ref: "A.2#1c",
    from: null,
    event: "issue-created",
    guard: {
      name: "repair-created-ready",
      check: (e) =>
        e.origin === "repair" && Number.isInteger(e.unmetDependencies) && e.unmetDependencies === 0,
    },
    to: "ready",
    note: "Creation row for the repair issues named by A.1#8/A.1#11 and the A.2 mission-level fast-subset row (A.2#18); repair issues are created ready, so unmet dependencies reject.",
  }),
  // A.2#2 — waiting-deps | dependency merged into mission branch | all deps merged | ready
  row({
    ref: "A.2#2",
    from: ["waiting-deps"],
    event: "dependency-merged",
    guard: { name: "all-deps-merged", check: (e) => attested(e.allDepsMerged) },
    to: "ready",
    note: "A dependency merge that leaves other deps unmet guard-rejects; the scheduler should emit the machine event only at full readiness (WP-119).",
  }),
  // A.2#3 — ready | scheduler dispatches | sequential slot free; mission executing (not paused) | claimed
  row({
    ref: "A.2#3",
    from: ["ready"],
    event: "dispatched",
    guard: {
      name: "sequential-slot-free-and-mission-executing",
      check: (e) => attested(e.sequentialSlotFree) && attested(e.missionExecuting),
    },
    to: "claimed",
    note: "The attempt lease is granted by the attempt machine's creation row (A.3#1) under the same dispatch.",
  }),
  // A.2#4 — ready | provider window exhausted | — | queued-quota
  row({
    ref: "A.2#4",
    from: ["ready"],
    event: "provider-window-exhausted",
    to: "queued-quota",
  }),
  // A.2#5 — queued-quota | quota window frees | — | ready (never counts toward failure counters)
  row({
    ref: "A.2#5",
    from: ["queued-quota"],
    event: "quota-window-freed",
    to: "ready",
    note: "Quota waits never count toward failure or family-switch counters — enforced by the failure-counter fold (views.ts) and tested.",
  }),
  // A.2#6 — claimed | worker starts | lease valid | implementing
  row({
    ref: "A.2#6",
    from: ["claimed"],
    event: "worker-started",
    guard: { name: "lease-valid", check: (e) => attested(e.leaseValid) },
    to: "implementing",
  }),
  // A.2#7 — claimed | attempt terminal before worker start | recorded | ready (or queued-quota for quota)
  row({
    ref: "A.2#7a",
    from: ["claimed"],
    event: "attempt-pre-start-terminal",
    guard: {
      name: "pre-start-non-quota-recorded",
      check: (e) =>
        (e.attemptTerminal === "expired" || e.attemptTerminal === "cancelled") &&
        attested(e.recorded),
    },
    to: "ready",
    note: "No issue is ever stranded in claimed without a live lease.",
  }),
  row({
    ref: "A.2#7b",
    from: ["claimed"],
    event: "attempt-pre-start-terminal",
    guard: {
      name: "pre-start-quota-recorded",
      check: (e) => e.attemptTerminal === "quota-blocked" && attested(e.recorded),
    },
    to: "queued-quota",
    note: "One appendix row, guard-split on the attempt's terminal kind.",
  }),
  // A.2#8 — implementing | worker submits final head | quarantine checks pass | validating
  row({
    ref: "A.2#8",
    from: ["implementing"],
    event: "final-head-submitted",
    guard: { name: "quarantine-checks-pass", check: (e) => attested(e.quarantinePassed) },
    to: "validating",
  }),
  // A.2#9 — implementing | attempt fails | retry policy | ready; 4 failures → escalated
  row({
    ref: "A.2#9a",
    from: ["implementing"],
    event: "attempt-failed",
    guard: {
      name: "retriable-failure-count",
      check: (e) =>
        Number.isInteger(e.failureCount) &&
        (e.failureCount as number) >= 1 &&
        (e.failureCount as number) < 4,
    },
    to: "ready",
    note: "failureCount is recorded context (a positive integer); family switch after 2 failures is retryPolicy advice to the scheduler, not a state change.",
  }),
  row({
    ref: "A.2#9b",
    from: ["implementing"],
    event: "attempt-failed",
    guard: {
      name: "failure-count-exhausted",
      check: (e) => Number.isInteger(e.failureCount) && (e.failureCount as number) >= 4,
    },
    to: "escalated",
  }),
  // A.2#10 — implementing | attempt budget breach | kill-confirm executed | escalated (never auto-retry)
  row({
    ref: "A.2#10",
    from: ["implementing"],
    event: "attempt-budget-breached",
    guard: { name: "kill-confirm-executed", check: (e) => attested(e.killConfirmed) },
    to: "escalated",
    note: "Kill-and-escalate per CAM-EXEC-03 — there is deliberately no retry row for budget breaches.",
  }),
  // A.2#11 — implementing | attempt quota-blocked | — | queued-quota (not a failure)
  row({
    ref: "A.2#11",
    from: ["implementing"],
    event: "attempt-quota-blocked",
    to: "queued-quota",
  }),
  // A.2#12 — implementing | attempt cancelled by preemption/pause | attempt summary written | ready
  row({
    ref: "A.2#12",
    from: ["implementing"],
    event: "attempt-cancelled",
    guard: {
      name: "preemption-or-pause-and-summary-written",
      check: (e) =>
        (e.reason === "urgent-preemption" || e.reason === "pause") && attested(e.summaryWritten),
    },
    to: "ready",
    note: "The appendix scopes this row to preemption/pause cancellations: a David cancel ends the issue via A.2#22 and an edit cancel goes through A.2#19 replanning. Re-dispatch happens when the mission resumes executing (A.2#3's mission-executing guard).",
  }),
  // A.2#13 — validating | gates green at candidate | freshness holds | merge-pending
  row({
    ref: "A.2#13",
    from: ["validating"],
    event: "validation-green",
    guard: { name: "freshness-holds", check: (e) => attested(e.freshnessHolds) },
    to: "merge-pending",
  }),
  // A.2#14 — validating | validation fails | repair policy | ready (repair attempt)
  row({
    ref: "A.2#14",
    from: ["validating"],
    event: "validation-failed",
    guard: { name: "repair-policy-allows", check: (e) => attested(e.repairPolicyAllows) },
    to: "ready",
    note: "Validation failures feed the same recorded failure counter as attempt failures (A.1b#6 'retry policy per A.2'); the appendix names no escalation bound on this row — audit item.",
  }),
  // A.2#15 — validating | infra-blocked | — | blocked
  row({
    ref: "A.2#15",
    from: ["validating"],
    event: "infra-blocked",
    to: "blocked",
  }),
  // A.2#16 — merge-pending | approval (David in training mode, or tier-1 — mission-branch targets only) | base check passes | merged
  row({
    ref: "A.2#16",
    from: ["merge-pending"],
    event: "merge-approved",
    guard: {
      name: "mission-branch-authority-and-base-check",
      check: (e) =>
        attested(e.baseCheckPassed) &&
        e.target === "mission-branch" &&
        (e.authority === "david" ? e.actor === "david" : e.authority === "tier-1"),
    },
    to: "merged",
    note: "The row's target cell is 'merged (into mission branch)': it applies to mission-branch targets ONLY, for every authority — quick-task (main-candidate) issues have no merge row at all per A.1b, which is audit finding AMEND-1. Tier-1 is additionally the only non-David authority. The fast subset runs post-merge and its failure creates a repair issue (A.2#18 → creation row A.2#1c).",
  }),
  // A.2#17 — merge-pending | mission branch advanced since validation | — | ready (revalidation)
  row({
    ref: "A.2#17",
    from: ["merge-pending"],
    event: "mission-branch-advanced",
    to: "ready",
  }),
  // A.2#18 — (mission-level) fast subset fails after an issue merge → repair issue created ready.
  // Not a transition of an existing issue: encoded as creation row A.2#1c; the
  // merges-block-until-green clause is scheduler policy (WP-119) — audit item.
  // A.2#19 — any active | contract edited, incompatible | — | replanning
  row({
    ref: "A.2#19",
    from: ISSUE_ACTIVE_STATES,
    event: "contract-edited-incompatible",
    to: "replanning",
  }),
  // A.2#20 — replanning | replan complete under contract v(n+1) | dependency readiness re-checked | ready / waiting-deps
  row({
    ref: "A.2#20a",
    from: ["replanning"],
    event: "replan-complete",
    guard: {
      name: "replan-under-next-contract-no-unmet-deps",
      check: (e) =>
        attested(e.contractVersionAdvanced) &&
        Number.isInteger(e.unmetDependencies) &&
        e.unmetDependencies === 0,
    },
    to: "ready",
  }),
  row({
    ref: "A.2#20b",
    from: ["replanning"],
    event: "replan-complete",
    guard: {
      name: "replan-under-next-contract-unmet-deps",
      check: (e) =>
        attested(e.contractVersionAdvanced) &&
        Number.isInteger(e.unmetDependencies) &&
        e.unmetDependencies > 0,
    },
    to: "waiting-deps",
    note: "One appendix row, guard-split on re-checked dependency readiness.",
  }),
  // A.2#21 — escalated | David answers | — | ready (or cancelled per answer)
  row({
    ref: "A.2#21a",
    from: ["escalated"],
    event: "escalation-answered",
    guard: {
      name: "david-answers-retry",
      check: (e) => e.actor === "david" && e.resolution === "retry",
    },
    to: "ready",
  }),
  row({
    ref: "A.2#21b",
    from: ["escalated"],
    event: "escalation-answered",
    guard: {
      name: "david-answers-cancel",
      check: (e) => e.actor === "david" && e.resolution === "cancel",
    },
    to: "cancelled",
    note: "One appendix row, guard-split on David's answer.",
  }),
  // A.2#22 — any active | David cancels | — | cancelled
  row({
    ref: "A.2#22",
    from: ISSUE_ACTIVE_STATES,
    event: "issue-cancelled",
    guard: { name: "actor-is-david", check: (e) => e.actor === "david" },
    to: "cancelled",
  }),
  // A.2#23 — blocked | resource restored / question answered | — | ready
  row({
    ref: "A.2#23",
    from: ["blocked"],
    event: "block-resolved",
    to: "ready",
  }),
  // A.2#24 — any active | cleanup failure during teardown | recorded | blocked (cleanup-failed cause)
  row({
    ref: "A.2#24",
    from: ISSUE_ACTIVE_STATES,
    event: "cleanup-failed",
    guard: { name: "failure-recorded", check: (e) => attested(e.recorded) },
    to: "blocked",
    note: "The cleanup-failed cause rides the event envelope's cause field (janitor + escalation are daemon behavior).",
  }),
];

export const issueMachine: MachineDef<IssueState, IssueEvent> = {
  name: "issue (A.2)",
  states: ISSUE_STATES,
  terminalStates: ISSUE_TERMINAL_STATES,
  rows: issueRows,
};

export const ISSUE_CREATION_EVENTS: readonly string[] = ["issue-created"];
