/**
 * Executable transition vectors — the test data behind the WP-101
 * exhaustiveness criterion (CAM-STATE-05): every legal Appendix A row of
 * every machine has at least one vector here, and the row-coverage test
 * (appendix-coverage.test.ts) fails if a row and its vectors ever drift
 * apart in either direction. Illegal vectors document representative
 * refused transitions with their expected rejection code.
 *
 * Guard-split appendix rows (e.g. "slot free, else queued") appear once per
 * split ref, exercising both guard outcomes. Multi-source rows ("any
 * active") are exercised from every listed source state by the coverage
 * test, using the vector's event.
 */
import type { MachineEvent } from "./machine.js";
import type { AttemptEvent, AttemptState } from "./attempt.js";
import type { IssueEvent, IssueState } from "./issue.js";
import type { MissionEvent, MissionState } from "./mission.js";

export interface LegalVector<State extends string, Event extends MachineEvent> {
  /** Row ref this vector exercises (must exist in the machine). */
  readonly ref: string;
  readonly from: State | null;
  readonly event: Event;
  readonly to: State;
}

export interface IllegalVector<State extends string, Event extends MachineEvent> {
  readonly name: string;
  readonly from: State | null;
  readonly event: Event;
  readonly expect: "illegal-transition" | "guard-rejected";
}

// ---------------------------------------------------------------- mission A.1

export const MISSION_INTEGRATION_LEGAL: readonly LegalVector<MissionState, MissionEvent>[] = [
  {
    ref: "A.1#1",
    from: null,
    event: { type: "mission-created", source: "prd-intake" },
    to: "draft",
  },
  {
    ref: "A.1#1",
    from: null,
    event: { type: "mission-created", source: "re-routed", reroutedFrom: "mission-q1" },
    to: "draft",
  },
  {
    ref: "A.1#2",
    from: "draft",
    event: { type: "plan-constructed", reviewAttached: true, checklistRendered: true },
    to: "planned",
  },
  {
    ref: "A.1#3a",
    from: "planned",
    event: { type: "plan-approved", actor: "david", dagAcyclic: true, executionSlotFree: true },
    to: "approved",
  },
  {
    ref: "A.1#3b",
    from: "planned",
    event: { type: "plan-approved", actor: "david", dagAcyclic: true, executionSlotFree: false },
    to: "queued",
  },
  { ref: "A.1#4", from: "planned", event: { type: "plan-rejected", actor: "david" }, to: "draft" },
  {
    ref: "A.1#5",
    from: "queued",
    event: { type: "execution-slot-freed", fifoHead: true },
    to: "approved",
  },
  {
    ref: "A.1#6",
    from: "approved",
    event: {
      type: "integration-branch-created",
      branchCreated: true,
      missionPrCreated: true,
      onboardingChecksGreen: true,
    },
    to: "executing",
  },
  {
    ref: "A.1#7",
    from: "executing",
    event: {
      type: "mission-gate-green",
      allIssuesTerminal: true,
      noStrandedRequirement: true,
      gateGreen: true,
      reviewPass: true,
      foldOnBranch: true,
      rollupAndPrPopulated: true,
      freshnessHolds: true,
      candidateSha: "cand-1",
      packetHash: "packet-1",
    },
    to: "awaiting-merge-approval",
  },
  {
    ref: "A.1#8",
    from: "executing",
    event: { type: "mission-gate-red", repairFitsApprovedScope: true },
    to: "executing",
  },
  {
    ref: "A.1#9",
    from: "executing",
    event: { type: "mission-gate-red", repairFitsApprovedScope: false },
    to: "escalated",
  },
  {
    ref: "A.1#10",
    from: "awaiting-merge-approval",
    event: {
      type: "mission-merge-approved",
      actor: "david",
      authority: "david",
      candidateSha: "cand-1",
      packetHash: "packet-1",
      currentCandidateSha: "cand-1",
      currentPacketHash: "packet-1",
    },
    to: "merging",
  },
  {
    ref: "A.1#10",
    from: "awaiting-merge-approval",
    event: {
      type: "mission-merge-approved",
      authority: "tier-2",
      candidateSha: "cand-1",
      packetHash: "packet-1",
      currentCandidateSha: "cand-1",
      currentPacketHash: "packet-1",
    },
    to: "merging",
  },
  {
    ref: "A.1#11",
    from: "awaiting-merge-approval",
    event: {
      type: "mission-merge-rejected",
      actor: "david",
      reason: "rollup incomplete for CAM-VAL-06a",
    },
    to: "executing",
  },
  {
    ref: "A.1#12",
    from: "merging",
    event: {
      type: "candidate-rebuilt",
      green: true,
      newCandidateSha: "cand-2",
      newPacketHash: "packet-2",
    },
    to: "awaiting-merge-approval",
  },
  {
    ref: "A.1#13",
    from: "merging",
    event: { type: "candidate-rebuilt", green: false, newCandidateSha: "cand-2" },
    to: "executing",
  },
  {
    ref: "A.1#14",
    from: "executing",
    event: { type: "external-edit-detected" },
    to: "paused-external",
  },
  { ref: "A.1#15", from: "executing", event: { type: "urgent-preemption" }, to: "paused-urgent" },
  {
    ref: "A.1#16",
    from: "executing",
    event: { type: "mission-paused", actor: "david", attemptSettled: true },
    to: "paused-manual",
  },
  {
    ref: "A.1#17",
    from: "paused-manual",
    event: { type: "mission-resumed", actor: "david", resumeTo: "executing" },
    to: "executing",
  },
  {
    ref: "A.1#17",
    from: "paused-manual",
    event: { type: "mission-resumed", actor: "david", resumeTo: "draft" },
    to: "draft",
  },
  { ref: "A.1#18", from: "executing", event: { type: "escalation-raised" }, to: "escalated" },
  { ref: "A.1#19", from: "executing", event: { type: "blocker-hit" }, to: "blocked" },
  {
    ref: "A.1#20",
    from: "paused-external",
    event: { type: "interruption-resolved", affectedIssuesHandled: true },
    to: "executing",
  },
  {
    ref: "A.1#20",
    from: "paused-urgent",
    event: { type: "interruption-resolved", affectedIssuesHandled: true },
    to: "executing",
  },
  {
    ref: "A.1#21a",
    from: "escalated",
    event: { type: "obstacle-cleared", actor: "david", affectedIssuesTransitioned: true },
    to: "executing",
  },
  {
    ref: "A.1#21b",
    from: "blocked",
    event: { type: "obstacle-cleared", affectedIssuesTransitioned: true },
    to: "executing",
  },
  {
    ref: "A.1#22a",
    from: "merging",
    event: {
      type: "push-confirmed",
      landedOnMain: true,
      pushedSha: "cand-1",
      approvedCandidateSha: "cand-1",
      descopedRequirements: [],
    },
    to: "complete",
  },
  {
    ref: "A.1#22b",
    from: "merging",
    event: {
      type: "push-confirmed",
      landedOnMain: true,
      pushedSha: "cand-1",
      approvedCandidateSha: "cand-1",
      descopedRequirements: ["CAM-GUI-04"],
    },
    to: "complete-with-residue",
  },
  {
    ref: "A.1#23",
    from: "merging",
    event: { type: "rebuilds-exhausted", rebuildCount: 2 },
    to: "escalated",
  },
  {
    ref: "A.1#24",
    from: "executing",
    event: { type: "mission-abandoned", actor: "david" },
    to: "abandoned",
  },
];

export const MISSION_INTEGRATION_ILLEGAL: readonly IllegalVector<MissionState, MissionEvent>[] = [
  {
    name: "creation of an already-created mission is not a machine row (recorder rejects earlier); creation from a live state is illegal",
    from: "draft",
    event: { type: "mission-created", source: "prd-intake" },
    expect: "illegal-transition",
  },
  {
    name: "skip approval: integration branch from draft",
    from: "draft",
    event: {
      type: "integration-branch-created",
      branchCreated: true,
      missionPrCreated: true,
      onboardingChecksGreen: true,
    },
    expect: "illegal-transition",
  },
  {
    name: "terminal states are absorbing: pause after complete",
    from: "complete",
    event: { type: "mission-paused", attemptSettled: true },
    expect: "illegal-transition",
  },
  {
    name: "terminal states are absorbing: approve after abandonment",
    from: "abandoned",
    event: { type: "plan-approved", dagAcyclic: true, executionSlotFree: true },
    expect: "illegal-transition",
  },
  {
    name: "push confirmation outside merging",
    from: "executing",
    event: {
      type: "push-confirmed",
      landedOnMain: true,
      pushedSha: "cand-1",
      approvedCandidateSha: "cand-1",
      descopedRequirements: [],
    },
    expect: "illegal-transition",
  },
  {
    name: "quick-task re-route row does not exist on the integration route",
    from: "executing",
    event: { type: "gate-violation-detected", workSummaryCarried: true, branchCarried: true },
    expect: "illegal-transition",
  },
  {
    name: "quick-task creation event on the integration machine",
    from: null,
    event: { type: "quick-task-intake" },
    expect: "illegal-transition",
  },
  {
    name: "tier-3 autonomy cannot land an integration mission (A.1#10 authority)",
    from: "awaiting-merge-approval",
    event: {
      type: "mission-merge-approved",
      authority: "tier-3",
      candidateSha: "cand-1",
      packetHash: "packet-1",
      currentCandidateSha: "cand-1",
      currentPacketHash: "packet-1",
    },
    expect: "guard-rejected",
  },
  {
    name: "david-authority approval whose envelope actor is not David (review r1 finding 7)",
    from: "awaiting-merge-approval",
    event: {
      type: "mission-merge-approved",
      actor: "mallory",
      authority: "david",
      candidateSha: "cand-1",
      packetHash: "packet-1",
      currentCandidateSha: "cand-1",
      currentPacketHash: "packet-1",
    },
    expect: "guard-rejected",
  },
  {
    name: "approval of a stale candidate SHA (A.4#4 binding)",
    from: "awaiting-merge-approval",
    event: {
      type: "mission-merge-approved",
      actor: "david",
      authority: "david",
      candidateSha: "cand-1",
      packetHash: "packet-1",
      currentCandidateSha: "cand-2",
      currentPacketHash: "packet-1",
    },
    expect: "guard-rejected",
  },
  {
    name: "approval whose packet hash is not the candidate's recorded packet (A.4#4 pair)",
    from: "awaiting-merge-approval",
    event: {
      type: "mission-merge-approved",
      actor: "david",
      authority: "david",
      candidateSha: "cand-1",
      packetHash: "not-the-packet",
      currentCandidateSha: "cand-1",
      currentPacketHash: "packet-1",
    },
    expect: "guard-rejected",
  },
  {
    name: "push confirmation with a SHA that is not the approved candidate",
    from: "merging",
    event: {
      type: "push-confirmed",
      landedOnMain: true,
      pushedSha: "other-sha",
      approvedCandidateSha: "cand-1",
      descopedRequirements: [],
    },
    expect: "guard-rejected",
  },
  {
    name: "push confirmation with no recorded approval binding",
    from: "merging",
    event: {
      type: "push-confirmed",
      landedOnMain: true,
      pushedSha: "cand-1",
      descopedRequirements: [],
    },
    expect: "guard-rejected",
  },
  {
    name: "plan approval with a cyclic dependency DAG",
    from: "planned",
    event: { type: "plan-approved", actor: "david", dagAcyclic: false, executionSlotFree: true },
    expect: "guard-rejected",
  },
  {
    name: "plan approval by a non-David actor (the appendix row is 'David approves')",
    from: "planned",
    event: { type: "plan-approved", actor: "mallory", dagAcyclic: true, executionSlotFree: true },
    expect: "guard-rejected",
  },
  {
    name: "re-routed creation without a reference to the terminal quick-task record",
    from: null,
    event: { type: "mission-created", source: "re-routed" },
    expect: "guard-rejected",
  },
  {
    name: "gate-green without the candidate's packet identity",
    from: "executing",
    event: {
      type: "mission-gate-green",
      allIssuesTerminal: true,
      noStrandedRequirement: true,
      gateGreen: true,
      reviewPass: true,
      foldOnBranch: true,
      rollupAndPrPopulated: true,
      freshnessHolds: true,
      candidateSha: "cand-1",
      packetHash: "",
    },
    expect: "guard-rejected",
  },
  {
    name: "push confirmation with a non-array descoped list (review r1 finding 4)",
    from: "merging",
    event: {
      type: "push-confirmed",
      landedOnMain: true,
      pushedSha: "cand-1",
      approvedCandidateSha: "cand-1",
      descopedRequirements: "not-an-array",
    } as unknown as MissionEvent,
    expect: "guard-rejected",
  },
  {
    name: "push confirmation with the descoped list omitted entirely (guard must refuse, not throw)",
    from: "merging",
    event: {
      type: "push-confirmed",
      landedOnMain: true,
      pushedSha: "cand-1",
      approvedCandidateSha: "cand-1",
    } as unknown as MissionEvent,
    expect: "guard-rejected",
  },
  {
    name: "gate-green without the fold on the branch (A.4#2 ordering)",
    from: "executing",
    event: {
      type: "mission-gate-green",
      allIssuesTerminal: true,
      noStrandedRequirement: true,
      gateGreen: true,
      reviewPass: true,
      foldOnBranch: false,
      rollupAndPrPopulated: true,
      freshnessHolds: true,
      candidateSha: "cand-1",
      packetHash: "packet-1",
    },
    expect: "guard-rejected",
  },
  {
    name: "resume to a target that was never an active prior state",
    from: "paused-manual",
    event: { type: "mission-resumed", actor: "david", resumeTo: "complete" },
    expect: "guard-rejected",
  },
  {
    name: "resume without recorded prior state",
    from: "paused-manual",
    event: { type: "mission-resumed", actor: "david" },
    expect: "guard-rejected",
  },
  {
    name: "slot-free activation out of FIFO order",
    from: "queued",
    event: { type: "execution-slot-freed", fifoHead: false },
    expect: "guard-rejected",
  },
  {
    name: "rebuild escalation before the retry bound (registry item 1)",
    from: "merging",
    event: { type: "rebuilds-exhausted", rebuildCount: 1 },
    expect: "guard-rejected",
  },
  {
    name: "manual pause while a running attempt is unsettled",
    from: "executing",
    event: { type: "mission-paused", actor: "david", attemptSettled: false },
    expect: "guard-rejected",
  },
  {
    name: "push confirmation without the landed-on-main attestation (review r3 finding 1)",
    from: "merging",
    event: {
      type: "push-confirmed",
      landedOnMain: false,
      pushedSha: "cand-1",
      approvedCandidateSha: "cand-1",
      descopedRequirements: [],
    },
    expect: "guard-rejected",
  },
  {
    name: "escalation answered by a non-David actor (A.1#21a; review r2 finding 3)",
    from: "escalated",
    event: { type: "obstacle-cleared", actor: "mallory", affectedIssuesTransitioned: true },
    expect: "guard-rejected",
  },
  {
    name: "rebuild-exhaustion count smuggled as a string (coercion; review r2 finding 7)",
    from: "merging",
    event: { type: "rebuilds-exhausted", rebuildCount: "3" } as unknown as MissionEvent,
    expect: "guard-rejected",
  },
];

// --------------------------------------------------------------- mission A.1b

export const MISSION_QUICK_LEGAL: readonly LegalVector<MissionState, MissionEvent>[] = [
  { ref: "A.1b#1", from: null, event: { type: "quick-task-intake" }, to: "draft" },
  {
    ref: "A.1b#2",
    from: "draft",
    event: { type: "contract-attached", miniReviewAttached: true, observabilityAdjudicated: true },
    to: "planned",
  },
  {
    ref: "A.1b#3a",
    from: "planned",
    event: {
      type: "plan-approved",
      actor: "david",
      dagAcyclic: true,
      executionSlotFree: true,
      riskTierLow: true,
      neutralConcurred: true,
      singleIssue: true,
    },
    to: "approved",
  },
  {
    ref: "A.1b#3b",
    from: "planned",
    event: {
      type: "plan-approved",
      actor: "david",
      dagAcyclic: true,
      executionSlotFree: false,
      riskTierLow: true,
      neutralConcurred: true,
      singleIssue: true,
    },
    to: "queued",
  },
  { ref: "A.1#4", from: "planned", event: { type: "plan-rejected", actor: "david" }, to: "draft" },
  {
    ref: "A.1#5",
    from: "queued",
    event: { type: "execution-slot-freed", fifoHead: true },
    to: "approved",
  },
  {
    ref: "A.1b#4",
    from: "approved",
    event: {
      type: "quick-task-execution-started",
      targetIsMainCandidate: true,
      noIntegrationBranchNoFold: true,
    },
    to: "executing",
  },
  {
    ref: "A.1b#5",
    from: "executing",
    event: {
      type: "quick-validation-green",
      packetPopulated: true,
      rollupAndPrPopulated: true,
      contractChecksGreen: true,
      repoFastSuiteGreen: true,
      freshnessVsMainHolds: true,
      candidateSha: "qcand-1",
      packetHash: "qpacket-1",
    },
    to: "awaiting-merge-approval",
  },
  {
    ref: "A.1b#6a",
    from: "executing",
    event: { type: "quick-validation-red", failureCount: 1 },
    to: "executing",
  },
  {
    ref: "A.1b#6b",
    from: "executing",
    event: { type: "quick-validation-red", failureCount: 4 },
    to: "escalated",
  },
  {
    ref: "A.1b#7",
    from: "awaiting-merge-approval",
    event: {
      type: "mission-merge-approved",
      actor: "david",
      authority: "david",
      candidateSha: "qcand-1",
      packetHash: "qpacket-1",
      currentCandidateSha: "qcand-1",
      currentPacketHash: "qpacket-1",
    },
    to: "merging",
  },
  {
    ref: "A.1b#7",
    from: "awaiting-merge-approval",
    event: {
      type: "mission-merge-approved",
      authority: "tier-3",
      candidateSha: "qcand-1",
      packetHash: "qpacket-1",
      currentCandidateSha: "qcand-1",
      currentPacketHash: "qpacket-1",
    },
    to: "merging",
  },
  {
    ref: "A.1b#8",
    from: "awaiting-merge-approval",
    event: { type: "mission-merge-rejected", actor: "david", reason: "packet incomplete" },
    to: "executing",
  },
  {
    ref: "A.1b#9",
    from: "merging",
    event: {
      type: "candidate-rebuilt",
      green: true,
      newCandidateSha: "qcand-2",
      newPacketHash: "qpacket-2",
    },
    to: "awaiting-merge-approval",
  },
  {
    ref: "A.1b#10",
    from: "merging",
    event: { type: "rebuilds-exhausted", rebuildCount: 2 },
    to: "escalated",
  },
  {
    ref: "A.1b#11",
    from: "merging",
    event: {
      type: "push-confirmed",
      landedOnMain: true,
      pushedSha: "qcand-1",
      approvedCandidateSha: "qcand-1",
      descopedRequirements: [],
    },
    to: "complete",
  },
  {
    ref: "A.1#16",
    from: "executing",
    event: { type: "mission-paused", actor: "david", attemptSettled: true },
    to: "paused-manual",
  },
  {
    ref: "A.1#17",
    from: "paused-manual",
    event: { type: "mission-resumed", actor: "david", resumeTo: "executing" },
    to: "executing",
  },
  { ref: "A.1#18", from: "executing", event: { type: "escalation-raised" }, to: "escalated" },
  { ref: "A.1#19", from: "executing", event: { type: "blocker-hit" }, to: "blocked" },
  {
    ref: "A.1#21a",
    from: "escalated",
    event: { type: "obstacle-cleared", actor: "david", affectedIssuesTransitioned: true },
    to: "executing",
  },
  {
    ref: "A.1#21b",
    from: "blocked",
    event: { type: "obstacle-cleared", affectedIssuesTransitioned: true },
    to: "executing",
  },
  {
    ref: "A.1b#12",
    from: "executing",
    event: { type: "gate-violation-detected", workSummaryCarried: true, branchCarried: true },
    to: "re-routed",
  },
  {
    ref: "A.1b#12",
    from: "merging",
    event: { type: "gate-violation-detected", workSummaryCarried: true, branchCarried: true },
    to: "re-routed",
  },
  {
    ref: "A.1#24",
    from: "executing",
    event: { type: "mission-abandoned", actor: "david" },
    to: "abandoned",
  },
];

export const MISSION_QUICK_ILLEGAL: readonly IllegalVector<MissionState, MissionEvent>[] = [
  {
    name: "A.1's plan-constructed row is not inherited (quick tasks attach a contract)",
    from: "draft",
    event: { type: "plan-constructed", reviewAttached: true, checklistRendered: true },
    expect: "illegal-transition",
  },
  {
    name: "paused-external is unreachable on the quick route (not inherited)",
    from: "executing",
    event: { type: "external-edit-detected" },
    expect: "illegal-transition",
  },
  {
    name: "paused-urgent is unreachable on the quick route (the quick task IS the urgent lane)",
    from: "executing",
    event: { type: "urgent-preemption" },
    expect: "illegal-transition",
  },
  {
    name: "integration gate-green row does not apply to quick tasks",
    from: "executing",
    event: {
      type: "mission-gate-green",
      allIssuesTerminal: true,
      noStrandedRequirement: true,
      gateGreen: true,
      reviewPass: true,
      foldOnBranch: true,
      rollupAndPrPopulated: true,
      freshnessHolds: true,
      candidateSha: "qcand-1",
      packetHash: "qpacket-1",
    },
    expect: "illegal-transition",
  },
  {
    name: "tier-2 autonomy never lands a quick task (A.1b#7 authority)",
    from: "awaiting-merge-approval",
    event: {
      type: "mission-merge-approved",
      authority: "tier-2",
      candidateSha: "qcand-1",
      packetHash: "qpacket-1",
      currentCandidateSha: "qcand-1",
      currentPacketHash: "qpacket-1",
    },
    expect: "guard-rejected",
  },
  {
    name: "quick validation green without the mandated contract-checks + fast-suite attestations (A.1b preamble)",
    from: "executing",
    event: {
      type: "quick-validation-green",
      packetPopulated: true,
      rollupAndPrPopulated: true,
      contractChecksGreen: false,
      repoFastSuiteGreen: true,
      freshnessVsMainHolds: true,
      candidateSha: "qcand-1",
      packetHash: "qpacket-1",
    },
    expect: "guard-rejected",
  },
  {
    name: "quick completion with a descoped-requirements residue",
    from: "merging",
    event: {
      type: "push-confirmed",
      landedOnMain: true,
      pushedSha: "qcand-1",
      approvedCandidateSha: "qcand-1",
      descopedRequirements: ["CAM-GUI-04"],
    },
    expect: "guard-rejected",
  },
  {
    name: "quick approval without the CAM-MERGE-01 low-risk gate",
    from: "planned",
    event: {
      type: "plan-approved",
      actor: "david",
      dagAcyclic: true,
      executionSlotFree: true,
      riskTierLow: false,
      neutralConcurred: true,
      singleIssue: true,
    },
    expect: "guard-rejected",
  },
  {
    name: "re-routed is terminal: nothing follows it",
    from: "re-routed",
    event: {
      type: "quick-task-execution-started",
      targetIsMainCandidate: true,
      noIntegrationBranchNoFold: true,
    },
    expect: "illegal-transition",
  },
  {
    name: "PRD-intake creation event on the quick machine",
    from: null,
    event: { type: "mission-created", source: "prd-intake" },
    expect: "illegal-transition",
  },
];

// ------------------------------------------------------------------ issue A.2

export const ISSUE_LEGAL: readonly LegalVector<IssueState, IssueEvent>[] = [
  {
    ref: "A.2#1a",
    from: null,
    event: { type: "issue-created", origin: "plan-approval", unmetDependencies: 0 },
    to: "ready",
  },
  {
    ref: "A.2#1b",
    from: null,
    event: { type: "issue-created", origin: "plan-approval", unmetDependencies: 2 },
    to: "waiting-deps",
  },
  {
    ref: "A.2#1c",
    from: null,
    event: { type: "issue-created", origin: "repair", unmetDependencies: 0 },
    to: "ready",
  },
  {
    ref: "A.2#2",
    from: "waiting-deps",
    event: { type: "dependency-merged", allDepsMerged: true },
    to: "ready",
  },
  {
    ref: "A.2#3",
    from: "ready",
    event: { type: "dispatched", sequentialSlotFree: true, missionExecuting: true },
    to: "claimed",
  },
  {
    ref: "A.2#4",
    from: "ready",
    event: { type: "provider-window-exhausted" },
    to: "queued-quota",
  },
  { ref: "A.2#5", from: "queued-quota", event: { type: "quota-window-freed" }, to: "ready" },
  {
    ref: "A.2#6",
    from: "claimed",
    event: { type: "worker-started", leaseValid: true },
    to: "implementing",
  },
  {
    ref: "A.2#7a",
    from: "claimed",
    event: { type: "attempt-pre-start-terminal", attemptTerminal: "expired", recorded: true },
    to: "ready",
  },
  {
    ref: "A.2#7a",
    from: "claimed",
    event: { type: "attempt-pre-start-terminal", attemptTerminal: "cancelled", recorded: true },
    to: "ready",
  },
  {
    ref: "A.2#7b",
    from: "claimed",
    event: {
      type: "attempt-pre-start-terminal",
      attemptTerminal: "quota-blocked",
      recorded: true,
    },
    to: "queued-quota",
  },
  {
    ref: "A.2#8",
    from: "implementing",
    event: { type: "final-head-submitted", quarantinePassed: true },
    to: "validating",
  },
  {
    ref: "A.2#9a",
    from: "implementing",
    event: { type: "attempt-failed", failureCount: 1 },
    to: "ready",
  },
  {
    ref: "A.2#9b",
    from: "implementing",
    event: { type: "attempt-failed", failureCount: 4 },
    to: "escalated",
  },
  {
    ref: "A.2#10",
    from: "implementing",
    event: { type: "attempt-budget-breached", killConfirmed: true },
    to: "escalated",
  },
  {
    ref: "A.2#11",
    from: "implementing",
    event: { type: "attempt-quota-blocked" },
    to: "queued-quota",
  },
  {
    ref: "A.2#12",
    from: "implementing",
    event: { type: "attempt-cancelled", reason: "pause", summaryWritten: true },
    to: "ready",
  },
  {
    ref: "A.2#12",
    from: "implementing",
    event: { type: "attempt-cancelled", reason: "urgent-preemption", summaryWritten: true },
    to: "ready",
  },
  {
    ref: "A.2#13",
    from: "validating",
    event: { type: "validation-green", freshnessHolds: true },
    to: "merge-pending",
  },
  {
    ref: "A.2#14",
    from: "validating",
    event: { type: "validation-failed", repairPolicyAllows: true, failureCount: 1 },
    to: "ready",
  },
  { ref: "A.2#15", from: "validating", event: { type: "infra-blocked" }, to: "blocked" },
  {
    ref: "A.2#16",
    from: "merge-pending",
    event: {
      type: "merge-approved",
      actor: "david",
      authority: "david",
      target: "mission-branch",
      baseCheckPassed: true,
    },
    to: "merged",
  },
  {
    ref: "A.2#16",
    from: "merge-pending",
    event: {
      type: "merge-approved",
      authority: "tier-1",
      target: "mission-branch",
      baseCheckPassed: true,
    },
    to: "merged",
  },
  {
    ref: "A.2#17",
    from: "merge-pending",
    event: { type: "mission-branch-advanced" },
    to: "ready",
  },
  {
    ref: "A.2#19",
    from: "implementing",
    event: { type: "contract-edited-incompatible" },
    to: "replanning",
  },
  {
    ref: "A.2#20a",
    from: "replanning",
    event: { type: "replan-complete", contractVersionAdvanced: true, unmetDependencies: 0 },
    to: "ready",
  },
  {
    ref: "A.2#20b",
    from: "replanning",
    event: { type: "replan-complete", contractVersionAdvanced: true, unmetDependencies: 1 },
    to: "waiting-deps",
  },
  {
    ref: "A.2#21a",
    from: "escalated",
    event: { type: "escalation-answered", actor: "david", resolution: "retry" },
    to: "ready",
  },
  {
    ref: "A.2#21b",
    from: "escalated",
    event: { type: "escalation-answered", actor: "david", resolution: "cancel" },
    to: "cancelled",
  },
  {
    ref: "A.2#22",
    from: "merge-pending",
    event: { type: "issue-cancelled", actor: "david" },
    to: "cancelled",
  },
  { ref: "A.2#23", from: "blocked", event: { type: "block-resolved" }, to: "ready" },
  {
    ref: "A.2#24",
    from: "validating",
    event: { type: "cleanup-failed", recorded: true },
    to: "blocked",
  },
];

export const ISSUE_ILLEGAL: readonly IllegalVector<IssueState, IssueEvent>[] = [
  {
    name: "worker start without a claim",
    from: "ready",
    event: { type: "worker-started", leaseValid: true },
    expect: "illegal-transition",
  },
  {
    name: "double dispatch of a claimed issue",
    from: "claimed",
    event: { type: "dispatched", sequentialSlotFree: true, missionExecuting: true },
    expect: "illegal-transition",
  },
  {
    name: "dispatch straight from queued-quota (must return to ready first)",
    from: "queued-quota",
    event: { type: "dispatched", sequentialSlotFree: true, missionExecuting: true },
    expect: "illegal-transition",
  },
  {
    name: "terminal states are absorbing: dispatch after merge",
    from: "merged",
    event: { type: "dispatched", sequentialSlotFree: true, missionExecuting: true },
    expect: "illegal-transition",
  },
  {
    name: "terminal states are absorbing: cancel after cancel",
    from: "cancelled",
    event: { type: "issue-cancelled" },
    expect: "illegal-transition",
  },
  {
    name: "dispatch while the mission is paused (A.2#3 guard)",
    from: "ready",
    event: { type: "dispatched", sequentialSlotFree: true, missionExecuting: false },
    expect: "guard-rejected",
  },
  {
    name: "tier-1 autonomy on a main candidate (scoped to mission-branch targets only)",
    from: "merge-pending",
    event: {
      type: "merge-approved",
      authority: "tier-1",
      target: "main-candidate",
      baseCheckPassed: true,
    },
    expect: "guard-rejected",
  },
  {
    name: "ANY authority on a main candidate — quick-task issues have no merge row at all (A.1b; review r1 finding 3)",
    from: "merge-pending",
    event: {
      type: "merge-approved",
      actor: "david",
      authority: "david",
      target: "main-candidate",
      baseCheckPassed: true,
    },
    expect: "guard-rejected",
  },
  {
    name: "merge approval with a failed base check",
    from: "merge-pending",
    event: {
      type: "merge-approved",
      actor: "david",
      authority: "david",
      target: "mission-branch",
      baseCheckPassed: false,
    },
    expect: "guard-rejected",
  },
  {
    name: "escalation answer from a non-David actor",
    from: "escalated",
    event: { type: "escalation-answered", actor: "mallory", resolution: "retry" },
    expect: "guard-rejected",
  },
  {
    name: "failure count below the recorded-counter floor (integers start at 1)",
    from: "implementing",
    event: { type: "attempt-failed", failureCount: 0 },
    expect: "guard-rejected",
  },
  {
    name: "attempt failure without a recorded failure count (enrichment missing)",
    from: "implementing",
    event: { type: "attempt-failed" },
    expect: "guard-rejected",
  },
  {
    name: "budget breach without kill-confirm (CAM-EXEC-03)",
    from: "implementing",
    event: { type: "attempt-budget-breached", killConfirmed: false },
    expect: "guard-rejected",
  },
  {
    name: "repair issue created with unmet dependencies",
    from: null,
    event: { type: "issue-created", origin: "repair", unmetDependencies: 2 },
    expect: "guard-rejected",
  },
  {
    name: "quarantine failure cannot enter validating",
    from: "implementing",
    event: { type: "final-head-submitted", quarantinePassed: false },
    expect: "guard-rejected",
  },
  {
    name: "attempt cancellation for a contract edit is not the preemption/pause row (A.2#12; review r2 finding 8)",
    from: "implementing",
    event: {
      type: "attempt-cancelled",
      reason: "edit",
      summaryWritten: true,
    } as unknown as IssueEvent,
    expect: "guard-rejected",
  },
  {
    name: "unmet-dependency count smuggled as a string (coercion; review r2 finding 7)",
    from: null,
    event: {
      type: "issue-created",
      origin: "plan-approval",
      unmetDependencies: "1",
    } as unknown as IssueEvent,
    expect: "guard-rejected",
  },
  {
    name: "replan dependency count smuggled as an array (coercion; review r2 finding 7)",
    from: "replanning",
    event: {
      type: "replan-complete",
      contractVersionAdvanced: true,
      unmetDependencies: [1],
    } as unknown as IssueEvent,
    expect: "guard-rejected",
  },
  {
    name: "replan without the contract-v(n+1) attestation (review r3 finding 2)",
    from: "replanning",
    event: { type: "replan-complete", contractVersionAdvanced: false, unmetDependencies: 0 },
    expect: "guard-rejected",
  },
];

// ---------------------------------------------------------------- attempt A.3

const ARCHIVAL_EVENT: AttemptEvent = {
  type: "archival-completed",
  quotasEnforced: true,
  ledgerRowReferencesArchive: true,
  archiveWrittenAt: "2026-07-19T10:00:00.000Z",
  ledgerRowAt: "2026-07-19T10:00:01.000Z",
  workspaceDestroyedAt: "2026-07-19T10:00:02.000Z",
};

export const ATTEMPT_LEGAL: readonly LegalVector<AttemptState, AttemptEvent>[] = [
  {
    ref: "A.3#1",
    from: null,
    event: { type: "attempt-dispatched", leaseGranted: true, leaseGeneration: 1 },
    to: "running",
  },
  {
    ref: "A.3#2",
    from: "running",
    event: { type: "heartbeat-lapsed", killConfirmed: true },
    to: "expired",
  },
  {
    ref: "A.3#3",
    from: "running",
    event: { type: "worker-completed", finalHeadFetched: true },
    to: "submitted",
  },
  {
    ref: "A.3#4",
    from: "running",
    event: {
      type: "attempt-cancel-requested",
      actor: "david",
      reason: "david",
      settledBy: "checkpoint",
      summaryWritten: true,
    },
    to: "cancelled",
  },
  {
    ref: "A.3#4",
    from: "running",
    event: {
      type: "attempt-cancel-requested",
      reason: "urgent-preemption",
      settledBy: "kill-confirm",
      summaryWritten: true,
    },
    to: "cancelled",
  },
  {
    ref: "A.3#5",
    from: "running",
    event: { type: "attempt-budget-breached", killConfirmed: true },
    to: "killed-budget",
  },
  { ref: "A.3#6", from: "running", event: { type: "rate-limited" }, to: "quota-blocked" },
  {
    ref: "A.3#7a",
    from: "submitted",
    event: { type: "verdict-recorded", quarantineAndValidationComplete: true, verdict: "pass" },
    to: "succeeded",
  },
  {
    ref: "A.3#7b",
    from: "submitted",
    event: {
      type: "verdict-recorded",
      quarantineAndValidationComplete: true,
      verdict: "fail",
      failureClass: "wiring-gap",
    },
    to: "failed",
  },
  { ref: "A.3#8", from: "succeeded", event: ARCHIVAL_EVENT, to: "archived" },
  { ref: "A.3#8", from: "failed", event: ARCHIVAL_EVENT, to: "archived" },
  { ref: "A.3#8", from: "quota-blocked", event: ARCHIVAL_EVENT, to: "archived" },
];

export const ATTEMPT_ILLEGAL: readonly IllegalVector<AttemptState, AttemptEvent>[] = [
  {
    name: "verdict before submission",
    from: "running",
    event: { type: "verdict-recorded", quarantineAndValidationComplete: true, verdict: "pass" },
    expect: "illegal-transition",
  },
  {
    name: "heartbeat lapse after submission",
    from: "submitted",
    event: { type: "heartbeat-lapsed", killConfirmed: true },
    expect: "illegal-transition",
  },
  {
    name: "worker completion after success (terminal)",
    from: "succeeded",
    event: { type: "worker-completed", finalHeadFetched: true },
    expect: "illegal-transition",
  },
  {
    name: "archival happens exactly once (A.4#5): archived is absorbing",
    from: "archived",
    event: ARCHIVAL_EVENT,
    expect: "illegal-transition",
  },
  {
    name: "archival before any terminal state",
    from: "running",
    event: ARCHIVAL_EVENT,
    expect: "illegal-transition",
  },
  {
    name: "budget-breach kill without kill-confirm",
    from: "running",
    event: { type: "attempt-budget-breached", killConfirmed: false },
    expect: "guard-rejected",
  },
  {
    name: "expiry without kill-confirm",
    from: "running",
    event: { type: "heartbeat-lapsed", killConfirmed: false },
    expect: "guard-rejected",
  },
  {
    name: "archival sub-steps out of order (ledger row before archive write)",
    from: "succeeded",
    event: {
      type: "archival-completed",
      quotasEnforced: true,
      ledgerRowReferencesArchive: true,
      archiveWrittenAt: "2026-07-19T10:00:05.000Z",
      ledgerRowAt: "2026-07-19T10:00:01.000Z",
      workspaceDestroyedAt: "2026-07-19T10:00:06.000Z",
    },
    expect: "guard-rejected",
  },
  {
    name: "archival with workspace destroyed before the ledger row",
    from: "failed",
    event: {
      type: "archival-completed",
      quotasEnforced: true,
      ledgerRowReferencesArchive: true,
      archiveWrittenAt: "2026-07-19T10:00:00.000Z",
      ledgerRowAt: "2026-07-19T10:00:02.000Z",
      workspaceDestroyedAt: "2026-07-19T10:00:01.000Z",
    },
    expect: "guard-rejected",
  },
  {
    name: "archival with a missing sub-step timestamp",
    from: "expired",
    event: {
      type: "archival-completed",
      quotasEnforced: true,
      ledgerRowReferencesArchive: true,
      archiveWrittenAt: "2026-07-19T10:00:00.000Z",
      ledgerRowAt: "",
      workspaceDestroyedAt: "2026-07-19T10:00:02.000Z",
    },
    expect: "guard-rejected",
  },
  {
    name: "archival whose ledger row does not reference the written archive (A.4#5)",
    from: "succeeded",
    event: {
      type: "archival-completed",
      quotasEnforced: true,
      ledgerRowReferencesArchive: false,
      archiveWrittenAt: "2026-07-19T10:00:00.000Z",
      ledgerRowAt: "2026-07-19T10:00:01.000Z",
      workspaceDestroyedAt: "2026-07-19T10:00:02.000Z",
    },
    expect: "guard-rejected",
  },
  {
    name: "cancellation with an unlisted reason (only the four appendix reasons are legal)",
    from: "running",
    event: {
      type: "attempt-cancel-requested",
      reason: "cosmic-ray",
      settledBy: "checkpoint",
      summaryWritten: true,
    } as unknown as AttemptEvent,
    expect: "guard-rejected",
  },
  {
    name: "David-reason cancellation whose envelope actor is not David",
    from: "running",
    event: {
      type: "attempt-cancel-requested",
      actor: "camino:scheduler",
      reason: "david",
      settledBy: "checkpoint",
      summaryWritten: true,
    },
    expect: "guard-rejected",
  },
  {
    name: "failure verdict without a taxonomy class",
    from: "submitted",
    event: { type: "verdict-recorded", quarantineAndValidationComplete: true, verdict: "fail" },
    expect: "guard-rejected",
  },
  {
    name: "verdict without the quarantine+validation completeness attestation (review r3 finding 2)",
    from: "submitted",
    event: { type: "verdict-recorded", quarantineAndValidationComplete: false, verdict: "pass" },
    expect: "guard-rejected",
  },
  {
    name: "dispatch without a lease generation",
    from: null,
    event: { type: "attempt-dispatched", leaseGranted: true, leaseGeneration: 0 },
    expect: "guard-rejected",
  },
];
