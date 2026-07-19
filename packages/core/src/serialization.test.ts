/**
 * Serialization primitives (WP-103, CAM-CORE-08): FIFO position is the seq
 * of the FIRST applied transition into `queued`, stable across pause/resume.
 */
import { describe, expect, it } from "vitest";
import type { EventRecord } from "@camino/shared";
import { auditActivationOrder, fifoOrder, queuedEntrySeqs } from "./serialization.js";

function record(overrides: Partial<EventRecord> & { seq: number }): EventRecord {
  return {
    entityKind: "mission",
    entityId: "m1",
    event: "plan-approved",
    actor: "david",
    cause: "test",
    payload: {},
    fromState: "planned",
    toState: "queued",
    outcome: "applied",
    recordedAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("queuedEntrySeqs", () => {
  it("maps each mission to the seq of its first applied entry into queued", () => {
    const entries = queuedEntrySeqs([
      record({ seq: 1, entityId: "mA" }),
      record({ seq: 2, entityId: "mB" }),
    ]);
    expect(entries.get("mA")).toBe(1);
    expect(entries.get("mB")).toBe(2);
  });

  it("keeps the FIRST entry when a mission re-enters queued (pause/resume keeps the place)", () => {
    const entries = queuedEntrySeqs([
      record({ seq: 1, entityId: "mA" }),
      // paused while queued…
      record({
        seq: 2,
        entityId: "mA",
        event: "mission-paused",
        fromState: "queued",
        toState: "paused-manual",
      }),
      // …and resumed back into queued: re-entry must not move it back.
      record({
        seq: 3,
        entityId: "mA",
        event: "mission-resumed",
        fromState: "paused-manual",
        toState: "queued",
      }),
    ]);
    expect(entries.get("mA")).toBe(1);
  });

  it("ignores rejected rows, other entity kinds, and non-queued targets", () => {
    const entries = queuedEntrySeqs([
      record({ seq: 1, outcome: "rejected", toState: null, rejectionCode: "guard-rejected" }),
      record({ seq: 2, entityKind: "issue", entityId: "i1", toState: "queued-quota" }),
      record({ seq: 3, toState: "approved" }),
    ]);
    expect(entries.size).toBe(0);
  });
});

describe("fifoOrder", () => {
  it("orders by recorded entry seq", () => {
    const entries = new Map([
      ["mB", 5],
      ["mA", 9],
      ["mC", 2],
    ]);
    expect(fifoOrder(["mA", "mB", "mC"], entries)).toEqual(["mC", "mB", "mA"]);
  });

  it("sorts ids without a recorded entry last, deterministically by id", () => {
    const entries = new Map([["mB", 5]]);
    expect(fifoOrder(["mZ", "mB", "mA"], entries)).toEqual(["mB", "mA", "mZ"]);
  });

  it("does not mutate its input", () => {
    const ids = ["mB", "mA"];
    fifoOrder(ids, new Map([["mA", 1]]));
    expect(ids).toEqual(["mB", "mA"]);
  });
});

describe("auditActivationOrder", () => {
  const LANES = new Map<string, "primary" | "urgent">([
    ["mA", "primary"],
    ["mB", "primary"],
    ["mU", "urgent"],
  ]);

  function activation(seq: number, entityId: string): EventRecord {
    return record({
      seq,
      entityId,
      event: "execution-slot-freed",
      fromState: "queued",
      toState: "approved",
    });
  }

  it("accepts in-order activations", () => {
    const deviations = auditActivationOrder(
      [
        record({ seq: 1, entityId: "mA" }), // mA enters queued
        record({ seq: 2, entityId: "mB" }), // mB enters queued behind it
        activation(3, "mA"),
        activation(4, "mB"),
      ],
      LANES,
    );
    expect(deviations).toEqual([]);
  });

  it("reports an activation that jumped the queue (r1 finding 4)", () => {
    const deviations = auditActivationOrder(
      [
        record({ seq: 1, entityId: "mA" }),
        record({ seq: 2, entityId: "mB" }),
        activation(3, "mB"), // mA was the head
      ],
      LANES,
    );
    expect(deviations).toEqual([
      { seq: 3, missionId: "mB", lane: "primary", reason: "jumped-queue", expectedHeadId: "mA" },
    ]);
  });

  it("reports an activation for a mission that never entered queued (r2 finding 10)", () => {
    // Empty lane: no honest recorder can produce this record, and the audit
    // must not certify it either.
    expect(auditActivationOrder([activation(1, "mA")], LANES)).toEqual([
      { seq: 1, missionId: "mA", lane: "primary", reason: "never-queued" },
    ]);
    // Non-empty lane: the never-queued activation names the true head too.
    expect(
      auditActivationOrder([record({ seq: 1, entityId: "mB" }), activation(2, "mA")], LANES),
    ).toEqual([
      { seq: 2, missionId: "mA", lane: "primary", reason: "never-queued", expectedHeadId: "mB" },
    ]);
  });

  it("audits lanes independently and honours first-entry order across re-entry", () => {
    const deviations = auditActivationOrder(
      [
        record({ seq: 1, entityId: "mA" }),
        record({ seq: 2, entityId: "mU" }), // urgent lane's own line
        record({ seq: 3, entityId: "mB" }),
        // mA pauses out of queued and resumes back in: keeps first-entry order.
        record({
          seq: 4,
          entityId: "mA",
          event: "mission-paused",
          fromState: "queued",
          toState: "paused-manual",
        }),
        record({
          seq: 5,
          entityId: "mA",
          event: "mission-resumed",
          fromState: "paused-manual",
          toState: "queued",
        }),
        activation(6, "mU"), // urgent head — its lane has only mU
        activation(7, "mA"), // primary head by first entry (seq 1 < 3)
        activation(8, "mB"),
      ],
      LANES,
    );
    expect(deviations).toEqual([]);
  });

  it("ignores rejected rows and missions outside the lane map", () => {
    const deviations = auditActivationOrder(
      [
        record({ seq: 1, entityId: "other-repo-mission" }),
        record({ seq: 2, entityId: "mA" }),
        record({
          seq: 3,
          entityId: "mA",
          event: "execution-slot-freed",
          outcome: "rejected",
          toState: null,
          rejectionCode: "guard-rejected",
        }),
        activation(4, "mA"),
      ],
      LANES,
    );
    expect(deviations).toEqual([]);
  });
});
