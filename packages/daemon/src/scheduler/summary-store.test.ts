// WP-114: durable CAM-PLAN-09 summaries — append-only, idempotent replay
// per attempt, conflicting evidence refused, validated on write AND read.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AttemptSummary } from "@camino/shared";
import { ATTEMPT_SUMMARY_SCHEMA_VERSION } from "@camino/shared";
import { AttemptSummaryStore } from "./summary-store.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function newStore() {
  const dir = mkdtempSync(join(tmpdir(), "camino-summaries-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "attempt-summaries.sqlite");
  const store = new AttemptSummaryStore(path, { writerLock: null });
  cleanups.push(() => store.close());
  return { store, path };
}

function summary(attempt: number, overrides: Partial<AttemptSummary> = {}): AttemptSummary {
  return {
    schemaVersion: ATTEMPT_SUMMARY_SCHEMA_VERSION,
    attemptId: `m1.I1.a${attempt}`,
    issueId: "m1.I1",
    missionId: "m1",
    contractRef: { issueId: "m1.I1", contractVersion: 1, contractHash: "b".repeat(64) },
    harness: "claude-code",
    family: "anthropic",
    model: null,
    reasoningTier: "high",
    outcome: "requirement-failed",
    attemptTerminal: "failed",
    failureClass: "requirement-failed",
    quotaSignalSeen: false,
    exitCode: 1,
    durationMs: 100,
    streamedEvents: 2,
    headline: `attempt ${attempt} failed`,
    recordedAt: `2026-07-23T10:0${attempt}:00.000Z`,
    ...overrides,
  };
}

describe("AttemptSummaryStore", () => {
  it("records, replays idempotently, and refuses conflicting evidence", () => {
    const { store } = newStore();
    store.record(summary(1));
    expect(store.record(summary(1))).toMatchObject({ attemptId: "m1.I1.a1" });
    expect(() => store.record(summary(1, { headline: "different story" }))).toThrow(
      /different content/,
    );
  });

  it("refuses an invalid summary on write (the closed-schema guarantee)", () => {
    const { store } = newStore();
    expect(() =>
      store.record({ ...summary(1), transcript: "smuggled" } as unknown as AttemptSummary),
    ).toThrow(/unknown field/);
  });

  it("serves per-issue history oldest-first and the latest for handoff", () => {
    const { store } = newStore();
    store.record(summary(1));
    store.record(summary(2, { family: "openai", harness: "codex-cli" }));
    expect(store.forIssue("m1.I1").map((s) => s.attemptId)).toEqual(["m1.I1.a1", "m1.I1.a2"]);
    expect(store.latestForIssue("m1.I1")?.family).toBe("openai");
    expect(store.get("m1.I1.a1")?.headline).toBe("attempt 1 failed");
  });

  it("re-validates on read: a corrupted row is refused, not served", () => {
    const { store, path } = newStore();
    store.record(summary(1));
    store.close();
    cleanups.pop();
    const raw = new Database(path);
    // Triggers close every in-band rewrite; corrupt via drop+recreate to
    // model a filesystem-level writer (the named boundary).
    raw.exec("DROP TRIGGER attempt_summaries_append_only_update");
    raw.prepare("UPDATE attempt_summaries SET record = '{\"schemaVersion\":1}'").run();
    raw.close();
    // Reopen refuses the tampered schema before any read can be served.
    expect(() => new AttemptSummaryStore(path, { writerLock: null })).toThrow(/tampered|schema/);
  });

  it("append-only triggers refuse UPDATE/DELETE/replace in the database", () => {
    const { store, path } = newStore();
    store.record(summary(1));
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    expect(() => raw.prepare("UPDATE attempt_summaries SET record = 'x'").run()).toThrow(
      /UPDATE rejected/,
    );
    expect(() => raw.prepare("DELETE FROM attempt_summaries").run()).toThrow(/DELETE rejected/);
  });
});
