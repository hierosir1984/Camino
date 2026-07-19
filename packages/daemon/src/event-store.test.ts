/**
 * SQLite event-store tests (CAM-STATE-01): append-only enforced in the
 * schema (triggers abort UPDATE/DELETE even from a separate raw
 * connection), envelope invariants as CHECK constraints, payload
 * round-trips, seq-ordered reads, and filter behavior.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { EventInput } from "@camino/shared";
import { SqliteEventStore } from "./event-store.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-event-store-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "events.db");
}

function openStore(path = ":memory:"): SqliteEventStore {
  let tick = 0;
  const store = new SqliteEventStore(path, {
    now: () => new Date(Date.UTC(2026, 6, 19, 12, 0, 0, (tick += 1))),
  });
  cleanups.push(() => store.close());
  return store;
}

function applied(overrides: Partial<EventInput> = {}): EventInput {
  return {
    entityKind: "mission",
    entityId: "m1",
    event: "mission-created",
    actor: "david",
    cause: "PRD intake",
    payload: { source: "prd-intake" },
    fromState: null,
    toState: "draft",
    outcome: "applied",
    ...overrides,
  };
}

describe("SqliteEventStore", () => {
  it("appends and reads back records in seq order with payload round-trip", () => {
    const store = openStore();
    const first = store.append(applied());
    const second = store.append(
      applied({
        event: "plan-constructed",
        payload: { reviewAttached: true, checklistRendered: true, nested: { deep: [1, 2] } },
        fromState: "draft",
        toState: "planned",
      }),
    );
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.recordedAt).toBe("2026-07-19T12:00:00.001Z");
    const all = store.read();
    expect(all.map((r) => r.seq)).toEqual([1, 2]);
    expect(all[1]?.payload).toEqual({
      reviewAttached: true,
      checklistRendered: true,
      nested: { deep: [1, 2] },
    });
  });

  it("records rejected attempts with their code and no target state", () => {
    const store = openStore();
    const rejected = store.append(
      applied({
        event: "integration-branch-created",
        fromState: "draft",
        toState: null,
        outcome: "rejected",
        rejectionCode: "illegal-transition",
      }),
    );
    expect(rejected.outcome).toBe("rejected");
    expect(rejected.toState).toBeNull();
    const readBack = store.read({ entityId: "m1" });
    expect(readBack[0]?.rejectionCode).toBe("illegal-transition");
  });

  it("filters by entity kind, entity id, and afterSeq", () => {
    const store = openStore();
    store.append(applied());
    store.append(
      applied({
        entityKind: "issue",
        entityId: "i1",
        event: "issue-created",
        payload: { origin: "plan-approval", unmetDependencies: 0 },
        toState: "ready",
      }),
    );
    store.append(
      applied({
        entityKind: "issue",
        entityId: "i2",
        event: "issue-created",
        payload: { origin: "plan-approval", unmetDependencies: 0 },
        toState: "ready",
      }),
    );
    expect(store.read({ entityKind: "issue" })).toHaveLength(2);
    expect(store.read({ entityKind: "issue", entityId: "i2" })).toHaveLength(1);
    expect(store.read({ afterSeq: 2 }).map((r) => r.seq)).toEqual([3]);
    expect(store.read({ afterSeq: 3 })).toEqual([]);
  });

  it("is append-only by construction: UPDATE and DELETE abort, even on a raw connection", () => {
    const path = tempDbPath();
    const store = openStore(path);
    store.append(applied());
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    expect(() => raw.prepare("UPDATE events SET actor = 'rewritten' WHERE seq = 1").run()).toThrow(
      /append-only/,
    );
    expect(() => raw.prepare("DELETE FROM events WHERE seq = 1").run()).toThrow(/append-only/);
    expect(store.read()).toHaveLength(1);
    expect(store.read()[0]?.actor).toBe("david");
  });

  it("keeps seq monotonic and never reused (AUTOINCREMENT)", () => {
    const store = openStore();
    store.append(applied());
    store.append(applied({ entityId: "m2" }));
    const third = store.append(applied({ entityId: "m3" }));
    expect(third.seq).toBe(3);
  });

  it("enforces the envelope invariants as CHECK constraints on raw inserts", () => {
    const path = tempDbPath();
    openStore(path);
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    const insert = (toState: string | null, outcome: string, rejectionCode: string | null) =>
      raw
        .prepare(
          `INSERT INTO events (entity_kind, entity_id, event, actor, cause, payload, from_state, to_state, outcome, rejection_code, recorded_at)
           VALUES ('mission', 'm1', 'e', 'a', 'c', '{}', NULL, ?, ?, ?, 't')`,
        )
        .run(toState, outcome, rejectionCode);
    // applied must carry a target; rejected must carry a code and no target.
    expect(() => insert(null, "applied", null)).toThrow(/CHECK/);
    expect(() => insert("draft", "rejected", "illegal-transition")).toThrow(/CHECK/);
    expect(() => insert(null, "rejected", null)).toThrow(/CHECK/);
    expect(() => insert(null, "rejected", "not-a-code")).toThrow(/CHECK/);
    expect(() => insert("draft", "applied", null)).not.toThrow();
  });

  it("uses WAL journaling on file databases", () => {
    const path = tempDbPath();
    openStore(path);
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("refuses a database from a different schema version", () => {
    const path = tempDbPath();
    const raw = new Database(path);
    raw.pragma("user_version = 99");
    raw.close();
    expect(() => new SqliteEventStore(path)).toThrow(/schema version 99/);
  });

  it("validates the envelope before writing", () => {
    const store = openStore();
    expect(() => store.append(applied({ actor: "" }))).toThrow(/actor/);
    expect(() => store.append(applied({ cause: "" }))).toThrow(/cause/);
    expect(() =>
      store.append(applied({ entityKind: "widget" as unknown as EventInput["entityKind"] })),
    ).toThrow(/entityKind/);
    expect(() =>
      store.append(applied({ payload: [] as unknown as EventInput["payload"] })),
    ).toThrow(/plain object/);
    expect(() => store.append(applied({ toState: null }))).toThrow(/toState/);
    expect(() => store.append(applied({ outcome: "rejected", toState: null }))).toThrow(
      /rejectionCode/,
    );
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => store.append(applied({ payload: circular }))).toThrow(/JSON-serializable/);
    expect(store.read()).toEqual([]);
  });
});
