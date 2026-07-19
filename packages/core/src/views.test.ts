/**
 * Derived-view fold tests (CAM-STATE-01): pausedFrom bookkeeping, approval
 * bindings (A.4#4), failure counters that never count quota waits (A.2#5),
 * rejected records changing nothing, and replay verification.
 */
import { describe, expect, it } from "vitest";
import type { EventRecord } from "@camino/shared";
import { applyRecord, emptyView, foldView, verifyReplay } from "./views.js";

let seqCounter = 0;

function record(partial: {
  entityKind: EventRecord["entityKind"];
  entityId: string;
  event: string;
  payload?: Record<string, unknown>;
  fromState: string | null;
  toState: string | null;
  outcome?: EventRecord["outcome"];
  rejectionCode?: EventRecord["rejectionCode"];
}): EventRecord {
  seqCounter += 1;
  return {
    seq: seqCounter,
    entityKind: partial.entityKind,
    entityId: partial.entityId,
    event: partial.event,
    actor: "test",
    cause: "views.test",
    payload: partial.payload ?? {},
    fromState: partial.fromState,
    toState: partial.toState,
    outcome: partial.outcome ?? "applied",
    ...(partial.rejectionCode === undefined ? {} : { rejectionCode: partial.rejectionCode }),
    recordedAt: "2026-07-19T12:00:00.000Z",
  };
}

describe("foldView", () => {
  it("builds entity snapshots from creation and transition records", () => {
    const view = foldView([
      record({
        entityKind: "mission",
        entityId: "m1",
        event: "mission-created",
        payload: { source: "prd-intake" },
        fromState: null,
        toState: "draft",
      }),
      record({
        entityKind: "issue",
        entityId: "i1",
        event: "issue-created",
        payload: { origin: "plan-approval", unmetDependencies: 0 },
        fromState: null,
        toState: "ready",
      }),
      record({
        entityKind: "attempt",
        entityId: "a1",
        event: "attempt-dispatched",
        payload: { leaseGranted: true, leaseGeneration: 1 },
        fromState: null,
        toState: "running",
      }),
    ]);
    expect(view.missions.get("m1")).toEqual({
      state: "draft",
      route: "integration",
      failureCount: 0,
    });
    expect(view.issues.get("i1")).toEqual({ state: "ready", failureCount: 0 });
    expect(view.attempts.get("a1")).toEqual({ state: "running" });
  });

  it("rejected records never change the view", () => {
    const creation = record({
      entityKind: "issue",
      entityId: "i1",
      event: "issue-created",
      payload: { origin: "plan-approval", unmetDependencies: 0 },
      fromState: null,
      toState: "ready",
    });
    const rejected = record({
      entityKind: "issue",
      entityId: "i1",
      event: "worker-started",
      payload: { leaseValid: true },
      fromState: "ready",
      toState: null,
      outcome: "rejected",
      rejectionCode: "illegal-transition",
    });
    const view = foldView([creation, rejected]);
    expect(view.issues.get("i1")?.state).toBe("ready");
  });

  it("keeps the first pausedFrom across a re-pause and clears it on resume", () => {
    const view = emptyView();
    applyRecord(
      view,
      record({
        entityKind: "mission",
        entityId: "m1",
        event: "quick-task-intake",
        fromState: null,
        toState: "draft",
      }),
    );
    applyRecord(
      view,
      record({
        entityKind: "mission",
        entityId: "m1",
        event: "mission-paused",
        payload: { attemptSettled: true },
        fromState: "draft",
        toState: "paused-manual",
      }),
    );
    expect(view.missions.get("m1")?.pausedFrom).toBe("draft");
    // Re-pause (any-active row includes paused-manual): pausedFrom survives.
    applyRecord(
      view,
      record({
        entityKind: "mission",
        entityId: "m1",
        event: "mission-paused",
        payload: { attemptSettled: true },
        fromState: "paused-manual",
        toState: "paused-manual",
      }),
    );
    expect(view.missions.get("m1")?.pausedFrom).toBe("draft");
    applyRecord(
      view,
      record({
        entityKind: "mission",
        entityId: "m1",
        event: "mission-resumed",
        payload: { resumeTo: "draft" },
        fromState: "paused-manual",
        toState: "draft",
      }),
    );
    expect(view.missions.get("m1")?.pausedFrom).toBeUndefined();
  });

  it("tracks candidate identity and clears the approval binding on rebuild (A.4#4)", () => {
    const view = emptyView();
    const apply = (
      event: string,
      payload: Record<string, unknown>,
      fromState: string,
      toState: string,
    ) =>
      applyRecord(
        view,
        record({ entityKind: "mission", entityId: "m1", event, payload, fromState, toState }),
      );
    applyRecord(
      view,
      record({
        entityKind: "mission",
        entityId: "m1",
        event: "mission-created",
        payload: { source: "prd-intake" },
        fromState: null,
        toState: "draft",
      }),
    );
    apply("mission-gate-green", { candidateSha: "cand-1" }, "executing", "awaiting-merge-approval");
    expect(view.missions.get("m1")?.currentCandidateSha).toBe("cand-1");
    apply(
      "mission-merge-approved",
      { candidateSha: "cand-1", packetHash: "p1", authority: "david" },
      "awaiting-merge-approval",
      "merging",
    );
    expect(view.missions.get("m1")?.approval).toEqual({ candidateSha: "cand-1", packetHash: "p1" });
    // Base moved: rebuild green → new candidate, approval binding cleared.
    apply(
      "candidate-rebuilt",
      { green: true, newCandidateSha: "cand-2" },
      "merging",
      "awaiting-merge-approval",
    );
    expect(view.missions.get("m1")?.currentCandidateSha).toBe("cand-2");
    expect(view.missions.get("m1")?.approval).toBeUndefined();
  });

  it("clears the approval binding when a rejection returns the mission to executing", () => {
    const view = emptyView();
    applyRecord(
      view,
      record({
        entityKind: "mission",
        entityId: "m1",
        event: "mission-created",
        payload: { source: "prd-intake" },
        fromState: null,
        toState: "draft",
      }),
    );
    applyRecord(
      view,
      record({
        entityKind: "mission",
        entityId: "m1",
        event: "mission-merge-approved",
        payload: { candidateSha: "cand-1", packetHash: "p1", authority: "david" },
        fromState: "awaiting-merge-approval",
        toState: "merging",
      }),
    );
    applyRecord(
      view,
      record({
        entityKind: "mission",
        entityId: "m1",
        event: "candidate-rebuilt",
        payload: { green: false, newCandidateSha: "cand-2" },
        fromState: "merging",
        toState: "executing",
      }),
    );
    const snapshot = view.missions.get("m1");
    expect(snapshot?.approval).toBeUndefined();
    // A red rebuild's candidate never becomes the current candidate.
    expect(snapshot?.currentCandidateSha).toBeUndefined();
  });

  it("records failure counters from the enriched payloads and never from quota waits", () => {
    const view = emptyView();
    applyRecord(
      view,
      record({
        entityKind: "issue",
        entityId: "i1",
        event: "issue-created",
        payload: { origin: "plan-approval", unmetDependencies: 0 },
        fromState: null,
        toState: "ready",
      }),
    );
    const step = (event: string, payload: Record<string, unknown>, from: string, to: string) =>
      applyRecord(
        view,
        record({
          entityKind: "issue",
          entityId: "i1",
          event,
          payload,
          fromState: from,
          toState: to,
        }),
      );
    step("dispatched", { sequentialSlotFree: true, missionExecuting: true }, "ready", "claimed");
    step("worker-started", { leaseValid: true }, "claimed", "implementing");
    step("attempt-failed", { failureCount: 1 }, "implementing", "ready");
    expect(view.issues.get("i1")?.failureCount).toBe(1);
    // Quota wait: state changes, counter does not (A.2#5).
    step("provider-window-exhausted", {}, "ready", "queued-quota");
    step("quota-window-freed", {}, "queued-quota", "ready");
    expect(view.issues.get("i1")?.failureCount).toBe(1);
    step("dispatched", { sequentialSlotFree: true, missionExecuting: true }, "ready", "claimed");
    step("worker-started", { leaseValid: true }, "claimed", "implementing");
    step("final-head-submitted", { quarantinePassed: true }, "implementing", "validating");
    step("validation-failed", { repairPolicyAllows: true, failureCount: 2 }, "validating", "ready");
    expect(view.issues.get("i1")?.failureCount).toBe(2);
  });

  it("fails loud on a log that could not have been recorded", () => {
    expect(() =>
      foldView([
        record({
          entityKind: "mission",
          entityId: "m1",
          event: "plan-rejected",
          fromState: "planned",
          toState: "draft",
        }),
      ]),
    ).toThrow(/unknown mission/);
    expect(() =>
      foldView([
        record({
          entityKind: "mission",
          entityId: "m1",
          event: "not-a-creation-event",
          fromState: null,
          toState: "draft",
        }),
      ]),
    ).toThrow(/unknown mission creation event/);
  });
});

describe("verifyReplay", () => {
  it("accepts a log the machines agree with", () => {
    const records = [
      record({
        entityKind: "mission",
        entityId: "m1",
        event: "mission-created",
        payload: { source: "prd-intake" },
        fromState: null,
        toState: "draft",
      }),
      record({
        entityKind: "mission",
        entityId: "m1",
        event: "plan-constructed",
        payload: { reviewAttached: true, checklistRendered: true },
        fromState: "draft",
        toState: "planned",
      }),
      record({
        entityKind: "mission",
        entityId: "m1",
        event: "integration-branch-created",
        payload: { onboardingChecksGreen: true },
        fromState: "planned",
        toState: "executing",
        outcome: "rejected",
        rejectionCode: "illegal-transition",
      }),
    ];
    expect(verifyReplay(records)).toEqual([]);
  });

  it("reports applied records the machines now reject or retarget", () => {
    const divergences = verifyReplay([
      record({
        entityKind: "mission",
        entityId: "m1",
        event: "mission-created",
        payload: { source: "prd-intake" },
        fromState: null,
        toState: "draft",
      }),
      // Recorded as applied, but draft --integration-branch-created--> is illegal.
      record({
        entityKind: "mission",
        entityId: "m1",
        event: "integration-branch-created",
        payload: { onboardingChecksGreen: true },
        fromState: "draft",
        toState: "executing",
      }),
    ]);
    expect(divergences).toHaveLength(1);
    expect(divergences[0]?.problem).toMatch(/rejects/);
  });

  it("reports machine-decided rejections that are legal today", () => {
    const divergences = verifyReplay([
      record({
        entityKind: "mission",
        entityId: "m1",
        event: "mission-created",
        payload: { source: "prd-intake" },
        fromState: null,
        toState: "draft",
      }),
      record({
        entityKind: "mission",
        entityId: "m1",
        event: "plan-constructed",
        payload: { reviewAttached: true, checklistRendered: true },
        fromState: "draft",
        toState: null,
        outcome: "rejected",
        rejectionCode: "guard-rejected",
      }),
    ]);
    expect(divergences).toHaveLength(1);
    expect(divergences[0]?.problem).toMatch(/now applies/);
  });
});
