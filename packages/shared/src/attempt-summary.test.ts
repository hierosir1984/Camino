// WP-114: the CAM-PLAN-09 structured-summary schema — summaries, never
// transcripts, enforced structurally (closed field set; one bounded line).
import { describe, expect, it } from "vitest";
import type { AttemptSummary } from "./attempt-summary.js";
import {
  ATTEMPT_SUMMARY_SCHEMA_VERSION,
  HEADLINE_MAX_CHARS,
  attemptSummaryProblems,
  summaryHeadline,
} from "./attempt-summary.js";

const VALID: AttemptSummary = Object.freeze({
  schemaVersion: ATTEMPT_SUMMARY_SCHEMA_VERSION,
  attemptId: "m1.I1.a1",
  issueId: "m1.I1",
  missionId: "m1",
  contractRef: { issueId: "m1.I1", contractVersion: 1, contractHash: "a".repeat(64) },
  harness: "claude-code",
  family: "anthropic",
  model: null,
  reasoningTier: "high",
  outcome: "requirement-failed",
  attemptTerminal: "failed",
  failureClass: "requirement-failed",
  quotaSignalSeen: false,
  exitCode: 1,
  durationMs: 1234,
  streamedEvents: 7,
  headline: "worker exited 1 before submitting a final head",
  recordedAt: "2026-07-23T10:00:00.000Z",
});

describe("attemptSummaryProblems", () => {
  it("accepts a complete failure summary", () => {
    expect(attemptSummaryProblems(VALID)).toEqual([]);
  });

  it("accepts optional budget-breach and kill-confirm evidence", () => {
    expect(
      attemptSummaryProblems({
        ...VALID,
        outcome: "killed-budget",
        attemptTerminal: "killed-budget",
        budgetBreach: { kind: "wall-clock", limit: 1000, observed: 1500 },
        killConfirm: { groupGone: true, escalatedToSigkill: true },
      }),
    ).toEqual([]);
  });

  it("REFUSES unknown fields — a transcript or event stream has no field to ride in", () => {
    for (const smuggle of [
      { events: [{ kind: "assistant", text: "full transcript…" }] },
      { transcript: "…" },
      { finalText: "…" },
      { log: ["line"] },
    ]) {
      const problems = attemptSummaryProblems({ ...VALID, ...smuggle });
      expect(problems.some((p) => p.includes("unknown field"))).toBe(true);
    }
  });

  it("bounds the headline to one line of HEADLINE_MAX_CHARS", () => {
    expect(
      attemptSummaryProblems({ ...VALID, headline: "x".repeat(HEADLINE_MAX_CHARS + 1) }),
    ).not.toEqual([]);
    expect(attemptSummaryProblems({ ...VALID, headline: "two\nlines" })).not.toEqual([]);
  });

  it("requires a resolvable ContractRef (CAM-PLAN-04 attempt half)", () => {
    expect(attemptSummaryProblems({ ...VALID, contractRef: { issueId: "m1.I1" } })).not.toEqual([]);
  });

  it("refuses non-canonical vocabulary (family, tier, outcome, terminal)", () => {
    expect(attemptSummaryProblems({ ...VALID, family: "acme" })).not.toEqual([]);
    expect(attemptSummaryProblems({ ...VALID, reasoningTier: "max" })).not.toEqual([]);
    expect(attemptSummaryProblems({ ...VALID, outcome: "exploded" })).not.toEqual([]);
    expect(attemptSummaryProblems({ ...VALID, attemptTerminal: "archived" })).not.toEqual([]);
  });
});

describe("summaryHeadline", () => {
  it("keeps only the first line, strips control characters, caps the length", () => {
    const line = summaryHeadline("first line\u0007 with bell\nsecond line\nthird");
    expect(line).toBe("first line  with bell");
    expect(summaryHeadline("x".repeat(10_000)).length).toBe(HEADLINE_MAX_CHARS);
  });

  it("repairs ill-formed output rather than propagating it", () => {
    const line = summaryHeadline("\ud800broken");
    expect(line.isWellFormed()).toBe(true);
  });

  it("never throws, even over hostile input", () => {
    expect(summaryHeadline(null as unknown as string)).toBeTypeOf("string");
  });

  it("scrubs credential-token literals; the validator refuses them outright (round-1 finding 13)", () => {
    const pat = `ghp_${"A".repeat(36)}`;
    const line = summaryHeadline(`auth failed for ${pat} while pushing`);
    expect(line).not.toContain(pat);
    expect(line).toContain("[token-scrubbed]");
    expect(
      attemptSummaryProblems({ ...VALID, headline: `leaked ${pat}` }).some((p) =>
        p.includes("credential-token"),
      ),
    ).toBe(true);
    expect(
      attemptSummaryProblems({ ...VALID, headline: `leaked github_pat_${"b".repeat(30)}` }),
    ).not.toEqual([]);
  });
});
