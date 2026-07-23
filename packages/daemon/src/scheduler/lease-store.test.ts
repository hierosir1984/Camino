/**
 * SqliteLeaseStore tests (WP-114, CAM-STATE-04 / registry item 5 verbatim):
 * generations monotonic per environment and PERSISTED; heartbeat 30s TTL
 * 5min; every environment operation presents its generation and stale
 * writes are rejected; re-grant only after kill-confirm; exactly one
 * fenced owner per environment; the store's triggers refuse rewrites even
 * from a bypassing writer.
 */
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LEASE_TTL_MS } from "@camino/shared";
import { SqliteLeaseStore } from "./lease-store.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-lease-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function newStore(path?: string, startMs = Date.parse("2026-07-23T10:00:00.000Z")) {
  const clock = { ms: startMs };
  const store = new SqliteLeaseStore(path ?? join(tempDir(), "leases.sqlite"), {
    writerLock: null,
    now: () => new Date(clock.ms),
  });
  cleanups.push(() => store.close());
  return { store, clock };
}

describe("grant + monotonic generations (persisted in SQLite)", () => {
  it("grants generation 1, then strictly increasing generations across settles", () => {
    const path = join(tempDir(), "leases.sqlite");
    const { store } = newStore(path);
    const g1 = store.grant("validation:r1", "m1.I1.a1");
    expect(g1).toMatchObject({ ok: true, lease: { generation: 1 } });
    store.release("validation:r1", 1, { groupGone: true, outcome: "succeeded" });
    const g2 = store.grant("validation:r1", "m1.I1.a2");
    expect(g2).toMatchObject({ ok: true, lease: { generation: 2 } });
    store.release("validation:r1", 2, { groupGone: true, outcome: "succeeded" });
    store.close();
    cleanups.pop();
    // PERSISTED: a fresh open continues the sequence, never restarts it.
    const { store: reopened } = newStore(path);
    const g3 = reopened.grant("validation:r1", "m1.I1.a3");
    expect(g3).toMatchObject({ ok: true, lease: { generation: 3 } });
  });

  it("environments count independently", () => {
    const { store } = newStore();
    expect(store.grant("validation:r1", "a1")).toMatchObject({
      ok: true,
      lease: { generation: 1 },
    });
    expect(store.grant("validation:r2", "b1")).toMatchObject({
      ok: true,
      lease: { generation: 1 },
    });
  });
});

describe("exactly one fenced owner per environment", () => {
  it("refuses a second grant while the first is held and live", () => {
    const { store } = newStore();
    store.grant("env", "a1");
    const second = store.grant("env", "a2");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("held-live");
      expect(second.holder.holderAttemptId).toBe("a1");
    }
  });

  it("the one-fenced-owner rule holds in the DATABASE, not only in this class", () => {
    const dir = tempDir();
    const path = join(dir, "leases.sqlite");
    const { store } = newStore(path);
    store.grant("env", "a1");
    // A bypassing writer inserting a second held lease is refused by the
    // trigger (the WP-103 REPLACE-guard lesson: rewrites die in SQL).
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    // A forged second held lease dies on whichever guard fires first —
    // off-generation inserts on the current-generation trigger, and a
    // same-generation forgery on the fenced-owner/replacement guards.
    expect(() =>
      raw
        .prepare(
          "INSERT INTO leases (environment_id, generation, holder_attempt_id, granted_at, heartbeat_at, state) VALUES ('env', 2, 'evil', 't', 't', 'held')",
        )
        .run(),
    ).toThrow(/exactly one fenced owner|current generation/);
    expect(() =>
      raw
        .prepare(
          "INSERT INTO leases (environment_id, generation, holder_attempt_id, granted_at, heartbeat_at, state) VALUES ('env', 1, 'evil', 't', 't', 'held')",
        )
        .run(),
    ).toThrow(/exactly one fenced owner|replacement rejected/);
    // Nor can it decrement the generation counter…
    expect(() =>
      raw
        .prepare(
          "UPDATE lease_environments SET current_generation = 0 WHERE environment_id = 'env'",
        )
        .run(),
    ).toThrow(/monotonic/);
    // …rewrite a lease's identity, delete evidence, or resurrect a row.
    expect(() =>
      raw
        .prepare("UPDATE leases SET holder_attempt_id = 'evil' WHERE environment_id = 'env'")
        .run(),
    ).toThrow(/identity is immutable/);
    expect(() => raw.prepare("DELETE FROM leases").run()).toThrow(/DELETE rejected/);
  });
});

describe("heartbeat + TTL + re-grant only after kill-confirm", () => {
  it("a live heartbeat keeps the lease live; a lapse past the TTL demands kill-confirm", () => {
    const { store, clock } = newStore();
    store.grant("env", "a1");
    clock.ms += LEASE_TTL_MS - 1000;
    expect(store.heartbeat("env", 1)).toEqual({ ok: true });
    // Fresh heartbeat: still live at +TTL-1s from the NEW beat.
    clock.ms += LEASE_TTL_MS - 1000;
    expect(store.grant("env", "a2")).toMatchObject({ ok: false, code: "held-live" });
    // Now lapse past the TTL with no heartbeat.
    clock.ms += LEASE_TTL_MS + 1000;
    const refused = store.grant("env", "a2");
    expect(refused).toMatchObject({ ok: false, code: "kill-confirm-required" });
    // Expiry alone NEVER re-grants (the holder may still be running).
    // Only a recorded kill-confirm licenses the next generation.
    const settled = store.recordKillConfirm("env", 1, "process-group");
    expect(settled.ok).toBe(true);
    const regrant = store.grant("env", "a2");
    expect(regrant).toMatchObject({ ok: true, lease: { generation: 2 } });
  });

  it("inspectRecovered classifies held leases live vs lapsed and mutates nothing", () => {
    const { store, clock } = newStore();
    store.grant("live-env", "a1");
    store.grant("lapsed-env", "b1");
    clock.ms += LEASE_TTL_MS + 5000;
    store.heartbeat("live-env", 1);
    const report = store.inspectRecovered(new Date(clock.ms));
    expect(report.heldLive.map((l) => l.environmentId)).toEqual(["live-env"]);
    expect(report.lapsed.map((l) => l.lease.environmentId)).toEqual(["lapsed-env"]);
    expect(report.lapsed[0]?.lapsedMs).toBeGreaterThan(LEASE_TTL_MS);
    // The fence is steady state, not a mutation of this pass: the lapsed
    // lease still refuses re-grant until kill-confirm.
    expect(store.grant("lapsed-env", "b2")).toMatchObject({
      ok: false,
      code: "kill-confirm-required",
    });
  });
});

describe("fencing: every environment operation presents its generation", () => {
  it("admits the current held generation; rejects stale generations", () => {
    const { store } = newStore();
    store.grant("env", "a1");
    expect(store.admitOperation("env", 1)).toEqual({ ok: true });
    store.release("env", 1, { groupGone: true, outcome: "succeeded" });
    store.grant("env", "a2");
    // The FENCED former owner presents generation 1: rejected.
    expect(store.admitOperation("env", 1)).toMatchObject({ ok: false, code: "stale-generation" });
    expect(store.heartbeat("env", 1)).toMatchObject({ ok: false, code: "stale-generation" });
    expect(store.admitOperation("env", 2)).toEqual({ ok: true });
  });

  it("rejects operations under a settled (not-held) current lease", () => {
    const { store } = newStore();
    store.grant("env", "a1");
    store.recordKillConfirm("env", 1, "container");
    expect(store.admitOperation("env", 1)).toMatchObject({ ok: false, code: "not-held" });
  });

  it("rejects operations on an environment that never had a lease", () => {
    expect(newStore().store.admitOperation("ghost", 1)).toMatchObject({
      ok: false,
      code: "stale-generation",
      currentGeneration: null,
    });
  });
});

describe("settlement", () => {
  it("release demands the WP-105 ordering evidence (groupGone literally true)", () => {
    const { store } = newStore();
    store.grant("env", "a1");
    expect(() =>
      store.release("env", 1, { groupGone: false as unknown as true, outcome: "succeeded" }),
    ).toThrow(/groupGone/);
  });

  it("settled leases are absorbing (second settle reports already-settled)", () => {
    const { store } = newStore();
    store.grant("env", "a1");
    store.release("env", 1, { groupGone: true, outcome: "cancelled" });
    expect(store.release("env", 1, { groupGone: true, outcome: "cancelled" })).toMatchObject({
      ok: false,
      code: "already-settled",
    });
    expect(store.recordKillConfirm("env", 1, "container")).toMatchObject({
      ok: false,
      code: "already-settled",
    });
    const view = store.current("env");
    expect(view).toMatchObject({ state: "released", releasedOutcome: "cancelled" });
  });

  it("records the kill-confirm source for the audit trail", () => {
    const { store } = newStore();
    store.grant("env", "a1");
    const settled = store.recordKillConfirm("env", 1, "never-spawned");
    expect(settled.ok).toBe(true);
    expect(store.current("env")).toMatchObject({
      state: "kill-confirmed",
      killConfirmSource: "never-spawned",
    });
  });
});

describe("adoption verification (canon-store pattern)", () => {
  it("refuses a store whose schema objects were tampered", () => {
    const dir = tempDir();
    const path = join(dir, "leases.sqlite");
    const { store } = newStore(path);
    store.grant("env", "a1");
    store.close();
    cleanups.pop();
    const raw = new Database(path);
    raw.exec("DROP TRIGGER leases_one_fenced_owner");
    raw.close();
    expect(() => new SqliteLeaseStore(path, { writerLock: null })).toThrow(
      /tampered|schema objects/,
    );
  });

  it("requires an explicit writer-lock decision", () => {
    expect(() => new SqliteLeaseStore(join(tempDir(), "x.sqlite"), {} as never)).toThrow(
      /writerLock decision/,
    );
  });
});
