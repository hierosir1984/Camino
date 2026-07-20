/**
 * Intent journal shell (WP-104): append-only enforced in the schema,
 * tamper-evident open, CAS append, single-observation payloads, and the
 * fail-closed adoption gate — the WP-101 store discipline applied to the
 * journal.
 */
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IntentJournal } from "./intent-journal.js";
import { WriterLock } from "./writer-lock.js";

const SHA_A = "a".repeat(40);
const BRANCH_SPEC = {
  op: "branch-create",
  repo: "r",
  branch: "camino/issue-1",
  targetSha: SHA_A,
} as const;

let dirs: string[] = [];
function journalPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-journal-"));
  dirs.push(dir);
  return join(dir, "intents.sqlite");
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function walkToConfirmed(journal: IntentJournal, intentId = "i1"): void {
  journal.append({ intentId, event: "recorded", actor: "camino:executor", payload: BRANCH_SPEC });
  journal.append({ intentId, event: "execution-started", actor: "camino:executor", payload: {} });
  journal.append({
    intentId,
    event: "confirmed",
    actor: "camino:executor",
    payload: { via: "response", result: { branch: "camino/issue-1" }, note: "ok" },
  });
}

describe("IntentJournal basics", () => {
  it("appends, reads back, and folds the lifecycle", () => {
    const path = journalPath();
    const journal = new IntentJournal(path);
    walkToConfirmed(journal);
    const rows = journal.read();
    expect(rows.map((r) => r.event)).toEqual(["recorded", "execution-started", "confirmed"]);
    expect(rows[0]!.payload).toEqual(BRANCH_SPEC);
    const entry = journal.entry("i1")!;
    expect(entry.status).toBe("confirmed");
    expect(entry.executionStartedCount).toBe(1);
    expect(entry.result).toEqual({ branch: "camino/issue-1" });
    journal.close();
  });

  it("a fresh journal over the same file folds the identical view (recovery is replay)", () => {
    const path = journalPath();
    const first = new IntentJournal(path);
    walkToConfirmed(first);
    const before = first.currentView();
    first.close();
    const second = new IntentJournal(path);
    expect(second.currentView()).toEqual(before);
    second.close();
  });

  it("refuses illegal appends loudly (throw, not a refusal row — internal writers only)", () => {
    const journal = new IntentJournal(journalPath());
    expect(() =>
      journal.append({ intentId: "i1", event: "execution-started", actor: "x", payload: {} }),
    ).toThrow(/no recorded row/);
    journal.append({
      intentId: "i1",
      event: "recorded",
      actor: "camino:executor",
      payload: BRANCH_SPEC,
    });
    expect(() =>
      journal.append({ intentId: "i1", event: "recorded", actor: "x", payload: BRANCH_SPEC }),
    ).toThrow(/already exists/);
    expect(() =>
      journal.append({
        intentId: "i1",
        event: "confirmed",
        actor: "x",
        payload: { via: "response", result: {}, note: "n" },
      }),
    ).toThrow(/not legal from status/);
    journal.close();
  });

  it("refuses an invalid operation spec at the durable boundary", () => {
    const journal = new IntentJournal(journalPath());
    expect(() =>
      journal.append({
        intentId: "i1",
        event: "recorded",
        actor: "x",
        payload: { op: "branch-create", repo: "r", branch: "b", targetSha: "not-a-sha" },
      }),
    ).toThrow(/40-character/);
    journal.close();
  });

  it("binds retry-authorized to the David actor through the shell too", () => {
    const journal = new IntentJournal(journalPath());
    journal.append({ intentId: "i1", event: "recorded", actor: "x", payload: BRANCH_SPEC });
    journal.append({ intentId: "i1", event: "execution-started", actor: "x", payload: {} });
    journal.append({
      intentId: "i1",
      event: "ambiguity-recorded",
      actor: "camino:recovery",
      payload: { reason: "unknown" },
    });
    journal.append({
      intentId: "i1",
      event: "escalated",
      actor: "camino:recovery",
      payload: { reason: "unknown" },
    });
    expect(() =>
      journal.append({
        intentId: "i1",
        event: "retry-authorized",
        actor: "camino:recovery",
        payload: { reason: "r" },
      }),
    ).toThrow(/David/);
    journal.close();
  });

  it("observes the payload exactly once (single-observation canonicalization)", () => {
    const journal = new IntentJournal(journalPath());
    let reads = 0;
    const sneaky = {
      op: "catch-all",
      get description(): string {
        reads += 1;
        return reads === 1 ? "first read" : "different on later reads";
      },
    };
    journal.append({
      intentId: "i1",
      event: "recorded",
      actor: "x",
      payload: sneaky as unknown as Readonly<Record<string, unknown>>,
    });
    const stored = journal.read()[0]!.payload;
    expect(stored["description"]).toBe("first read");
    expect(journal.entry("i1")!.spec).toEqual({ op: "catch-all", description: "first read" });
    journal.close();
  });

  it("refuses payloads JSON cannot hold as a plain object", () => {
    const journal = new IntentJournal(journalPath());
    expect(() =>
      journal.append({
        intentId: "i1",
        event: "recorded",
        actor: "x",
        payload: { toJSON: () => [] } as unknown as Readonly<Record<string, unknown>>,
      }),
    ).toThrow(/plain JSON object/);
    journal.close();
  });

  it("CAS is unconditional: a second writer instance's interleave refuses without writing", () => {
    const path = journalPath();
    const first = new IntentJournal(path);
    first.append({ intentId: "i1", event: "recorded", actor: "x", payload: BRANCH_SPEC });
    // A second instance over the same file advances the store...
    const second = new IntentJournal(path);
    second.append({ intentId: "i1", event: "execution-started", actor: "x", payload: {} });
    second.close();
    // ...so the FIRST instance's next append must refuse — no opt-out
    // exists for any caller (the CAS runs on every append).
    expect(() =>
      first.append({ intentId: "i1", event: "execution-started", actor: "x", payload: {} }),
    ).toThrow(/advanced beyond/);
    expect(first.read()).toHaveLength(2);
    first.close();
  });

  it("nonTerminal lists exactly the unresolved statuses", () => {
    const journal = new IntentJournal(journalPath());
    walkToConfirmed(journal, "done");
    journal.append({ intentId: "pending", event: "recorded", actor: "x", payload: BRANCH_SPEC });
    journal.append({
      intentId: "inflight",
      event: "recorded",
      actor: "x",
      payload: BRANCH_SPEC,
    });
    journal.append({ intentId: "inflight", event: "execution-started", actor: "x", payload: {} });
    const ids = journal.nonTerminal().map((s) => s.intentId);
    expect(ids).toEqual(["pending", "inflight"]);
    journal.close();
  });
});

describe("IntentJournal durability shell", () => {
  it("append-only is enforced by schema triggers on RAW connections", () => {
    const path = journalPath();
    const journal = new IntentJournal(path);
    walkToConfirmed(journal);
    journal.close();
    const raw = new Database(path);
    expect(() =>
      raw.prepare("UPDATE intent_events SET actor = 'forged' WHERE seq = 1").run(),
    ).toThrow(/append-only/);
    expect(() => raw.prepare("DELETE FROM intent_events WHERE seq = 1").run()).toThrow(
      /append-only/,
    );
    raw.close();
  });

  it("refuses to open a version-claiming database missing its triggers (tamper evidence)", () => {
    const path = journalPath();
    new IntentJournal(path).close();
    const raw = new Database(path);
    raw.exec("DROP TRIGGER intent_events_append_only_update");
    raw.close();
    expect(() => new IntentJournal(path)).toThrow(/missing intent_events_append_only_update/);
  });

  it("refuses a schema version it does not know", () => {
    const path = journalPath();
    new IntentJournal(path).close();
    const raw = new Database(path);
    raw.pragma("user_version = 99");
    raw.close();
    expect(() => new IntentJournal(path)).toThrow(/schema version 99/);
  });

  it("refuses a non-UTF-8 database (the NUL byte checks assume UTF-8)", () => {
    const path = journalPath();
    const raw = new Database(path);
    raw.pragma("encoding = 'UTF-16le'");
    raw.exec("CREATE TABLE seed (x TEXT)"); // forces the encoding to stick
    raw.close();
    expect(() => new IntentJournal(path)).toThrow(/UTF-8/);
  });

  it("fail-closed adoption: refuses a journal whose history the lifecycle rejects", () => {
    const path = journalPath();
    new IntentJournal(path).close();
    const raw = new Database(path);
    // Forge a confirmed row with no recorded/execution-started history.
    raw
      .prepare(
        `INSERT INTO intent_events (intent_id, event, actor, payload, recorded_at)
         VALUES ('forged', 'confirmed', 'x', '{"via":"response","result":{},"note":"n"}', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    raw.close();
    expect(() => new IntentJournal(path)).toThrow(/fails lifecycle verification/);
  });

  it("asserts the writer lock is held on every append when wired", () => {
    const path = journalPath();
    const lockPath = `${path}.lock`;
    const lock = WriterLock.acquire(lockPath);
    const journal = new IntentJournal(path, { writerLock: lock });
    journal.append({ intentId: "i1", event: "recorded", actor: "x", payload: BRANCH_SPEC });
    lock.release();
    expect(() =>
      journal.append({ intentId: "i1", event: "execution-started", actor: "x", payload: {} }),
    ).toThrow(/without the writer lock held/);
    journal.close();
  });
});

describe("round-1 regressions", () => {
  it("round 2, finding 1: ids carrying token delimiters refuse at the durable boundary", () => {
    const journal = new IntentJournal(journalPath());
    expect(() =>
      journal.append({
        intentId: "intent-A]foreign",
        event: "recorded",
        actor: "x",
        payload: { op: "catch-all", description: "d" },
      }),
    ).toThrow(/must match/);
    journal.close();
  });

  it("finding 1: the journal binds marker keys to the intent id at the durable boundary", () => {
    const journal = new IntentJournal(journalPath());
    expect(() =>
      journal.append({
        intentId: "intent-1",
        event: "recorded",
        actor: "x",
        payload: {
          op: "comment-post",
          repo: "r",
          targetKind: "issue",
          targetNumber: 1,
          body: "b [camino-intent:some-other-id]",
          marker: "some-other-id",
        },
      }),
    ).toThrow(/marker must equal the intent id/);
    expect(() =>
      journal.append({
        intentId: "intent-1",
        event: "recorded",
        actor: "x",
        payload: {
          op: "workflow-dispatch",
          repo: "r",
          workflow: "w.yml",
          ref: "main",
          correlationId: "intent-2",
        },
      }),
    ).toThrow(/correlationId must equal the intent id/);
    journal.close();
  });

  it("finding 10: refused adoptions close the native handle (no fd leak)", () => {
    const path = journalPath();
    new IntentJournal(path).close();
    const raw = new Database(path);
    raw
      .prepare(
        `INSERT INTO intent_events (intent_id, event, actor, payload, recorded_at)
         VALUES ('forged', 'confirmed', 'x', '{"via":"response","result":{},"note":"n"}', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    raw.close();
    const fdDir = "/dev/fd";
    const before = readdirSync(fdDir).length;
    for (let i = 0; i < 100; i += 1) {
      expect(() => new IntentJournal(path)).toThrow(/fails lifecycle verification/);
    }
    const after = readdirSync(fdDir).length;
    // 100 refused opens must not retain 100 handles; small slack for
    // unrelated runtime churn.
    expect(after - before).toBeLessThan(10);
  });
});

describe("round-4 regressions", () => {
  it("finding 1: free-text dispatch fields cannot embed a correlation token", () => {
    const journal = new IntentJournal(journalPath());
    expect(() =>
      journal.append({
        intentId: "attacker-B",
        event: "recorded",
        actor: "x",
        payload: {
          op: "workflow-dispatch",
          repo: "r",
          workflow: "attacker.yml [camino_intent_id=victim-A]",
          ref: "main",
          correlationId: "attacker-B",
        },
      }),
    ).toThrow(/namespace is reserved for the transport/);
    journal.close();
  });

  it("regression on r3 finding 2: raw-persisted JSON -0 reads and folds as canonical 0 everywhere", () => {
    const path = journalPath();
    new IntentJournal(path).close();
    const raw = new Database(path);
    // A raw writer persists a lifecycle-legal history whose result text
    // carries a literal -0 (the append path would have canonicalized it).
    const spec = JSON.stringify({ op: "catch-all", description: "d" });
    raw
      .prepare(
        `INSERT INTO intent_events (intent_id, event, actor, payload, recorded_at) VALUES
         ('i1', 'recorded', 'x', ?, '2026-01-01T00:00:00.000Z'),
         ('i1', 'execution-started', 'x', '{}', '2026-01-01T00:00:01.000Z'),
         ('i1', 'confirmed', 'x', '{"via":"response","result":{"delta":-0},"note":"n"}', '2026-01-01T00:00:02.000Z')`,
      )
      .run(spec);
    raw.close();
    const journal = new IntentJournal(path);
    const readResult = (
      journal.read({ intentId: "i1" }).find((r) => r.event === "confirmed")!.payload[
        "result"
      ] as Record<string, unknown>
    )["delta"];
    const foldedResult = (journal.entry("i1")!.result as Record<string, unknown>)["delta"];
    // ONE canonical observation: read() and the fold agree, and neither is -0.
    expect(Object.is(readResult, -0)).toBe(false);
    expect(Object.is(foldedResult, -0)).toBe(false);
    expect(readResult).toBe(0);
    expect(foldedResult).toBe(0);
    journal.close();
  });
});
