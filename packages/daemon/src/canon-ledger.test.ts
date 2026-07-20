/**
 * Durable intent ledger tests (WP-109, CAM-CANON-01 acceptance): the
 * mutation surface is six named user-action methods; merge/revert/abandon
 * observations have no path in — refused at the type level (no generic
 * append exists), the decision level (core), and the schema level (raw
 * SQL CHECKs) — and a storm of code-lifecycle facts leaves the ledger
 * byte-identical.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DAVID_ACTOR, projectStatus } from "@camino/core";
import { CanonFactsStore } from "./canon-facts.js";
import { CanonLedgerStore } from "./canon-ledger.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-canon-ledger-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const R = "CAM-DEMO-01";
const SHA = "d".repeat(40);

function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 20, 0, 0, tick++));
}

function openStore(dir: string): CanonLedgerStore {
  const store = new CanonLedgerStore(join(dir, "canon-ledger.sqlite"), { now: fixedClock() });
  cleanups.push(() => store.close());
  return store;
}

describe("the six named user-action methods", () => {
  it("drive the full disposition lifecycle and read back canonically", () => {
    const store = openStore(tempDir());
    store.proposeRequirement(R, { statement: "demo works", sourceMissionId: "mission-1" });
    store.acceptRequirement(R);
    store.disputeRequirement(R, { reason: "later PRD conflicts", conflictWith: null });
    store.resolveDisputeAccepted(R, { resolution: "revised", statement: "demo works v2" });
    store.descopeRequirement(R, { reason: "descoped after all" });

    const records = store.read();
    expect(records.map((r) => r.event)).toEqual([
      "requirement-proposed",
      "requirement-accepted",
      "requirement-disputed",
      "dispute-resolved-accepted",
      "requirement-descoped",
    ]);
    expect(records.every((r) => r.actor === DAVID_ACTOR)).toBe(true);
    expect(store.entry(R)?.disposition).toBe("descoped");
    expect(store.lastSeq).toBe(5);

    // Re-proposal (D2) and the assumed path.
    store.proposeRequirement(R, { statement: "back again", sourceMissionId: "mission-2" });
    store.disputeRequirement(R, { reason: "unknowable history", conflictWith: "CAM-DEMO-02" });
    store.resolveDisputeAssumed(R, { assumption: "legacy behavior intended" });
    expect(store.entry(R)).toMatchObject({
      disposition: "assumed",
      statement: "back again",
      assumption: "legacy behavior intended",
    });
  });

  it("illegal method calls throw with the lifecycle's reason (daemon-bug loudness)", () => {
    const store = openStore(tempDir());
    expect(() => store.acceptRequirement(R)).toThrow(/no ledger entry/);
    store.proposeRequirement(R, { statement: "s", sourceMissionId: "m1" });
    expect(() => store.resolveDisputeAssumed(R, { assumption: "a" })).toThrow(/not legal from/);
    expect(() =>
      store.proposeRequirement(R, { statement: "again", sourceMissionId: "m1" }),
    ).toThrow(/not legal from/);
    expect(() =>
      store.proposeRequirement("not-an-id", { statement: "s", sourceMissionId: "m" }),
    ).toThrow(/stable-id grammar/);
    expect(() =>
      store.proposeRequirement("CAM-DEMO-03", { statement: "s\u0000x", sourceMissionId: "m" }),
    ).toThrow(/embedded NUL/);
  });

  it("exposes NO generic append surface (CAM-CANON-01 by construction)", () => {
    const store = openStore(tempDir());
    const surface = store as unknown as Record<string, unknown>;
    expect(surface["append"]).toBeUndefined();
    expect(surface["recordFact"]).toBeUndefined();
    // @ts-expect-error — appendEvent is private: code-lifecycle handlers cannot name it.
    const privateProbe: unknown = store.appendEvent;
    expect(privateProbe).toBeTypeOf("function");
  });
});

describe("CAM-CANON-01 acceptance: merge/revert/abandon events cannot touch intent", () => {
  it("a storm of code-lifecycle facts leaves the ledger records and dispositions identical", () => {
    const dir = tempDir();
    const ledger = openStore(dir);
    const facts = new CanonFactsStore(join(dir, "canon-facts.sqlite"), { now: fixedClock() });
    cleanups.push(() => facts.close());

    ledger.proposeRequirement(R, { statement: "demo works", sourceMissionId: "mission-1" });
    ledger.acceptRequirement(R);
    const before = ledger.read();

    // Everything that happens to code, incl. the events CAM-CANON-01
    // names: merge (landed), revert, abandonment-shaped suspicion.
    facts.recordFact({
      requirementId: R,
      kind: "implementation-recorded",
      actor: "camino:merge",
      payload: { branch: "mission-m1", sha: SHA },
    });
    facts.recordFact({
      requirementId: R,
      kind: "landed-on-main",
      actor: "camino:merge",
      payload: { sha: SHA },
    });
    facts.recordFact({
      requirementId: R,
      kind: "revert-recorded",
      actor: "camino:merge",
      payload: { contextKind: "main", sha: SHA },
    });
    facts.recordFact({
      requirementId: R,
      kind: "absence-suspected",
      actor: "camino:reconciler",
      payload: { contextKind: "main", reason: "mission abandoned mid-flight" },
    });

    const after = ledger.read();
    expect(after).toEqual(before);
    expect(ledger.entry(R)?.disposition).toBe("accepted");

    // And the projection's disposition column comes from the ledger alone.
    const tuples = projectStatus(ledger.currentView(), facts.read(), {
      kind: "main",
      headSha: SHA,
    });
    expect(tuples.get(R)?.disposition).toBe("accepted");
    expect(tuples.get(R)?.implementation).toEqual({ kind: "suspected-absent" });
  });

  it("raw SQL cannot smuggle a code event in: event CHECK refuses non-user-action names", () => {
    const dir = tempDir();
    const path = join(dir, "canon-ledger.sqlite");
    new CanonLedgerStore(path).close();
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    for (const event of [
      "merge-landed",
      "revert-recorded",
      "mission-abandoned",
      "landed-on-main",
    ]) {
      expect(() =>
        raw
          .prepare(
            "INSERT INTO canon_ledger (requirement_id, event, actor, payload, recorded_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(R, event, DAVID_ACTOR, "{}", "2026-07-20T00:00:00.000Z"),
      ).toThrow(/CHECK/);
    }
  });

  it("raw SQL cannot smuggle a system actor in: actor CHECK is pinned to the user", () => {
    const dir = tempDir();
    const path = join(dir, "canon-ledger.sqlite");
    new CanonLedgerStore(path).close();
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    for (const actor of ["camino:merge", "camino:reconciler", "worker:codex-cli", ""]) {
      expect(() =>
        raw
          .prepare(
            "INSERT INTO canon_ledger (requirement_id, event, actor, payload, recorded_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(R, "requirement-proposed", actor, "{}", "2026-07-20T00:00:00.000Z"),
      ).toThrow(/CHECK/);
    }
  });

  it("UPDATE and DELETE are refused by schema triggers (append-only)", () => {
    const dir = tempDir();
    const path = join(dir, "canon-ledger.sqlite");
    const store = new CanonLedgerStore(path, { now: fixedClock() });
    store.proposeRequirement(R, { statement: "s", sourceMissionId: "m1" });
    store.close();
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    expect(() => raw.prepare("UPDATE canon_ledger SET payload = '{}' WHERE seq = 1").run()).toThrow(
      /append-only/,
    );
    expect(() => raw.prepare("DELETE FROM canon_ledger WHERE seq = 1").run()).toThrow(
      /append-only/,
    );
  });
});

describe("fail-closed adoption and tamper evidence", () => {
  it("refuses a history the lifecycle disagrees with, even when every column CHECK passes", () => {
    const dir = tempDir();
    const path = join(dir, "canon-ledger.sqlite");
    new CanonLedgerStore(path).close();
    const raw = new Database(path);
    // Legal column values, illegal ORDER: accepted before proposed.
    raw
      .prepare(
        "INSERT INTO canon_ledger (requirement_id, event, actor, payload, recorded_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(R, "requirement-accepted", DAVID_ACTOR, "{}", "2026-07-20T00:00:00.000Z");
    raw.close();
    expect(() => new CanonLedgerStore(path)).toThrow(/lifecycle verification/);
  });

  it("refuses a claimed-version ledger missing its append-only triggers", () => {
    const dir = tempDir();
    const path = join(dir, "canon-ledger.sqlite");
    new CanonLedgerStore(path).close();
    const raw = new Database(path);
    raw.exec("DROP TRIGGER canon_ledger_append_only_delete");
    raw.close();
    expect(() => new CanonLedgerStore(path)).toThrow(/missing canon_ledger_append_only_delete/);
  });

  it("refuses an unknown schema version", () => {
    const dir = tempDir();
    const path = join(dir, "canon-ledger.sqlite");
    new CanonLedgerStore(path).close();
    const raw = new Database(path);
    raw.pragma("user_version = 99");
    raw.close();
    expect(() => new CanonLedgerStore(path)).toThrow(/schema version 99/);
  });

  it("refused opens close the native handle (no fd leak on retry loops)", () => {
    const dir = tempDir();
    const path = join(dir, "canon-ledger.sqlite");
    new CanonLedgerStore(path).close();
    const raw = new Database(path);
    raw.pragma("user_version = 99");
    raw.close();
    const fdDir = "/dev/fd";
    const before = readdirSync(fdDir).length;
    for (let i = 0; i < 100; i += 1) {
      expect(() => new CanonLedgerStore(path)).toThrow(/schema version 99/);
    }
    const after = readdirSync(fdDir).length;
    expect(after - before).toBeLessThan(10);
  });
});

describe("single-writer discipline", () => {
  it("the CAS refuses an interleaving second writer instance", () => {
    const dir = tempDir();
    const path = join(dir, "canon-ledger.sqlite");
    const a = new CanonLedgerStore(path, { now: fixedClock() });
    cleanups.push(() => a.close());
    const b = new CanonLedgerStore(path, { now: fixedClock() });
    cleanups.push(() => b.close());
    a.proposeRequirement(R, { statement: "s", sourceMissionId: "m1" });
    expect(() =>
      b.proposeRequirement("CAM-DEMO-02", { statement: "t", sourceMissionId: "m1" }),
    ).toThrow(/single-writer contract/);
  });

  it("asserts the writer lock on every append when wired", () => {
    const dir = tempDir();
    const path = join(dir, "canon-ledger.sqlite");
    let held = true;
    const lock = {
      get held(): boolean {
        return held;
      },
      assertHeld(context: string): void {
        if (!held) throw new Error(`${context} attempted without the writer lock held`);
      },
    };
    const store = new CanonLedgerStore(path, { now: fixedClock(), writerLock: lock });
    cleanups.push(() => store.close());
    store.proposeRequirement(R, { statement: "s", sourceMissionId: "m1" });
    held = false;
    expect(() => store.acceptRequirement(R)).toThrow(/without the writer lock/);
  });

  it("refuses to append inside an enclosing transaction", () => {
    const dir = tempDir();
    const path = join(dir, "canon-ledger.sqlite");
    const store = new CanonLedgerStore(path, { now: fixedClock() });
    cleanups.push(() => store.close());
    // Reach the private db handle the way a buggy composition might: via
    // another connection is not enough (inTransaction is per-connection),
    // so drive the store's own connection through a reflective handle.
    const db = (store as unknown as { db: Database.Database }).db;
    db.exec("BEGIN");
    try {
      expect(() => store.proposeRequirement(R, { statement: "s", sourceMissionId: "m1" })).toThrow(
        /enclosing transaction/,
      );
    } finally {
      db.exec("ROLLBACK");
    }
  });
});
