/**
 * Knowledge store tests (WP-113, CAM-CANON-09): durable append-only lifecycle
 * of candidates, observations, rule/human promotion, curation, and the same
 * tamper-evident open / single-writer hardening posture as the intent ledger.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeEntryInput } from "@camino/shared";
import { KnowledgeStore } from "./knowledge-store.js";
import type { HeldWriterLock } from "./writer-lock.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-knowledge-store-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 20, 0, 0, tick++));
}

function openStore(dir: string, options: { writerLock?: HeldWriterLock } = {}): KnowledgeStore {
  const store = new KnowledgeStore(join(dir, "knowledge.sqlite"), {
    now: fixedClock(),
    writerLock: options.writerLock,
  });
  cleanups.push(() => store.close());
  return store;
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function makeEntry(overrides: Partial<KnowledgeEntryInput> = {}): KnowledgeEntryInput {
  return {
    entryId: "k-1",
    entryClass: "command",
    subjectKey: "npm test",
    claim: "succeeds",
    text: "npm test succeeds on this base",
    scope: { kind: "global" },
    expiresAt: "2027-01-01T00:00:00.000Z",
    provenance: {
      missionId: "m-1",
      issueId: "m-1.i-1",
      attemptId: "a-1",
      context: "observed during attempt",
    },
    validity: { commitSha: SHA_A, baseSha: SHA_B },
    ...overrides,
  };
}

function observeSuccess(
  store: KnowledgeStore,
  commandKey: string,
  missionId: string,
  attemptId: string,
  validity: { commitSha: string; baseSha: string } = { commitSha: SHA_A, baseSha: SHA_B },
): void {
  store.recordCommandObservation(
    { commandKey, missionId, attemptId, succeeded: true, ...validity },
    "camino:wp-114",
  );
}

describe("round-trip + lifecycle surface", () => {
  it("recordCandidate persists; read/view/lastSeq agree on the candidate", () => {
    const store = openStore(tempDir());
    const entry = makeEntry();
    const rec = store.recordCandidate(entry, "camino:attempt");

    expect(rec.seq).toBe(1);
    expect(rec.event).toBe("candidate-recorded");
    expect(rec.actor).toBe("camino:attempt");
    expect(rec.payload).toEqual({ entry });

    const records = store.read();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(rec);
    expect(store.lastSeq).toBe(1);

    const snap = store.currentView().entries.get("k-1");
    expect(snap?.state).toBe("candidate");
    expect(snap?.entry).toEqual(entry);
    expect(snap?.recordedSeq).toBe(1);
    expect(store.currentView().lastSeq).toBe(1);
  });

  it("close + reopen adopts the same view and records as live writes", () => {
    const dir = tempDir();
    const path = join(dir, "knowledge.sqlite");
    const store = new KnowledgeStore(path, { now: fixedClock() });
    store.recordCandidate(makeEntry(), "camino:attempt");
    observeSuccess(store, "npm test", "m-1", "a-1");
    const beforeView = store.currentView();
    const beforeRead = store.read();
    store.close();

    const reopened = new KnowledgeStore(path, { now: fixedClock() });
    cleanups.push(() => reopened.close());
    expect(reopened.read()).toEqual(beforeRead);
    expect(reopened.currentView()).toEqual(beforeView);
    expect(reopened.lastSeq).toBe(beforeView.lastSeq);
  });

  it("three command observations across two missions license rule-command-success promotion", () => {
    const store = openStore(tempDir());
    store.recordCandidate(makeEntry(), "camino:attempt");
    observeSuccess(store, "npm test", "m-1", "a-1");
    observeSuccess(store, "npm test", "m-1", "a-2");
    observeSuccess(store, "npm test", "m-2", "a-3");

    const promo = store.promoteEntry("k-1", { kind: "rule-command-success" }, "camino:knowledge");
    expect(promo.event).toBe("entry-promoted");
    expect(promo.payload).toEqual({
      entryId: "k-1",
      authority: { kind: "rule-command-success" },
    });
    expect(store.currentView().entries.get("k-1")?.state).toBe("approved");
    expect(store.currentView().entries.get("k-1")?.promotion?.authority).toEqual({
      kind: "rule-command-success",
    });
  });

  it("promoteEligibleByRules promotes ready entries, skips short evidence and contradictions", () => {
    const store = openStore(tempDir());

    // Standing approved that blocks a later candidate on the same subject.
    store.recordCandidate(
      makeEntry({
        entryId: "k-standing",
        subjectKey: "npm lint",
        claim: "fails",
        text: "npm lint fails on this base",
      }),
      "camino:attempt",
    );
    store.promoteEntry("k-standing", { kind: "human-batch", batchId: "batch-1" }, "david");

    // Eligible command (3 successes / 2 missions).
    store.recordCandidate(
      makeEntry({ entryId: "k-cmd", subjectKey: "npm test", text: "npm test succeeds" }),
      "camino:attempt",
    );
    observeSuccess(store, "npm test", "m-1", "a-1");
    observeSuccess(store, "npm test", "m-1", "a-2");
    observeSuccess(store, "npm test", "m-2", "a-3");

    // Eligible flaky-test with quarantine confirmation.
    store.recordCandidate(
      makeEntry({
        entryId: "k-flaky",
        entryClass: "flaky-test",
        subjectKey: "suite::flake",
        claim: "flaky",
        text: "suite::flake is flaky",
      }),
      "camino:attempt",
    );
    store.recordQuarantineConfirmation(
      {
        testId: "suite::flake",
        missionId: "m-1",
        reference: "quarantine/suite-flake",
        commitSha: SHA_A,
        baseSha: SHA_B,
      },
      "camino:wp-108",
    );

    // Short evidence — one success only.
    store.recordCandidate(
      makeEntry({
        entryId: "k-short",
        subjectKey: "npm build",
        text: "npm build succeeds",
      }),
      "camino:attempt",
    );
    observeSuccess(store, "npm build", "m-1", "a-9");

    // Would meet the command rule, but contradicts standing approved on npm lint.
    store.recordCandidate(
      makeEntry({
        entryId: "k-blocked",
        subjectKey: "npm lint",
        claim: "succeeds",
        text: "npm lint succeeds",
      }),
      "camino:attempt",
    );
    observeSuccess(store, "npm lint", "m-1", "a-1");
    observeSuccess(store, "npm lint", "m-1", "a-2");
    observeSuccess(store, "npm lint", "m-2", "a-3");

    const promoted = store.promoteEligibleByRules("camino:knowledge");
    expect(promoted).toHaveLength(2);
    const promotedIds = promoted.map((r) => (r.payload as { entryId: string }).entryId).sort();
    expect(promotedIds).toEqual(["k-cmd", "k-flaky"]);
    expect(
      promoted.map((r) => (r.payload as { authority: { kind: string } }).authority.kind).sort(),
    ).toEqual(["rule-command-success", "rule-quarantine-flaky"]);

    const view = store.currentView();
    expect(view.entries.get("k-cmd")?.state).toBe("approved");
    expect(view.entries.get("k-flaky")?.state).toBe("approved");
    expect(view.entries.get("k-short")?.state).toBe("candidate");
    expect(view.entries.get("k-blocked")?.state).toBe("candidate");
  });

  it("rejectEntry and retireEntry record resolution with actor david", () => {
    const store = openStore(tempDir());
    store.recordCandidate(makeEntry({ entryId: "k-rej" }), "camino:attempt");
    store.recordCandidate(makeEntry({ entryId: "k-ret", subjectKey: "npm run" }), "camino:attempt");
    store.promoteEntry("k-ret", { kind: "human-batch", batchId: "batch-ret" }, "david");

    store.rejectEntry("k-rej", "not useful");
    store.retireEntry("k-ret", "superseded by better evidence");

    const view = store.currentView();
    expect(view.entries.get("k-rej")?.state).toBe("rejected");
    expect(view.entries.get("k-rej")?.resolution).toEqual({
      kind: "rejected",
      reason: "not useful",
      actor: "david",
      seq: expect.any(Number),
    });
    expect(view.entries.get("k-ret")?.state).toBe("retired");
    expect(view.entries.get("k-ret")?.resolution).toEqual({
      kind: "retired",
      reason: "superseded by better evidence",
      actor: "david",
      seq: expect.any(Number),
    });
  });

  it("recordValidityBaseRevert invalidates matching candidate and approved entries", () => {
    const store = openStore(tempDir());
    store.recordCandidate(makeEntry({ entryId: "k-cand" }), "camino:attempt");
    store.recordCandidate(
      makeEntry({
        entryId: "k-ok",
        subjectKey: "npm other",
        validity: { commitSha: SHA_C, baseSha: SHA_B },
      }),
      "camino:attempt",
    );
    store.recordCandidate(
      makeEntry({ entryId: "k-appr", subjectKey: "npm appr" }),
      "camino:attempt",
    );
    store.promoteEntry("k-appr", { kind: "human-batch", batchId: "b-appr" }, "david");

    store.recordValidityBaseRevert(SHA_A, "camino:merge");

    const view = store.currentView();
    expect(view.entries.get("k-cand")?.state).toBe("invalidated");
    expect(view.entries.get("k-cand")?.invalidation).toEqual({
      revertedSha: SHA_A,
      seq: expect.any(Number),
    });
    expect(view.entries.get("k-appr")?.state).toBe("invalidated");
    expect(view.entries.get("k-ok")?.state).toBe("candidate");
  });

  it("curationQueue and visibleFor delegate: contradiction pair and issue-scoped candidates", () => {
    const store = openStore(tempDir());
    store.recordCandidate(
      makeEntry({
        entryId: "k-standing",
        subjectKey: "npm lint",
        claim: "fails",
        text: "npm lint fails",
      }),
      "camino:attempt",
    );
    store.promoteEntry("k-standing", { kind: "human-batch", batchId: "b-1" }, "david");
    store.recordCandidate(
      makeEntry({
        entryId: "k-cand",
        subjectKey: "npm lint",
        claim: "succeeds",
        text: "npm lint succeeds",
        provenance: {
          missionId: "m-1",
          issueId: "m-1.i-1",
          attemptId: "a-2",
          context: "sibling observation",
        },
      }),
      "camino:attempt",
    );

    expect(store.curationQueue()).toEqual([
      { candidateId: "k-cand", approvedEntryId: "k-standing" },
    ]);

    const nowIso = "2026-07-20T12:00:00.000Z";
    const sameIssue = store.visibleFor({ missionId: "m-1", issueId: "m-1.i-1" }, nowIso);
    expect(sameIssue.map((v) => v.snapshot.entry.entryId).sort()).toEqual(["k-cand", "k-standing"]);
    expect(sameIssue.find((v) => v.snapshot.entry.entryId === "k-cand")?.visibility).toBe(
      "same-issue-candidate",
    );
    expect(sameIssue.find((v) => v.snapshot.entry.entryId === "k-standing")?.visibility).toBe(
      "approved",
    );

    const foreign = store.visibleFor({ missionId: "m-2", issueId: "m-2.i-1" }, nowIso);
    expect(foreign.map((v) => v.snapshot.entry.entryId)).toEqual(["k-standing"]);
    expect(foreign.every((v) => v.visibility === "approved")).toBe(true);
  });
});

describe("refusals at the API", () => {
  it("duplicate entryId is refused and appends nothing", () => {
    const store = openStore(tempDir());
    store.recordCandidate(makeEntry(), "camino:attempt");
    const seqBefore = store.lastSeq;
    expect(() => store.recordCandidate(makeEntry(), "camino:attempt")).toThrow(/already exists/);
    expect(store.lastSeq).toBe(seqBefore);
    expect(store.read()).toHaveLength(1);
  });

  it("promoteEntry without evidence is refused; human-batch requires actor david", () => {
    const store = openStore(tempDir());
    store.recordCandidate(makeEntry(), "camino:attempt");
    const seqBefore = store.lastSeq;

    expect(() =>
      store.promoteEntry("k-1", { kind: "rule-command-success" }, "camino:knowledge"),
    ).toThrow(/evidence not met/);
    expect(() =>
      store.promoteEntry("k-1", { kind: "human-batch", batchId: "batch-x" }, "camino:bot"),
    ).toThrow(/david/);
    expect(store.lastSeq).toBe(seqBefore);
    expect(store.currentView().entries.get("k-1")?.state).toBe("candidate");
  });

  it("a payload that cannot canonicalize throws TypeError naming plain JSON object", () => {
    const store = openStore(tempDir());
    // Function is not JSON-representable; nested under the entry forces the
    // single observation point to refuse before any row is written.
    const cyclic = { ...makeEntry() } as KnowledgeEntryInput & { self?: unknown };
    cyclic.self = cyclic;
    expect(() => store.recordCandidate(cyclic as never, "camino:attempt")).toThrow(TypeError);
    expect(() => store.recordCandidate(cyclic as never, "camino:attempt")).toThrow(
      /plain JSON object/,
    );
    expect(store.read()).toEqual([]);
    expect(store.lastSeq).toBe(0);
  });
});

describe("durability hardening", () => {
  it("UPDATE/DELETE are append-only; out-of-order INSERT is rejected", () => {
    const dir = tempDir();
    const path = join(dir, "knowledge.sqlite");
    const store = new KnowledgeStore(path, { now: fixedClock() });
    store.recordCandidate(makeEntry(), "camino:attempt");
    store.recordCandidate(makeEntry({ entryId: "k-2", subjectKey: "npm run" }), "camino:attempt");
    store.close();

    const raw = new Database(path);
    cleanups.push(() => raw.close());
    expect(() =>
      raw.prepare("UPDATE knowledge_events SET payload = '{}' WHERE seq = 1").run(),
    ).toThrow(/append-only/);
    expect(() => raw.prepare("DELETE FROM knowledge_events WHERE seq = 1").run()).toThrow(
      /append-only/,
    );
    expect(() =>
      raw
        .prepare(
          "INSERT INTO knowledge_events (seq, event, actor, payload, recorded_at) VALUES (1, 'command-observation', 'camino:wp-114', ?, ?)",
        )
        .run(
          JSON.stringify({
            commandKey: "npm test",
            missionId: "m-1",
            attemptId: "a-x",
            succeeded: true,
          }),
          "2026-07-20T00:00:00.000Z",
        ),
    ).toThrow(/out-of-order/);
  });

  it("schema verification refuses a store whose trigger definition was altered", () => {
    const dir = tempDir();
    const path = join(dir, "knowledge.sqlite");
    new KnowledgeStore(path).close();
    const raw = new Database(path);
    raw.exec("DROP TRIGGER knowledge_events_append_only_delete");
    raw.close();
    expect(() => new KnowledgeStore(path)).toThrow(
      /does not match this daemon's definition|schema objects/,
    );
  });

  it("user_version mismatch is refused at open", () => {
    const dir = tempDir();
    const path = join(dir, "knowledge.sqlite");
    new KnowledgeStore(path).close();
    const raw = new Database(path);
    raw.pragma("user_version = 99");
    raw.close();
    expect(() => new KnowledgeStore(path)).toThrow(/schema version 99/);
  });

  it("adoption refuses a lifecycle-invalid tail row", () => {
    const dir = tempDir();
    const path = join(dir, "knowledge.sqlite");
    new KnowledgeStore(path).close();
    const raw = new Database(path);
    raw
      .prepare(
        "INSERT INTO knowledge_events (event, actor, payload, recorded_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "entry-promoted",
        "david",
        JSON.stringify({
          entryId: "does-not-exist",
          authority: { kind: "human-batch", batchId: "batch-ghost" },
        }),
        "2026-07-20T00:00:00.000Z",
      );
    raw.close();
    expect(() => new KnowledgeStore(path)).toThrow(/fails lifecycle verification/);
  });

  it("single-writer CAS refuses a second instance whose view is stale", () => {
    const dir = tempDir();
    const path = join(dir, "knowledge.sqlite");
    const a = new KnowledgeStore(path, { now: fixedClock() });
    cleanups.push(() => a.close());
    const b = new KnowledgeStore(path, { now: fixedClock() });
    cleanups.push(() => b.close());
    a.recordCandidate(makeEntry(), "camino:attempt");
    expect(() =>
      b.recordCandidate(makeEntry({ entryId: "k-2", subjectKey: "npm run" }), "camino:attempt"),
    ).toThrow(/advanced beyond the writer's view/);
  });

  it("writer lock assertHeld failure propagates and appends nothing", () => {
    const lock: HeldWriterLock = {
      held: false,
      assertHeld(context: string): void {
        throw new Error(`${context} attempted without the writer lock held`);
      },
    };
    const store = openStore(tempDir(), { writerLock: lock });
    expect(() => store.recordCandidate(makeEntry(), "camino:attempt")).toThrow(
      /without the writer lock/,
    );
    expect(store.read()).toEqual([]);
    expect(store.lastSeq).toBe(0);
  });

  it("the returned record is deep-frozen — no shared mutable state (r1 finding 2)", () => {
    const store = openStore(tempDir());
    const record = store.recordCandidate(makeEntry({ entryId: "k-frozen" }), "camino:attempt");
    expect(Object.isFrozen(record)).toBe(true);
    // Mutating the returned record throws in strict mode (ESM) and, either
    // way, leaves the live view untouched.
    expect(() => {
      // Cast past the readonly types to exercise the RUNTIME freeze.
      (record.payload as { entry: Record<string, unknown> }).entry["text"] = "MUTATED";
    }).toThrow(TypeError);
    expect(store.currentView().entries.get("k-frozen")?.entry.text).not.toBe("MUTATED");
  });
});
