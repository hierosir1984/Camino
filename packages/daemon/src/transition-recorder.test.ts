/**
 * Transition-recorder tests (WP-101): every state transition is an event
 * with actor and cause; illegal transitions are rejected AND logged
 * (CAM-STATE-05); recorded-context enrichment comes from the view, never
 * the caller; and a recorder rebuilt over the same log arrives at the
 * identical derived view (CAM-STATE-01 — rebuild from the log alone).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EntityKind } from "@camino/shared";
import { SqliteEventStore } from "./event-store.js";
import { TransitionRecorder } from "./transition-recorder.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function newRecorder(path = ":memory:"): { store: SqliteEventStore; recorder: TransitionRecorder } {
  const store = new SqliteEventStore(path);
  cleanups.push(() => store.close());
  return { store, recorder: new TransitionRecorder(store) };
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-recorder-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "events.db");
}

/** Shorthand: record and assert the transition applied, returning the target. */
function apply(
  recorder: TransitionRecorder,
  entityKind: EntityKind,
  entityId: string,
  event: string,
  payload: Record<string, unknown> = {},
  actor = "camino:test",
  cause = "recorder.test walk",
): string {
  const outcome = recorder.record({ entityKind, entityId, event, actor, cause, payload });
  expect(outcome.ok, `${entityKind}/${entityId} ${event} should apply`).toBe(true);
  return outcome.ok ? outcome.to : "";
}

/** Drive an issue from ready through one implementing cycle. */
function driveToImplementing(recorder: TransitionRecorder, issueId: string): void {
  apply(recorder, "issue", issueId, "dispatched", {
    sequentialSlotFree: true,
    missionExecuting: true,
  });
  apply(recorder, "issue", issueId, "worker-started", { leaseValid: true });
}

describe("TransitionRecorder", () => {
  it("walks a full A.1 mission lifecycle with issue and attempt, all recorded as events", () => {
    const { store, recorder } = newRecorder();

    expect(
      apply(
        recorder,
        "mission",
        "m1",
        "mission-created",
        { source: "prd-intake" },
        "david",
        "PRD intake",
      ),
    ).toBe("draft");
    apply(recorder, "mission", "m1", "plan-constructed", {
      reviewAttached: true,
      checklistRendered: true,
    });
    expect(
      apply(
        recorder,
        "mission",
        "m1",
        "plan-approved",
        {
          dagAcyclic: true,
          executionSlotFree: true,
        },
        "david",
        "plan review",
      ),
    ).toBe("approved");
    apply(recorder, "mission", "m1", "integration-branch-created", {
      onboardingChecksGreen: true,
    });

    expect(
      apply(recorder, "issue", "i1", "issue-created", {
        origin: "plan-approval",
        unmetDependencies: 0,
      }),
    ).toBe("ready");
    driveToImplementing(recorder, "i1");
    expect(
      apply(recorder, "attempt", "a1", "attempt-dispatched", {
        leaseGranted: true,
        leaseGeneration: 1,
      }),
    ).toBe("running");
    apply(recorder, "attempt", "a1", "worker-completed", { finalHeadFetched: true });
    apply(recorder, "issue", "i1", "final-head-submitted", { quarantinePassed: true });
    apply(recorder, "attempt", "a1", "verdict-recorded", { verdict: "pass" });
    apply(recorder, "attempt", "a1", "archival-completed", {
      quotasEnforced: true,
      archiveWrittenAt: "2026-07-19T10:00:00.000Z",
      ledgerRowAt: "2026-07-19T10:00:01.000Z",
      workspaceDestroyedAt: "2026-07-19T10:00:02.000Z",
    });
    apply(recorder, "issue", "i1", "validation-green", { freshnessHolds: true });
    expect(
      apply(
        recorder,
        "issue",
        "i1",
        "merge-approved",
        {
          authority: "david",
          target: "mission-branch",
          baseCheckPassed: true,
        },
        "david",
      ),
    ).toBe("merged");

    apply(recorder, "mission", "m1", "mission-gate-green", {
      allIssuesTerminal: true,
      noStrandedRequirement: true,
      gateGreen: true,
      reviewPass: true,
      foldOnBranch: true,
      rollupAndPrPopulated: true,
      freshnessHolds: true,
      candidateSha: "cand-1",
    });
    expect(
      apply(
        recorder,
        "mission",
        "m1",
        "mission-merge-approved",
        {
          authority: "david",
          candidateSha: "cand-1",
          packetHash: "packet-1",
        },
        "david",
        "approval bound to cand-1/packet-1",
      ),
    ).toBe("merging");
    expect(
      apply(recorder, "mission", "m1", "push-confirmed", {
        pushedSha: "cand-1",
        descopedRequirements: [],
      }),
    ).toBe("complete");

    // Every transition above is an event row with actor and cause.
    const records = store.read();
    expect(records.every((r) => r.outcome === "applied")).toBe(true);
    expect(records.every((r) => r.actor.length > 0 && r.cause.length > 0)).toBe(true);
    expect(recorder.currentState("mission", "m1")).toBe("complete");
    expect(recorder.currentState("issue", "i1")).toBe("merged");
    expect(recorder.currentState("attempt", "a1")).toBe("archived");
    expect(recorder.verify()).toEqual([]);
  });

  it("rejects AND logs illegal transitions, guard refusals, unknown entities, and duplicate creations", () => {
    const { store, recorder } = newRecorder();
    apply(recorder, "mission", "m1", "mission-created", { source: "prd-intake" });

    const illegal = recorder.record({
      entityKind: "mission",
      entityId: "m1",
      event: "integration-branch-created",
      actor: "camino:test",
      cause: "skip approval",
      payload: { onboardingChecksGreen: true },
    });
    expect(illegal).toMatchObject({ ok: false, code: "illegal-transition" });

    apply(recorder, "mission", "m1", "plan-constructed", {
      reviewAttached: true,
      checklistRendered: true,
    });
    const guardRejected = recorder.record({
      entityKind: "mission",
      entityId: "m1",
      event: "plan-approved",
      actor: "david",
      cause: "cyclic plan",
      payload: { dagAcyclic: false, executionSlotFree: true },
    });
    expect(guardRejected).toMatchObject({ ok: false, code: "guard-rejected" });

    const unknown = recorder.record({
      entityKind: "issue",
      entityId: "ghost",
      event: "dispatched",
      actor: "camino:scheduler",
      cause: "no such issue",
      payload: { sequentialSlotFree: true, missionExecuting: true },
    });
    expect(unknown).toMatchObject({ ok: false, code: "unknown-entity" });

    const duplicate = recorder.record({
      entityKind: "mission",
      entityId: "m1",
      event: "mission-created",
      actor: "camino:test",
      cause: "double create",
      payload: { source: "prd-intake" },
    });
    expect(duplicate).toMatchObject({ ok: false, code: "already-exists" });

    // All four rejections are logged with their codes; none changed state.
    const rejected = store.read().filter((r) => r.outcome === "rejected");
    expect(rejected.map((r) => r.rejectionCode)).toEqual([
      "illegal-transition",
      "guard-rejected",
      "unknown-entity",
      "already-exists",
    ]);
    expect(rejected.every((r) => r.toState === null)).toBe(true);
    expect(recorder.currentState("mission", "m1")).toBe("planned");
  });

  it("enriches the resume target from the recorded pause, ignoring caller claims", () => {
    const { store, recorder } = newRecorder();
    apply(recorder, "mission", "q1", "quick-task-intake", {}, "david", "quick task");
    apply(recorder, "mission", "q1", "contract-attached", {
      miniReviewAttached: true,
      observabilityAdjudicated: true,
    });
    apply(
      recorder,
      "mission",
      "q1",
      "plan-approved",
      {
        dagAcyclic: true,
        executionSlotFree: true,
        riskTierLow: true,
        neutralConcurred: true,
        singleIssue: true,
      },
      "david",
    );
    apply(recorder, "mission", "q1", "quick-task-execution-started", {});
    apply(recorder, "mission", "q1", "mission-paused", { attemptSettled: true }, "david", "pause");

    // The caller lies about the resume target; the recorder records the truth.
    const resumed = recorder.record({
      entityKind: "mission",
      entityId: "q1",
      event: "mission-resumed",
      actor: "david",
      cause: "resume",
      payload: { resumeTo: "complete" },
    });
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.to).toBe("executing");
    const resumeRecord = store.read().at(-1);
    expect(resumeRecord?.payload["resumeTo"]).toBe("executing");
  });

  it("rejects a resume with no recorded pause context", () => {
    const { recorder } = newRecorder();
    apply(recorder, "mission", "m1", "mission-created", { source: "prd-intake" });
    // Force paused-manual without recorded context is impossible through the
    // recorder; a resume in any other state is illegal and logged.
    const outcome = recorder.record({
      entityKind: "mission",
      entityId: "m1",
      event: "mission-resumed",
      actor: "david",
      cause: "resume without pause",
      payload: {},
    });
    expect(outcome).toMatchObject({ ok: false, code: "illegal-transition" });
  });

  it("mechanizes A.4#4: approvals bind to the candidate SHA and never transfer", () => {
    const { recorder } = newRecorder();
    apply(recorder, "mission", "m1", "mission-created", { source: "prd-intake" });
    apply(recorder, "mission", "m1", "plan-constructed", {
      reviewAttached: true,
      checklistRendered: true,
    });
    apply(
      recorder,
      "mission",
      "m1",
      "plan-approved",
      { dagAcyclic: true, executionSlotFree: true },
      "david",
    );
    apply(recorder, "mission", "m1", "integration-branch-created", { onboardingChecksGreen: true });
    apply(recorder, "mission", "m1", "mission-gate-green", {
      allIssuesTerminal: true,
      noStrandedRequirement: true,
      gateGreen: true,
      reviewPass: true,
      foldOnBranch: true,
      rollupAndPrPopulated: true,
      freshnessHolds: true,
      candidateSha: "cand-1",
    });
    apply(
      recorder,
      "mission",
      "m1",
      "mission-merge-approved",
      {
        authority: "david",
        candidateSha: "cand-1",
        packetHash: "packet-1",
      },
      "david",
    );

    // Base moved: rebuild green produces cand-2 and clears the binding.
    apply(recorder, "mission", "m1", "candidate-rebuilt", {
      green: true,
      newCandidateSha: "cand-2",
    });

    // Approving the STALE SHA is refused — approvals never transfer.
    const staleApproval = recorder.record({
      entityKind: "mission",
      entityId: "m1",
      event: "mission-merge-approved",
      actor: "david",
      cause: "stale approval",
      payload: { authority: "david", candidateSha: "cand-1", packetHash: "packet-1" },
    });
    expect(staleApproval).toMatchObject({ ok: false, code: "guard-rejected" });

    // A fresh approval of cand-2 proceeds; a push of anything else is refused.
    apply(
      recorder,
      "mission",
      "m1",
      "mission-merge-approved",
      {
        authority: "david",
        candidateSha: "cand-2",
        packetHash: "packet-2",
      },
      "david",
    );
    const wrongPush = recorder.record({
      entityKind: "mission",
      entityId: "m1",
      event: "push-confirmed",
      actor: "camino:merge",
      cause: "push of an unapproved sha",
      payload: { pushedSha: "cand-1", descopedRequirements: [] },
    });
    expect(wrongPush).toMatchObject({ ok: false, code: "guard-rejected" });
    expect(
      apply(recorder, "mission", "m1", "push-confirmed", {
        pushedSha: "cand-2",
        descopedRequirements: [],
      }),
    ).toBe("complete");
  });

  it("counts failures through enrichment — quota waits never count (A.2#5)", () => {
    const { recorder } = newRecorder();
    apply(recorder, "issue", "i1", "issue-created", {
      origin: "plan-approval",
      unmetDependencies: 0,
    });

    driveToImplementing(recorder, "i1");
    expect(apply(recorder, "issue", "i1", "attempt-failed", {})).toBe("ready");
    expect(recorder.currentView.issues.get("i1")?.failureCount).toBe(1);

    // A quota wait between failures leaves the counter untouched.
    apply(recorder, "issue", "i1", "provider-window-exhausted", {});
    apply(recorder, "issue", "i1", "quota-window-freed", {});
    expect(recorder.currentView.issues.get("i1")?.failureCount).toBe(1);

    driveToImplementing(recorder, "i1");
    expect(apply(recorder, "issue", "i1", "attempt-failed", {})).toBe("ready");
    driveToImplementing(recorder, "i1");
    expect(apply(recorder, "issue", "i1", "attempt-failed", {})).toBe("ready");
    driveToImplementing(recorder, "i1");
    // Fourth failure escalates (A.2#9b) with the enriched count of 4.
    expect(apply(recorder, "issue", "i1", "attempt-failed", {})).toBe("escalated");
    expect(recorder.currentView.issues.get("i1")?.failureCount).toBe(4);
  });

  it("recovers a claimed issue whose attempt died before the worker started (A.2#7)", () => {
    const { recorder } = newRecorder();
    apply(recorder, "issue", "i1", "issue-created", {
      origin: "plan-approval",
      unmetDependencies: 0,
    });
    apply(recorder, "issue", "i1", "dispatched", {
      sequentialSlotFree: true,
      missionExecuting: true,
    });
    apply(recorder, "attempt", "a1", "attempt-dispatched", {
      leaseGranted: true,
      leaseGeneration: 1,
    });
    // The attempt expires before worker start; the issue returns to ready.
    apply(recorder, "attempt", "a1", "heartbeat-lapsed", { killConfirmed: true });
    expect(
      apply(recorder, "issue", "i1", "attempt-pre-start-terminal", {
        attemptTerminal: "expired",
        recorded: true,
      }),
    ).toBe("ready");

    // Quota variant: the pre-start terminal routes to queued-quota instead.
    apply(recorder, "issue", "i1", "dispatched", {
      sequentialSlotFree: true,
      missionExecuting: true,
    });
    apply(recorder, "attempt", "a2", "attempt-dispatched", {
      leaseGranted: true,
      leaseGeneration: 2,
    });
    apply(recorder, "attempt", "a2", "rate-limited", {});
    expect(
      apply(recorder, "issue", "i1", "attempt-pre-start-terminal", {
        attemptTerminal: "quota-blocked",
        recorded: true,
      }),
    ).toBe("queued-quota");
    // Neither recovery counted as a failure.
    expect(recorder.currentView.issues.get("i1")?.failureCount).toBe(0);
  });

  it("kills-and-escalates on budget breach with no retry row (CAM-EXEC-03)", () => {
    const { recorder } = newRecorder();
    apply(recorder, "issue", "i1", "issue-created", {
      origin: "plan-approval",
      unmetDependencies: 0,
    });
    driveToImplementing(recorder, "i1");
    apply(recorder, "attempt", "a1", "attempt-dispatched", {
      leaseGranted: true,
      leaseGeneration: 1,
    });
    expect(
      apply(recorder, "attempt", "a1", "attempt-budget-breached", { killConfirmed: true }),
    ).toBe("killed-budget");
    expect(apply(recorder, "issue", "i1", "attempt-budget-breached", { killConfirmed: true })).toBe(
      "escalated",
    );
    // There is no automatic-retry row out of escalated: a retry attempt is
    // rejected and logged.
    const retry = recorder.record({
      entityKind: "issue",
      entityId: "i1",
      event: "attempt-failed",
      actor: "camino:scheduler",
      cause: "auto-retry after budget breach",
      payload: {},
    });
    expect(retry).toMatchObject({ ok: false, code: "illegal-transition" });
  });

  it("re-routes a quick task on a violated CAM-MERGE-01 gate, then starts the successor mission", () => {
    const { recorder } = newRecorder();
    apply(recorder, "mission", "q1", "quick-task-intake", {}, "david");
    apply(recorder, "mission", "q1", "contract-attached", {
      miniReviewAttached: true,
      observabilityAdjudicated: true,
    });
    apply(
      recorder,
      "mission",
      "q1",
      "plan-approved",
      {
        dagAcyclic: true,
        executionSlotFree: true,
        riskTierLow: true,
        neutralConcurred: true,
        singleIssue: true,
      },
      "david",
    );
    apply(recorder, "mission", "q1", "quick-task-execution-started", {});
    expect(
      apply(recorder, "mission", "q1", "gate-violation-detected", {
        workSummaryCarried: true,
        branchCarried: true,
      }),
    ).toBe("re-routed");
    // The quick task ended before the successor activates (serialization).
    expect(
      apply(
        recorder,
        "mission",
        "m2",
        "mission-created",
        { source: "re-routed", reroutedFrom: "q1" },
        "camino:intake",
        "re-routed from quick task q1 per A.1b",
      ),
    ).toBe("draft");
    // The terminal quick task accepts nothing further.
    const afterTerminal = recorder.record({
      entityKind: "mission",
      entityId: "q1",
      event: "quick-task-execution-started",
      actor: "camino:test",
      cause: "post-terminal",
      payload: {},
    });
    expect(afterTerminal).toMatchObject({ ok: false, code: "illegal-transition" });
  });

  it("exercises the urgent-pause interrupt and dispatch-while-paused refusal", () => {
    const { recorder } = newRecorder();
    apply(recorder, "mission", "m1", "mission-created", { source: "prd-intake" });
    apply(recorder, "mission", "m1", "plan-constructed", {
      reviewAttached: true,
      checklistRendered: true,
    });
    apply(
      recorder,
      "mission",
      "m1",
      "plan-approved",
      { dagAcyclic: true, executionSlotFree: true },
      "david",
    );
    apply(recorder, "mission", "m1", "integration-branch-created", { onboardingChecksGreen: true });
    apply(recorder, "issue", "i1", "issue-created", {
      origin: "plan-approval",
      unmetDependencies: 0,
    });

    expect(
      apply(
        recorder,
        "mission",
        "m1",
        "urgent-preemption",
        {},
        "camino:scheduler",
        "urgent task claims the lane",
      ),
    ).toBe("paused-urgent");
    // Dispatching against a paused mission violates the A.2#3 guard.
    const dispatch = recorder.record({
      entityKind: "issue",
      entityId: "i1",
      event: "dispatched",
      actor: "camino:scheduler",
      cause: "dispatch during pause",
      payload: { sequentialSlotFree: true, missionExecuting: false },
    });
    expect(dispatch).toMatchObject({ ok: false, code: "guard-rejected" });
    expect(
      apply(recorder, "mission", "m1", "interruption-resolved", { affectedIssuesHandled: true }),
    ).toBe("executing");
  });

  it("archives exactly once, in order (A.4#5)", () => {
    const { recorder } = newRecorder();
    apply(recorder, "attempt", "a1", "attempt-dispatched", {
      leaseGranted: true,
      leaseGeneration: 1,
    });
    apply(recorder, "attempt", "a1", "worker-completed", { finalHeadFetched: true });
    apply(recorder, "attempt", "a1", "verdict-recorded", {
      verdict: "fail",
      failureClass: "stub-completion",
    });

    const outOfOrder = recorder.record({
      entityKind: "attempt",
      entityId: "a1",
      event: "archival-completed",
      actor: "camino:janitor",
      cause: "archival with inverted sub-steps",
      payload: {
        quotasEnforced: true,
        archiveWrittenAt: "2026-07-19T10:00:05.000Z",
        ledgerRowAt: "2026-07-19T10:00:01.000Z",
        workspaceDestroyedAt: "2026-07-19T10:00:06.000Z",
      },
    });
    expect(outOfOrder).toMatchObject({ ok: false, code: "guard-rejected" });

    expect(
      apply(recorder, "attempt", "a1", "archival-completed", {
        quotasEnforced: true,
        archiveWrittenAt: "2026-07-19T10:00:00.000Z",
        ledgerRowAt: "2026-07-19T10:00:01.000Z",
        workspaceDestroyedAt: "2026-07-19T10:00:02.000Z",
      }),
    ).toBe("archived");

    const second = recorder.record({
      entityKind: "attempt",
      entityId: "a1",
      event: "archival-completed",
      actor: "camino:janitor",
      cause: "second archival",
      payload: {
        quotasEnforced: true,
        archiveWrittenAt: "2026-07-19T10:00:03.000Z",
        ledgerRowAt: "2026-07-19T10:00:04.000Z",
        workspaceDestroyedAt: "2026-07-19T10:00:05.000Z",
      },
    });
    expect(second).toMatchObject({ ok: false, code: "illegal-transition" });
  });

  it("rebuilds the identical view from the log alone (CAM-STATE-01)", () => {
    const path = tempDbPath();
    const { recorder } = newRecorder(path);

    // A walk mixing routes, interrupts, rejections, and counters.
    apply(recorder, "mission", "m1", "mission-created", { source: "prd-intake" });
    apply(recorder, "mission", "m1", "plan-constructed", {
      reviewAttached: true,
      checklistRendered: true,
    });
    apply(
      recorder,
      "mission",
      "m1",
      "plan-approved",
      { dagAcyclic: true, executionSlotFree: true },
      "david",
    );
    apply(recorder, "mission", "m1", "integration-branch-created", { onboardingChecksGreen: true });
    apply(recorder, "mission", "m1", "mission-paused", { attemptSettled: true }, "david", "pause");
    apply(recorder, "mission", "m1", "mission-resumed", {}, "david", "resume");
    apply(recorder, "issue", "i1", "issue-created", {
      origin: "plan-approval",
      unmetDependencies: 1,
    });
    apply(recorder, "issue", "i1", "dependency-merged", { allDepsMerged: true });
    driveToImplementing(recorder, "i1");
    apply(recorder, "issue", "i1", "attempt-failed", {});
    apply(recorder, "attempt", "a1", "attempt-dispatched", {
      leaseGranted: true,
      leaseGeneration: 1,
    });
    apply(recorder, "attempt", "a1", "rate-limited", {});
    recorder.record({
      entityKind: "mission",
      entityId: "m1",
      event: "push-confirmed",
      actor: "camino:merge",
      cause: "premature push",
      payload: { pushedSha: "x", descopedRequirements: [] },
    });
    apply(recorder, "mission", "q1", "quick-task-intake", {}, "david");
    apply(recorder, "mission", "q1", "contract-attached", {
      miniReviewAttached: true,
      observabilityAdjudicated: true,
    });

    // A fresh recorder over the same file replays to the identical view.
    const reopened = new SqliteEventStore(path);
    cleanups.push(() => reopened.close());
    const rebuilt = new TransitionRecorder(reopened);
    expect(rebuilt.currentView).toEqual(recorder.currentView);
    // And the incremental view equals its own from-scratch rebuild.
    const live = structuredClone(recorder.currentView);
    expect(recorder.rebuild()).toEqual(live);
    expect(rebuilt.verify()).toEqual([]);
  });
});
