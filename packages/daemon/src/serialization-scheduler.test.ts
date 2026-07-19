/**
 * Serialization-scheduler tests (WP-103, CAM-CORE-08 + Appendix A
 * serialization rule): a second mission on the same repo waits VISIBLY in
 * `queued`; intake/planning proceed concurrently; execution-bearing states
 * hold at most one mission per repo per lane; the urgent lane exists as a
 * first-class slot and `executing → paused-urgent → executing` is exercised
 * at the state-machine level through the transition recorder.
 *
 * Every transition here goes through the WP-101 recorder — the scheduler
 * never bypasses it. Plan approval goes through `approvePlan` (the honest,
 * single-synchronous-frame path — r1 finding 2); FIFO activations are
 * audited against the log (r1 finding 4); the urgent lane respects
 * quick-task non-preemptibility (r1 finding 3). The urgent preemption
 * WORKFLOW is CAM-PLAN-10 [P2]: recorded, not built.
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
  const intake = new MissionIntake(domain, recorder, events);
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

/** Plan an integration mission, then approve through the scheduler (honest path). */
function planAndApprove(h: Harness, missionId: string): string {
  apply(h, missionId, "plan-constructed", { reviewAttached: true, checklistRendered: true });
  const outcome = h.scheduler.approvePlan(missionId, "david", {
    checklistApproved: true,
    dagAcyclic: true,
  });
  expect(outcome.ok, `${missionId} approval should apply`).toBe(true);
  return outcome.ok ? outcome.to : "";
}

/** Plan a quick task, then approve through the scheduler (honest path). */
function planAndApproveQuick(h: Harness, missionId: string): string {
  apply(h, missionId, "contract-attached", {
    miniReviewAttached: true,
    observabilityAdjudicated: true,
  });
  const outcome = h.scheduler.approvePlan(missionId, "david", {
    riskTierLow: true,
    neutralConcurred: true,
    singleIssue: true,
  });
  expect(outcome.ok, `${missionId} quick approval should apply`).toBe(true);
  return outcome.ok ? outcome.to : "";
}

/** approved → executing on the integration route (A.1#6). */
function startExecution(h: Harness, missionId: string): void {
  apply(h, missionId, "integration-branch-created", {
    branchCreated: true,
    missionPrCreated: true,
    onboardingChecksGreen: true,
  });
}

/** approved → executing on the quick-task route (A.1b#4). */
function startQuickExecution(h: Harness, missionId: string): void {
  apply(h, missionId, "quick-task-execution-started", {
    targetIsMainCandidate: true,
    noIntegrationBranchNoFold: true,
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
  it("routes the second approval to queued via approvePlan and shows it waiting", () => {
    const h = newHarness();
    const m1 = intakePrdMission(h, "First mission");
    const m2 = intakePrdMission(h, "Second mission");

    expect(planAndApprove(h, m1)).toBe("approved"); // slot free → approved (A.1#3a)
    startExecution(h, m1);

    // The slot is now held; approvePlan computes the fact itself and the
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

  it("sequential approvePlan calls cannot double-book the slot (r1 finding 2)", () => {
    const h = newHarness();
    const m1 = intakePrdMission(h, "A");
    const m2 = intakePrdMission(h, "B");
    apply(h, m1, "plan-constructed", { reviewAttached: true, checklistRendered: true });
    apply(h, m2, "plan-constructed", { reviewAttached: true, checklistRendered: true });

    // Both approvals go through the scheduler; the slot fact is computed in
    // the same synchronous frame as the record, so the second call sees the
    // first one's outcome — approved-then-queued, never approved-approved.
    const first = h.scheduler.approvePlan(m1, "david", {
      checklistApproved: true,
      dagAcyclic: true,
    });
    const second = h.scheduler.approvePlan(m2, "david", {
      checklistApproved: true,
      dagAcyclic: true,
    });
    expect(first.ok && first.to).toBe("approved");
    expect(second.ok && second.to).toBe("queued");
    expect(h.scheduler.serializationViolations(h.repoId)).toEqual([]);
  });

  it("approvePlan refuses facts that do not match the mission's route", () => {
    const h = newHarness();
    const m1 = intakePrdMission(h, "Integration mission");
    apply(h, m1, "plan-constructed", { reviewAttached: true, checklistRendered: true });
    expect(() =>
      h.scheduler.approvePlan(m1, "david", {
        riskTierLow: true,
        neutralConcurred: true,
        singleIssue: true,
      }),
    ).toThrow(/IntegrationApprovalFacts/);
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
    // Every recorded activation went to the then-head (r1 finding 4).
    expect(h.scheduler.auditActivations(h.repoId)).toEqual([]);
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
    expect(h.scheduler.auditActivations(h.repoId)).toEqual([]);
  });

  it("a false fifoHead attestation is reported by the activation audit (r1 finding 4)", () => {
    const h = newHarness();
    const m1 = intakePrdMission(h, "Holder");
    const m2 = intakePrdMission(h, "True head");
    const m3 = intakePrdMission(h, "Queue jumper");

    planAndApprove(h, m1);
    startExecution(h, m1);
    expect(planAndApprove(h, m2)).toBe("queued");
    expect(planAndApprove(h, m3)).toBe("queued");
    completeMission(h, m1);

    // A caller bypasses the scheduler and attests head-of-queue for the
    // SECOND waiter. The machine checks the attested fact, so it applies —
    // and the audit re-derives the truth from the log.
    apply(h, m3, "execution-slot-freed", { fifoHead: true });
    expect(h.recorder.currentState("mission", m3)).toBe("approved");
    expect(h.recorder.verify()).toEqual([]); // replay is content with the attested row

    const deviations = h.scheduler.auditActivations(h.repoId);
    expect(deviations).toHaveLength(1);
    expect(deviations[0]).toMatchObject({
      missionId: m3,
      lane: "primary",
      reason: "jumped-queue",
      expectedHeadId: m2,
    });
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
    startQuickExecution(h, qU);
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
    startQuickExecution(h, qU);

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
    expect(h.scheduler.auditActivations(h.repoId)).toEqual([]);
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

  it("the urgent lane is unavailable while the primary is unparkable — approved has no preemption row (r2 finding 1)", () => {
    const h = newHarness();
    // An integration mission APPROVED but not yet executing: execution-
    // bearing, and no Appendix A row can park it (A.1#15 is from executing).
    const m1 = intakePrdMission(h, "Approved primary");
    expect(planAndApprove(h, m1)).toBe("approved");

    // The urgent lane therefore counts as unavailable: the urgent task
    // queues instead of activating beside an unparkable holder.
    const qU = intakeQuickTask(h, "Urgent behind approved", true);
    expect(h.scheduler.executionSlotFreeFor(qU)).toBe(false);
    expect(planAndApproveQuick(h, qU)).toBe("queued");
    expect(h.scheduler.activateNext(h.repoId)).toEqual([]);

    // The moment the primary starts executing it becomes parkable — the
    // lane opens and the urgent task activates.
    startExecution(h, m1);
    expect(h.scheduler.activateNext(h.repoId)).toEqual([
      { lane: "urgent", missionId: qU, to: "approved" },
    ]);
    // Honest continuation: park the primary (A.1#15), run the urgent task.
    apply(h, m1, "urgent-preemption", {}, "camino:scheduler");
    startQuickExecution(h, qU);
    expect(h.scheduler.serializationViolations(h.repoId)).toEqual([]);
  });

  it("a forced urgent execution beside an unparked approved primary is a reported violation (r2 finding 1)", () => {
    const h = newHarness();
    const m1 = intakePrdMission(h, "Approved primary");
    expect(planAndApprove(h, m1)).toBe("approved");

    // Force the reviewer's exact sequence with a dishonest slot attestation:
    // the urgent task approves and starts executing while the primary sits
    // in `approved`, which nothing can park.
    const qU = intakeQuickTask(h, "Urgent beside approved", true);
    apply(h, qU, "contract-attached", {
      miniReviewAttached: true,
      observabilityAdjudicated: true,
    });
    apply(
      h,
      qU,
      "plan-approved",
      { riskTierLow: true, neutralConcurred: true, singleIssue: true, executionSlotFree: true },
      "david",
    );
    startQuickExecution(h, qU);

    expect(h.scheduler.serializationViolations(h.repoId)).toContainEqual({
      kind: "urgent-beside-unadmittable-primary",
      primaryMissionId: m1,
      primaryState: "approved",
      urgentMissionId: qU,
    });
  });

  it("a bypassed approved+approved pairing is a reported violation even before anything executes (r3 finding 5)", () => {
    const h = newHarness();
    const m1 = intakePrdMission(h, "Approved primary");
    expect(planAndApprove(h, m1)).toBe("approved");

    // Direct recorder call with a dishonest slot attestation: the urgent
    // task lands in `approved` beside an unparkable `approved` primary.
    // Neither is executing — but the pairing is wedged (the primary can
    // never be parked from approved) and must not report green.
    const qU = intakeQuickTask(h, "Urgent approved beside it", true);
    apply(h, qU, "contract-attached", {
      miniReviewAttached: true,
      observabilityAdjudicated: true,
    });
    apply(
      h,
      qU,
      "plan-approved",
      { riskTierLow: true, neutralConcurred: true, singleIssue: true, executionSlotFree: true },
      "david",
    );

    expect(h.scheduler.serializationViolations(h.repoId)).toContainEqual({
      kind: "urgent-beside-unadmittable-primary",
      primaryMissionId: m1,
      primaryState: "approved",
      urgentMissionId: qU,
    });
  });

  it("the urgent lane activates before primary: a younger primary cannot leapfrog an older urgent task (r5 finding 1)", () => {
    const h = newHarness();
    // A quick task holds primary (unadmittable) so BOTH later missions queue.
    const q0 = intakeQuickTask(h, "Quick holder", false);
    expect(planAndApproveQuick(h, q0)).toBe("approved");
    startQuickExecution(h, q0);

    const qU = intakeQuickTask(h, "Older urgent", true);
    expect(planAndApproveQuick(h, qU)).toBe("queued"); // lane unavailable (quick primary)
    const m1 = intakePrdMission(h, "Younger primary");
    expect(planAndApprove(h, m1)).toBe("queued"); // primary held

    // The holder terminates: both slots are free, the urgent task is OLDER.
    completeQuickTask(h, q0, "holder-sha");
    // Urgent activates FIRST; symmetric admission then keeps primary queued.
    expect(h.scheduler.activateNext(h.repoId)).toEqual([
      { lane: "urgent", missionId: qU, to: "approved" },
    ]);
    expect(h.recorder.currentState("mission", m1)).toBe("queued");

    // The urgent task lands → the primary follows.
    startQuickExecution(h, qU);
    completeQuickTask(h, qU, "urgent-sha");
    expect(h.scheduler.activateNext(h.repoId)).toEqual([
      { lane: "primary", missionId: m1, to: "approved" },
    ]);
    expect(h.scheduler.serializationViolations(h.repoId)).toEqual([]);
    expect(h.scheduler.auditActivations(h.repoId)).toEqual([]);
  });

  it("admission is symmetric: a primary approval while the urgent lane is occupied queues (r4 finding 1)", () => {
    const h = newHarness();
    // Urgent-first: an urgent quick task alone on the repo takes the lane
    // and executes.
    const qU = intakeQuickTask(h, "Urgent first", true);
    expect(planAndApproveQuick(h, qU)).toBe("approved");
    startQuickExecution(h, qU);

    // A normal mission approved NOW must not land beside it in `approved`
    // (nothing could ever park it) — it queues instead.
    const m1 = intakePrdMission(h, "Primary while urgent runs");
    expect(h.scheduler.executionSlotFreeFor(m1)).toBe(false);
    expect(planAndApprove(h, m1)).toBe("queued");
    expect(h.scheduler.activateNext(h.repoId)).toEqual([]); // still occupied
    expect(h.scheduler.serializationViolations(h.repoId)).toEqual([]);

    // The urgent task lands → the primary activates.
    completeQuickTask(h, qU, "urgent-first-sha");
    expect(h.scheduler.activateNext(h.repoId)).toEqual([
      { lane: "primary", missionId: m1, to: "approved" },
    ]);
    expect(h.scheduler.serializationViolations(h.repoId)).toEqual([]);
    expect(h.scheduler.auditActivations(h.repoId)).toEqual([]);
  });

  it("skipping the A.1#15 preemption step is a reported violation (parkable but unparked)", () => {
    const h = newHarness();
    const m1 = intakePrdMission(h, "Executing primary");
    planAndApprove(h, m1);
    startExecution(h, m1);

    // Honest approval — the lane admits the urgent task because the primary
    // is parkable — but the workflow then FAILS to park it before starting.
    const qU = intakeQuickTask(h, "Urgent that skipped the park", true);
    expect(planAndApproveQuick(h, qU)).toBe("approved");
    startQuickExecution(h, qU); // A.1#15 never recorded on m1

    expect(h.scheduler.serializationViolations(h.repoId)).toContainEqual({
      kind: "urgent-active-while-primary-unparked",
      primaryMissionId: m1,
      primaryState: "executing",
      urgentMissionId: qU,
    });
  });

  it("a quick task David paused manually IS parked: the urgent lane opens deliberately (r3 finding 8)", () => {
    const h = newHarness();
    const q = intakeQuickTask(h, "Paused quick task", false);
    expect(planAndApproveQuick(h, q)).toBe("approved");
    startQuickExecution(h, q);
    // Quick tasks cannot be PREEMPTED (no A.1b urgent-preemption row), but
    // David can pause one manually — that is a parked primary.
    apply(h, q, "mission-paused", { attemptSettled: true }, "david");
    expect(h.recorder.currentState("mission", q)).toBe("paused-manual");

    const qU = intakeQuickTask(h, "Urgent while quick paused", true);
    expect(h.scheduler.executionSlotFreeFor(qU)).toBe(true);
    expect(planAndApproveQuick(h, qU)).toBe("approved");
    startQuickExecution(h, qU);
    expect(h.scheduler.serializationViolations(h.repoId)).toEqual([]);

    // The urgent task lands; the paused quick task resumes to executing.
    completeQuickTask(h, qU, "urgent-sha");
    expect(apply(h, q, "mission-resumed", {}, "david")).toBe("executing");
    expect(h.scheduler.serializationViolations(h.repoId)).toEqual([]);
  });

  it("the urgent lane is unavailable while a quick task holds primary — no preemption rows exist for quick tasks (r1 finding 3)", () => {
    const h = newHarness();
    // A non-urgent quick task takes the primary slot and starts executing.
    const q = intakeQuickTask(h, "Plain quick task", false);
    expect(planAndApproveQuick(h, q)).toBe("approved");
    startQuickExecution(h, q);

    // The quick-task machine has no A.1#15 row: preemption is illegal.
    const preemption = h.recorder.record({
      entityKind: "mission",
      entityId: q,
      event: "urgent-preemption",
      actor: "camino:scheduler",
      cause: "scheduler.test: preemption attempt on a quick task",
      payload: {},
    });
    expect(preemption.ok).toBe(false);

    // So the urgent lane counts as unavailable: an urgent task queues
    // instead of activating beside it…
    const qU = intakeQuickTask(h, "Urgent behind quick", true);
    expect(h.scheduler.executionSlotFreeFor(qU)).toBe(false);
    expect(planAndApproveQuick(h, qU)).toBe("queued");
    expect(h.scheduler.activateNext(h.repoId)).toEqual([]); // lane not available

    // …and activates the moment the quick task terminates.
    completeQuickTask(h, q, "quick-sha");
    const outcomes = h.scheduler.activateNext(h.repoId);
    expect(outcomes).toEqual([{ lane: "urgent", missionId: qU, to: "approved" }]);
    expect(h.scheduler.serializationViolations(h.repoId)).toEqual([]);
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
    expect(violations[0]?.kind).toBe("multi-holder");
    if (violations[0]?.kind !== "multi-holder") return;
    expect(violations[0].lane).toBe("primary");
    expect([...violations[0].missionIds].sort()).toEqual([m1, m2].sort());
  });

  it("concurrent active execution across lanes is visible as a violation (r1 finding 3)", () => {
    const h = newHarness();
    // Force the breach with dishonest attestations: a quick task executing
    // on primary AND an urgent task executing on the lane.
    const q = intakeQuickTask(h, "Quick on primary", false);
    expect(planAndApproveQuick(h, q)).toBe("approved");
    startQuickExecution(h, q);

    const qU = intakeQuickTask(h, "Urgent beside it", true);
    apply(h, qU, "contract-attached", {
      miniReviewAttached: true,
      observabilityAdjudicated: true,
    });
    apply(
      h,
      qU,
      "plan-approved",
      { riskTierLow: true, neutralConcurred: true, singleIssue: true, executionSlotFree: true },
      "david",
    );
    startQuickExecution(h, qU);

    const violations = h.scheduler.serializationViolations(h.repoId);
    // A quick task executing on primary is unadmittable (not parked, not
    // parkable) — the wedged-pairing rule fires.
    expect(violations).toContainEqual({
      kind: "urgent-beside-unadmittable-primary",
      primaryMissionId: q,
      primaryState: "executing",
      urgentMissionId: qU,
    });
  });
});
