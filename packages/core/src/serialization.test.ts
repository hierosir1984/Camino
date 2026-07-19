/**
 * Serialization primitives (WP-103, CAM-CORE-08): FIFO position is the seq
 * of the FIRST applied transition into `queued`, stable across pause/resume.
 */
import { describe, expect, it } from "vitest";
import type { EventRecord } from "@camino/shared";
import { fifoOrder, queuedEntrySeqs } from "./serialization.js";

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
