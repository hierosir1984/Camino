/**
 * Serialization-scheduler tests (WP-103, CAM-CORE-08 + Appendix A
 * serialization rule): a second mission on the same repo waits VISIBLY in
 * `queued`; intake/planning proceed concurrently; execution-bearing states
 * hold at most one mission per repo per lane; the urgent lane exists as a
 * first-class slot and `executing → paused-urgent → executing` is exercised
 * at the state-machine level through the transition recorder.
 *
 * Every transition here goes through the WP-101 recorder — the scheduler
 * never bypasses it. The urgent preemption WORKFLOW (checkpoint-cancel,
 * land-first, merge-back, revalidate) is CAM-PLAN-10 [P2]: recorded, not
 * built — these tests exercise the lane and the machine rows only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDomainStore } from "./domain-store.js";
import { SqliteEventStore } from "./event-store.js";
import { TransitionRecorder } from "./transition-recorder.js";
import { MissionIntake } from "./intake.js";
import { SCHEDULER_ACTOR, SerializationScheduler } from "./serialization-scheduler.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Harness {
  domain: SqliteDomainStore;
  events: SqliteEventStore;
  recorder: TransitionRecorder;
  intake: MissionIntake;
  scheduler: SerializationScheduler;
  repoId: string;
}

function newHarness(): Harness {
  const domain = new SqliteDomainStore(":memory:");
  const events = new SqliteEventStore(":memory:");
  cleanups.push(() => {
    domain.close();
    events.close();
  });
  const recorder = new TransitionRecorder(events);
  const intake = new MissionIntake(domain, recorder);
  const scheduler = new SerializationScheduler(domain, recorder, events);
  const project = domain.createProject("camino");
  const repo = domain.createRepo(project.id, "camino");
  return { domain, events, recorder, intake, scheduler, repoId: repo.id };
}

/** Record one mission transition and assert it applied; returns the target state. */
function apply(
  h: Harness,
  missionId: string,
  event: string,
  payload: Record<string, unknown> = {},
  actor = "camino:test",
): string {
  const outcome = h.recorder.record({
    entityKind: "mission",
    entityId: missionId,
    event,
    actor,
    cause: `scheduler.test: ${event}`,
    payload,
  });
  expect(outcome.ok, `${missionId} ${event} should apply`).toBe(true);
  return outcome.ok ? outcome.to : "";
}

/** Intake a PRD mission (integration route) and return its id. */
function intakePrdMission(h: Harness, title: string, repoId = h.repoId): string {
  const result = h.intake.createFromText({
    repoId,
    title,
    content: `# ${title}\n\nPRD text.`,
    actor: "david",
  });
  expect(result.ok).toBe(true);
  return result.ok ? result.mission.id : "";
}

/** Intake a quick task and return its id. */
function intakeQuickTask(h: Harness, title: string, urgent: boolean): string {
  const result = h.intake.createQuickTask({
    repoId: h.repoId,
    title,
    description: `${title} description`,
    urgent,
    actor: "david",
  });
  expect(result.ok).toBe(true);
  return result.ok ? result.mission.id : "";
}

/** Plan an integration mission, then approve it with the scheduler-computed slot fact. */
function planAndApprove(h: Harness, missionId: string): string {
  apply(h, missionId, "plan-constructed", { reviewAttached: true, checklistRendered: true });
  return apply(
    h,
    missionId,
    "plan-approved",
    {
      checklistApproved: true,
      dagAcyclic: true,
      executionSlotFree: h.scheduler.executionSlotFreeFor(missionId),
    },
    "david",
  );
}

/** Plan a quick task, then approve it with the scheduler-computed slot fact. */
function planAndApproveQuick(h: Harness, missionId: string): string {
  apply(h, missionId, "contract-attached", {
    miniReviewAttached: true,
    observabilityAdjudicated: true,
  });
  return apply(
    h,
    missionId,
    "plan-approved",
    {
      riskTierLow: true,
      neutralConcurred: true,
      singleIssue: true,
      executionSlotFree: h.scheduler.executionSlotFreeFor(missionId),
    },
    "david",
  );
}

/** approved → executing on the integration route (A.1#6). */
function startExecution(h: Harness, missionId: string): void {
  apply(h, missionId, "integration-branch-created", {
    branchCreated: true,
    missionPrCreated: true,
    onboardingChecksGreen: true,
  });
}

/** Drive an EXECUTING integration mission to `complete` (A.1#7 → #10 → #22). */
function completeMission(h: Harness, missionId: string): void {
  apply(h, missionId, "mission-gate-green", {
    allIssuesTerminal: true,
    noStrandedRequirement: true,
    gateGreen: true,
    reviewPass: true,
    foldOnBranch: true,
    rollupAndPrPopulated: true,
    freshnessHolds: true,
    candidateSha: "cand-1",
    packetHash: "packet-1",
  });
  apply(
    h,
    missionId,
    "mission-merge-approved",
    { authority: "david", candidateSha: "cand-1", packetHash: "packet-1" },
    "david",
  );
  apply(h, missionId, "push-confirmed", {
    landedOnMain: true,
    pushedSha: "cand-1",
    descopedRequirements: [],
  });
}

/** Drive an EXECUTING quick task to `complete` (A.1b#5 → #7 → #11). */
function completeQuickTask(h: Harness, missionId: string, sha: string): void {
  apply(h, missionId, "quick-validation-green", {
    packetPopulated: true,
    rollupAndPrPopulated: true,
    contractChecksGreen: true,
    repoFastSuiteGreen: true,
    freshnessVsMainHolds: true,
    candidateSha: sha,
    packetHash: `${sha}-packet`,
  });
  apply(
    h,
    missionId,
    "mission-merge-approved",
    { authority: "david", candidateSha: sha, packetHash: `${sha}-packet` },
    "david",
  );
  apply(h, missionId, "push-confirmed", {
    landedOnMain: true,
    pushedSha: sha,
    descopedRequirements: [],
  });
}

describe("CAM-CORE-08 — a second mission on the same repo waits visibly in `queued`", () => {
  it("routes the second approval to queued via the honest slot attestation and shows it waiting", () => {
    const h = newHarness();
    const m1 = intakePrdMission(h, "First mission");
    const m2 = intakePrdMission(h, "Second mission");

    expect(planAndApprove(h, m1)).toBe("approved"); // slot free → approved (A.1#3a)
    startExecution(h, m1);

    // The slot is now held; the scheduler attests that honestly and the
    // guard-split routes the second mission to `queued` (A.1#3b).
    expect(h.scheduler.executionSlotFreeFor(m2)).toBe(false);
    expect(planAndApprove(h, m2)).toBe("queued");

    // Waiting is VISIBLE: the queue view names the mission, its lane, and
    // since when it has been waiting.
    const queue = h.scheduler.repoQueue(h.repoId);
    expect(queue.active.primary).toEqual({ missionId: m1, state: "executing" });
    expect(queue.queued).toHaveLength(1);
    expect(queue.queued[0]).toMatchObject({ missionId: m2, lane: "primary" });
    expect(queue.queued[0]?.queuedSinceSeq).toBeGreaterThan(0);
    expect(queue.queued[0]?.queuedSince).not.toBe("");
    expect(h.scheduler.serializationViolations(h.repoId)).toEqual([]);
  });

  it("intake and planning proceed concurrently while the slot is held", () => {
    const h = newHarness();
    const m1 = intakePrdMission(h, "Executing mission");
    planAndApprove(h, m1);
    startExecution(h, m1);

    // A second and third mission move through intake and planning freely —
    // draft and planned are not execution-bearing.
    const m2 = intakePrdMission(h, "Planning mission");
    apply(h, m2, "plan-constructed", { reviewAttached: true, checklistRendered: true });
    const m3 = intakePrdMission(h, "Drafting mission");

    const queue = h.scheduler.repoQueue(h.repoId);
    expect(queue.concurrent.map((c) => c.missionId).sort()).toEqual([m2, m3].sort());
    expect(queue.concurrent.find((c) => c.missionId === m2)?.state).toBe("planned");
    expect(queue.concurrent.find((c) => c.missionId === m3)?.state).toBe("draft");
    expect(h.scheduler.serializationViolations(h.repoId)).toEqual([]);
  });

  it("missions on other repos are unaffected (serialization is per repo)", () => {
    const h = newHarness();
    const otherProject = h.domain.createProject("other-product");
    const otherRepo = h.domain.createRepo(otherProject.id, "other-repo");

    const m1 = intakePrdMission(h, "Repo A mission");
    planAndApprove(h, m1);
    startExecution(h, m1);

    const mB = intakePrdMission(h, "Repo B mission", otherRepo.id);
    expect(planAndApprove(h, mB)).toBe("approved"); // its own repo's slot is free

    expect(h.scheduler.laneOccupancy(h.repoId).primary?.missionId).toBe(m1);
    expect(h.scheduler.laneOccupancy(otherRepo.id).primary?.missionId).toBe(mB);
    expect(h.scheduler.serializationViolations(h.repoId)).toEqual([]);
    expect(h.scheduler.serializationViolations(otherRepo.id)).toEqual([]);
  });
});

describe("FIFO activation when the slot frees (A.1#5)", () => {
  it("activates the head of the queue — and only the head — via a recorded transition", () => {
    const h = newHarness();
    const m1 = intakePrdMission(h, "First");
    const m2 = intakePrdMission(h, "Second");
    const m3 = intakePrdMission(h, "Third");

    planAndApprove(h, m1);
    startExecution(h, m1);
    expect(planAndApprove(h, m2)).toBe("queued");
    expect(planAndApprove(h, m3)).toBe("queued");

    // Nothing activates while the slot is held.
    expect(h.scheduler.activateNext(h.repoId)).toEqual([]);

    completeMission(h, m1);
    const outcomes = h.scheduler.activateNext(h.repoId);
    expect(outcomes).toEqual([{ lane: "primary", missionId: m2, to: "approved" }]);
    expect(h.recorder.currentState("mission", m2)).toBe("approved");
    expect(h.recorder.currentState("mission", m3)).toBe("queued"); // still waiting

    // The activation is itself a recorded event with the scheduler as actor.
    const activation = h.events
      .read({ entityKind: "mission", entityId: m2 })
      .find((r) => r.event === "execution-slot-freed");
    expect(activation?.actor).toBe(SCHEDULER_ACTOR);
    expect(activation?.payload).toEqual({ fifoHead: true });

    // The slot is taken again (approved is execution-bearing): no double activation.
    expect(h.scheduler.activateNext(h.repoId)).toEqual([]);
  });

  it("a mission paused while queued keeps its FIFO place across resume", () => {
    const h = newHarness();
    const m1 = intakePrdMission(h, "Holder");
    const m2 = intakePrdMission(h, "Paused-in-queue");
    const m3 = intakePrdMission(h, "Behind");

    planAndApprove(h, m1);
    startExecution(h, m1);
    expect(planAndApprove(h, m2)).toBe("queued"); // first into the line
    expect(planAndApprove(h, m3)).toBe("queued"); // second

    // Pause m2 while queued (not slot-holding: paused from a non-bearing state)…
    apply(h, m2, "mission-paused", { attemptSettled: true }, "david");
    expect(h.scheduler.executionSlotFreeFor(m3)).toBe(false); // m1 still holds
    // …and resume it back into `queued`.
    expect(apply(h, m2, "mission-resumed", {}, "david")).toBe("queued");

    completeMission(h, m1);
    const outcomes = h.scheduler.activateNext(h.repoId);
    // First entry wins: m2 queued before m3 and did not lose its place.
    expect(outcomes).toEqual([{ lane: "primary", missionId: m2, to: "approved" }]);
  });
});

describe("paused-manual slot semantics (AMEND-2: execution-bearing is f(state, pausedFrom))", () => {
  it("a mission paused from executing still holds the slot", () => {
    const h = newHarness();
    const m1 = intakePrdMission(h, "Paused holder");
    const m2 = intakePrdMission(h, "Waiter");

    planAndApprove(h, m1);
    startExecution(h, m1);
    apply(h, m1, "mission-paused", { attemptSettled: true }, "david");

    expect(h.recorder.currentState("mission", m1)).toBe("paused-manual");
    expect(h.scheduler.executionSlotFreeFor(m2)).toBe(false);
    expect(h.scheduler.laneOccupancy(h.repoId).primary?.missionId).toBe(m1);
    expect(h.scheduler.activateNext(h.repoId)).toEqual([]);
  });

  it("a mission paused from planning does not hold the slot", () => {
    const h = newHarness();
    const m1 = intakePrdMission(h, "Paused planner");
    const m2 = intakePrdMission(h, "Free to go");

    apply(h, m1, "plan-constructed", { reviewAttached: true, checklistRendered: true });
    apply(h, m1, "mission-paused", { attemptSettled: true }, "david"); // paused from planned

    expect(h.scheduler.executionSlotFreeFor(m2)).toBe(true);
    expect(h.scheduler.laneOccupancy(h.repoId).primary).toBeUndefined();
  });
});

describe("the urgent lane (CAM-CORE-08 'one active mission, plus the urgent lane')", () => {
  it("exercises executing → paused-urgent → executing at the state-machine level with the lane accounted", () => {
    const h = newHarness();
    const m1 = intakePrdMission(h, "Primary mission");
    planAndApprove(h, m1);
    startExecution(h, m1);

    // An urgent quick task schedules on the URGENT lane: its slot fact is the
    // lane's freedom, independent of the held primary slot.
    const qU = intakeQuickTask(h, "Urgent hotfix", true);
    expect(h.scheduler.executionSlotFreeFor(qU)).toBe(true);
    expect(planAndApproveQuick(h, qU)).toBe("approved");

    // The urgent task claims the lane: the primary mission is preempted
    // (A.1#15) — recorded through the machinery, exactly the row WP-101 shipped.
    apply(h, m1, "urgent-preemption", {}, "camino:scheduler");
    expect(h.recorder.currentState("mission", m1)).toBe("paused-urgent");

    // The urgent task executes per A.1b#4 while the primary holds its slot.
    apply(h, qU, "quick-task-execution-started", {
      targetIsMainCandidate: true,
      noIntegrationBranchNoFold: true,
    });
    const during = h.scheduler.laneOccupancy(h.repoId);
    expect(during.primary).toEqual({ missionId: m1, state: "paused-urgent" });
    expect(during.urgent).toEqual({ missionId: qU, state: "executing" });
    expect(h.scheduler.serializationViolations(h.repoId)).toEqual([]);

    // The urgent task lands; the lane frees; the primary resumes (A.1#20).
    completeQuickTask(h, qU, "urgent-sha");
    expect(h.scheduler.laneOccupancy(h.repoId).urgent).toBeUndefined();
    apply(h, m1, "interruption-resolved", { affectedIssuesHandled: true }, "camino:scheduler");
    expect(h.recorder.currentState("mission", m1)).toBe("executing");
    expect(h.scheduler.laneOccupancy(h.repoId).primary).toEqual({
      missionId: m1,
      state: "executing",
    });
  });

  it("the urgent lane itself serializes: a second urgent task waits in queued and activates FIFO", () => {
    const h = newHarness();
    const m1 = intakePrdMission(h, "Primary mission");
    planAndApprove(h, m1);
    startExecution(h, m1);

    const qU = intakeQuickTask(h, "Urgent A", true);
    planAndApproveQuick(h, qU);
    apply(h, m1, "urgent-preemption", {}, "camino:scheduler");
    apply(h, qU, "quick-task-execution-started", {
      targetIsMainCandidate: true,
      noIntegrationBranchNoFold: true,
    });

    // A second urgent task finds the LANE held → queued (A.1b#3b).
    const qV = intakeQuickTask(h, "Urgent B", true);
    expect(h.scheduler.executionSlotFreeFor(qV)).toBe(false);
    expect(planAndApproveQuick(h, qV)).toBe("queued");
    expect(h.scheduler.repoQueue(h.repoId).queued[0]).toMatchObject({
      missionId: qV,
      lane: "urgent",
    });

    // The first urgent task lands → the lane frees → FIFO activation on the lane.
    completeQuickTask(h, qU, "urgent-a-sha");
    const outcomes = h.scheduler.activateNext(h.repoId);
    expect(outcomes).toEqual([{ lane: "urgent", missionId: qV, to: "approved" }]);
    // The primary mission is still preempted, untouched by lane activation.
    expect(h.recorder.currentState("mission", m1)).toBe("paused-urgent");
  });

  it("a non-urgent quick task competes for the PRIMARY slot, not the lane", () => {
    const h = newHarness();
    const m1 = intakePrdMission(h, "Primary mission");
    planAndApprove(h, m1);
    startExecution(h, m1);

    const q = intakeQuickTask(h, "Plain quick task", false);
    expect(h.scheduler.executionSlotFreeFor(q)).toBe(false); // primary held by m1
    expect(planAndApproveQuick(h, q)).toBe("queued");
    expect(h.scheduler.repoQueue(h.repoId).queued[0]).toMatchObject({
      missionId: q,
      lane: "primary",
    });
  });
});

describe("enforcement boundary (stated, not hidden)", () => {
  it("a dishonest slot attestation reaches approved — and the breach is visible as a violation", () => {
    const h = newHarness();
    const m1 = intakePrdMission(h, "Honest holder");
    const m2 = intakePrdMission(h, "Dishonest attester");

    planAndApprove(h, m1);
    startExecution(h, m1);

    // A caller that skips the scheduler and attests a free slot: the machine
    // checks the ATTESTED fact (Appendix A guards are over attested facts),
    // so the transition applies — and the resulting double-occupancy is
    // exactly what serializationViolations exists to surface.
    apply(h, m2, "plan-constructed", { reviewAttached: true, checklistRendered: true });
    apply(
      h,
      m2,
      "plan-approved",
      { checklistApproved: true, dagAcyclic: true, executionSlotFree: true },
      "david",
    );
    expect(h.recorder.currentState("mission", m2)).toBe("approved");

    const violations = h.scheduler.serializationViolations(h.repoId);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.lane).toBe("primary");
    expect([...(violations[0]?.missionIds ?? [])].sort()).toEqual([m1, m2].sort());
  });
});
