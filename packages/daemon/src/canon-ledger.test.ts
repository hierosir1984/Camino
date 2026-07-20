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

    // Descoped is terminal (r1 finding 13); the assumed path runs on a
    // fresh requirement id.
    expect(() =>
      store.proposeRequirement(R, { statement: "back again", sourceMissionId: "mission-2" }),
    ).toThrow(/not legal from disposition "descoped"/);
    const R2 = "CAM-DEMO-04";
    store.proposeRequirement(R2, { statement: "another", sourceMissionId: "mission-2" });
    store.disputeRequirement(R2, { reason: "unknowable history", conflictWith: "CAM-DEMO-02" });
    store.resolveDisputeAssumed(R2, { assumption: "legacy behavior intended" });
    expect(store.entry(R2)).toMatchObject({
      disposition: "assumed",
      statement: "another",
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

  it("exposes NO generic append surface, not even at runtime (CAM-CANON-01, r1 finding 2)", () => {
    const store = openStore(tempDir());
    const surface = store as unknown as Record<string, unknown>;
    expect(surface["append"]).toBeUndefined();
    expect(surface["recordFact"]).toBeUndefined();
    // The single write path is an ECMAScript #private method: it does not
    // exist as a property from outside the class, so a code-lifecycle
    // handler cannot reach it even reflectively.
    expect(surface["appendEvent"]).toBeUndefined();
    expect(Object.getOwnPropertyNames(store)).toEqual([]);
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(store)).filter((n) =>
        n.toLowerCase().includes("append"),
      ),
    ).toEqual([]);
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
    expect(() => new CanonLedgerStore(path)).toThrow(/schema objects/);
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

  it("the store handle is fully encapsulated: no reflective route to the connection", () => {
    const store = openStore(tempDir());
    // Every field is an ECMAScript #private: a buggy or hostile in-process
    // caller cannot pull the raw connection out of the store and drive it
    // into an enclosing transaction (the in-transaction refusal guards the
    // store's own code paths; encapsulation removes the reflective ones).
    expect(Object.getOwnPropertyNames(store)).toEqual([]);
    expect((store as unknown as Record<string, unknown>)["db"]).toBeUndefined();
  });
});

describe("round-1 regressions (falsification review findings)", () => {
  it("f1: INSERT OR REPLACE cannot rewrite history — the append-order guard fires before REPLACE deletes", () => {
    const dir = tempDir();
    const path = join(dir, "canon-ledger.sqlite");
    const store = new CanonLedgerStore(path, { now: fixedClock() });
    store.proposeRequirement(R, { statement: "s", sourceMissionId: "m1" });
    store.acceptRequirement(R);
    store.close();
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    expect(() =>
      raw
        .prepare(
          "INSERT OR REPLACE INTO canon_ledger (seq, requirement_id, event, actor, payload, recorded_at) VALUES (2, ?, 'requirement-descoped', ?, ?, ?)",
        )
        .run(R, DAVID_ACTOR, JSON.stringify({ reason: "smuggled" }), "2026-07-20T00:00:00.000Z"),
    ).toThrow(/conflicting or out-of-order INSERT rejected/);
    // History is intact and the store reopens clean.
    expect(raw.prepare("SELECT COUNT(*) AS n FROM canon_ledger").get()).toEqual({ n: 2 });
    raw.close();
    cleanups.pop();
    const reopened = new CanonLedgerStore(path, { now: fixedClock() });
    expect(reopened.entry(R)?.disposition).toBe("accepted");
    reopened.close();
  });

  it("f1: a raw INSERT at a below-max gap seq is refused (append order, not just conflicts)", () => {
    const dir = tempDir();
    const path = join(dir, "canon-ledger.sqlite");
    const store = new CanonLedgerStore(path, { now: fixedClock() });
    store.proposeRequirement(R, { statement: "s", sourceMissionId: "m1" });
    store.acceptRequirement(R);
    store.close();
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    expect(() =>
      raw
        .prepare(
          "INSERT INTO canon_ledger (seq, requirement_id, event, actor, payload, recorded_at) VALUES (1, ?, 'requirement-descoped', ?, ?, ?)",
        )
        .run(
          "CAM-DEMO-09",
          DAVID_ACTOR,
          JSON.stringify({ reason: "r" }),
          "2026-07-20T00:00:00.000Z",
        ),
    ).toThrow(/conflicting or out-of-order INSERT rejected/);
  });

  it("f9: an inert same-named trigger is a tampered store — definitions are verified, not names", () => {
    const dir = tempDir();
    const path = join(dir, "canon-ledger.sqlite");
    new CanonLedgerStore(path).close();
    const raw = new Database(path);
    raw.exec(`DROP TRIGGER canon_ledger_append_only_update;
CREATE TRIGGER canon_ledger_append_only_update BEFORE UPDATE ON canon_ledger
BEGIN SELECT 1; END;`);
    raw.close();
    expect(() => new CanonLedgerStore(path)).toThrow(/does not match this daemon's definition/);
  });

  it("f9: a dropped index is a tampered store", () => {
    const dir = tempDir();
    const path = join(dir, "canon-ledger.sqlite");
    new CanonLedgerStore(path).close();
    const raw = new Database(path);
    raw.exec("DROP INDEX idx_canon_ledger_requirement");
    raw.close();
    expect(() => new CanonLedgerStore(path)).toThrow(/schema objects/);
  });

  it("f8: sequence numbers beyond JavaScript's safe range are refused at insert AND at open", () => {
    const dir = tempDir();
    const path = join(dir, "canon-ledger.sqlite");
    new CanonLedgerStore(path).close();
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    // The schema CHECK refuses the insert outright.
    expect(() =>
      raw
        .prepare(
          "INSERT INTO canon_ledger (seq, requirement_id, event, actor, payload, recorded_at) VALUES (?, ?, 'requirement-proposed', ?, ?, ?)",
        )
        .run(
          BigInt(2) ** BigInt(53),
          R,
          DAVID_ACTOR,
          JSON.stringify({ statement: "s", sourceMissionId: "m" }),
          "2026-07-20T00:00:00.000Z",
        ),
    ).toThrow(/CHECK/);
  });

  it("f12: a raw row with a non-instant recordedAt is refused at adoption", () => {
    const dir = tempDir();
    const path = join(dir, "canon-ledger.sqlite");
    new CanonLedgerStore(path).close();
    const raw = new Database(path);
    raw
      .prepare(
        "INSERT INTO canon_ledger (requirement_id, event, actor, payload, recorded_at) VALUES (?, 'requirement-proposed', ?, ?, ?)",
      )
      .run(
        "CAM-DEMO-08",
        DAVID_ACTOR,
        JSON.stringify({ statement: "s", sourceMissionId: "m" }),
        "merge-event/not-an-iso-time",
      );
    raw.close();
    // (The impossible-date variant, 2026-02-30, is covered at the core
    // layer; one durable round-trip proves the store wires it.)
    expect(() => new CanonLedgerStore(path)).toThrow(/recordedAt/);
  });
});

describe("round-2 regressions (falsification review findings)", () => {
  it("f8: crossing the safe-integer ceiling via sqlite_sequence tampering is refused at insert", () => {
    const dir = tempDir();
    const path = join(dir, "canon-ledger.sqlite");
    const store = new CanonLedgerStore(path, { now: fixedClock() });
    store.proposeRequirement(R, { statement: "s", sourceMissionId: "m1" });
    store.close();
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    // Force the AUTOINCREMENT cursor just below the safe ceiling.
    raw
      .prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'canon_ledger'")
      .run(9007199254740990);
    // Two auto appends: the first lands at MAX_SAFE, the second would be
    // MAX_SAFE+1 and the CHECK refuses it.
    raw
      .prepare(
        "INSERT INTO canon_ledger (requirement_id, event, actor, payload, recorded_at) VALUES (?, 'requirement-accepted', 'david', '{}', '2026-07-20T00:00:00.000Z')",
      )
      .run(R);
    expect(() =>
      raw
        .prepare(
          "INSERT INTO canon_ledger (requirement_id, event, actor, payload, recorded_at) VALUES (?, 'requirement-descoped', 'david', ?, '2026-07-20T00:00:00.000Z')",
        )
        .run(R, JSON.stringify({ reason: "over the ceiling" })),
    ).toThrow(/CHECK/);
  });

  it("f9: an ATTACH/temp extra schema object is caught by the count check", () => {
    const dir = tempDir();
    const path = join(dir, "canon-ledger.sqlite");
    new CanonLedgerStore(path).close();
    const raw = new Database(path);
    raw.exec("CREATE TABLE extra_smuggled (x INTEGER)");
    raw.close();
    expect(() => new CanonLedgerStore(path)).toThrow(/schema objects|does not match/);
  });

  it("f12: an expanded-year recordedAt round-trips (writer and reader agree)", () => {
    const dir = tempDir();
    const path = join(dir, "canon-ledger.sqlite");
    // A clock at year 10000 produces "+010000-…"; the store must adopt it.
    let tick = 0;
    const farFuture = () => new Date(Date.UTC(10000, 0, 1, 0, 0, tick++));
    const store = new CanonLedgerStore(path, { now: farFuture });
    const rec = store.proposeRequirement(R, { statement: "s", sourceMissionId: "m1" });
    expect(rec.recordedAt.startsWith("+010000")).toBe(true);
    store.close();
    const reopened = new CanonLedgerStore(path, { now: farFuture });
    expect(reopened.read()[0]?.recordedAt.startsWith("+010000")).toBe(true);
    reopened.close();
  });
});
