/**
 * Deterministic seeded kill-point suite (WP-104, CAM-STATE-06).
 *
 * For EVERY §4.4 operation class, a real child process runs the durable
 * protocol and SIGKILLs ITSELF at named points on BOTH sides of the
 * external call:
 *
 *   K1 after-intent-recorded      intent durable, nothing sent
 *   K2 in-transport-before-effect barrier durable, request "in flight",
 *                                 effect never committed externally
 *   K3 after-external-call        effect committed AND response received,
 *                                 confirmation not yet recorded — the
 *                                 dangerous ambiguity window
 *
 * The parent then recovers in-process exactly as a restarted daemon
 * would (lock → replay-verify → reconcile → complete) and asserts the
 * class's §4.4 outcome PLUS the universal invariants: zero duplicate
 * external effects, zero lost state, exactly-once ambiguity, idempotent
 * re-recovery. Sub-case rows cover the escalation classes (closed/reused
 * branch, out-of-band ref moves, superseded merge base) and kills INSIDE
 * recovery itself. Random-kill runs live in chaos-random.test.ts —
 * supplement, never substitute (they assert the same invariants without
 * the per-class expectations).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { IntentStatus } from "@camino/shared";
import {
  assertChaosInvariants,
  destroyWorld,
  eventCount,
  prepareWorld,
  recoverAndComplete,
  runChaosChild,
} from "./harness.js";
import type { ChaosWorld, RecoveredWorld } from "./harness.js";
import type { KillPointName } from "./kill-points.js";
import { CHAOS_SCRIPTS, OTHER_SHA } from "./scripts.js";

let worlds: ChaosWorld[] = [];
function world(script?: string): ChaosWorld {
  const w = prepareWorld(script === undefined ? undefined : CHAOS_SCRIPTS[script]);
  worlds.push(w);
  return w;
}
afterEach(() => {
  for (const w of worlds) destroyWorld(w);
  worlds = [];
});

interface MatrixExpect {
  /** Final status of the scripted intent after recovery + completion. */
  readonly finalStatus: IntentStatus;
  /** Times execution ever started (at-most-once evidence). */
  readonly executionStarted: number;
  /** Ambiguity rows durably recorded (exactly one per genuinely ambiguous case). */
  readonly ambiguityRows: number;
  /** Per-class effect assertion after everything settles. */
  assertEffects(world: ChaosWorld): void;
}

interface MatrixRow {
  readonly script: string;
  readonly intentId: string;
  readonly killPoint: KillPointName;
  /** Out-of-band world change between the child's death and recovery. */
  postKill?(world: ChaosWorld): void;
  readonly expect: MatrixExpect;
}

const SHA_F = "f".repeat(40);
const SHA_E = "e".repeat(40);

const effectOnce =
  (key: string) =>
  (w: ChaosWorld): void => {
    expect(w.github.effectCounts().get(key), `effect ${key}`).toBe(1);
  };
const effectNever =
  (key: string) =>
  (w: ChaosWorld): void => {
    expect(w.github.effectCounts().get(key), `effect ${key}`).toBeUndefined();
  };

/** The three canonical kill points for one class, with per-window outcomes. */
function classRows(
  script: string,
  intentId: string,
  outcomes: {
    /** K2: what the barrier-window kill recovers to (before any effect landed). */
    readonly beforeEffect: MatrixExpect;
    /** K3: what the post-effect kill recovers to. */
    readonly afterEffect: MatrixExpect;
    /** K1 effect assertion (completion applies the effect exactly once). */
    assertK1Effects(world: ChaosWorld): void;
  },
): MatrixRow[] {
  return [
    {
      script,
      intentId,
      killPoint: "after-intent-recorded",
      expect: {
        finalStatus: "confirmed",
        executionStarted: 1,
        ambiguityRows: 0,
        assertEffects: outcomes.assertK1Effects,
      },
    },
    { script, intentId, killPoint: "in-transport-before-effect", expect: outcomes.beforeEffect },
    { script, intentId, killPoint: "after-external-call", expect: outcomes.afterEffect },
  ];
}

/** Decidable classes: K2 re-arms and completes; K3 reconcile-confirms. */
function decidable(script: string, intentId: string, effectKey: string): MatrixRow[] {
  return classRows(script, intentId, {
    assertK1Effects: effectOnce(effectKey),
    beforeEffect: {
      finalStatus: "confirmed",
      executionStarted: 2,
      ambiguityRows: 0,
      assertEffects: effectOnce(effectKey),
    },
    afterEffect: {
      finalStatus: "confirmed",
      executionStarted: 1,
      ambiguityRows: 0,
      assertEffects: effectOnce(effectKey),
    },
  });
}

const MATRIX: MatrixRow[] = [
  ...decidable("branch-create", "intent-branch-1", "branch:fixture-repo:camino/issue-1"),
  ...decidable("push", "intent-push-1", `push:fixture-repo:camino/issue-1:${SHA_F}`),
  ...decidable("pr-create", "intent-pr-1", "pr:fixture-repo:camino/issue-1:main"),
  ...decidable("merge-by-push", "intent-merge-1", `merge:fixture-repo:main:${SHA_E}`),
  ...decidable(
    "label-set",
    "intent-label-1",
    "label:fixture-repo:issue#7:camino:executing:present",
  ),
  ...decidable(
    "comment-post",
    "intent-comment-1",
    "comment:fixture-repo:issue#7:camino-intent:intent-comment-1",
  ),

  // workflow-dispatch: at-most-once. K2 = lost response, NO correlated run
  // → one durable ambiguity, escalation, zero dispatches, no auto-retry.
  // K3 = run exists → correlation presence is conclusive → confirmed.
  ...classRows("workflow-dispatch", "intent-dispatch-1", {
    assertK1Effects: effectOnce("dispatch:fixture-repo:intent-dispatch-1"),
    beforeEffect: {
      finalStatus: "escalated",
      executionStarted: 1,
      ambiguityRows: 1,
      assertEffects: effectNever("dispatch:fixture-repo:intent-dispatch-1"),
    },
    afterEffect: {
      finalStatus: "confirmed",
      executionStarted: 1,
      ambiguityRows: 0,
      assertEffects: effectOnce("dispatch:fixture-repo:intent-dispatch-1"),
    },
  }),

  // test-service resettable: the environment is the idempotency unit —
  // both windows recover to exactly one application (reset-before-use
  // wipes any pre-crash application before the re-execution).
  ...classRows("test-service-resettable", "intent-test-1", {
    assertK1Effects: (w) => {
      expect(w.testService.environmentCount("env-alpha", "seed-database")).toBe(1);
    },
    beforeEffect: {
      finalStatus: "confirmed",
      executionStarted: 2,
      ambiguityRows: 0,
      assertEffects: (w) => {
        expect(w.testService.environmentCount("env-alpha", "seed-database")).toBe(1);
      },
    },
    afterEffect: {
      finalStatus: "confirmed",
      executionStarted: 2,
      ambiguityRows: 0,
      assertEffects: (w) => {
        expect(w.testService.environmentCount("env-alpha", "seed-database")).toBe(1);
      },
    },
  }),

  // test-service irreversible: any unconfirmed window is ambiguity +
  // escalation; the outbox proves no auto-retry ever fired.
  ...classRows("test-service-irreversible", "intent-test-2", {
    assertK1Effects: (w) => {
      expect(w.testService.outboxCount("env-alpha", "send-verification-email")).toBe(1);
    },
    beforeEffect: {
      finalStatus: "escalated",
      executionStarted: 1,
      ambiguityRows: 1,
      assertEffects: (w) => {
        expect(w.testService.outboxCount("env-alpha", "send-verification-email")).toBe(0);
      },
    },
    afterEffect: {
      finalStatus: "escalated",
      executionStarted: 1,
      ambiguityRows: 1,
      assertEffects: (w) => {
        expect(w.testService.outboxCount("env-alpha", "send-verification-email")).toBe(1);
      },
    },
  }),

  // catch-all: no reconciliation key exists — every unconfirmed window is
  // one durable ambiguity + escalation, whatever really happened.
  ...classRows("catch-all", "intent-misc-1", {
    assertK1Effects: (w) => {
      expect(w.catchAll.effectCount("rotate the fixture tenant token")).toBe(1);
    },
    beforeEffect: {
      finalStatus: "escalated",
      executionStarted: 1,
      ambiguityRows: 1,
      assertEffects: (w) => {
        expect(w.catchAll.effectCount("rotate the fixture tenant token")).toBe(0);
      },
    },
    afterEffect: {
      finalStatus: "escalated",
      executionStarted: 1,
      ambiguityRows: 1,
      assertEffects: (w) => {
        expect(w.catchAll.effectCount("rotate the fixture tenant token")).toBe(1);
      },
    },
  }),

  // ---- escalation sub-cases: the world changed while we were dead ----

  // Closed/reused-branch: a closed PR appears on the head branch.
  {
    script: "pr-create",
    intentId: "intent-pr-1",
    killPoint: "in-transport-before-effect",
    postKill: (w) => {
      w.github.seedPullRequest("fixture-repo", {
        headBranch: "camino/issue-1",
        baseBranch: "main",
        state: "closed",
        title: "an earlier mission's PR",
        body: "old",
      });
    },
    expect: {
      finalStatus: "escalated",
      executionStarted: 1,
      ambiguityRows: 1,
      assertEffects: effectNever("pr:fixture-repo:camino/issue-1:main"),
    },
  },
  // Mutable body: the PR landed but someone edited the marker away —
  // branch key primary, confirmed uncorroborated.
  {
    script: "pr-create",
    intentId: "intent-pr-1",
    killPoint: "after-external-call",
    postKill: (w) => {
      w.github.setPullRequestBodyOutOfBand("fixture-repo", 1, "body edited by someone");
    },
    expect: {
      finalStatus: "confirmed",
      executionStarted: 1,
      ambiguityRows: 0,
      assertEffects: effectOnce("pr:fixture-repo:camino/issue-1:main"),
    },
  },
  // Out-of-band ref move during the crash: push escalates, never forces.
  {
    script: "push",
    intentId: "intent-push-1",
    killPoint: "in-transport-before-effect",
    postKill: (w) => {
      w.github.moveRefOutOfBand("fixture-repo", "camino/issue-1", OTHER_SHA);
    },
    expect: {
      finalStatus: "escalated",
      executionStarted: 1,
      ambiguityRows: 1,
      assertEffects: (w) => {
        expect(w.github.getRef("fixture-repo", "camino/issue-1")).toBe(OTHER_SHA);
      },
    },
  },
  // Branch name collision during the crash: escalates, never overwrites.
  {
    script: "branch-create",
    intentId: "intent-branch-1",
    killPoint: "in-transport-before-effect",
    postKill: (w) => {
      w.github.moveRefOutOfBand("fixture-repo", "camino/issue-1", OTHER_SHA);
    },
    expect: {
      finalStatus: "escalated",
      executionStarted: 1,
      ambiguityRows: 1,
      assertEffects: (w) => {
        expect(w.github.getRef("fixture-repo", "camino/issue-1")).toBe(OTHER_SHA);
      },
    },
  },
  // Superseded merge base: main moved on — terminal failure, surfaced.
  {
    script: "merge-by-push",
    intentId: "intent-merge-1",
    killPoint: "in-transport-before-effect",
    postKill: (w) => {
      w.github.moveRefOutOfBand("fixture-repo", "main", OTHER_SHA);
    },
    expect: {
      finalStatus: "failed",
      executionStarted: 1,
      ambiguityRows: 0,
      assertEffects: (w) => {
        expect(w.github.getRef("fixture-repo", "main")).toBe(OTHER_SHA);
      },
    },
  },
];

function runRow(row: MatrixRow): { w: ChaosWorld; recovered: RecoveredWorld } {
  const w = world(row.script);
  const result = runChaosChild(w, {
    mode: "run",
    script: row.script,
    killPoint: row.killPoint,
  });
  expect(result.signal, `child must die by SIGKILL at ${row.killPoint}: ${result.stderr}`).toBe(
    "SIGKILL",
  );
  expect(result.completed).toBe(false);
  row.postKill?.(w);
  const recovered = recoverAndComplete(w);
  return { w, recovered };
}

describe("deterministic kill-point matrix (every §4.4 class, both sides of the call)", () => {
  for (const row of MATRIX) {
    const label = `${row.script} × ${row.killPoint}${row.postKill ? " (world changed during the crash)" : ""}`;
    it(
      label,
      () => {
        const { w, recovered } = runRow(row);
        try {
          const entry = recovered.state.journal.entry(row.intentId);
          expect(entry, `intent ${row.intentId} missing from the journal`).toBeDefined();
          expect(entry!.status).toBe(row.expect.finalStatus);
          expect(entry!.executionStartedCount).toBe(row.expect.executionStarted);
          expect(eventCount(recovered.state, row.intentId, "ambiguity-recorded")).toBe(
            row.expect.ambiguityRows,
          );
          row.expect.assertEffects(w);
          assertChaosInvariants(w, recovered);
        } finally {
          recovered.state.close();
        }
      },
      45_000,
    );
  }
});

describe("kills inside recovery itself (reconciliation must be idempotent mid-crash)", () => {
  it("a crash between the ambiguity row and its escalation row leaves exactly one of each", () => {
    // Manufacture a dispatch lost-response crash...
    const w = world("workflow-dispatch");
    const crash = runChaosChild(w, {
      mode: "run",
      script: "workflow-dispatch",
      killPoint: "in-transport-before-effect",
    });
    expect(crash.signal).toBe("SIGKILL");
    // ...then kill the RECOVERING daemon between the two escalation appends.
    const recoveryCrash = runChaosChild(w, {
      mode: "recover",
      killPoint: "recovery-between-ambiguity-and-escalation",
    });
    expect(recoveryCrash.signal).toBe("SIGKILL");
    const recovered = recoverAndComplete(w);
    try {
      expect(recovered.state.journal.entry("intent-dispatch-1")!.status).toBe("escalated");
      expect(eventCount(recovered.state, "intent-dispatch-1", "ambiguity-recorded")).toBe(1);
      expect(eventCount(recovered.state, "intent-dispatch-1", "escalated")).toBe(1);
      assertChaosInvariants(w, recovered);
    } finally {
      recovered.state.close();
    }
  }, 45_000);

  it("a crash after a re-arm append (before completion) re-arms exactly once and completes", () => {
    const w = world("branch-create");
    const crash = runChaosChild(w, {
      mode: "run",
      script: "branch-create",
      killPoint: "in-transport-before-effect",
    });
    expect(crash.signal).toBe("SIGKILL");
    // The recovering daemon appends re-armed, then dies before executing.
    const recoveryCrash = runChaosChild(w, {
      mode: "recover",
      killPoint: "recovery-after-resolution-append",
    });
    expect(recoveryCrash.signal).toBe("SIGKILL");
    const recovered = recoverAndComplete(w);
    try {
      const entry = recovered.state.journal.entry("intent-branch-1")!;
      expect(entry.status).toBe("confirmed");
      expect(eventCount(recovered.state, "intent-branch-1", "re-armed")).toBe(1);
      expect(w.github.effectCounts().get("branch:fixture-repo:camino/issue-1")).toBe(1);
      assertChaosInvariants(w, recovered);
    } finally {
      recovered.state.close();
    }
  }, 45_000);
});

describe("the composite daemon-resume story (mixed script)", () => {
  it("control: with no kill, the child completes everything", () => {
    const w = world("mixed");
    const result = runChaosChild(w, { mode: "run", script: "mixed" });
    expect(result.completed, `child failed: ${result.stderr}`).toBe(true);
    expect(result.signal).toBeNull();
    const recovered = recoverAndComplete(w);
    try {
      expect(recovered.report.reconciled).toEqual([]);
      expect(recovered.state.recorder.currentState("mission", "mission-chaos")).toBe("draft");
      assertChaosInvariants(w, recovered);
    } finally {
      recovered.state.close();
    }
  }, 45_000);

  it("a kill mid-workload recovers the event log AND the journal together", () => {
    const w = world("mixed");
    // Third occurrence of the transport pre-effect point = the third
    // intent's external call; the mission event and two confirmed intents
    // are already durable.
    const result = runChaosChild(w, {
      mode: "run",
      script: "mixed",
      killPoint: "in-transport-before-effect",
      killOccurrence: 3,
    });
    expect(result.signal).toBe("SIGKILL");
    const recovered = recoverAndComplete(w);
    try {
      // The recorder's mission survived (its store replay-verified on open).
      expect(recovered.state.recorder.currentState("mission", "mission-chaos")).toBe("draft");
      // First two intents were already confirmed; the third re-armed and completed.
      expect(recovered.state.journal.entry("intent-mixed-branch")!.status).toBe("confirmed");
      expect(recovered.state.journal.entry("intent-mixed-push")!.status).toBe("confirmed");
      expect(recovered.state.journal.entry("intent-mixed-test")!.status).toBe("confirmed");
      expect(recovered.completed).toEqual(["intent-mixed-test"]);
      expect(w.testService.environmentCount("env-mixed", "seed-database")).toBe(1);
      assertChaosInvariants(w, recovered);
    } finally {
      recovered.state.close();
    }
  }, 45_000);
});
