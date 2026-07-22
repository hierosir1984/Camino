// WP-107 · CAM-EXEC-03 budget fixtures: wall-clock ALWAYS (kill-confirmed
// mid-flight), tokens WHERE REPORTABLE (mid-stream kill on cumulative usage;
// over-budget final report never classifies succeeded), breach → the A.2#10 /
// A.3#5 kill-and-escalate rows with NO automatic retry — pinned against the
// core tables themselves, not just this module's behavior.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attemptMachine, issueMachine, transition } from "@camino/core";
import type { IssueEvent } from "@camino/core";
import type { AdapterSpec } from "@camino/shared";
import { mockAdapter } from "../dispatch/adapters/mock.js";
import { BudgetConfigError, dispatchWithBudget, validateAttemptBudget } from "./budget.js";

/**
 * The `budget-starve-descendant` mock wrapped in an adapter whose parseLine
 * busy-waits synchronously on the STARVE marker line — starving the daemon's
 * event loop long past the budget deadline AND the descendant's self-exit, so
 * the in-process budget TIMER can never fire in time (round-9 finding 4).
 */
function starvingAdapter(): AdapterSpec {
  const base = mockAdapter("budget-starve-descendant");
  return {
    ...base,
    name: "mock:budget-starve-descendant",
    parseLine(line: string, channel: "stdout" | "stderr") {
      const ev = base.parseLine(line, channel);
      const text = (ev as { text?: unknown } | null)?.text;
      if (typeof text === "string" && text.includes("STARVE")) {
        // Block the loop well past both the 200ms budget AND the descendant's
        // self-exit (~handshake + 400ms), so under load the timer still can't
        // fire until the group is gone — leaving only the backstop. Busy-wait is
        // CPU-bound on Date.now(), so it measures real time regardless of load.
        const until = Date.now() + 1_500;
        while (Date.now() < until) {
          /* deliberate busy-wait: starve the event loop */
        }
      }
      return ev;
    },
  };
}

// Budget kills use short kill-confirm timings so the suite stays fast; the
// production 30s grace is pinned by the WP-105 lifecycle tests.
const FAST_KILL = { graceMs: 3_000, sigkillWaitMs: 3_000 };

let dirs: string[] = [];
function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-wp107-budget-"));
  execFileSync("git", ["-C", dir, "init", "--quiet"], { stdio: "ignore" });
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("validateAttemptBudget", () => {
  it("requires a finite positive wall-clock (always enforced) and sane tokens", () => {
    expect(() => validateAttemptBudget({ wallClockMs: 0 })).toThrow(BudgetConfigError);
    expect(() => validateAttemptBudget({ wallClockMs: Number.NaN })).toThrow(BudgetConfigError);
    expect(() => validateAttemptBudget({ wallClockMs: -5 })).toThrow(BudgetConfigError);
    expect(() => validateAttemptBudget({ wallClockMs: 1000, tokens: 0 })).toThrow(
      BudgetConfigError,
    );
    expect(() => validateAttemptBudget({ wallClockMs: 1000, tokens: Number.NaN })).toThrow(
      BudgetConfigError,
    );
    expect(() => validateAttemptBudget({ wallClockMs: 1000 })).not.toThrow();
    expect(() => validateAttemptBudget({ wallClockMs: 1000, tokens: 50_000 })).not.toThrow();
  });
});

describe("dispatchWithBudget (CAM-EXEC-03)", () => {
  it("wall-clock breach: kill-confirm runs, outcome is killed-budget, escalation events map to A.3#5/A.2#10", async () => {
    const { record, escalation } = await dispatchWithBudget(
      mockAdapter("graceful-cancel"),
      { workdir: workdir(), prompt: "run forever" },
      { wallClockMs: 700 },
      { killConfirm: FAST_KILL },
    );
    expect(record.outcome).toBe("killed-budget");
    expect(record.budgetBreach).toMatchObject({ kind: "wall-clock", limit: 700 });
    // `observed` (wall clock) can read a hair under the limit vs the timer's
    // monotonic clock — assert it fired near the budget, tolerating that skew.
    expect(record.budgetBreach!.observed).toBeGreaterThanOrEqual(600);
    expect(record.killConfirm?.groupGone).toBe(true);
    expect(escalation).toBeDefined();
    expect(escalation!.attemptEvent).toEqual({
      type: "attempt-budget-breached",
      killConfirmed: true,
    });
    // The events drive EXACTLY the appendix rows: attempt running →
    // killed-budget (A.3#5); issue implementing → escalated (A.2#10).
    const attemptStep = transition(attemptMachine, "running", escalation!.attemptEvent);
    expect(attemptStep).toEqual({ ok: true, to: "killed-budget", ref: "A.3#5" });
    const issueStep = transition(issueMachine, "implementing", escalation!.issueEvent);
    expect(issueStep).toEqual({ ok: true, to: "escalated", ref: "A.2#10" });
  }, 30_000);

  it("wall-clock covers the GROUP: a leader that EXITS 0 while an in-group descendant outlives the budget is killed-budget, not succeeded (round-8 finding 1)", async () => {
    // The leader emits its success result and exits 0 well before the budget; a
    // same-group descendant ignores SIGTERM and runs past it. The old
    // leader-gated timer returned early on the leader's exit and let the run
    // classify `succeeded`. The group-scoped timer breaches because the tracked
    // group is still alive at the deadline. Grace is generous so the survivor is
    // still alive when the deadline fires (the post-exit sweep's SIGTERM is
    // ignored); the eventual SIGKILL confirms the group gone.
    //
    // The 2s budget is deliberately far larger than the leader's setup+exit
    // (~tens of ms, bounded by the descendant-readiness handshake) so that even
    // under heavy parallel CI load the leader has EXITED before the deadline —
    // the property this test asserts. A tight budget raced the handshake and
    // flaked (the budget SIGTERM'd the not-yet-exited leader).
    const { record, escalation } = await dispatchWithBudget(
      mockAdapter("budget-descendant"),
      { workdir: workdir(), prompt: "leave a budget-outliving descendant" },
      { wallClockMs: 2_000 },
      { killConfirm: { graceMs: 2_000, sigkillWaitMs: 2_000 } },
    );
    // The leader genuinely ran to completion and exited 0 — its success result
    // is in the transcript — yet the budget still classifies killed-budget.
    expect(record.finalText).toContain("RAN_AND_EXITED_BEFORE_BUDGET");
    expect(record.exitCode).toBe(0);
    expect(record.outcome).toBe("killed-budget");
    expect(record.budgetBreach).toMatchObject({ kind: "wall-clock", limit: 2_000 });
    // Tolerate wall-vs-monotonic clock skew on the observed elapsed (see above).
    expect(record.budgetBreach!.observed).toBeGreaterThanOrEqual(1_900);
    // The surviving descendant required SIGKILL; the group is confirmed gone, so
    // the clean A.3#5 / A.2#10 escalation (not the cleanup-failed path) applies.
    expect(escalation).toBeDefined();
    expect(escalation!.attemptEvent).toEqual({
      type: "attempt-budget-breached",
      killConfirmed: true,
    });
  }, 30_000);

  it("wall-clock BACKSTOP: an over-budget worker is killed-budget even when a synchronous callback starves the event loop so the timer misses the deadline (round-9 finding 4)", async () => {
    // The worker's leader exits fast; a same-group descendant lives ~400ms past
    // the 200ms budget then self-exits; the adapter's parseLine busy-waits 800ms
    // on the STARVE line, so the in-process budget timer cannot fire until the
    // group is already gone. Only the elapsed-since-start backstop remains —
    // and it must still classify killed-budget (never silently `succeeded`).
    const { record, escalation } = await dispatchWithBudget(
      starvingAdapter(),
      { workdir: workdir(), prompt: "starve the loop" },
      { wallClockMs: 200 },
      { killConfirm: { graceMs: 500, sigkillWaitMs: 1_000 } },
    );
    expect(record.outcome).toBe("killed-budget");
    expect(record.budgetBreach).toMatchObject({ kind: "wall-clock", limit: 200 });
    expect(record.budgetBreach!.observed).toBeGreaterThan(200);
    // The descendant self-exited, so the group is confirmed gone by the probe →
    // the clean A.3#5 / A.2#10 escalation applies (not the cleanup-failed path).
    expect(escalation).toBeDefined();
    expect(escalation!.attemptEvent.killConfirmed).toBe(true);
  }, 30_000);

  it("token breach mid-stream: cumulative usage reports kill the dispatch in flight", async () => {
    const { record, escalation } = await dispatchWithBudget(
      mockAdapter("tokens-stream"),
      { workdir: workdir(), prompt: "stream usage" },
      { wallClockMs: 60_000, tokens: 2_000 },
      { killConfirm: FAST_KILL },
    );
    expect(record.outcome).toBe("killed-budget");
    expect(record.budgetBreach).toMatchObject({ kind: "tokens", limit: 2_000 });
    expect(record.budgetBreach!.observed).toBeGreaterThanOrEqual(2_000);
    expect(escalation?.attemptEvent.killConfirmed).toBe(true);
  }, 30_000);

  it("token breach on the final report: exit 0 with over-budget usage is killed-budget, never succeeded", async () => {
    const { record, escalation } = await dispatchWithBudget(
      mockAdapter("tokens-final"),
      { workdir: workdir(), prompt: "report at end" },
      { wallClockMs: 60_000, tokens: 1_000 },
      { killConfirm: FAST_KILL },
    );
    // The breach can be detected while the process is still alive (killed by
    // signal → exitCode null) or from the drain after a natural exit 0 — the
    // classification must be killed-budget EITHER way, never succeeded.
    expect([0, null]).toContain(record.exitCode);
    expect(record.outcome).toBe("killed-budget");
    expect(record.budgetBreach).toMatchObject({ kind: "tokens", limit: 1_000, observed: 999_999 });
    expect(escalation).toBeDefined();
  }, 30_000);

  it("a generous budget never manufactures a breach", async () => {
    const { record, escalation } = await dispatchWithBudget(
      mockAdapter(),
      { workdir: workdir(), prompt: "solve" },
      { wallClockMs: 60_000, tokens: 1_000_000 },
      { killConfirm: FAST_KILL },
    );
    expect(record.outcome).toBe("succeeded");
    expect(record.budgetBreach).toBeUndefined();
    expect(escalation).toBeUndefined();
  }, 30_000);

  it("a provider rate limit under budget stays quota-blocked — a quota wait is not a budget breach", async () => {
    const { record, escalation } = await dispatchWithBudget(
      mockAdapter("quota"),
      { workdir: workdir(), prompt: "rate limited" },
      { wallClockMs: 60_000, tokens: 1_000_000 },
      { killConfirm: FAST_KILL },
    );
    expect(record.outcome).toBe("quota-blocked");
    expect(escalation).toBeUndefined();
  }, 30_000);

  it("refuses a malformed budget before dispatching anything", async () => {
    await expect(
      dispatchWithBudget(mockAdapter(), { workdir: workdir(), prompt: "x" }, { wallClockMs: 0 }),
    ).rejects.toThrow(BudgetConfigError);
  });

  it("a plan() that overruns the wall-clock budget then THROWS is killed-budget, not requirement-failed (round-2 finding 5)", async () => {
    // An adapter whose plan() blocks past the deadline then throws never armed
    // the async timer; the exception path must still charge the elapsed time.
    const throwingAdapter = {
      name: "mock:plan-overrun",
      enabled: true,
      plan(): never {
        const until = Date.now() + 120;
        while (Date.now() < until) {
          /* block synchronously past the 30ms budget */
        }
        throw new Error("plan failed after overrunning the budget");
      },
      parseLine: () => null,
    };
    const { record, escalation } = await dispatchWithBudget(
      throwingAdapter,
      { workdir: workdir(), prompt: "overrun" },
      { wallClockMs: 30 },
      { killConfirm: FAST_KILL },
    );
    expect(record.outcome).toBe("killed-budget");
    expect(record.budgetBreach).toMatchObject({ kind: "wall-clock", limit: 30 });
    expect(escalation).toBeDefined();
  }, 30_000);

  it("a plan() that overruns the budget then returns an UNSPAWNABLE file is killed-budget (round-3 finding 7)", async () => {
    const badSpawnAdapter = {
      name: "mock:overrun-badspawn",
      enabled: true,
      plan() {
        const until = Date.now() + 120;
        while (Date.now() < until) {
          /* block past the 30ms budget */
        }
        return { file: "/definitely/missing/camino-worker", args: [] };
      },
      parseLine: () => null,
    };
    const { record, escalation } = await dispatchWithBudget(
      badSpawnAdapter,
      { workdir: workdir(), prompt: "overrun-badspawn" },
      { wallClockMs: 30 },
      { killConfirm: FAST_KILL },
    );
    expect(record.spawned).toBe(false);
    expect(record.outcome).toBe("killed-budget");
    expect(record.budgetBreach).toMatchObject({ kind: "wall-clock", limit: 30 });
    expect(escalation).toBeDefined();
  }, 30_000);

  it("a budget breach at the SAME boundary as a generic timeout classifies killed-budget (round-1 finding 7)", async () => {
    // Equal wall-clock budget and timeout: the budget must win so A.2#10
    // kill-and-escalate fires, never a generic `killed`.
    const { record, escalation } = await dispatchWithBudget(
      mockAdapter("graceful-cancel"),
      { workdir: workdir(), prompt: "run forever" },
      { wallClockMs: 600 },
      { killConfirm: FAST_KILL, timeoutMs: 600 },
    );
    expect(record.outcome).toBe("killed-budget");
    expect(record.budgetBreach?.kind).toBe("wall-clock");
    expect(escalation).toBeDefined();
  }, 30_000);
});

describe("never an automatic retry (A.2#10 pinned against the core table)", () => {
  it("every attempt-budget-breached row escalates; none re-readies", () => {
    const issueRows = issueMachine.rows.filter((r) => r.eventType === "attempt-budget-breached");
    expect(issueRows.length).toBeGreaterThan(0);
    for (const row of issueRows) expect(row.to).toBe("escalated");
    const attemptRows = attemptMachine.rows.filter(
      (r) => r.eventType === "attempt-budget-breached",
    );
    expect(attemptRows.length).toBeGreaterThan(0);
    for (const row of attemptRows) expect(row.to).toBe("killed-budget");
  });

  it("leaving `escalated` for `ready` requires David's answer — no automatic path resumes dispatch", () => {
    const outOfEscalated = issueMachine.rows.filter(
      (r) => Array.isArray(r.from) && r.from.includes("escalated"),
    );
    expect(outOfEscalated.length).toBeGreaterThan(0);
    // The no-auto-retry claim, precisely: every row that can take an
    // escalated issue back to `ready` (dispatchable) is the human-answer
    // event. Other exits (cancel, contract edit → replanning, cleanup
    // failure → blocked) never resume dispatch directly.
    const toReady = outOfEscalated.filter((r) => r.to === "ready");
    expect(toReady.length).toBeGreaterThan(0);
    for (const row of toReady) expect(row.eventType).toBe("escalation-answered");
    for (const row of outOfEscalated) {
      if (typeof row.to === "string" && row.to !== "ready") continue;
      expect(row.eventType).toBe("escalation-answered");
    }
  });

  it("an unconfirmed kill cannot take the clean escalation row (guard refuses)", () => {
    const event: IssueEvent = { type: "attempt-budget-breached", killConfirmed: false };
    const step = transition(issueMachine, "implementing", event);
    expect(step.ok).toBe(false);
  });
});
