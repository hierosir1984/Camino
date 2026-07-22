/**
 * WP-106 quota-window tracker (registry item 13): windows tracked from
 * adapter rate-limit signals, shapes and capacity refined from ledger
 * observation, estimates stated with their basis — never guessed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { QUOTA_PAUSE_THRESHOLD } from "@camino/shared";
import type { ProviderFamily, WindowShape } from "@camino/shared";
import { QuotaWindowTracker } from "./window-tracker.js";

let dirs: string[] = [];
function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-windows-"));
  dirs.push(dir);
  return join(dir, "windows.sqlite");
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const HOUR = 3_600_000;
const MINUTE = 60_000;
const T0 = Date.parse("2026-07-22T00:00:00Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs);

/** A single 1-hour window, injected so the estimation math is exact. */
const oneHourShape = (): readonly WindowShape[] => [
  { id: "test-1h", kind: "rolling", durationMs: HOUR },
];

describe("observation log", () => {
  it("records dispatches durably and reads them back after reopen", () => {
    const path = tempPath();
    const tracker = new QuotaWindowTracker(path, { writerLock: null });
    tracker.recordDispatch("anthropic", {
      dispatchId: "d1",
      outcome: "succeeded",
      durationMs: 90_000,
      quotaSignalSeen: false,
      at: at(0),
    });
    tracker.recordDispatch("anthropic", {
      dispatchId: "d2",
      outcome: "quota-blocked",
      durationMs: 5_000,
      quotaSignalSeen: true,
      at: at(10 * MINUTE),
    });
    tracker.close();

    const reopened = new QuotaWindowTracker(path, { writerLock: null });
    try {
      const observations = reopened.observations("anthropic");
      expect(observations).toHaveLength(2);
      expect(observations[0]).toMatchObject({
        family: "anthropic",
        outcome: "succeeded",
        durationMs: 90_000,
        quotaSignalSeen: false,
      });
      expect(observations[1]?.outcome).toBe("quota-blocked");
      expect(reopened.observations("openai")).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it("accepts the WP-107 `killed-budget` outcome — runtime allowlist AND SQL CHECK (round-18 finding 2)", () => {
    // killed-budget is a valid DispatchOutcome (CAM-EXEC-03). Without it in both the
    // runtime allowlist and the SQL CHECK, a real budget-breach record is rejected
    // downstream ("Unknown dispatch outcome" / CHECK constraint).
    const path = tempPath();
    const tracker = new QuotaWindowTracker(path, { writerLock: null });
    tracker.recordDispatch("anthropic", {
      dispatchId: "kb1",
      outcome: "killed-budget",
      durationMs: 1_234,
      quotaSignalSeen: false,
      at: at(0),
    });
    tracker.close();
    const reopened = new QuotaWindowTracker(path, { writerLock: null });
    try {
      const obs = reopened.observations("anthropic");
      expect(obs).toHaveLength(1);
      expect(obs[0]?.outcome).toBe("killed-budget");
    } finally {
      reopened.close();
    }
  });

  it("is append-only at the database layer", () => {
    const path = tempPath();
    const tracker = new QuotaWindowTracker(path, { writerLock: null });
    tracker.recordDispatch("openai", {
      dispatchId: "d3",
      outcome: "succeeded",
      durationMs: 1_000,
      quotaSignalSeen: false,
      at: at(0),
    });
    tracker.close();
    const db = new Database(path);
    try {
      expect(() =>
        db.prepare("UPDATE window_observations SET outcome = 'succeeded'").run(),
      ).toThrow(/append-only/);
      expect(() => db.prepare("DELETE FROM window_observations").run()).toThrow(/append-only/);
    } finally {
      db.close();
    }
  });

  it("refuses unknown families, unknown outcomes, and invalid durations", () => {
    const tracker = new QuotaWindowTracker(tempPath(), { writerLock: null });
    try {
      expect(() =>
        tracker.recordDispatch("openrouter" as ProviderFamily, {
          dispatchId: "bad-family",
          outcome: "succeeded",
          durationMs: 1,
          quotaSignalSeen: false,
        }),
      ).toThrow(TypeError);
      expect(() =>
        tracker.recordDispatch("anthropic", {
          dispatchId: "d4",
          outcome: "rate-limited" as never,
          durationMs: 1,
          quotaSignalSeen: false,
        }),
      ).toThrow(TypeError);
      expect(() =>
        tracker.recordDispatch("anthropic", {
          dispatchId: "d5",
          outcome: "succeeded",
          durationMs: Number.NaN,
          quotaSignalSeen: false,
        }),
      ).toThrow(TypeError);
      expect(() =>
        tracker.recordDispatch("anthropic", {
          dispatchId: "d6",
          outcome: "succeeded",
          durationMs: -5,
          quotaSignalSeen: false,
        }),
      ).toThrow(TypeError);
    } finally {
      tracker.close();
    }
  });

  it("marks a quota-blocked outcome as a quota signal even if the caller forgot the flag", () => {
    const tracker = new QuotaWindowTracker(tempPath(), { writerLock: null });
    try {
      const observation = tracker.recordDispatch("xai", {
        dispatchId: "d7",
        outcome: "quota-blocked",
        durationMs: 1_000,
        quotaSignalSeen: false,
        at: at(0),
      });
      expect(observation.quotaSignalSeen).toBe(true);
    } finally {
      tracker.close();
    }
  });
});

describe("idempotent recording (round-5 finding 1)", () => {
  it("replays of the same dispatch id with identical content return the existing row", () => {
    const tracker = new QuotaWindowTracker(tempPath(), {
      writerLock: null,
      windowShapes: oneHourShape,
    });
    try {
      const input = {
        dispatchId: "attempt-42",
        outcome: "succeeded" as const,
        durationMs: 30 * MINUTE,
        quotaSignalSeen: false,
        at: at(30 * MINUTE),
      };
      const first = tracker.recordDispatch("openai", input);
      const replay = tracker.recordDispatch("openai", input); // crash-recovery replay
      expect(replay).toEqual(first);
      expect(tracker.observations("openai")).toHaveLength(1);
      // The reviewer's duplicate-capacity receipt: a replay must not double
      // the denominator. One 30-minute dispatch, then exhaustion → the
      // capacity sample stays 30 minutes.
      tracker.recordDispatch("openai", {
        dispatchId: "attempt-43",
        outcome: "quota-blocked",
        durationMs: 0,
        quotaSignalSeen: true,
        at: at(31 * MINUTE),
      });
      const state = tracker.windowState("openai", { now: at(2 * HOUR) });
      expect(state.windows[0]?.capacityEstimateMs).toBe(30 * MINUTE);
    } finally {
      tracker.close();
    }
  });

  it("refuses the same dispatch id with different content as conflicting evidence", () => {
    const tracker = new QuotaWindowTracker(tempPath(), { writerLock: null });
    try {
      tracker.recordDispatch("xai", {
        dispatchId: "attempt-1",
        outcome: "succeeded",
        durationMs: 1_000,
        quotaSignalSeen: false,
        at: at(0),
      });
      expect(() =>
        tracker.recordDispatch("xai", {
          dispatchId: "attempt-1",
          outcome: "quota-blocked",
          durationMs: 5_000,
          quotaSignalSeen: true,
          at: at(MINUTE),
        }),
      ).toThrow(/conflicting evidence/);
      expect(tracker.observations("xai")).toHaveLength(1);
    } finally {
      tracker.close();
    }
  });

  it("refuses missing or malformed dispatch ids", () => {
    const tracker = new QuotaWindowTracker(tempPath(), { writerLock: null });
    try {
      for (const dispatchId of [undefined, "", "a".repeat(201), "x\0y", "\ud800"]) {
        expect(() =>
          tracker.recordDispatch("xai", {
            dispatchId: dispatchId as string,
            outcome: "succeeded",
            durationMs: 1,
            quotaSignalSeen: false,
            at: at(0),
          }),
        ).toThrow(TypeError);
      }
    } finally {
      tracker.close();
    }
  });
});

describe("append-only guards for the dispatch key (round-6 findings 1, 5)", () => {
  it("refuses INSERT OR REPLACE that conflicts on dispatch_id", () => {
    const path = tempPath();
    const tracker = new QuotaWindowTracker(path, { writerLock: null });
    tracker.recordDispatch("openai", {
      dispatchId: "victim",
      outcome: "succeeded",
      durationMs: 1_000,
      quotaSignalSeen: false,
      at: at(0),
    });
    tracker.close();
    const db = new Database(path);
    try {
      expect(() =>
        db
          .prepare(
            `INSERT OR REPLACE INTO window_observations (dispatch_id, family, observed_at, duration_ms, outcome, quota_signal)
             VALUES ('victim', 'openai', ?, 999999, 'quota-blocked', 1)`,
          )
          .run(at(0).toISOString()),
      ).toThrow(/append-only/);
      const row = db
        .prepare(
          "SELECT outcome, duration_ms FROM window_observations WHERE dispatch_id = 'victim'",
        )
        .get() as { outcome: string; duration_ms: number };
      expect(row).toEqual({ outcome: "succeeded", duration_ms: 1000 });
    } finally {
      db.close();
    }
  });

  it("refuses an older-version store with the version message, not a tamper message", () => {
    const path = tempPath();
    new QuotaWindowTracker(path, { writerLock: null }).close();
    const db = new Database(path);
    db.pragma("user_version = 1");
    db.close();
    expect(() => new QuotaWindowTracker(path, { writerLock: null })).toThrow(
      /schema version 1; this daemon expects 2/,
    );
  });
});

describe("replay timestamp semantics (round-6 finding 2)", () => {
  it("treats a clock-derived instant as the store's, not caller content — later replays still match", () => {
    let clock = at(HOUR);
    const tracker = new QuotaWindowTracker(tempPath(), { writerLock: null, now: () => clock });
    try {
      const input = {
        dispatchId: "durable-1",
        outcome: "succeeded" as const,
        durationMs: 1_000,
        quotaSignalSeen: false,
        // no `at`: the instant comes from the store's clock
      };
      const first = tracker.recordDispatch("openai", input);
      clock = at(2 * HOUR); // crash, restart, replay an hour later
      const replay = tracker.recordDispatch("openai", input);
      expect(replay).toEqual(first);
      expect(replay.observedAt).toBe(at(HOUR).toISOString());
      expect(tracker.observations("openai")).toHaveLength(1);
    } finally {
      tracker.close();
    }
  });

  it("still refuses a replay whose EXPLICIT instant differs — that is caller content", () => {
    const tracker = new QuotaWindowTracker(tempPath(), { writerLock: null });
    try {
      tracker.recordDispatch("openai", {
        dispatchId: "explicit-1",
        outcome: "succeeded",
        durationMs: 1_000,
        quotaSignalSeen: false,
        at: at(0),
      });
      expect(() =>
        tracker.recordDispatch("openai", {
          dispatchId: "explicit-1",
          outcome: "succeeded",
          durationMs: 1_000,
          quotaSignalSeen: false,
          at: at(MINUTE),
        }),
      ).toThrow(/conflicting evidence/);
    } finally {
      tracker.close();
    }
  });
});

describe("writer lock and clock independence (round-7 findings 2, 3)", () => {
  it("refuses construction without an explicit runtime lock decision (round-9 finding 1)", () => {
    type LooseCtor = new (path: string, options?: unknown) => unknown;
    const Loose = QuotaWindowTracker as unknown as LooseCtor;
    expect(() => new Loose(tempPath())).toThrow(/writerLock decision/);
    expect(() => new Loose(tempPath(), {})).toThrow(/writerLock decision/);
    expect(() => new Loose(tempPath(), { writerLock: undefined })).toThrow(/or explicitly null/);
    expect(() => new Loose(tempPath(), { writerLock: {} })).toThrow(/assertHeld/);
    expect(() => new Loose(tempPath(), { writerLock: "held" })).toThrow(/assertHeld/);
  });

  it("asserts the daemon writer lock on every append when wired", () => {
    const calls: string[] = [];
    const tracker = new QuotaWindowTracker(tempPath(), {
      writerLock: {
        assertHeld: (context) => {
          calls.push(context);
        },
      },
    });
    try {
      tracker.recordDispatch("openai", {
        dispatchId: "locked-1",
        outcome: "succeeded",
        durationMs: 1,
        quotaSignalSeen: false,
        at: at(0),
      });
      expect(calls).toEqual(["window observation append"]);
    } finally {
      tracker.close();
    }
    const refused = new QuotaWindowTracker(tempPath(), {
      writerLock: {
        assertHeld: () => {
          throw new Error("writer lock lost");
        },
      },
    });
    try {
      expect(() =>
        refused.recordDispatch("openai", {
          dispatchId: "locked-2",
          outcome: "succeeded",
          durationMs: 1,
          quotaSignalSeen: false,
          at: at(0),
        }),
      ).toThrow(/writer lock lost/);
      expect(refused.observations("openai")).toEqual([]);
    } finally {
      refused.close();
    }
  });

  it("replays an omitted-`at` dispatch without consulting the clock", () => {
    // Round-7 review finding 3: a replay whose instant is already
    // store-owned must not require a live clock.
    let clockCalls = 0;
    const tracker = new QuotaWindowTracker(tempPath(), {
      writerLock: null,
      now: () => {
        clockCalls++;
        if (clockCalls > 1) throw new Error("clock unavailable");
        return at(HOUR);
      },
    });
    try {
      const input = {
        dispatchId: "clockless-1",
        outcome: "succeeded" as const,
        durationMs: 1_000,
        quotaSignalSeen: false,
      };
      const first = tracker.recordDispatch("openai", input); // clock call 1
      const replay = tracker.recordDispatch("openai", input); // must not call the clock
      expect(replay).toEqual(first);
      expect(tracker.observations("openai")).toHaveLength(1);
    } finally {
      tracker.close();
    }
  });
});

describe("as-of semantics (round-5 finding 2)", () => {
  it("ignores future-dated observations until their instant arrives", () => {
    const tracker = new QuotaWindowTracker(tempPath(), { writerLock: null }); // xai: shapeless
    try {
      tracker.recordDispatch("xai", {
        dispatchId: "af-1",
        outcome: "quota-blocked",
        durationMs: MINUTE,
        quotaSignalSeen: true,
        at: at(0),
      });
      tracker.recordDispatch("xai", {
        dispatchId: "af-2",
        outcome: "succeeded",
        durationMs: MINUTE,
        quotaSignalSeen: false,
        at: at(10 * HOUR), // future-dated relative to the query below
      });
      // At +1h the recovery has not happened yet: still exhausted with an
      // unknown horizon, and no shape is synthesized from the future.
      const before = tracker.windowState("xai", { now: at(HOUR) });
      expect(before.windows).toEqual([]);
      expect(before.lastQuotaBlockedAt).toBe(at(0).toISOString());
      expect(tracker.recoveryGapsMs("xai", { asOf: at(HOUR) })).toEqual([]);
      // Once its instant arrives, the recovery counts normally.
      const after = tracker.windowState("xai", { now: at(11 * HOUR) });
      expect(after.windows).toHaveLength(1);
      expect(after.windows[0]?.shape.durationMs).toBe(10 * HOUR);
    } finally {
      tracker.close();
    }
  });
});

describe("window consumption estimates", () => {
  it("reports full consumption until one window duration after an exhaustion (conservative reset)", () => {
    const tracker = new QuotaWindowTracker(tempPath(), {
      writerLock: null,
      windowShapes: oneHourShape,
    });
    try {
      tracker.recordDispatch("anthropic", {
        dispatchId: "d8",
        outcome: "quota-blocked",
        durationMs: 2 * MINUTE,
        quotaSignalSeen: true,
        at: at(0),
      });
      const during = tracker.windowState("anthropic", { now: at(30 * MINUTE) });
      expect(during.windows[0]).toMatchObject({
        estimatedConsumption: 1,
        basis: "exhaustion-observed",
        estimatedResetAt: at(HOUR).toISOString(),
      });
      // After the conservative reset bound the exhaustion no longer pins
      // the estimate — and a refused attempt's own wall time is NOT
      // capacity evidence (round-4 finding 4), so with no other usage
      // there is no capacity estimate at all.
      const after = tracker.windowState("anthropic", { now: at(HOUR + MINUTE) });
      expect(after.windows[0]).toMatchObject({
        basis: "no-capacity-estimate",
        estimatedConsumption: null,
        capacityEstimateMs: null,
      });
      expect(after.lastQuotaBlockedAt).toBe(at(0).toISOString());
    } finally {
      tracker.close();
    }
  });

  it("keeps the longer window exhausted after the shorter one frees (Claude 5h + weekly shapes)", () => {
    const tracker = new QuotaWindowTracker(tempPath(), { writerLock: null }); // seed shapes for anthropic
    try {
      tracker.recordDispatch("anthropic", {
        dispatchId: "d9",
        outcome: "quota-blocked",
        durationMs: MINUTE,
        quotaSignalSeen: true,
        at: at(0),
      });
      const sixHoursLater = tracker.windowState("anthropic", { now: at(6 * HOUR) });
      const byId = new Map(sixHoursLater.windows.map((w) => [w.shape.id, w]));
      // The 5-hour window's pin has expired (any reset semantics of a
      // 5-hour period has fully reset by now) — and because its reset
      // semantics are UNKNOWN, no usage fraction is claimed (round-3
      // finding 2). The weekly window stays pinned for its whole period.
      expect(byId.get("session-5h")).toMatchObject({
        basis: "reset-semantics-unknown",
        estimatedConsumption: null,
      });
      expect(byId.get("weekly")).toMatchObject({
        estimatedConsumption: 1,
        basis: "exhaustion-observed",
      });
    } finally {
      tracker.close();
    }
  });

  it("refines capacity from the ledger: pre-exhaustion usage becomes the conservative capacity sample", () => {
    const tracker = new QuotaWindowTracker(tempPath(), {
      writerLock: null,
      windowShapes: oneHourShape,
    });
    try {
      // 30 minutes of dispatch time inside the hour preceding exhaustion.
      tracker.recordDispatch("openai", {
        dispatchId: "d10",
        outcome: "succeeded",
        durationMs: 20 * MINUTE,
        quotaSignalSeen: false,
        at: at(10 * MINUTE),
      });
      tracker.recordDispatch("openai", {
        dispatchId: "d11",
        outcome: "succeeded",
        durationMs: 10 * MINUTE,
        quotaSignalSeen: false,
        at: at(30 * MINUTE),
      });
      tracker.recordDispatch("openai", {
        dispatchId: "d12",
        outcome: "quota-blocked",
        durationMs: MINUTE,
        quotaSignalSeen: true,
        at: at(40 * MINUTE),
      });
      // Two hours later (past the reset bound): fresh usage of 15 minutes
      // against the observed ~31-minute capacity.
      tracker.recordDispatch("openai", {
        dispatchId: "d13",
        outcome: "succeeded",
        durationMs: 15 * MINUTE,
        quotaSignalSeen: false,
        at: at(2 * HOUR + 30 * MINUTE),
      });
      const state = tracker.windowState("openai", { now: at(2 * HOUR + 31 * MINUTE) });
      const window = state.windows[0]!;
      expect(window.basis).toBe("usage-fraction");
      // 20 + 10 minutes of SUCCEEDED usage before the block; the refused
      // attempt's own wall time is not capacity evidence (round-4 finding 4).
      expect(window.capacityEstimateMs).toBe(30 * MINUTE);
      expect(window.observedUsageMs).toBe(15 * MINUTE);
      expect(window.estimatedConsumption).toBeCloseTo(15 / 30, 5);
      expect(window.estimatedConsumption!).toBeLessThan(QUOTA_PAUSE_THRESHOLD);

      // More usage pushes the estimate over the WP-114 pause threshold.
      tracker.recordDispatch("openai", {
        dispatchId: "d14",
        outcome: "succeeded",
        durationMs: 12 * MINUTE,
        quotaSignalSeen: false,
        at: at(2 * HOUR + 45 * MINUTE),
      });
      const later = tracker.windowState("openai", { now: at(2 * HOUR + 46 * MINUTE) });
      expect(later.windows[0]?.estimatedConsumption).toBeCloseTo(27 / 30, 5);
      expect(later.windows[0]!.estimatedConsumption!).toBeGreaterThan(QUOTA_PAUSE_THRESHOLD);
    } finally {
      tracker.close();
    }
  });

  it("states 'no capacity estimate' instead of guessing when no exhaustion was ever observed", () => {
    const tracker = new QuotaWindowTracker(tempPath(), {
      writerLock: null,
      windowShapes: oneHourShape,
    });
    try {
      tracker.recordDispatch("anthropic", {
        dispatchId: "d15",
        outcome: "succeeded",
        durationMs: 45 * MINUTE,
        quotaSignalSeen: false,
        at: at(10 * MINUTE),
      });
      const state = tracker.windowState("anthropic", { now: at(20 * MINUTE) });
      expect(state.windows[0]).toMatchObject({
        estimatedConsumption: null,
        basis: "no-capacity-estimate",
        capacityEstimateMs: null,
        observedUsageMs: 45 * MINUTE,
      });
    } finally {
      tracker.close();
    }
  });

  it("exposes a recovered transient signal as pressure without forcing exhaustion (WP-105 round-7 channel)", () => {
    const tracker = new QuotaWindowTracker(tempPath(), {
      writerLock: null,
      windowShapes: oneHourShape,
    });
    try {
      tracker.recordDispatch("anthropic", {
        dispatchId: "d16",
        outcome: "succeeded",
        durationMs: 5 * MINUTE,
        quotaSignalSeen: true, // hit a limit mid-run, recovered to success
        at: at(0),
      });
      const state = tracker.windowState("anthropic", { now: at(MINUTE) });
      expect(state.lastQuotaSignalAt).toBe(at(0).toISOString());
      expect(state.lastQuotaBlockedAt).toBeNull();
      expect(state.windows[0]?.basis).toBe("no-capacity-estimate");
    } finally {
      tracker.close();
    }
  });

  it("refines a shapeless provider (Grok Build) into a scheduler-consumable observed shape", () => {
    const tracker = new QuotaWindowTracker(tempPath(), { writerLock: null }); // seed: xai has no recorded shape
    try {
      tracker.recordDispatch("xai", {
        dispatchId: "d17",
        outcome: "quota-blocked",
        durationMs: MINUTE,
        quotaSignalSeen: true,
        at: at(0),
      });
      tracker.recordDispatch("xai", {
        dispatchId: "d18",
        outcome: "requirement-failed",
        durationMs: MINUTE,
        quotaSignalSeen: false,
        at: at(30 * MINUTE),
      });
      // Before any recovery gap exists, no shape is claimed — exhausted
      // with an unknown reset horizon (the stated WP-114 boundary).
      const beforeRecovery = tracker.windowState("xai", { now: at(45 * MINUTE) });
      expect(beforeRecovery.windows).toEqual([]);
      expect(beforeRecovery.lastQuotaBlockedAt).toBe(at(0).toISOString());

      tracker.recordDispatch("xai", {
        dispatchId: "d19",
        outcome: "succeeded",
        durationMs: MINUTE,
        quotaSignalSeen: false,
        at: at(90 * MINUTE),
      });
      // The exhaustion→success gap (a failed dispatch is not recovery) is
      // the registry-item-13 refinement evidence — and it becomes a live
      // window shape the scheduler can apply the pause threshold to.
      expect(tracker.recoveryGapsMs("xai")).toEqual([90 * MINUTE]);
      const refined = tracker.windowState("xai", { now: at(2 * HOUR) });
      expect(refined.windows).toHaveLength(1);
      expect(refined.windows[0]?.shape).toEqual({
        id: "observed-recovery",
        kind: "unknown-reset", // a recovery gap is a horizon, not rolling evidence (round-4 finding 2)
        durationMs: 90 * MINUTE,
      });
      // A fresh exhaustion now pins the observed window until its
      // conservative reset bound.
      tracker.recordDispatch("xai", {
        dispatchId: "d20",
        outcome: "quota-blocked",
        durationMs: MINUTE,
        quotaSignalSeen: true,
        at: at(3 * HOUR),
      });
      const pinned = tracker.windowState("xai", { now: at(3 * HOUR + 30 * MINUTE) });
      expect(pinned.windows[0]).toMatchObject({
        estimatedConsumption: 1,
        basis: "exhaustion-observed",
        estimatedResetAt: at(4 * HOUR + 30 * MINUTE).toISOString(),
      });
    } finally {
      tracker.close();
    }
  });

  it("keeps the reset bound pinned to the LATEST exhaustion by timestamp, not insertion order", () => {
    // Round-1 review finding 1: a backfilled older exhaustion must not
    // displace a newer one and un-pin the window early.
    const tracker = new QuotaWindowTracker(tempPath(), {
      writerLock: null,
      windowShapes: oneHourShape,
    });
    try {
      tracker.recordDispatch("anthropic", {
        dispatchId: "d21",
        outcome: "quota-blocked",
        durationMs: MINUTE,
        quotaSignalSeen: true,
        at: at(2 * HOUR),
      });
      tracker.recordDispatch("anthropic", {
        dispatchId: "d22",
        outcome: "quota-blocked",
        durationMs: MINUTE,
        quotaSignalSeen: true,
        at: at(0), // backfill, inserted after
      });
      const state = tracker.windowState("anthropic", { now: at(2 * HOUR + 30 * MINUTE) });
      expect(state.lastQuotaBlockedAt).toBe(at(2 * HOUR).toISOString());
      expect(state.windows[0]).toMatchObject({
        estimatedConsumption: 1,
        basis: "exhaustion-observed",
        estimatedResetAt: at(3 * HOUR).toISOString(),
      });
    } finally {
      tracker.close();
    }
  });

  it("clips a dispatch longer than the window to the window (usage and capacity are interval overlaps)", () => {
    // Round-1 review finding 2: a two-hour dispatch must contribute at most
    // one hour to a one-hour window — as usage and as a capacity sample.
    const tracker = new QuotaWindowTracker(tempPath(), {
      writerLock: null,
      windowShapes: oneHourShape,
    });
    try {
      tracker.recordDispatch("openai", {
        dispatchId: "d23",
        outcome: "succeeded",
        durationMs: 2 * HOUR,
        quotaSignalSeen: false,
        at: at(HOUR), // ran 23:00→01:00; ends at T0+1h
      });
      tracker.recordDispatch("openai", {
        dispatchId: "d24",
        outcome: "quota-blocked",
        durationMs: 0,
        quotaSignalSeen: true,
        at: at(HOUR),
      });
      const afterReset = tracker.windowState("openai", { now: at(2 * HOUR + MINUTE) });
      expect(afterReset.windows[0]?.capacityEstimateMs).toBe(HOUR); // clipped, not 2h
      tracker.recordDispatch("openai", {
        dispatchId: "d25",
        outcome: "succeeded",
        durationMs: 30 * MINUTE,
        quotaSignalSeen: false,
        at: at(3 * HOUR),
      });
      const later = tracker.windowState("openai", { now: at(3 * HOUR + MINUTE) });
      expect(later.windows[0]).toMatchObject({
        basis: "usage-fraction",
        estimatedConsumption: 0.5, // 30min / 1h-clipped capacity — not 25%
      });
    } finally {
      tracker.close();
    }
  });

  it("excludes rows recorded after an exhaustion from its capacity sample even at equal timestamps", () => {
    // Round-1 review finding 2 (tie handling): "pre-exhaustion" is
    // timestamp-then-insertion order.
    const tracker = new QuotaWindowTracker(tempPath(), {
      writerLock: null,
      windowShapes: oneHourShape,
    });
    try {
      tracker.recordDispatch("anthropic", {
        dispatchId: "d26",
        outcome: "quota-blocked",
        durationMs: 0,
        quotaSignalSeen: true,
        at: at(HOUR),
      });
      tracker.recordDispatch("anthropic", {
        dispatchId: "d27",
        outcome: "succeeded",
        durationMs: 40 * MINUTE,
        quotaSignalSeen: false,
        at: at(HOUR), // same instant, inserted after the exhaustion
      });
      // Past the reset bound: the only would-be sample is the post-exhaustion
      // row, which must not count — so no capacity evidence exists.
      const state = tracker.windowState("anthropic", { now: at(2 * HOUR + MINUTE) });
      expect(state.windows[0]).toMatchObject({
        basis: "no-capacity-estimate",
        estimatedConsumption: null,
      });
    } finally {
      tracker.close();
    }
  });

  it("computes recovery gaps in timestamp order — backfills cannot make a gap negative", () => {
    const tracker = new QuotaWindowTracker(tempPath(), { writerLock: null });
    try {
      tracker.recordDispatch("xai", {
        dispatchId: "d28",
        outcome: "quota-blocked",
        durationMs: MINUTE,
        quotaSignalSeen: true,
        at: at(2 * HOUR),
      });
      tracker.recordDispatch("xai", {
        dispatchId: "d29",
        outcome: "succeeded",
        durationMs: MINUTE,
        quotaSignalSeen: false,
        at: at(HOUR), // backfilled success BEFORE the exhaustion
      });
      tracker.recordDispatch("xai", {
        dispatchId: "d30",
        outcome: "succeeded",
        durationMs: MINUTE,
        quotaSignalSeen: false,
        at: at(3 * HOUR + 30 * MINUTE),
      });
      expect(tracker.recoveryGapsMs("xai")).toEqual([90 * MINUTE]);
    } finally {
      tracker.close();
    }
  });

  it("does not count a success that was already in flight at the exhaustion as recovery", () => {
    // Round-2 review finding 1: a succeeded dispatch whose interval BEGAN
    // before the exhaustion proves nothing about the quota freeing — it
    // must not synthesize a shape or refine one.
    const tracker = new QuotaWindowTracker(tempPath(), { writerLock: null }); // xai: no seeded shape
    try {
      tracker.recordDispatch("xai", {
        dispatchId: "d31",
        outcome: "succeeded",
        durationMs: MINUTE,
        quotaSignalSeen: false,
        at: at(HOUR),
      });
      tracker.recordDispatch("xai", {
        dispatchId: "d32",
        outcome: "quota-blocked",
        durationMs: 0,
        quotaSignalSeen: true,
        at: at(HOUR),
      });
      tracker.recordDispatch("xai", {
        dispatchId: "d33",
        outcome: "succeeded",
        durationMs: HOUR, // started at 00:01 — BEFORE the 01:00 exhaustion
        quotaSignalSeen: false,
        at: at(HOUR + MINUTE),
      });
      expect(tracker.recoveryGapsMs("xai")).toEqual([]);
      const state = tracker.windowState("xai", { now: at(HOUR + 2 * MINUTE) });
      expect(state.windows).toEqual([]); // still "exhausted, horizon unknown"

      // A GENUINE recovery — whole interval after the exhaustion — counts.
      tracker.recordDispatch("xai", {
        dispatchId: "d34",
        outcome: "succeeded",
        durationMs: MINUTE,
        quotaSignalSeen: false,
        at: at(2 * HOUR + 30 * MINUTE),
      });
      expect(tracker.recoveryGapsMs("xai")).toEqual([90 * MINUTE]);
    } finally {
      tracker.close();
    }
  });

  it("refuses to adopt a store whose schema objects were tampered with", () => {
    // Round-2 review finding 2: the append-only promise rests on the
    // triggers, so adoption verifies schema DEFINITIONS, not user_version.
    const path = tempPath();
    new QuotaWindowTracker(path, { writerLock: null }).close();
    const db = new Database(path);
    db.exec("DROP TRIGGER window_obs_append_only_replace");
    db.close();
    expect(() => new QuotaWindowTracker(path, { writerLock: null })).toThrow(
      /tampered or foreign store/,
    );
  });

  it("refuses a negative-seq row that would collide with the autoincrement sentinel", () => {
    // Round-2 review finding 3: a schema-valid seq=-1 row would make every
    // later append look like a replacement. The CHECK refuses it outright,
    // and ordinary appends keep working afterwards.
    const path = tempPath();
    const tracker = new QuotaWindowTracker(path, { writerLock: null });
    try {
      const db = new Database(path);
      try {
        expect(() =>
          db
            .prepare(
              `INSERT INTO window_observations (seq, dispatch_id, family, observed_at, duration_ms, outcome, quota_signal)
               VALUES (-1, 'forged-neg', 'xai', ?, 0, 'succeeded', 0)`,
            )
            .run(at(0).toISOString()),
        ).toThrow(/CHECK/);
      } finally {
        db.close();
      }
      const appended = tracker.recordDispatch("xai", {
        dispatchId: "d35",
        outcome: "succeeded",
        durationMs: 1_000,
        quotaSignalSeen: false,
        at: at(MINUTE),
      });
      expect(appended.seq).toBeGreaterThan(0);
    } finally {
      tracker.close();
    }
  });

  it("keeps an unresolved exhaustion pinned on a synthesized shape until recovery evidence exists", () => {
    // Round-3 review finding 1: the synthesized duration is a guess, and a
    // guess must not expire a pin. Only observed recovery evidence does.
    const tracker = new QuotaWindowTracker(tempPath(), { writerLock: null }); // xai: shapeless
    try {
      tracker.recordDispatch("xai", {
        dispatchId: "d36",
        outcome: "quota-blocked",
        durationMs: MINUTE,
        quotaSignalSeen: true,
        at: at(0),
      });
      tracker.recordDispatch("xai", {
        dispatchId: "d37",
        outcome: "succeeded",
        durationMs: MINUTE,
        quotaSignalSeen: false,
        at: at(10 * MINUTE), // genuine recovery → 10-minute observed gap
      });
      tracker.recordDispatch("xai", {
        dispatchId: "d38",
        outcome: "quota-blocked",
        durationMs: MINUTE,
        quotaSignalSeen: true,
        at: at(30 * MINUTE), // NEW exhaustion, no recovery after it
      });
      // Far beyond the synthesized 10-minute duration: still pinned.
      const hoursLater = tracker.windowState("xai", { now: at(10 * HOUR) });
      expect(hoursLater.windows[0]).toMatchObject({
        estimatedConsumption: 1,
        basis: "exhaustion-observed",
      });
      // A backfilled SHORTER gap must not un-pin it either.
      tracker.recordDispatch("xai", {
        dispatchId: "d39",
        outcome: "succeeded",
        durationMs: MINUTE,
        quotaSignalSeen: false,
        at: at(5 * MINUTE), // backfill: shrinks nothing that matters
      });
      expect(
        tracker.windowState("xai", { now: at(10 * HOUR) }).windows[0]?.estimatedConsumption,
      ).toBe(1);
      // Recovery evidence AFTER the latest exhaustion un-pins.
      tracker.recordDispatch("xai", {
        dispatchId: "d40",
        outcome: "succeeded",
        durationMs: MINUTE,
        quotaSignalSeen: false,
        at: at(11 * HOUR),
      });
      expect(
        tracker.windowState("xai", { now: at(11 * HOUR + MINUTE) }).windows[0]?.basis,
      ).not.toBe("exhaustion-observed");
    } finally {
      tracker.close();
    }
  });

  it("rounds durations UP so rounding cannot manufacture a post-exhaustion start", () => {
    // Round-3 review finding 1 (rounding): a 0.4ms dispatch stores as 1ms —
    // the interval can only widen, never shrink past the exhaustion.
    const tracker = new QuotaWindowTracker(tempPath(), { writerLock: null });
    try {
      const observation = tracker.recordDispatch("xai", {
        dispatchId: "d41",
        outcome: "succeeded",
        durationMs: 0.4,
        quotaSignalSeen: false,
        at: at(0),
      });
      expect(observation.durationMs).toBe(1);
    } finally {
      tracker.close();
    }
  });

  it("uses the LATEST exhaustion's capacity sample, not the historical maximum", () => {
    // Round-3 review finding 2 (capacity drift): an old large sample must
    // not mask a later, smaller observed capacity.
    const tracker = new QuotaWindowTracker(tempPath(), {
      writerLock: null,
      windowShapes: oneHourShape,
    });
    try {
      tracker.recordDispatch("openai", {
        dispatchId: "d42",
        outcome: "succeeded",
        durationMs: 40 * MINUTE,
        quotaSignalSeen: false,
        at: at(40 * MINUTE),
      });
      tracker.recordDispatch("openai", {
        dispatchId: "d43",
        outcome: "quota-blocked",
        durationMs: 0,
        quotaSignalSeen: true,
        at: at(41 * MINUTE), // sample ≈ 40min
      });
      tracker.recordDispatch("openai", {
        dispatchId: "d44",
        outcome: "succeeded",
        durationMs: 20 * MINUTE,
        quotaSignalSeen: false,
        at: at(4 * HOUR),
      });
      tracker.recordDispatch("openai", {
        dispatchId: "d45",
        outcome: "quota-blocked",
        durationMs: 0,
        quotaSignalSeen: true,
        at: at(4 * HOUR + MINUTE), // later, smaller sample ≈ 20min
      });
      tracker.recordDispatch("openai", {
        dispatchId: "d46",
        outcome: "succeeded",
        durationMs: 10 * MINUTE,
        quotaSignalSeen: false,
        at: at(6 * HOUR),
      });
      const state = tracker.windowState("openai", { now: at(6 * HOUR + MINUTE) });
      expect(state.windows[0]).toMatchObject({
        basis: "usage-fraction",
        capacityEstimateMs: 20 * MINUTE,
        estimatedConsumption: 0.5, // 10min against the LATEST 20min sample
      });
    } finally {
      tracker.close();
    }
  });

  it("does not release a pin for an equal-timestamp success recorded BEFORE the exhaustion", () => {
    // Round-4 review finding 1: "after the exhaustion" is recorded order
    // (timestamp-then-seq), not timestamp alone.
    const tracker = new QuotaWindowTracker(tempPath(), { writerLock: null }); // xai: shapeless
    try {
      tracker.recordDispatch("xai", {
        dispatchId: "d47",
        outcome: "quota-blocked",
        durationMs: MINUTE,
        quotaSignalSeen: true,
        at: at(0),
      });
      tracker.recordDispatch("xai", {
        dispatchId: "d48",
        outcome: "succeeded",
        durationMs: 0,
        quotaSignalSeen: false,
        at: at(10 * MINUTE), // genuine gap → synthesized shape exists
      });
      tracker.recordDispatch("xai", {
        dispatchId: "d49",
        outcome: "succeeded",
        durationMs: 0,
        quotaSignalSeen: false,
        at: at(30 * MINUTE), // recorded BEFORE the block below, same instant
      });
      tracker.recordDispatch("xai", {
        dispatchId: "d50",
        outcome: "quota-blocked",
        durationMs: 0,
        quotaSignalSeen: true,
        at: at(30 * MINUTE),
      });
      const state = tracker.windowState("xai", { now: at(5 * HOUR) });
      expect(state.windows[0]).toMatchObject({
        estimatedConsumption: 1,
        basis: "exhaustion-observed",
      });
    } finally {
      tracker.close();
    }
  });

  it("yields no capacity estimate when the LATEST exhaustion carries no measured usage", () => {
    // Round-4 review finding 3: a zero-sample latest exhaustion must not
    // resurrect a stale historical sample.
    const tracker = new QuotaWindowTracker(tempPath(), {
      writerLock: null,
      windowShapes: oneHourShape,
    });
    try {
      tracker.recordDispatch("openai", {
        dispatchId: "d51",
        outcome: "succeeded",
        durationMs: 40 * MINUTE,
        quotaSignalSeen: false,
        at: at(40 * MINUTE),
      });
      tracker.recordDispatch("openai", {
        dispatchId: "d52",
        outcome: "quota-blocked",
        durationMs: 0,
        quotaSignalSeen: true,
        at: at(41 * MINUTE), // sample ≈ 40min at this exhaustion
      });
      // Hours later: a bare exhaustion with nothing in its window.
      tracker.recordDispatch("openai", {
        dispatchId: "d53",
        outcome: "quota-blocked",
        durationMs: 0,
        quotaSignalSeen: true,
        at: at(10 * HOUR),
      });
      tracker.recordDispatch("openai", {
        dispatchId: "d54",
        outcome: "succeeded",
        durationMs: 15 * MINUTE,
        quotaSignalSeen: false,
        at: at(12 * HOUR),
      });
      const state = tracker.windowState("openai", { now: at(12 * HOUR + MINUTE) });
      expect(state.windows[0]).toMatchObject({
        basis: "no-capacity-estimate",
        estimatedConsumption: null,
        capacityEstimateMs: null,
      });
    } finally {
      tracker.close();
    }
  });

  it("refuses seq replacement through INSERT OR REPLACE (append-only, the PR #45 fold)", () => {
    const path = tempPath();
    const tracker = new QuotaWindowTracker(path, { writerLock: null });
    tracker.recordDispatch("openai", {
      dispatchId: "d55",
      outcome: "succeeded",
      durationMs: 1_000,
      quotaSignalSeen: false,
      at: at(0),
    });
    tracker.close();
    const db = new Database(path);
    try {
      // Existing-seq replacement, fresh-position forgery, and max-rowid
      // poisoning (which would make every later autoincrement fail
      // SQLITE_FULL — round-3 finding 4) are all the same refused shape:
      // a caller-supplied seq.
      for (const seq of ["1", "50", "9223372036854775807"]) {
        expect(() =>
          db
            .prepare(
              `INSERT OR REPLACE INTO window_observations (seq, dispatch_id, family, observed_at, duration_ms, outcome, quota_signal)
               VALUES (${seq}, 'forged-${seq}', 'openai', ?, 999999, 'quota-blocked', 1)`,
            )
            .run(at(0).toISOString()),
        ).toThrow(/append-only/);
      }
      const tracker2 = new QuotaWindowTracker(path, { writerLock: null });
      try {
        expect(
          tracker2.recordDispatch("openai", {
            dispatchId: "d56",
            outcome: "succeeded",
            durationMs: 1,
            quotaSignalSeen: false,
            at: at(MINUTE),
          }).seq,
        ).toBeGreaterThan(0);
      } finally {
        tracker2.close();
      }
    } finally {
      db.close();
    }
  });
});
