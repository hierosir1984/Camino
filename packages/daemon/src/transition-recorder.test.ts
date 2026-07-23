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
          checklistApproved: true,
          dagAcyclic: true,
          executionSlotFree: true,
        },
        "david",
        "plan review",
      ),
    ).toBe("approved");
    apply(recorder, "mission", "m1", "integration-branch-created", {
      branchCreated: true,
      missionPrCreated: true,
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
        contractRef: { issueId: "i1", contractVersion: 1, contractHash: "a".repeat(64) },
      }),
    ).toBe("running");
    apply(recorder, "attempt", "a1", "worker-completed", { finalHeadFetched: true });
    apply(recorder, "issue", "i1", "final-head-submitted", { quarantinePassed: true });
    apply(recorder, "attempt", "a1", "verdict-recorded", {
      quarantineAndValidationComplete: true,
      verdict: "pass",
    });
    apply(recorder, "attempt", "a1", "archival-completed", {
      quotasEnforced: true,
      ledgerRowReferencesArchive: true,
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
      packetHash: "packet-1",
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
        landedOnMain: true,
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
      payload: { branchCreated: true, missionPrCreated: true, onboardingChecksGreen: true },
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
      payload: { checklistApproved: true, dagAcyclic: false, executionSlotFree: true },
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
    apply(recorder, "mission", "q1", "quick-task-execution-started", {
      targetIsMainCandidate: true,
      noIntegrationBranchNoFold: true,
    });
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
      { checklistApproved: true, dagAcyclic: true, executionSlotFree: true },
      "david",
    );
    apply(recorder, "mission", "m1", "integration-branch-created", {
      branchCreated: true,
      missionPrCreated: true,
      onboardingChecksGreen: true,
    });
    apply(recorder, "mission", "m1", "mission-gate-green", {
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
      newPacketHash: "packet-2",
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
      payload: { landedOnMain: true, pushedSha: "cand-1", descopedRequirements: [] },
    });
    expect(wrongPush).toMatchObject({ ok: false, code: "guard-rejected" });
    expect(
      apply(recorder, "mission", "m1", "push-confirmed", {
        landedOnMain: true,
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
      contractRef: { issueId: "i1", contractVersion: 1, contractHash: "a".repeat(64) },
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
      contractRef: { issueId: "i1", contractVersion: 1, contractHash: "a".repeat(64) },
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
      contractRef: { issueId: "i1", contractVersion: 1, contractHash: "a".repeat(64) },
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
    apply(recorder, "mission", "q1", "quick-task-execution-started", {
      targetIsMainCandidate: true,
      noIntegrationBranchNoFold: true,
    });
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
      payload: { targetIsMainCandidate: true, noIntegrationBranchNoFold: true },
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
      { checklistApproved: true, dagAcyclic: true, executionSlotFree: true },
      "david",
    );
    apply(recorder, "mission", "m1", "integration-branch-created", {
      branchCreated: true,
      missionPrCreated: true,
      onboardingChecksGreen: true,
    });
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
      contractRef: { issueId: "i1", contractVersion: 1, contractHash: "a".repeat(64) },
    });
    apply(recorder, "attempt", "a1", "worker-completed", { finalHeadFetched: true });
    apply(recorder, "attempt", "a1", "verdict-recorded", {
      quarantineAndValidationComplete: true,
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
        ledgerRowReferencesArchive: true,
        archiveWrittenAt: "2026-07-19T10:00:05.000Z",
        ledgerRowAt: "2026-07-19T10:00:01.000Z",
        workspaceDestroyedAt: "2026-07-19T10:00:06.000Z",
      },
    });
    expect(outOfOrder).toMatchObject({ ok: false, code: "guard-rejected" });

    expect(
      apply(recorder, "attempt", "a1", "archival-completed", {
        quotasEnforced: true,
        ledgerRowReferencesArchive: true,
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
        ledgerRowReferencesArchive: true,
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
      { checklistApproved: true, dagAcyclic: true, executionSlotFree: true },
      "david",
    );
    apply(recorder, "mission", "m1", "integration-branch-created", {
      branchCreated: true,
      missionPrCreated: true,
      onboardingChecksGreen: true,
    });
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
      contractRef: { issueId: "i1", contractVersion: 1, contractHash: "a".repeat(64) },
    });
    apply(recorder, "attempt", "a1", "rate-limited", {});
    recorder.record({
      entityKind: "mission",
      entityId: "m1",
      event: "push-confirmed",
      actor: "camino:merge",
      cause: "premature push",
      payload: { landedOnMain: true, pushedSha: "x", descopedRequirements: [] },
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
  it("refuses payloads carrying the reserved fields — and logs the refusal (review r1 finding 1)", () => {
    const { store, recorder } = newRecorder();
    apply(recorder, "mission", "m1", "mission-created", { source: "prd-intake" });
    apply(recorder, "mission", "m1", "plan-constructed", {
      reviewAttached: true,
      checklistRendered: true,
    });

    // A payload "type" must never redirect the machine to a different row.
    const forgedType = recorder.record({
      entityKind: "mission",
      entityId: "m1",
      event: "plan-rejected",
      actor: "david",
      cause: "payload attempts to smuggle a different event type",
      payload: { type: "plan-constructed", reviewAttached: true, checklistRendered: true },
    });
    expect(forgedType).toMatchObject({ ok: false, code: "malformed-payload" });
    expect(recorder.currentState("mission", "m1")).toBe("planned");

    // A payload "actor" must never impersonate the envelope actor.
    const forgedActor = recorder.record({
      entityKind: "mission",
      entityId: "m1",
      event: "plan-approved",
      actor: "camino:scheduler",
      cause: "payload attempts to claim David as actor",
      payload: {
        actor: "david",
        checklistApproved: true,
        dagAcyclic: true,
        executionSlotFree: true,
      },
    });
    expect(forgedActor).toMatchObject({ ok: false, code: "malformed-payload" });

    const rejected = store.read().filter((r) => r.outcome === "rejected");
    expect(rejected.map((r) => r.rejectionCode)).toEqual([
      "malformed-payload",
      "malformed-payload",
    ]);
    expect(recorder.verify()).toEqual([]);
  });

  it("binds David-actioned rows to the envelope actor (review r1 finding 7)", () => {
    const { recorder } = newRecorder();
    apply(recorder, "mission", "m1", "mission-created", { source: "prd-intake" });
    apply(recorder, "mission", "m1", "plan-constructed", {
      reviewAttached: true,
      checklistRendered: true,
    });
    const impersonated = recorder.record({
      entityKind: "mission",
      entityId: "m1",
      event: "plan-approved",
      actor: "mallory",
      cause: "approval without David as the envelope actor",
      payload: { checklistApproved: true, dagAcyclic: true, executionSlotFree: true },
    });
    expect(impersonated).toMatchObject({ ok: false, code: "guard-rejected" });
    expect(recorder.currentState("mission", "m1")).toBe("planned");
    expect(
      apply(
        recorder,
        "mission",
        "m1",
        "plan-approved",
        { checklistApproved: true, dagAcyclic: true, executionSlotFree: true },
        "david",
      ),
    ).toBe("approved");
  });

  it("decides on the JSON-canonical payload it persists (review r1 finding 5)", () => {
    const { store, recorder } = newRecorder();
    // Infinity survives no JSON round-trip: the guard must see null and
    // refuse, and the log must agree with a re-derivation.
    const outcome = recorder.record({
      entityKind: "issue",
      entityId: "i1",
      event: "issue-created",
      actor: "camino:planner",
      cause: "payload with a non-finite number",
      payload: { origin: "plan-approval", unmetDependencies: Infinity },
    });
    expect(outcome).toMatchObject({ ok: false, code: "guard-rejected" });
    expect(store.read().at(-1)?.payload["unmetDependencies"]).toBeNull();
    expect(recorder.verify()).toEqual([]);
    // A payload JSON cannot represent at all is refused AND logged (round 2):
    // the stand-in payload carries a reserved key, so replay re-derives the
    // same malformed-payload refusal.
    const unserializable = recorder.record({
      entityKind: "issue",
      entityId: "i1",
      event: "issue-created",
      actor: "camino:planner",
      cause: "unserializable payload",
      payload: { origin: "plan-approval", unmetDependencies: 1n as unknown as number },
    });
    expect(unserializable).toMatchObject({ ok: false, code: "malformed-payload" });
    const arrayish = recorder.record({
      entityKind: "issue",
      entityId: "i1",
      event: "issue-created",
      actor: "camino:planner",
      cause: "payload whose toJSON yields an array",
      payload: { toJSON: () => [] } as unknown as Record<string, unknown>,
    });
    expect(arrayish).toMatchObject({ ok: false, code: "malformed-payload" });
    const rejected = store.read().filter((r) => r.rejectionCode === "malformed-payload");
    expect(rejected).toHaveLength(2);
    expect(recorder.verify()).toEqual([]);
  });

  it("snapshots the request once — accessor games cannot desync decision and record (review r2 finding 1)", () => {
    const { store, recorder } = newRecorder();
    let reads = 0;
    const request = {
      entityKind: "mission" as const,
      entityId: "m1",
      get event() {
        reads += 1;
        return reads === 1 ? "mission-created" : "quick-task-intake";
      },
      actor: "david",
      cause: "accessor probe",
      payload: { source: "prd-intake" },
    };
    const outcome = recorder.record(request);
    expect(outcome).toMatchObject({ ok: true, ref: "A.1#1" });
    // The durable record carries the event the decision used, so the route
    // derived on replay matches the live one.
    expect(store.read()[0]?.event).toBe("mission-created");
    expect(recorder.currentView.missions.get("m1")?.route).toBe("integration");
    expect(recorder.verify()).toEqual([]);
  });

  it("single-observation canonicalization: the canonical form is the sole authority for reserved keys (r2 f4 superseded by r4 f2)", () => {
    const { store, recorder } = newRecorder();
    apply(recorder, "mission", "m1", "mission-created", { source: "prd-intake" });
    apply(recorder, "mission", "m1", "plan-constructed", {
      reviewAttached: true,
      checklistRendered: true,
    });
    // A reserved key with a REPRESENTABLE value appears in the canonical
    // form and is refused.
    const carried = recorder.record({
      entityKind: "mission",
      entityId: "m1",
      event: "plan-rejected",
      actor: "david",
      cause: "reserved key in the canonical form",
      payload: { type: "plan-constructed" },
    });
    expect(carried).toMatchObject({ ok: false, code: "malformed-payload" });
    // An undefined-valued reserved key is absent from the single observation
    // (JSON drops it), so it is absent from what is decided AND persisted —
    // it cannot redirect anything, and the transition proceeds on the
    // declared event. There is no second read for a time-varying object to
    // diverge from.
    const dropped = recorder.record({
      entityKind: "mission",
      entityId: "m1",
      event: "plan-rejected",
      actor: "david",
      cause: "undefined-valued reserved key drops out of the observation",
      payload: { type: undefined } as unknown as Record<string, unknown>,
    });
    expect(dropped).toMatchObject({ ok: true, to: "draft" });
    expect(store.read().at(-1)?.payload).toEqual({});
    expect(recorder.verify()).toEqual([]);
  });

  it("guards refuse (and the log records) a malformed shape instead of throwing (review r1 finding 4)", () => {
    const { store, recorder } = newRecorder();
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
      { checklistApproved: true, dagAcyclic: true, executionSlotFree: true },
      "david",
    );
    apply(recorder, "mission", "m1", "integration-branch-created", {
      branchCreated: true,
      missionPrCreated: true,
      onboardingChecksGreen: true,
    });
    apply(recorder, "mission", "m1", "mission-gate-green", {
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
      recorder,
      "mission",
      "m1",
      "mission-merge-approved",
      { authority: "david", candidateSha: "cand-1", packetHash: "packet-1" },
      "david",
    );
    const before = store.read().length;
    // descopedRequirements omitted and mistyped: refused, logged, state kept.
    for (const payload of [
      { landedOnMain: true, pushedSha: "cand-1" },
      { landedOnMain: true, pushedSha: "cand-1", descopedRequirements: "not-an-array" },
      { landedOnMain: true, pushedSha: "cand-1", descopedRequirements: [1, 2] },
    ]) {
      const outcome = recorder.record({
        entityKind: "mission",
        entityId: "m1",
        event: "push-confirmed",
        actor: "camino:merge",
        cause: "malformed completion payload",
        payload,
      });
      expect(outcome).toMatchObject({ ok: false, code: "guard-rejected" });
    }
    expect(store.read().length).toBe(before + 3);
    expect(recorder.currentState("mission", "m1")).toBe("merging");
    expect(recorder.verify()).toEqual([]);
  });

  it("hands out snapshot views only — mutating one cannot forge recorded context (review r1 finding 2)", () => {
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
      { checklistApproved: true, dagAcyclic: true, executionSlotFree: true },
      "david",
    );
    apply(recorder, "mission", "m1", "integration-branch-created", {
      branchCreated: true,
      missionPrCreated: true,
      onboardingChecksGreen: true,
    });
    apply(recorder, "mission", "m1", "mission-gate-green", {
      allIssuesTerminal: true,
      noStrandedRequirement: true,
      gateGreen: true,
      reviewPass: true,
      foldOnBranch: true,
      rollupAndPrPopulated: true,
      freshnessHolds: true,
      candidateSha: "cand-real",
      packetHash: "packet-real",
    });
    const leaked = recorder.currentView;
    const snapshot = leaked.missions.get("m1");
    expect(snapshot?.currentCandidateSha).toBe("cand-real");
    if (snapshot) snapshot.currentCandidateSha = "cand-forged";
    // The recorder's own view is untouched: a forged-SHA approval still fails.
    const forged = recorder.record({
      entityKind: "mission",
      entityId: "m1",
      event: "mission-merge-approved",
      actor: "david",
      cause: "approval of a SHA planted into a leaked view",
      payload: { authority: "david", candidateSha: "cand-forged", packetHash: "packet-real" },
    });
    expect(forged).toMatchObject({ ok: false, code: "guard-rejected" });
    expect(recorder.currentView.missions.get("m1")?.currentCandidateSha).toBe("cand-real");
  });

  it("detects a second writer and refuses to record over a stale view (single-writer, CAM-STATE-03)", () => {
    const path = tempDbPath();
    const storeA = new SqliteEventStore(path);
    cleanups.push(() => storeA.close());
    const recorderA = new TransitionRecorder(storeA);
    const storeB = new SqliteEventStore(path);
    cleanups.push(() => storeB.close());
    const recorderB = new TransitionRecorder(storeB);

    apply(recorderA, "mission", "m1", "mission-created", { source: "prd-intake" });
    expect(() =>
      recorderB.record({
        entityKind: "mission",
        entityId: "m1",
        event: "mission-created",
        actor: "camino:test",
        cause: "second writer",
        payload: { source: "prd-intake" },
      }),
    ).toThrow(/single-writer/);
    // After a rebuild the second recorder sees the store and proceeds honestly.
    recorderB.rebuild();
    const duplicate = recorderB.record({
      entityKind: "mission",
      entityId: "m1",
      event: "mission-created",
      actor: "camino:test",
      cause: "duplicate creation after rebuild",
      payload: { source: "prd-intake" },
    });
    expect(duplicate).toMatchObject({ ok: false, code: "already-exists" });
  });

  it("verify() re-derives the log and reports forged rows appended behind the recorder's back", () => {
    const { store, recorder } = newRecorder();
    apply(recorder, "mission", "m1", "mission-created", { source: "prd-intake" });
    apply(recorder, "mission", "m1", "plan-constructed", {
      reviewAttached: true,
      checklistRendered: true,
    });
    // Forged rows appended raw behind the recorder: a wrong source state and
    // a mislabeled rejection of a legal transition.
    store.append({
      entityKind: "mission",
      entityId: "m1",
      event: "plan-rejected",
      actor: "david",
      cause: "forged source state",
      payload: {},
      fromState: "draft",
      toState: "draft",
      outcome: "applied",
    });
    store.append({
      entityKind: "issue",
      entityId: "i1",
      event: "issue-created",
      actor: "camino:planner",
      cause: "honest issue creation",
      payload: { origin: "plan-approval", unmetDependencies: 0 },
      fromState: null,
      toState: "ready",
      outcome: "applied",
    });
    store.append({
      entityKind: "issue",
      entityId: "i1",
      event: "provider-window-exhausted",
      actor: "camino:scheduler",
      cause: "mislabeled rejection of a legal transition",
      payload: {},
      fromState: "ready",
      toState: null,
      outcome: "rejected",
      rejectionCode: "unknown-entity",
    });
    // A rejected row whose recorded enrichment was forged (review r2
    // finding 5): re-derivation computes failureCount 1, not 999.
    store.append({
      entityKind: "issue",
      entityId: "i1",
      event: "attempt-failed",
      actor: "camino:scheduler",
      cause: "forged rejected-row enrichment",
      payload: { failureCount: 999 },
      fromState: "ready",
      toState: null,
      outcome: "rejected",
      rejectionCode: "guard-rejected",
    });
    const problems = recorder.verify();
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.some((d) => /fromState/.test(d.problem))).toBe(true);
    expect(problems.some((d) => /now applies/.test(d.problem))).toBe(true);
    expect(problems.some((d) => /rejection payload diverges/.test(d.problem))).toBe(true);
  });

  it("binds escalation answers to David while blocked recoveries stay open (A.1#21 split, review r2 finding 3)", () => {
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
      { checklistApproved: true, dagAcyclic: true, executionSlotFree: true },
      "david",
    );
    apply(recorder, "mission", "m1", "integration-branch-created", {
      branchCreated: true,
      missionPrCreated: true,
      onboardingChecksGreen: true,
    });
    apply(recorder, "mission", "m1", "escalation-raised", {});
    const nonDavid = recorder.record({
      entityKind: "mission",
      entityId: "m1",
      event: "obstacle-cleared",
      actor: "camino:scheduler",
      cause: "non-David escalation answer",
      payload: { affectedIssuesTransitioned: true },
    });
    expect(nonDavid).toMatchObject({ ok: false, code: "guard-rejected" });
    expect(
      apply(
        recorder,
        "mission",
        "m1",
        "obstacle-cleared",
        { affectedIssuesTransitioned: true },
        "david",
      ),
    ).toBe("executing");
    // Blocked recoveries are obstacle-driven, not David-bound.
    apply(recorder, "mission", "m1", "blocker-hit", {});
    expect(
      apply(
        recorder,
        "mission",
        "m1",
        "obstacle-cleared",
        { affectedIssuesTransitioned: true },
        "camino:poller",
      ),
    ).toBe("executing");
  });
  it("recovery is fail-closed: a forged log is refused at construction and rebuild (review r3 finding 3)", () => {
    const path = tempDbPath();
    const store = new SqliteEventStore(path);
    cleanups.push(() => store.close());
    // A structurally valid row no machine would produce: created straight
    // into a terminal state.
    store.append({
      entityKind: "mission",
      entityId: "m1",
      event: "mission-created",
      actor: "camino:forger",
      cause: "impossible durable state",
      payload: { source: "prd-intake" },
      fromState: null,
      toState: "complete",
      outcome: "applied",
    });
    expect(() => new TransitionRecorder(store)).toThrow(/fails replay verification/);
  });

  it("verify() reports rather than throws on rows the fold rejects (review r3 finding 4)", () => {
    const { store, recorder } = newRecorder();
    // Applied row for an entity that was never created: decide rejects it,
    // the fold cannot apply it, and verification must return divergences.
    store.append({
      entityKind: "mission",
      entityId: "ghost",
      event: "plan-constructed",
      actor: "camino:forger",
      cause: "applied row for unknown entity",
      payload: { reviewAttached: true, checklistRendered: true },
      fromState: "draft",
      toState: "planned",
      outcome: "applied",
    });
    const problems = recorder.verify();
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(problems.some((d) => /fold rejects the record/.test(d.problem))).toBe(true);
  });

  it("canonicalization contains property traps as logged refusals (review r3 finding 6)", () => {
    const { store, recorder } = newRecorder();
    apply(recorder, "mission", "m1", "mission-created", { source: "prd-intake" });
    apply(recorder, "mission", "m1", "plan-constructed", {
      reviewAttached: true,
      checklistRendered: true,
    });
    // A reserved key whose getter deletes itself during serialization: the
    // single observation still captures its value into the canonical form,
    // which is refused.
    const selfDeleting: Record<string, unknown> = { dagAcyclic: true, executionSlotFree: true };
    Object.defineProperty(selfDeleting, "type", {
      configurable: true,
      enumerable: true,
      get() {
        delete selfDeleting["type"];
        return "plan-rejected";
      },
    });
    const dodged = recorder.record({
      entityKind: "mission",
      entityId: "m1",
      event: "plan-approved",
      actor: "david",
      cause: "self-deleting reserved key",
      payload: selfDeleting,
    });
    expect(dodged).toMatchObject({ ok: false, code: "malformed-payload" });
    // A Proxy whose trap throws DURING the single observation: refused and
    // logged as unrepresentable, never thrown past.
    const trapped = new Proxy(
      { dagAcyclic: true },
      {
        get() {
          throw new Error("value trap");
        },
      },
    ) as Record<string, unknown>;
    const trappedOutcome = recorder.record({
      entityKind: "mission",
      entityId: "m1",
      event: "plan-approved",
      actor: "david",
      cause: "throwing property trap",
      payload: trapped,
    });
    expect(trappedOutcome).toMatchObject({ ok: false, code: "malformed-payload" });
    // A trap the observation never touches (empty own keys) canonicalizes to
    // {} — refused by the guards and logged, just under a different code.
    const dormant = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("descriptor trap");
        },
      },
    ) as Record<string, unknown>;
    const dormantOutcome = recorder.record({
      entityKind: "mission",
      entityId: "m1",
      event: "plan-approved",
      actor: "david",
      cause: "dormant property trap",
      payload: dormant,
    });
    expect(dormantOutcome).toMatchObject({ ok: false, code: "guard-rejected" });
    const rejected = store.read().filter((r) => r.outcome === "rejected");
    expect(rejected.map((r) => r.rejectionCode)).toEqual([
      "malformed-payload",
      "malformed-payload",
      "guard-rejected",
    ]);
    expect(recorder.currentState("mission", "m1")).toBe("planned");
    expect(recorder.verify()).toEqual([]);
  });

  it("store append snapshots its input and CAS option exactly once (review r3 findings 5, 7)", () => {
    const { store } = newRecorder();
    let idReads = 0;
    let seqReads = 0;
    const input = {
      entityKind: "mission" as const,
      get entityId() {
        idReads += 1;
        return `m${idReads}`;
      },
      event: "mission-created",
      actor: "david",
      cause: "accessor input",
      payload: { source: "prd-intake" },
      fromState: null,
      toState: "draft",
      outcome: "applied" as const,
    };
    const options = {
      get expectedLastSeq() {
        seqReads += 1;
        return 0;
      },
    };
    const returned = store.append(input, options);
    expect(idReads).toBe(1);
    expect(seqReads).toBe(1);
    // The returned record and the persisted row carry the same single read.
    expect(returned.entityId).toBe("m1");
    expect(store.read()[0]?.entityId).toBe("m1");
  });

  it("store append refuses to run inside an enclosing transaction (review r3 finding 5)", () => {
    const { store } = newRecorder();
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    const wrapped = db.transaction(() => {
      store.append({
        entityKind: "mission",
        entityId: "m1",
        event: "mission-created",
        actor: "david",
        cause: "append inside enclosing transaction",
        payload: { source: "prd-intake" },
        fromState: null,
        toState: "draft",
        outcome: "applied",
      });
    });
    expect(() => wrapped()).toThrow(/enclosing transaction/);
    expect(store.read()).toEqual([]);
  });
  it("walks the approved amendments end to end (AMEND-1/3/4/5 applied 2026-07-19)", () => {
    const { recorder } = newRecorder();
    // Quick task to executing.
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
    apply(recorder, "mission", "q1", "quick-task-execution-started", {
      targetIsMainCandidate: true,
      noIntegrationBranchNoFold: true,
    });
    apply(recorder, "mission", "q1", "quick-validation-green", {
      packetPopulated: true,
      rollupAndPrPopulated: true,
      contractChecksGreen: true,
      repoFastSuiteGreen: true,
      freshnessVsMainHolds: true,
      candidateSha: "qcand-1",
      packetHash: "qpacket-1",
    });
    apply(
      recorder,
      "mission",
      "q1",
      "mission-merge-approved",
      { authority: "david", candidateSha: "qcand-1", packetHash: "qpacket-1" },
      "david",
    );
    // AMEND-3: a red rebuild inside the retry bound returns to executing.
    expect(
      apply(recorder, "mission", "q1", "candidate-rebuilt", {
        green: false,
        newCandidateSha: "qcand-2",
      }),
    ).toBe("executing");
    // AMEND-4: the 4th validation failure escalates the issue from validating.
    apply(recorder, "issue", "i1", "issue-created", {
      origin: "plan-approval",
      unmetDependencies: 0,
    });
    driveToImplementing(recorder, "i1");
    apply(recorder, "issue", "i1", "attempt-failed", {});
    driveToImplementing(recorder, "i1");
    apply(recorder, "issue", "i1", "attempt-failed", {});
    driveToImplementing(recorder, "i1");
    apply(recorder, "issue", "i1", "attempt-failed", {});
    driveToImplementing(recorder, "i1");
    apply(recorder, "issue", "i1", "final-head-submitted", { quarantinePassed: true });
    expect(apply(recorder, "issue", "i1", "validation-failed", { repairPolicyAllows: true })).toBe(
      "escalated",
    );
    // AMEND-1: a quick-task issue in merge-pending lands when the mission push confirms.
    apply(recorder, "issue", "i2", "issue-created", {
      origin: "plan-approval",
      unmetDependencies: 0,
    });
    driveToImplementing(recorder, "i2");
    apply(recorder, "issue", "i2", "final-head-submitted", { quarantinePassed: true });
    apply(recorder, "issue", "i2", "validation-green", { freshnessHolds: true });
    expect(
      apply(recorder, "issue", "i2", "quick-task-mission-landed", {
        missionPushConfirmed: true,
        targetMainCandidate: true,
      }),
    ).toBe("merged");
    // AMEND-5: a pre-execution quick task re-routes with the work summary
    // alone; a paused-manual one resolves by the RECORDED paused-from state.
    apply(recorder, "mission", "q2", "quick-task-intake", {}, "david");
    expect(
      apply(recorder, "mission", "q2", "gate-violation-detected", { workSummaryCarried: true }),
    ).toBe("re-routed");
    apply(recorder, "mission", "q3", "quick-task-intake", {}, "david");
    apply(recorder, "mission", "q3", "mission-paused", { attemptSettled: true }, "david");
    // Paused from draft: no branch exists, none required (enrichment supplies
    // the recorded paused-from; the caller's claim is overwritten).
    expect(
      apply(recorder, "mission", "q3", "gate-violation-detected", {
        workSummaryCarried: true,
        pausedFrom: "executing",
      }),
    ).toBe("re-routed");
    expect(recorder.verify()).toEqual([]);
  });
});
