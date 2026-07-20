/**
 * Canon-fact store tests (WP-109, CAM-CANON-03 persistence): the same
 * store discipline every Camino log carries — append-only triggers,
 * tamper-evident open, fail-closed shape-verified adoption, unconditional
 * CAS, constructor cleanup — over the observation vocabulary the status
 * projection folds.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CANON_FACT_KINDS } from "@camino/shared";
import type { CanonFactKind } from "@camino/shared";
import { CanonFactsStore } from "./canon-facts.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-canon-facts-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const R = "CAM-DEMO-01";
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 20, 0, 0, tick++));
}

function openStore(dir: string): CanonFactsStore {
  const store = new CanonFactsStore(join(dir, "canon-facts.sqlite"), { now: fixedClock() });
  cleanups.push(() => store.close());
  return store;
}

describe("recordFact", () => {
  it("round-trips every fact kind with canonical payloads and filtered reads", () => {
    const store = openStore(tempDir());
    store.recordFact({
      requirementId: R,
      kind: "requirement-touched",
      actor: "camino:quarantine",
      payload: { branch: "mission-m1", sha: SHA },
    });
    store.recordFact({
      requirementId: R,
      kind: "implementation-recorded",
      actor: "camino:merge",
      payload: { branch: "mission-m1", sha: SHA },
    });
    store.recordFact({
      requirementId: R,
      kind: "landed-on-main",
      actor: "camino:merge",
      payload: { sha: SHA2 },
    });
    store.recordFact({
      requirementId: R,
      kind: "mainline-inherited",
      actor: "camino:branch-sync",
      payload: { branch: "mission-m2", sha: SHA2 },
    });
    store.recordFact({
      requirementId: R,
      kind: "revert-recorded",
      actor: "camino:merge",
      payload: { contextKind: "main", sha: SHA2 },
    });
    store.recordFact({
      requirementId: R,
      kind: "absence-suspected",
      actor: "camino:reconciler",
      payload: { contextKind: "main", reason: "external edit" },
    });
    store.recordFact({
      requirementId: R,
      kind: "absence-resolved",
      actor: "camino:reconciler",
      payload: { contextKind: "main", resolution: "absent" },
    });
    store.recordFact({
      requirementId: R,
      kind: "verification-verdict",
      actor: "camino:validation",
      payload: {
        contextKind: "branch",
        branch: "mission-m1",
        headSha: SHA,
        baseSha: SHA2,
        outcome: "pass",
      },
    });
    store.recordFact({
      requirementId: R,
      kind: "verification-blocked",
      actor: "camino:validation",
      payload: { contextKind: "main", reason: "probe quarantined" },
    });
    store.recordFact({
      requirementId: "CAM-DEMO-02",
      kind: "verification-unblocked",
      actor: "camino:validation",
      payload: { contextKind: "main" },
    });

    expect(new Set(store.read().map((f) => f.kind)).size).toBe(CANON_FACT_KINDS.length);
    expect(store.read({ requirementId: R })).toHaveLength(9);
    expect(store.read({ afterSeq: 9 })).toHaveLength(1);
    expect(store.lastSeq).toBe(10);
    const first = store.read()[0];
    expect(first?.recordedAt).toBe("2026-07-20T00:00:00.000Z");
  });

  it("throws on shape violations (daemon-bug loudness, validated in core)", () => {
    const store = openStore(tempDir());
    expect(() =>
      store.recordFact({
        requirementId: R,
        kind: "merge-landed" as CanonFactKind,
        actor: "camino:merge",
        payload: {},
      }),
    ).toThrow(/not a canon fact kind/);
    expect(() =>
      store.recordFact({
        requirementId: "nope",
        kind: "landed-on-main",
        actor: "camino:merge",
        payload: { sha: SHA },
      }),
    ).toThrow(/stable-id grammar/);
    expect(() =>
      store.recordFact({
        requirementId: R,
        kind: "landed-on-main",
        actor: "camino:merge",
        payload: { sha: "short" },
      }),
    ).toThrow(/40-hex/);
    expect(() =>
      store.recordFact({
        requirementId: R,
        kind: "landed-on-main",
        actor: "camino:merge",
        payload: { sha: SHA, extra: 1 },
      }),
    ).toThrow(/unexpected payload field/);
    expect(() =>
      store.recordFact({
        requirementId: R,
        kind: "implementation-recorded",
        actor: "camino:merge",
        payload: { branch: "main", sha: SHA },
      }),
    ).toThrow(/must not be "main"/);
  });

  it("refuses non-JSON-object payloads at the single observation point", () => {
    const store = openStore(tempDir());
    expect(() =>
      store.recordFact({
        requirementId: R,
        kind: "landed-on-main",
        actor: "camino:merge",
        payload: {
          sha: SHA,
          cyclic: undefined,
          toJSON: () => "not-an-object",
        } as unknown as Record<string, unknown>,
      }),
    ).toThrow(/plain JSON object/);
  });
});

describe("store discipline", () => {
  it("UPDATE and DELETE are refused by schema triggers", () => {
    const dir = tempDir();
    const path = join(dir, "canon-facts.sqlite");
    const store = new CanonFactsStore(path, { now: fixedClock() });
    store.recordFact({
      requirementId: R,
      kind: "landed-on-main",
      actor: "camino:merge",
      payload: { sha: SHA },
    });
    store.close();
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    expect(() => raw.prepare("UPDATE canon_facts SET payload = '{}' WHERE seq = 1").run()).toThrow(
      /append-only/,
    );
    expect(() => raw.prepare("DELETE FROM canon_facts WHERE seq = 1").run()).toThrow(/append-only/);
  });

  it("unknown kinds are refused by the schema CHECK even via raw SQL", () => {
    const dir = tempDir();
    const path = join(dir, "canon-facts.sqlite");
    new CanonFactsStore(path).close();
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    expect(() =>
      raw
        .prepare(
          "INSERT INTO canon_facts (requirement_id, kind, actor, payload, recorded_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(R, "requirement-accepted", "camino:merge", "{}", "2026-07-20T00:00:00.000Z"),
    ).toThrow(/CHECK/);
  });

  it("fail-closed adoption: a raw row that fails shape validation refuses the open", () => {
    const dir = tempDir();
    const path = join(dir, "canon-facts.sqlite");
    new CanonFactsStore(path).close();
    const raw = new Database(path);
    raw
      .prepare(
        "INSERT INTO canon_facts (requirement_id, kind, actor, payload, recorded_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(R, "landed-on-main", "camino:merge", '{"sha":"not-a-sha"}', "2026-07-20T00:00:00.000Z");
    raw.close();
    expect(() => new CanonFactsStore(path)).toThrow(/shape verification/);
  });

  it("refuses a claimed-version store missing its triggers, and an unknown version", () => {
    const dir = tempDir();
    const path = join(dir, "canon-facts.sqlite");
    new CanonFactsStore(path).close();
    let raw = new Database(path);
    raw.exec("DROP TRIGGER canon_facts_append_only_update");
    raw.close();
    expect(() => new CanonFactsStore(path)).toThrow(/schema objects/);

    const path2 = join(dir, "canon-facts-2.sqlite");
    new CanonFactsStore(path2).close();
    raw = new Database(path2);
    raw.pragma("user_version = 7");
    raw.close();
    expect(() => new CanonFactsStore(path2)).toThrow(/schema version 7/);
  });

  it("refused opens close the native handle (no fd leak on retry loops)", () => {
    const dir = tempDir();
    const path = join(dir, "canon-facts.sqlite");
    new CanonFactsStore(path).close();
    const raw = new Database(path);
    raw.pragma("user_version = 7");
    raw.close();
    const before = readdirSync("/dev/fd").length;
    for (let i = 0; i < 100; i += 1) {
      expect(() => new CanonFactsStore(path)).toThrow(/schema version 7/);
    }
    const after = readdirSync("/dev/fd").length;
    expect(after - before).toBeLessThan(10);
  });

  it("the CAS refuses an interleaving second writer instance", () => {
    const dir = tempDir();
    const path = join(dir, "canon-facts.sqlite");
    const a = new CanonFactsStore(path, { now: fixedClock() });
    cleanups.push(() => a.close());
    const b = new CanonFactsStore(path, { now: fixedClock() });
    cleanups.push(() => b.close());
    a.recordFact({
      requirementId: R,
      kind: "landed-on-main",
      actor: "camino:merge",
      payload: { sha: SHA },
    });
    expect(() =>
      b.recordFact({
        requirementId: R,
        kind: "landed-on-main",
        actor: "camino:merge",
        payload: { sha: SHA2 },
      }),
    ).toThrow(/single-writer contract/);
  });

  it("asserts the writer lock on every append when wired", () => {
    const dir = tempDir();
    let held = true;
    const lock = {
      get held(): boolean {
        return held;
      },
      assertHeld(context: string): void {
        if (!held) throw new Error(`${context} attempted without the writer lock held`);
      },
    };
    const store = new CanonFactsStore(join(dir, "canon-facts.sqlite"), {
      now: fixedClock(),
      writerLock: lock,
    });
    cleanups.push(() => store.close());
    store.recordFact({
      requirementId: R,
      kind: "landed-on-main",
      actor: "camino:merge",
      payload: { sha: SHA },
    });
    held = false;
    expect(() =>
      store.recordFact({
        requirementId: R,
        kind: "landed-on-main",
        actor: "camino:merge",
        payload: { sha: SHA2 },
      }),
    ).toThrow(/without the writer lock/);
  });
});

describe("round-1 regressions (falsification review findings)", () => {
  it("f1: INSERT OR REPLACE cannot rewrite facts — the append-order guard fires first", () => {
    const dir = tempDir();
    const path = join(dir, "canon-facts.sqlite");
    const store = new CanonFactsStore(path, { now: fixedClock() });
    store.recordFact({
      requirementId: R,
      kind: "landed-on-main",
      actor: "camino:merge",
      payload: { sha: SHA },
    });
    store.close();
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    expect(() =>
      raw
        .prepare(
          "INSERT OR REPLACE INTO canon_facts (seq, requirement_id, kind, actor, payload, recorded_at) VALUES (1, ?, 'revert-recorded', 'x:y', ?, ?)",
        )
        .run(R, JSON.stringify({ contextKind: "main", sha: SHA2 }), "2026-07-20T00:00:00.000Z"),
    ).toThrow(/conflicting or out-of-order INSERT rejected/);
    expect(raw.prepare("SELECT kind FROM canon_facts WHERE seq = 1").get()).toEqual({
      kind: "landed-on-main",
    });
  });

  it("f8: an unsafe raw seq is refused by the schema CHECK; a tampered-schema file is refused at open", () => {
    const dir = tempDir();
    const path = join(dir, "canon-facts.sqlite");
    new CanonFactsStore(path).close();
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    expect(() =>
      raw
        .prepare(
          "INSERT INTO canon_facts (seq, requirement_id, kind, actor, payload, recorded_at) VALUES (?, ?, 'landed-on-main', 'x:y', ?, ?)",
        )
        .run(BigInt(2) ** BigInt(53), R, JSON.stringify({ sha: SHA }), "2026-07-20T00:00:00.000Z"),
    ).toThrow(/CHECK/);
  });

  it("f9: an inert same-named trigger is a tampered store", () => {
    const dir = tempDir();
    const path = join(dir, "canon-facts.sqlite");
    new CanonFactsStore(path).close();
    const raw = new Database(path);
    raw.exec(`DROP TRIGGER canon_facts_append_only_delete;
CREATE TRIGGER canon_facts_append_only_delete BEFORE DELETE ON canon_facts
BEGIN SELECT 1; END;`);
    raw.close();
    expect(() => new CanonFactsStore(path)).toThrow(/does not match this daemon's definition/);
  });

  it("f12: a raw row with a non-instant recordedAt is refused at adoption", () => {
    const dir = tempDir();
    const path = join(dir, "canon-facts.sqlite");
    new CanonFactsStore(path).close();
    const raw = new Database(path);
    raw
      .prepare(
        "INSERT INTO canon_facts (requirement_id, kind, actor, payload, recorded_at) VALUES (?, 'landed-on-main', 'x:y', ?, ?)",
      )
      .run(R, JSON.stringify({ sha: SHA }), "2026-02-30T00:00:00.000Z");
    raw.close();
    expect(() => new CanonFactsStore(path)).toThrow(/not a real instant/);
  });
});

describe("round-2 regressions (falsification review findings)", () => {
  it("f9: an extra smuggled schema object is refused at open", () => {
    const dir = tempDir();
    const path = join(dir, "canon-facts.sqlite");
    new CanonFactsStore(path).close();
    const raw = new Database(path);
    raw.exec("CREATE INDEX extra_smuggled ON canon_facts (actor)");
    raw.close();
    expect(() => new CanonFactsStore(path)).toThrow(/schema objects|does not match/);
  });

  it("f12: an expanded-year recordedAt round-trips", () => {
    const dir = tempDir();
    const path = join(dir, "canon-facts.sqlite");
    let tick = 0;
    const farFuture = () => new Date(Date.UTC(10000, 0, 1, 0, 0, tick++));
    const store = new CanonFactsStore(path, { now: farFuture });
    const rec = store.recordFact({
      requirementId: R,
      kind: "landed-on-main",
      actor: "camino:merge",
      payload: { sha: SHA },
    });
    expect(rec.recordedAt.startsWith("+010000")).toBe(true);
    store.close();
    const reopened = new CanonFactsStore(path, { now: farFuture });
    expect(reopened.read()).toHaveLength(1);
    reopened.close();
  });
});
