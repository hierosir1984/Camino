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
    const tracker = new QuotaWindowTracker(path);
    tracker.recordDispatch("anthropic", {
      outcome: "succeeded",
      durationMs: 90_000,
      quotaSignalSeen: false,
      at: at(0),
    });
    tracker.recordDispatch("anthropic", {
      outcome: "quota-blocked",
      durationMs: 5_000,
      quotaSignalSeen: true,
      at: at(10 * MINUTE),
    });
    tracker.close();

    const reopened = new QuotaWindowTracker(path);
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

  it("is append-only at the database layer", () => {
    const path = tempPath();
    const tracker = new QuotaWindowTracker(path);
    tracker.recordDispatch("openai", {
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
    const tracker = new QuotaWindowTracker(tempPath());
    try {
      expect(() =>
        tracker.recordDispatch("openrouter" as ProviderFamily, {
          outcome: "succeeded",
          durationMs: 1,
          quotaSignalSeen: false,
        }),
      ).toThrow(TypeError);
      expect(() =>
        tracker.recordDispatch("anthropic", {
          outcome: "rate-limited" as never,
          durationMs: 1,
          quotaSignalSeen: false,
        }),
      ).toThrow(TypeError);
      expect(() =>
        tracker.recordDispatch("anthropic", {
          outcome: "succeeded",
          durationMs: Number.NaN,
          quotaSignalSeen: false,
        }),
      ).toThrow(TypeError);
      expect(() =>
        tracker.recordDispatch("anthropic", {
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
    const tracker = new QuotaWindowTracker(tempPath());
    try {
      const observation = tracker.recordDispatch("xai", {
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

describe("window consumption estimates", () => {
  it("reports full consumption until one window duration after an exhaustion (conservative reset)", () => {
    const tracker = new QuotaWindowTracker(tempPath(), { windowShapes: oneHourShape });
    try {
      tracker.recordDispatch("anthropic", {
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
      // the estimate; the blocked dispatch's own 2 minutes became the
      // capacity sample, and the freed window reads as empty.
      const after = tracker.windowState("anthropic", { now: at(HOUR + MINUTE) });
      expect(after.windows[0]).toMatchObject({
        basis: "usage-fraction",
        estimatedConsumption: 0,
        capacityEstimateMs: 2 * MINUTE,
      });
      expect(after.lastQuotaBlockedAt).toBe(at(0).toISOString());
    } finally {
      tracker.close();
    }
  });

  it("keeps the longer window exhausted after the shorter one frees (Claude 5h + weekly shapes)", () => {
    const tracker = new QuotaWindowTracker(tempPath()); // seed shapes for anthropic
    try {
      tracker.recordDispatch("anthropic", {
        outcome: "quota-blocked",
        durationMs: MINUTE,
        quotaSignalSeen: true,
        at: at(0),
      });
      const sixHoursLater = tracker.windowState("anthropic", { now: at(6 * HOUR) });
      const byId = new Map(sixHoursLater.windows.map((w) => [w.shape.id, w]));
      // The 5-hour window has freed (nothing dispatched in the last hour);
      // the weekly window stays pinned at full for its whole duration.
      expect(byId.get("session-5h")).toMatchObject({
        basis: "usage-fraction",
        estimatedConsumption: 0,
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
    const tracker = new QuotaWindowTracker(tempPath(), { windowShapes: oneHourShape });
    try {
      // 30 minutes of dispatch time inside the hour preceding exhaustion.
      tracker.recordDispatch("openai", {
        outcome: "succeeded",
        durationMs: 20 * MINUTE,
        quotaSignalSeen: false,
        at: at(10 * MINUTE),
      });
      tracker.recordDispatch("openai", {
        outcome: "succeeded",
        durationMs: 10 * MINUTE,
        quotaSignalSeen: false,
        at: at(30 * MINUTE),
      });
      tracker.recordDispatch("openai", {
        outcome: "quota-blocked",
        durationMs: MINUTE,
        quotaSignalSeen: true,
        at: at(40 * MINUTE),
      });
      // Two hours later (past the reset bound): fresh usage of 15 minutes
      // against the observed ~31-minute capacity.
      tracker.recordDispatch("openai", {
        outcome: "succeeded",
        durationMs: 15 * MINUTE,
        quotaSignalSeen: false,
        at: at(2 * HOUR + 30 * MINUTE),
      });
      const state = tracker.windowState("openai", { now: at(2 * HOUR + 31 * MINUTE) });
      const window = state.windows[0]!;
      expect(window.basis).toBe("usage-fraction");
      expect(window.capacityEstimateMs).toBe(31 * MINUTE); // 20 + 10 + 1 before the block
      expect(window.observedUsageMs).toBe(15 * MINUTE);
      expect(window.estimatedConsumption).toBeCloseTo(15 / 31, 5);
      expect(window.estimatedConsumption!).toBeLessThan(QUOTA_PAUSE_THRESHOLD);

      // More usage pushes the estimate over the WP-114 pause threshold.
      tracker.recordDispatch("openai", {
        outcome: "succeeded",
        durationMs: 12 * MINUTE,
        quotaSignalSeen: false,
        at: at(2 * HOUR + 45 * MINUTE),
      });
      const later = tracker.windowState("openai", { now: at(2 * HOUR + 46 * MINUTE) });
      expect(later.windows[0]?.estimatedConsumption).toBeCloseTo(27 / 31, 5);
      expect(later.windows[0]!.estimatedConsumption!).toBeGreaterThan(QUOTA_PAUSE_THRESHOLD);
    } finally {
      tracker.close();
    }
  });

  it("states 'no capacity estimate' instead of guessing when no exhaustion was ever observed", () => {
    const tracker = new QuotaWindowTracker(tempPath(), { windowShapes: oneHourShape });
    try {
      tracker.recordDispatch("anthropic", {
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
    const tracker = new QuotaWindowTracker(tempPath(), { windowShapes: oneHourShape });
    try {
      tracker.recordDispatch("anthropic", {
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
    const tracker = new QuotaWindowTracker(tempPath()); // seed: xai has no recorded shape
    try {
      tracker.recordDispatch("xai", {
        outcome: "quota-blocked",
        durationMs: MINUTE,
        quotaSignalSeen: true,
        at: at(0),
      });
      tracker.recordDispatch("xai", {
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
        kind: "rolling",
        durationMs: 90 * MINUTE,
      });
      // A fresh exhaustion now pins the observed window until its
      // conservative reset bound.
      tracker.recordDispatch("xai", {
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
    const tracker = new QuotaWindowTracker(tempPath(), { windowShapes: oneHourShape });
    try {
      tracker.recordDispatch("anthropic", {
        outcome: "quota-blocked",
        durationMs: MINUTE,
        quotaSignalSeen: true,
        at: at(2 * HOUR),
      });
      tracker.recordDispatch("anthropic", {
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
    const tracker = new QuotaWindowTracker(tempPath(), { windowShapes: oneHourShape });
    try {
      tracker.recordDispatch("openai", {
        outcome: "succeeded",
        durationMs: 2 * HOUR,
        quotaSignalSeen: false,
        at: at(HOUR), // ran 23:00→01:00; ends at T0+1h
      });
      tracker.recordDispatch("openai", {
        outcome: "quota-blocked",
        durationMs: 0,
        quotaSignalSeen: true,
        at: at(HOUR),
      });
      const afterReset = tracker.windowState("openai", { now: at(2 * HOUR + MINUTE) });
      expect(afterReset.windows[0]?.capacityEstimateMs).toBe(HOUR); // clipped, not 2h
      tracker.recordDispatch("openai", {
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
    const tracker = new QuotaWindowTracker(tempPath(), { windowShapes: oneHourShape });
    try {
      tracker.recordDispatch("anthropic", {
        outcome: "quota-blocked",
        durationMs: 0,
        quotaSignalSeen: true,
        at: at(HOUR),
      });
      tracker.recordDispatch("anthropic", {
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
    const tracker = new QuotaWindowTracker(tempPath());
    try {
      tracker.recordDispatch("xai", {
        outcome: "quota-blocked",
        durationMs: MINUTE,
        quotaSignalSeen: true,
        at: at(2 * HOUR),
      });
      tracker.recordDispatch("xai", {
        outcome: "succeeded",
        durationMs: MINUTE,
        quotaSignalSeen: false,
        at: at(HOUR), // backfilled success BEFORE the exhaustion
      });
      tracker.recordDispatch("xai", {
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
    const tracker = new QuotaWindowTracker(tempPath()); // xai: no seeded shape
    try {
      tracker.recordDispatch("xai", {
        outcome: "succeeded",
        durationMs: MINUTE,
        quotaSignalSeen: false,
        at: at(HOUR),
      });
      tracker.recordDispatch("xai", {
        outcome: "quota-blocked",
        durationMs: 0,
        quotaSignalSeen: true,
        at: at(HOUR),
      });
      tracker.recordDispatch("xai", {
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
    new QuotaWindowTracker(path).close();
    const db = new Database(path);
    db.exec("DROP TRIGGER window_obs_append_only_replace");
    db.close();
    expect(() => new QuotaWindowTracker(path)).toThrow(/tampered or foreign store/);
  });

  it("refuses a negative-seq row that would collide with the autoincrement sentinel", () => {
    // Round-2 review finding 3: a schema-valid seq=-1 row would make every
    // later append look like a replacement. The CHECK refuses it outright,
    // and ordinary appends keep working afterwards.
    const path = tempPath();
    const tracker = new QuotaWindowTracker(path);
    try {
      const db = new Database(path);
      try {
        expect(() =>
          db
            .prepare(
              `INSERT INTO window_observations (seq, family, observed_at, duration_ms, outcome, quota_signal)
               VALUES (-1, 'xai', ?, 0, 'succeeded', 0)`,
            )
            .run(at(0).toISOString()),
        ).toThrow(/CHECK/);
      } finally {
        db.close();
      }
      const appended = tracker.recordDispatch("xai", {
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

  it("refuses seq replacement through INSERT OR REPLACE (append-only, the PR #45 fold)", () => {
    const path = tempPath();
    const tracker = new QuotaWindowTracker(path);
    tracker.recordDispatch("openai", {
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
            `INSERT OR REPLACE INTO window_observations (seq, family, observed_at, duration_ms, outcome, quota_signal)
             VALUES (1, 'openai', ?, 999999, 'quota-blocked', 1)`,
          )
          .run(at(0).toISOString()),
      ).toThrow(/append-only/);
    } finally {
      db.close();
    }
  });
});
