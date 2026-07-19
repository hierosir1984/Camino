/**
 * Mission state machine — Appendix A §A.1 (integration-branch route) and
 * §A.1b (quick-task route), transcribed row by row. Row refs anchor the
 * consistency audit (docs/design/26-appendix-a-audit.md): "A.1#n" numbers
 * the A.1 table rows top to bottom; letter suffixes (#3a/#3b) mark one
 * appendix row encoded as guard-split code rows; "A.1b#n" likewise. A.1b
 * inherits the A.1 rows its preamble lists — those are the same row objects
 * in both tables, so "with the same guards" holds by construction.
 *
 * Guard inputs ride the event payload as attested facts (see machine.ts).
 * Fields marked "recorded context" are filled by the daemon recorder from
 * the derived view, never by the caller — see MISSION_CONTEXT_ENRICHMENT.
 */
import type { EnrichmentSpec, MachineDef, TransitionRow } from "./machine.js";
import { attested, nonEmptyString, stringArray } from "./machine.js";

export const MISSION_ACTIVE_STATES = [
  "queued",
  "draft",
  "planned",
  "approved",
  "executing",
  "awaiting-merge-approval",
  "merging",
  "paused-external",
  "paused-urgent",
  "paused-manual",
  "escalated",
  "blocked",
] as const;

export const MISSION_TERMINAL_STATES = [
  "complete",
  "complete-with-residue",
  "abandoned",
  "re-routed", // A.1b only
] as const;

export type MissionState =
  (typeof MISSION_ACTIVE_STATES)[number] | (typeof MISSION_TERMINAL_STATES)[number];

export const MISSION_STATES = [...MISSION_ACTIVE_STATES, ...MISSION_TERMINAL_STATES] as const;

export type MissionRoute = "integration" | "quick-task";

/**
 * Serialization (Appendix A preamble): at most one mission per repo occupies
 * an execution-bearing state; additional missions wait in `queued`.
 *
 * The appendix (as amended per AMEND-2, approved 2026-07-19) defines the span
 * as "approved through merging, including interrupt states entered from that
 * span; a manually paused mission holds the slot iff it held it when paused" —
 * execution-bearing is a function of (state, pausedFrom), which this predicate
 * implements.
 */
const EXECUTION_BEARING_BASE: readonly MissionState[] = [
  "approved",
  "executing",
  "awaiting-merge-approval",
  "merging",
  "paused-external",
  "paused-urgent",
  "escalated",
  "blocked",
];

export function isExecutionBearing(state: MissionState, pausedFrom?: MissionState): boolean {
  if (state === "paused-manual") {
    return pausedFrom !== undefined && EXECUTION_BEARING_BASE.includes(pausedFrom);
  }
  return EXECUTION_BEARING_BASE.includes(state);
}

export type MissionEvent =
  // A.1#1 — mission created (PRD intake, or quick task re-routed per A.1b)
  | { type: "mission-created"; source: "prd-intake" | "re-routed"; reroutedFrom?: string }
  // A.1b#1 — quick task intake
  | { type: "quick-task-intake" }
  // A.1#2 — plan constructed + falsification review attached
  | { type: "plan-constructed"; reviewAttached: boolean; checklistRendered: boolean }
  // A.1b#2 — contract + mini falsification review attached
  | {
      type: "contract-attached";
      miniReviewAttached: boolean;
      observabilityAdjudicated: boolean;
    }
  // A.1#3 / A.1b#3 — David approves plan (+ checklist); actor is reserved (envelope-copied)
  | {
      type: "plan-approved";
      actor?: string;
      checklistApproved?: boolean; // A.1#3 "plan + checklist" (integration route)
      dagAcyclic: boolean;
      executionSlotFree: boolean;
      riskTierLow?: boolean; // A.1b gates
      neutralConcurred?: boolean;
      singleIssue?: boolean;
    }
  // A.1#4 — David rejects / edits
  | { type: "plan-rejected"; actor?: string }
  // A.1#5 — execution slot frees
  | { type: "execution-slot-freed"; fifoHead: boolean }
  // A.1#6 — integration branch + mission PR created
  | {
      type: "integration-branch-created";
      branchCreated: boolean;
      missionPrCreated: boolean;
      onboardingChecksGreen: boolean;
    }
  // A.1b#4 — the single issue executes per A.2 with target = main candidate; no branch, no fold
  | {
      type: "quick-task-execution-started";
      targetIsMainCandidate: boolean;
      noIntegrationBranchNoFold: boolean;
    }
  // A.1#7 — all issues terminal ∧ no stranded requirement ∧ gate green ∧ review pass
  | {
      type: "mission-gate-green";
      allIssuesTerminal: boolean;
      noStrandedRequirement: boolean;
      gateGreen: boolean;
      reviewPass: boolean;
      foldOnBranch: boolean; // A.4#2 (integration route only)
      rollupAndPrPopulated: boolean; // A.4#3
      freshnessHolds: boolean;
      candidateSha: string;
      packetHash: string; // the candidate's packet identity (A.4#4 pair)
    }
  // A.1#8/#9 — mission gate red, or CAM-VAL-06a review fail
  | { type: "mission-gate-red"; repairFitsApprovedScope: boolean }
  // A.1b#5 — quick-task validation green at the main candidate
  | {
      type: "quick-validation-green";
      packetPopulated: boolean;
      rollupAndPrPopulated: boolean; // A.4#3 (both routes)
      contractChecksGreen: boolean; // A.1b preamble: the task's full contract checks…
      repoFastSuiteGreen: boolean; // …plus the repo fast suite, at the exact candidate
      freshnessVsMainHolds: boolean;
      candidateSha: string;
      packetHash: string;
    }
  // A.1b#6 — validation red (failureCount is recorded context)
  | { type: "quick-validation-red"; failureCount?: number }
  // A.1#10 / A.1b#7 — merge approval (binds to candidate SHA + packet hash, A.4#4)
  | {
      type: "mission-merge-approved";
      actor?: string;
      authority: "david" | "tier-2" | "tier-3";
      candidateSha: string;
      packetHash: string;
      currentCandidateSha?: string; // recorded context
      currentPacketHash?: string; // recorded context
    }
  // A.1#11 / A.1b#8 — David rejects with reason
  | { type: "mission-merge-rejected"; actor?: string; reason: string }
  // A.1#12/#13, A.1b#9 — base moved → candidate rebuilt and revalidated
  | { type: "candidate-rebuilt"; green: boolean; newCandidateSha: string; newPacketHash?: string }
  // A.1#14 — ExternalEdit impact on mission scope
  | { type: "external-edit-detected" }
  // A.1#15 — urgent task claims the lane
  | { type: "urgent-preemption" }
  // A.1#16 — David pauses (any active)
  | { type: "mission-paused"; actor?: string; attemptSettled: boolean }
  // A.1#17 — David resumes (resumeTo is recorded context: the state at pause time)
  | { type: "mission-resumed"; actor?: string; resumeTo?: MissionState }
  // A.1#18 — escalation raised requiring David
  | { type: "escalation-raised" }
  // A.1#19 — blocker with no automated path
  | { type: "blocker-hit" }
  // A.1#20 — impact assessment complete / urgent landed + resync
  | { type: "interruption-resolved"; affectedIssuesHandled: boolean }
  // A.1#21 — David answers / obstacle cleared
  | { type: "obstacle-cleared"; actor?: string; affectedIssuesTransitioned: boolean }
  // A.1#22 / A.1b#11 — merge-by-push lands ON MAIN, push confirmed
  | {
      type: "push-confirmed";
      landedOnMain: boolean;
      pushedSha: string;
      descopedRequirements: readonly string[];
      approvedCandidateSha?: string; // recorded context (the bound approval)
    }
  // A.1#23 / A.1b#10 — base moved > retry bound (registry item 1: 2 rebuilds)
  | { type: "rebuilds-exhausted"; rebuildCount: number }
  // A.1#24 — David abandons mission
  | { type: "mission-abandoned"; actor?: string }
  // A.1b#12 — any CAM-MERGE-01 gate found violated (AMEND-5: branch carried where executed)
  | {
      type: "gate-violation-detected";
      workSummaryCarried: boolean;
      branchCarried?: boolean;
      pausedFrom?: MissionState; // recorded context (paused-manual source resolution)
    };

/**
 * Recorded-context contract: fields the daemon recorder must fill from the
 * derived view (never trusting caller-supplied values) before running the
 * transition. Pure declaration; the recorder implements it.
 */
export const MISSION_CONTEXT_ENRICHMENT: Readonly<Record<string, readonly EnrichmentSpec[]>> = {
  "mission-resumed": [{ field: "resumeTo", source: "paused-from" }],
  "mission-merge-approved": [
    { field: "currentCandidateSha", source: "current-candidate-sha" },
    { field: "currentPacketHash", source: "current-packet-hash" },
  ],
  "push-confirmed": [{ field: "approvedCandidateSha", source: "approved-candidate-sha" }],
  "quick-validation-red": [{ field: "failureCount", source: "next-mission-failure-count" }],
  "gate-violation-detected": [{ field: "pausedFrom", source: "paused-from" }],
};

type MissionRow = TransitionRow<MissionState, MissionEvent>;

function row<T extends MissionEvent["type"]>(def: {
  ref: string;
  from: readonly MissionState[] | null;
  event: T;
  guard?: {
    name: string;
    check: (event: Extract<MissionEvent, { type: T }>) => boolean;
  };
  to:
    | MissionState
    | {
        name: string;
        derive: (event: Extract<MissionEvent, { type: T }>) => MissionState | undefined;
      };
  note?: string;
}): MissionRow {
  return {
    ref: def.ref,
    from: def.from,
    eventType: def.event,
    guard: def.guard as MissionRow["guard"],
    to: def.to as MissionRow["to"],
    note: def.note,
  };
}

// ---- Rows shared verbatim between A.1 and A.1b (the A.1b preamble's inheritance list) ----

// A.1#4 — planned | David rejects / edits | — | draft
const planRejected = row({
  ref: "A.1#4",
  from: ["planned"],
  event: "plan-rejected",
  guard: { name: "actor-is-david", check: (e) => e.actor === "david" },
  to: "draft",
});

// A.1#5 — queued | execution slot frees | FIFO | approved
const slotFreed = row({
  ref: "A.1#5",
  from: ["queued"],
  event: "execution-slot-freed",
  guard: { name: "fifo-order", check: (e) => attested(e.fifoHead) },
  to: "approved",
  note: "FIFO ordering across queued missions is the scheduler's (WP-103); the machine records the attested head-of-queue fact.",
});

// A.1#16 — any active | David pauses | running attempt checkpoints or completes | paused-manual
const manualPause = row({
  ref: "A.1#16",
  from: MISSION_ACTIVE_STATES,
  event: "mission-paused",
  guard: {
    name: "david-pauses-with-attempt-settled",
    check: (e) => e.actor === "david" && attested(e.attemptSettled),
  },
  to: "paused-manual",
  note: "Includes paused-manual itself (any active); the view keeps the first pausedFrom so a re-pause cannot lose the resume target.",
});

// A.1#17 — paused-manual | David resumes | — | prior state (recorded)
const manualResume = row({
  ref: "A.1#17",
  from: ["paused-manual"],
  event: "mission-resumed",
  guard: { name: "actor-is-david", check: (e) => e.actor === "david" },
  to: {
    name: "recorded-prior-state",
    derive: (e) =>
      e.resumeTo !== undefined &&
      MISSION_ACTIVE_STATES.includes(e.resumeTo as (typeof MISSION_ACTIVE_STATES)[number]) &&
      e.resumeTo !== "paused-manual"
        ? e.resumeTo
        : undefined,
  },
  note: "resumeTo is recorded context (the state held when pausing), recorder-enriched from the view; a missing or non-active value rejects.",
});

// A.1#18 — executing | escalation raised requiring David | — | escalated
const escalationRaised = row({
  ref: "A.1#18",
  from: ["executing"],
  event: "escalation-raised",
  to: "escalated",
});

// A.1#19 — executing | blocker with no automated path | — | blocked
const blockerHit = row({
  ref: "A.1#19",
  from: ["executing"],
  event: "blocker-hit",
  to: "blocked",
});

// A.1#21 — escalated / blocked | David answers / obstacle cleared | affected issues transitioned per answer | executing
// The event column is disjunctive and maps onto the two source states (as in
// A.2#21 vs A.2#23): an escalation is answered BY DAVID; a blocker clears by
// the obstacle going away, whoever observes it. Guard-split accordingly.
const obstacleClearedEscalated = row({
  ref: "A.1#21a",
  from: ["escalated"],
  event: "obstacle-cleared",
  guard: {
    name: "david-answers-and-issues-transitioned",
    check: (e) => e.actor === "david" && attested(e.affectedIssuesTransitioned),
  },
  to: "executing",
});
const obstacleClearedBlocked = row({
  ref: "A.1#21b",
  from: ["blocked"],
  event: "obstacle-cleared",
  guard: {
    name: "affected-issues-transitioned",
    check: (e) => attested(e.affectedIssuesTransitioned),
  },
  to: "executing",
});

// A.1#24 — any active | David abandons mission | intent ledger untouched | abandoned
const abandoned = row({
  ref: "A.1#24",
  from: MISSION_ACTIVE_STATES,
  event: "mission-abandoned",
  guard: { name: "actor-is-david", check: (e) => e.actor === "david" },
  to: "abandoned",
  note: "The guard 'intent ledger untouched' (CAM-CANON-01) is structural — core has no ledger surface to touch — not a runtime check.",
});

// ---- A.1 integration-route rows ----

const integrationRows: readonly MissionRow[] = [
  // A.1#1 — — | mission created (PRD intake, or quick task re-routed per A.1b) | — | draft
  row({
    ref: "A.1#1",
    from: null,
    event: "mission-created",
    guard: {
      name: "re-route-carries-reference",
      check: (e) =>
        e.source === "prd-intake" || (e.source === "re-routed" && nonEmptyString(e.reroutedFrom)),
    },
    to: "draft",
    note: "A re-routed successor must reference the terminal quick-task record (A.1b#12 'referencing this record').",
  }),
  // A.1#2 — draft | plan constructed + falsification review attached | checklist rendered | planned
  row({
    ref: "A.1#2",
    from: ["draft"],
    event: "plan-constructed",
    guard: {
      name: "review-attached-and-checklist-rendered",
      check: (e) => attested(e.reviewAttached) && attested(e.checklistRendered),
    },
    to: "planned",
  }),
  // A.1#3 — planned | David approves plan + checklist | DAG acyclic; slot free, else queued | approved
  row({
    ref: "A.1#3a",
    from: ["planned"],
    event: "plan-approved",
    guard: {
      name: "david-approves-plan-and-checklist-slot-free",
      check: (e) =>
        e.actor === "david" &&
        attested(e.checklistApproved) &&
        attested(e.dagAcyclic) &&
        attested(e.executionSlotFree),
    },
    to: "approved",
  }),
  row({
    ref: "A.1#3b",
    from: ["planned"],
    event: "plan-approved",
    guard: {
      name: "david-approves-plan-and-checklist-slot-taken",
      check: (e) =>
        e.actor === "david" &&
        attested(e.checklistApproved) &&
        attested(e.dagAcyclic) &&
        e.executionSlotFree === false,
    },
    to: "queued",
    note: "One appendix row, guard-split: 'execution slot free, else queued'. 'Plan + checklist' holds on BOTH splits; a cyclic DAG matches neither — rejected.",
  }),
  planRejected,
  slotFreed,
  // A.1#6 — approved | integration branch + mission PR created | onboarding checks green | executing
  row({
    ref: "A.1#6",
    from: ["approved"],
    event: "integration-branch-created",
    guard: {
      name: "branch-and-pr-created-onboarding-green",
      check: (e) =>
        attested(e.branchCreated) &&
        attested(e.missionPrCreated) &&
        attested(e.onboardingChecksGreen),
    },
    to: "executing",
  }),
  // A.1#7 — executing | all issues terminal ∧ … ∧ review pass | A.4 ordering; freshness | awaiting-merge-approval
  row({
    ref: "A.1#7",
    from: ["executing"],
    event: "mission-gate-green",
    guard: {
      name: "gate-conjunction-and-a4-ordering",
      check: (e) =>
        attested(e.allIssuesTerminal) &&
        attested(e.noStrandedRequirement) &&
        attested(e.gateGreen) &&
        attested(e.reviewPass) &&
        attested(e.foldOnBranch) &&
        attested(e.rollupAndPrPopulated) &&
        attested(e.freshnessHolds) &&
        nonEmptyString(e.candidateSha) &&
        nonEmptyString(e.packetHash),
    },
    to: "awaiting-merge-approval",
    note: "Candidate identity is the (SHA, packet hash) pair — recorded here, bound by A.1#10 (A.4#4).",
  }),
  // A.1#8 — executing | mission gate red, or CAM-VAL-06a review fail | repair fits approved scope | executing
  row({
    ref: "A.1#8",
    from: ["executing"],
    event: "mission-gate-red",
    guard: {
      name: "repair-fits-approved-scope",
      check: (e) => attested(e.repairFitsApprovedScope),
    },
    to: "executing",
    note: "Repair issues are created ready under mission scope — issue machine creation row A.2#1c.",
  }),
  // A.1#9 — executing | mission gate red, repair exceeds approved scope | — | escalated
  row({
    ref: "A.1#9",
    from: ["executing"],
    event: "mission-gate-red",
    guard: {
      name: "repair-exceeds-approved-scope",
      check: (e) => e.repairFitsApprovedScope === false,
    },
    to: "escalated",
  }),
  // A.1#10 — awaiting-merge-approval | David approves mission merge, or tier-2 | — | merging
  row({
    ref: "A.1#10",
    from: ["awaiting-merge-approval"],
    event: "mission-merge-approved",
    guard: {
      name: "integration-authority-and-pair-binding",
      check: (e) =>
        (e.authority === "david" ? e.actor === "david" : e.authority === "tier-2") &&
        nonEmptyString(e.candidateSha) &&
        nonEmptyString(e.packetHash) &&
        e.candidateSha === e.currentCandidateSha &&
        e.packetHash === e.currentPacketHash,
    },
    to: "merging",
    note: "Approval binds to the recorded (candidate SHA, packet hash) pair — A.4#4; a stale SHA or a hash that is not the candidate's recorded packet rejects. David-authority approvals must carry David as the envelope actor.",
  }),
  // A.1#11 — awaiting-merge-approval | David rejects with reason | — | executing
  row({
    ref: "A.1#11",
    from: ["awaiting-merge-approval"],
    event: "mission-merge-rejected",
    guard: {
      name: "david-rejects-with-reason",
      check: (e) => e.actor === "david" && nonEmptyString(e.reason),
    },
    to: "executing",
  }),
  // A.1#12 — merging | base moved → candidate rebuilt and revalidated | new candidate green | awaiting-merge-approval
  row({
    ref: "A.1#12",
    from: ["merging"],
    event: "candidate-rebuilt",
    guard: {
      name: "new-candidate-green",
      check: (e) =>
        attested(e.green) && nonEmptyString(e.newCandidateSha) && nonEmptyString(e.newPacketHash),
    },
    to: "awaiting-merge-approval",
    note: "A new candidate requires a new approval — the view records the new (SHA, packet hash) pair and clears the approval binding (A.4#4).",
  }),
  // A.1#13 — merging | rebuilt candidate red | — | executing
  row({
    ref: "A.1#13",
    from: ["merging"],
    event: "candidate-rebuilt",
    guard: { name: "rebuilt-candidate-red", check: (e) => e.green === false },
    to: "executing",
  }),
  // A.1#14 — executing | ExternalEdit impact on mission scope | — | paused-external
  row({
    ref: "A.1#14",
    from: ["executing"],
    event: "external-edit-detected",
    to: "paused-external",
  }),
  // A.1#15 — executing | urgent task claims the lane | — | paused-urgent
  row({
    ref: "A.1#15",
    from: ["executing"],
    event: "urgent-preemption",
    to: "paused-urgent",
  }),
  manualPause,
  manualResume,
  escalationRaised,
  blockerHit,
  // A.1#20 — paused-external / paused-urgent | impact assessed / urgent landed + resync | issues revalidated or re-queued | executing
  row({
    ref: "A.1#20",
    from: ["paused-external", "paused-urgent"],
    event: "interruption-resolved",
    guard: {
      name: "affected-issues-handled",
      check: (e) => attested(e.affectedIssuesHandled),
    },
    to: "executing",
  }),
  obstacleClearedEscalated,
  obstacleClearedBlocked,
  // A.1#22 — merging | push confirmed | pushed SHA ≡ approved candidate SHA | complete / complete-with-residue
  row({
    ref: "A.1#22a",
    from: ["merging"],
    event: "push-confirmed",
    guard: {
      name: "sha-bound-no-residue",
      check: (e) =>
        attested(e.landedOnMain) &&
        nonEmptyString(e.pushedSha) &&
        e.pushedSha === e.approvedCandidateSha &&
        stringArray(e.descopedRequirements) &&
        e.descopedRequirements.length === 0,
    },
    to: "complete",
  }),
  row({
    ref: "A.1#22b",
    from: ["merging"],
    event: "push-confirmed",
    guard: {
      name: "sha-bound-with-residue",
      check: (e) =>
        attested(e.landedOnMain) &&
        nonEmptyString(e.pushedSha) &&
        e.pushedSha === e.approvedCandidateSha &&
        stringArray(e.descopedRequirements) &&
        e.descopedRequirements.length > 0,
    },
    to: "complete-with-residue",
    note: "One appendix row, guard-split on the descoped-requirements list (which must be a real string array); approvedCandidateSha is recorded context from the bound approval.",
  }),
  // A.1#23 — merging | base moved > retry bound | 2 rebuilds exhausted | escalated
  row({
    ref: "A.1#23",
    from: ["merging"],
    event: "rebuilds-exhausted",
    guard: {
      name: "two-rebuilds-exhausted",
      check: (e) => Number.isInteger(e.rebuildCount) && e.rebuildCount >= 2,
    },
    to: "escalated",
    note: "Registry item 1: 2 automatic rebuild-and-revalidate cycles per candidate, then escalate.",
  }),
  abandoned,
];

// ---- A.1b quick-task rows (inherited rows are the same objects as A.1's) ----

const quickTaskRows: readonly MissionRow[] = [
  // A.1b#1 — — | quick task intake | — | draft
  row({
    ref: "A.1b#1",
    from: null,
    event: "quick-task-intake",
    to: "draft",
  }),
  // A.1b#2 — draft | contract + mini falsification review attached | observability adjudicated per criterion | planned
  row({
    ref: "A.1b#2",
    from: ["draft"],
    event: "contract-attached",
    guard: {
      name: "mini-review-and-observability-adjudicated",
      check: (e) => attested(e.miniReviewAttached) && attested(e.observabilityAdjudicated),
    },
    to: "planned",
  }),
  // A.1b#3 — planned | David approves | risk low; neutral concurred; single issue; slot free, else queued | approved
  row({
    ref: "A.1b#3a",
    from: ["planned"],
    event: "plan-approved",
    guard: {
      name: "david-approves-quick-gates-slot-free",
      check: (e) =>
        e.actor === "david" &&
        attested(e.riskTierLow) &&
        attested(e.neutralConcurred) &&
        attested(e.singleIssue) &&
        attested(e.executionSlotFree),
    },
    to: "approved",
  }),
  row({
    ref: "A.1b#3b",
    from: ["planned"],
    event: "plan-approved",
    guard: {
      name: "david-approves-quick-gates-slot-taken",
      check: (e) =>
        e.actor === "david" &&
        attested(e.riskTierLow) &&
        attested(e.neutralConcurred) &&
        attested(e.singleIssue) &&
        e.executionSlotFree === false,
    },
    to: "queued",
    note: "One appendix row, guard-split: 'execution slot free, else queued'. The CAM-MERGE-01 gates must hold for either split.",
  }),
  planRejected, // A.1b←A.1#4 (inherited)
  slotFreed, // A.1b←A.1#5 (inherited)
  // A.1b#4 — approved | the single issue executes per A.2 with target = main candidate | — | executing
  row({
    ref: "A.1b#4",
    from: ["approved"],
    event: "quick-task-execution-started",
    guard: {
      name: "main-candidate-target-no-branch-no-fold",
      check: (e) => attested(e.targetIsMainCandidate) && attested(e.noIntegrationBranchNoFold),
    },
    to: "executing",
  }),
  // A.1b#5 — executing | quick-task validation green at main candidate ∧ packet populated | freshness vs main | awaiting-merge-approval
  row({
    ref: "A.1b#5",
    from: ["executing"],
    event: "quick-validation-green",
    guard: {
      name: "quick-validation-conjunction",
      check: (e) =>
        attested(e.packetPopulated) &&
        attested(e.rollupAndPrPopulated) &&
        attested(e.contractChecksGreen) &&
        attested(e.repoFastSuiteGreen) &&
        attested(e.freshnessVsMainHolds) &&
        nonEmptyString(e.candidateSha) &&
        nonEmptyString(e.packetHash),
    },
    to: "awaiting-merge-approval",
    note: "rollupAndPrPopulated encodes A.4#3 (both routes); contract checks + repo fast suite encode the A.1b preamble's quick-task validation scope; candidate identity is the (SHA, packet hash) pair.",
  }),
  // A.1b#6 — executing | validation red | retry per A.2 | executing; 4 failures → escalated
  row({
    ref: "A.1b#6a",
    from: ["executing"],
    event: "quick-validation-red",
    guard: {
      name: "retriable-failure-count",
      check: (e) =>
        Number.isInteger(e.failureCount) &&
        (e.failureCount as number) >= 1 &&
        (e.failureCount as number) < 4,
    },
    to: "executing",
    note: "failureCount is recorded context (a positive integer, view-derived); family switch after 2 failures is routing advice — see retryPolicy.",
  }),
  row({
    ref: "A.1b#6b",
    from: ["executing"],
    event: "quick-validation-red",
    guard: {
      name: "failure-count-exhausted",
      check: (e) => Number.isInteger(e.failureCount) && (e.failureCount as number) >= 4,
    },
    to: "escalated",
  }),
  // A.1b#7 — awaiting-merge-approval | David approves (or tier-3); approval binds to candidate SHA | — | merging
  row({
    ref: "A.1b#7",
    from: ["awaiting-merge-approval"],
    event: "mission-merge-approved",
    guard: {
      name: "quick-authority-and-pair-binding",
      check: (e) =>
        (e.authority === "david" ? e.actor === "david" : e.authority === "tier-3") &&
        nonEmptyString(e.candidateSha) &&
        nonEmptyString(e.packetHash) &&
        e.candidateSha === e.currentCandidateSha &&
        e.packetHash === e.currentPacketHash,
    },
    to: "merging",
    note: "Landing authority per the A.1b preamble: David or tier-3 only; (SHA, packet hash) pair binding per A.4#4 (both routes).",
  }),
  // A.1b#8 — awaiting-merge-approval | David rejects with reason | — | executing (repair attempt)
  row({
    ref: "A.1b#8",
    from: ["awaiting-merge-approval"],
    event: "mission-merge-rejected",
    guard: {
      name: "david-rejects-with-reason",
      check: (e) => e.actor === "david" && nonEmptyString(e.reason),
    },
    to: "executing",
  }),
  // A.1b#9 — merging | base moved → rebuild + revalidate | green | awaiting-merge-approval (new approval required)
  row({
    ref: "A.1b#9",
    from: ["merging"],
    event: "candidate-rebuilt",
    guard: {
      name: "new-candidate-green",
      check: (e) =>
        attested(e.green) && nonEmptyString(e.newCandidateSha) && nonEmptyString(e.newPacketHash),
    },
    to: "awaiting-merge-approval",
  }),
  // A.1b#10 — merging | rebuilds exhausted (2) | — | escalated
  row({
    ref: "A.1b#10",
    from: ["merging"],
    event: "rebuilds-exhausted",
    guard: {
      name: "two-rebuilds-exhausted",
      check: (e) => Number.isInteger(e.rebuildCount) && e.rebuildCount >= 2,
    },
    to: "escalated",
  }),
  // A.1b#11 — merging | push confirmed | pushed SHA ≡ approved candidate SHA | complete
  row({
    ref: "A.1b#11",
    from: ["merging"],
    event: "push-confirmed",
    guard: {
      name: "sha-bound-quick-complete",
      check: (e) =>
        attested(e.landedOnMain) &&
        nonEmptyString(e.pushedSha) &&
        e.pushedSha === e.approvedCandidateSha &&
        stringArray(e.descopedRequirements) &&
        e.descopedRequirements.length === 0,
    },
    to: "complete",
    note: "A.1b has no residue terminal; a non-empty (or malformed) descoped list rejects rather than landing silently.",
  }),
  // A.1b#13 (AMEND-3, approved 2026-07-19) — merging | rebuilt candidate red | — | executing
  row({
    ref: "A.1b#13",
    from: ["merging"],
    event: "candidate-rebuilt",
    guard: { name: "rebuilt-candidate-red", check: (e) => e.green === false },
    to: "executing",
    note: "Mirrors A.1#13: a red rebuild inside the retry bound returns to executing for repair.",
  }),
  manualPause, // A.1b←A.1#16 (inherited)
  manualResume, // A.1b←A.1#17 (inherited)
  escalationRaised, // A.1b←A.1#18 (inherited, per the preamble's escalated/blocked clause)
  blockerHit, // A.1b←A.1#19 (inherited)
  obstacleClearedEscalated, // A.1b←A.1#21a (inherited)
  obstacleClearedBlocked, // A.1b←A.1#21b (inherited)
  // A.1b#12 — any active | gate violated | work summary carried; branch carried where the
  // task had entered execution (AMEND-5, approved 2026-07-19) | re-routed
  row({
    ref: "A.1b#12a",
    from: ["queued", "draft", "planned", "approved"],
    event: "gate-violation-detected",
    guard: {
      name: "work-summary-carried-pre-execution",
      check: (e) => attested(e.workSummaryCarried),
    },
    to: "re-routed",
    note: "Pre-execution sources have no branch to carry; only the work summary is required.",
  }),
  row({
    ref: "A.1b#12b",
    from: [
      "executing",
      "awaiting-merge-approval",
      "merging",
      "paused-external",
      "paused-urgent",
      "escalated",
      "blocked",
    ],
    event: "gate-violation-detected",
    guard: {
      name: "work-summary-and-branch-carried",
      check: (e) => attested(e.workSummaryCarried) && attested(e.branchCarried),
    },
    to: "re-routed",
    note: "Execution-entered sources must carry the branch. Terminal; a successor A.1 mission is created referencing this record (mission-created with source re-routed) after this task ends, preserving serialization.",
  }),
  row({
    ref: "A.1b#12c",
    from: ["paused-manual"],
    event: "gate-violation-detected",
    guard: {
      name: "work-summary-and-branch-if-paused-from-execution",
      check: (e) =>
        attested(e.workSummaryCarried) &&
        typeof e.pausedFrom === "string" &&
        MISSION_ACTIVE_STATES.includes(e.pausedFrom as (typeof MISSION_ACTIVE_STATES)[number]) &&
        (["queued", "draft", "planned", "approved"].includes(e.pausedFrom) ||
          attested(e.branchCarried)),
    },
    to: "re-routed",
    note: "paused-manual resolves by the RECORDED paused-from state (enriched): a task paused before execution needs no branch; otherwise the branch attestation is required. Absent or unrecognized recorded context REJECTS outright — an honest log always carries pausedFrom in paused-manual (scoped verify pass, finding 1).",
  }),
  abandoned, // A.1b←A.1#24 (inherited)
];

export const missionIntegrationMachine: MachineDef<MissionState, MissionEvent> = {
  name: "mission (A.1 integration route)",
  states: MISSION_STATES,
  terminalStates: MISSION_TERMINAL_STATES,
  rows: integrationRows,
};

export const missionQuickTaskMachine: MachineDef<MissionState, MissionEvent> = {
  name: "mission (A.1b quick-task route)",
  states: MISSION_STATES,
  terminalStates: MISSION_TERMINAL_STATES,
  rows: quickTaskRows,
};

export function missionMachineFor(route: MissionRoute): MachineDef<MissionState, MissionEvent> {
  return route === "integration" ? missionIntegrationMachine : missionQuickTaskMachine;
}

/** The creation event that starts each route (route is derived from it on replay). */
export const MISSION_CREATION_EVENTS: Readonly<Record<string, MissionRoute>> = {
  "mission-created": "integration",
  "quick-task-intake": "quick-task",
};
