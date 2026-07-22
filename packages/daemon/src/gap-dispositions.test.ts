/**
 * Gap-disposition store tests (WP-122): the append-only, tamper-evident,
 * actor-bound construction — the same properties the intent ledger pins,
 * re-asserted against THIS store's schema (a copied construction that
 * silently drifted would pass the ledger's tests and fail here).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DAVID_ACTOR } from "@camino/core";
import type { StatusTuple } from "@camino/shared";
import { GapDispositionsStore } from "./gap-dispositions.js";
import { WriterLock } from "./writer-lock.js";

const TUPLE: StatusTuple = {
  disposition: "accepted",
  implementation: { kind: "absent" },
  evidence: "unverified",
};

let dir: string;
let path: string;
let store: GapDispositionsStore | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "camino-gapdisp-"));
  path = join(dir, "gap-dispositions.sqlite");
  store = undefined;
});

afterEach(() => {
  store?.close();
});

const open = (): GapDispositionsStore => {
  store = new GapDispositionsStore(path, { now: () => new Date("2026-07-03T00:00:00.000Z") });
  return store;
};

const payload = (reason = "queued"): Record<string, unknown> => ({
  tuple: TUPLE,
  contextKey: "main",
  reason,
});

describe("append/read round-trip", () => {
  it("assigns strictly increasing seqs, binds the David actor, and reads back canonical JSON", () => {
    const s = open();
    const first = s.append({
      requirementId: "CAM-DEMO-01",
      event: "gap-fix-queued",
      payload: payload(),
    });
    expect(first.seq).toBe(1);
    expect(first.actor).toBe(DAVID_ACTOR);
    const second = s.append({
      requirementId: "CAM-DEMO-02",
      event: "gap-disputed",
      payload: payload("not a gap"),
    });
    expect(second.seq).toBe(2);
    expect(s.lastSeq).toBe(2);
    expect(s.read().map((r) => r.seq)).toEqual([1, 2]);
    expect(s.read({ requirementId: "CAM-DEMO-02" }).map((r) => r.event)).toEqual(["gap-disputed"]);
    expect(s.read({ afterSeq: 1 }).map((r) => r.seq)).toEqual([2]);
    expect(s.read()[0]!.payload).toEqual(payload());
  });

  it("refuses appends the log verifier would refuse at the next open (one hygiene path)", () => {
    const s = open();
    expect(() =>
      s.append({
        requirementId: "CAM-DEMO-01",
        event: "gap-fix-queued",
        payload: { reason: "no tuple" },
      }),
    ).toThrow(/missing payload field/);
    expect(() =>
      s.append({
        requirementId: "CAM-DEMO-01",
        event: "gap-fix-queued",
        payload: { tuple: TUPLE, contextKey: "main", reason: "two\nlines" },
      }),
    ).toThrow(/single-line/);
    expect(() =>
      s.append({ requirementId: "not an id", event: "gap-fix-queued", payload: payload() }),
    ).toThrow(/stable-id grammar/);
    expect(() =>
      s.append({ requirementId: "CAM-DEMO-01", event: "waive" as never, payload: payload() }),
    ).toThrow(/not a gap-disposition event/);
  });
});

describe("append-only construction (CAM-CORE-04: dispositions are immutable events)", () => {
  it("rejects UPDATE and DELETE at the schema level, whatever the caller", () => {
    const s = open();
    s.append({ requirementId: "CAM-DEMO-01", event: "gap-fix-queued", payload: payload() });
    s.close();
    store = undefined;
    const raw = new Database(path);
    try {
      expect(() => raw.prepare("UPDATE gap_dispositions SET event = 'gap-reopened'").run()).toThrow(
        /append-only/,
      );
      expect(() => raw.prepare("DELETE FROM gap_dispositions").run()).toThrow(/append-only/);
    } finally {
      raw.close();
    }
  });

  it("rejects raw rows with a non-David actor or an unknown event (SQL CHECK layer)", () => {
    const s = open();
    s.close();
    store = undefined;
    const raw = new Database(path);
    try {
      const insert = raw.prepare(
        `INSERT INTO gap_dispositions (requirement_id, event, actor, payload, recorded_at)
         VALUES (@r, @e, @a, @p, @t)`,
      );
      const base = {
        r: "CAM-DEMO-01",
        e: "gap-fix-queued",
        a: DAVID_ACTOR,
        p: JSON.stringify(payload()),
        t: "2026-07-03T00:00:00.000Z",
      };
      expect(() => insert.run({ ...base, a: "camino:scheduler" })).toThrow(/CHECK/);
      expect(() => insert.run({ ...base, e: "requirement-descoped" })).toThrow(/CHECK/);
      insert.run(base); // the well-formed row is accepted
    } finally {
      raw.close();
    }
  });
});

describe("tamper-evident open (fail-closed adoption)", () => {
  it("refuses a store whose schema objects differ from this daemon's definition", () => {
    const s = open();
    s.close();
    store = undefined;
    const raw = new Database(path);
    try {
      raw.exec("DROP TRIGGER gap_dispositions_append_only_update");
    } finally {
      raw.close();
    }
    expect(open).toThrow(/does not match this daemon's definition|schema objects/);
    store = undefined;
  });

  it("refuses a log with a row the shape hygiene rejects", () => {
    const s = open();
    s.close();
    store = undefined;
    const raw = new Database(path);
    try {
      raw
        .prepare(
          `INSERT INTO gap_dispositions (requirement_id, event, actor, payload, recorded_at)
           VALUES ('CAM-DEMO-01', 'gap-fix-queued', '${DAVID_ACTOR}', '{"reason":"no tuple"}', '2026-07-03T00:00:00.000Z')`,
        )
        .run();
    } finally {
      raw.close();
    }
    expect(open).toThrow(/fails shape verification/);
    store = undefined;
  });

  it("refuses a foreign schema version", () => {
    const raw = new Database(path);
    raw.pragma("user_version = 99");
    raw.close();
    expect(open).toThrow(/schema version 99/);
    store = undefined;
  });
});

describe("writer-lock binding", () => {
  it("asserts the daemon's writer lock on every append", () => {
    const lock = WriterLock.acquire(join(dir, "writer-lock.sqlite"));
    const s = new GapDispositionsStore(path, { writerLock: lock });
    store = s;
    s.append({ requirementId: "CAM-DEMO-01", event: "gap-fix-queued", payload: payload() });
    lock.release();
    expect(() =>
      s.append({ requirementId: "CAM-DEMO-01", event: "gap-disputed", payload: payload("x") }),
    ).toThrow(/lock/i);
  });
});
