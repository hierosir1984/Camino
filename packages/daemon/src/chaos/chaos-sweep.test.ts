/**
 * Exhaustive kill-point sweep (WP-104, CAM-STATE-06): walk N upward and
 * SIGKILL the mixed-workload child at its N-th hook invocation — EVERY
 * instrumented protocol gap in the script, without naming any of them —
 * until a run survives to completion. Deterministic (same script, same
 * seeds, same N → same gap), and every iteration must satisfy the same
 * universal invariants as the named matrix.
 *
 * This closes the gap between the named points and "any interleaving":
 * points the matrix samples once (e.g. after-execution-started,
 * in-transport-after-effect) are all swept here across every intent of
 * the mixed workload.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  assertChaosInvariants,
  destroyWorld,
  prepareWorld,
  recoverAndComplete,
  runChaosChild,
} from "./harness.js";
import type { ChaosWorld } from "./harness.js";
import { CHAOS_SCRIPTS } from "./scripts.js";

const SWEEP_CAP = 40;

let worlds: ChaosWorld[] = [];
afterEach(() => {
  for (const w of worlds) destroyWorld(w);
  worlds = [];
});

describe("exhaustive Nth-hook sweep over the mixed workload", () => {
  it("every hook-site kill recovers with the universal invariants intact", () => {
    let completedAt: number | null = null;
    for (let n = 1; n <= SWEEP_CAP; n += 1) {
      const world = prepareWorld(CHAOS_SCRIPTS["mixed"]);
      worlds.push(world);
      const result = runChaosChild(world, { mode: "run", script: "mixed", killNth: n });
      if (result.completed) {
        // N exceeded the script's total hook count: the child ran the
        // whole workload with the hook armed but never triggered.
        expect(result.signal).toBeNull();
        completedAt = n;
        break;
      }
      expect(result.signal, `iteration ${n} should die by SIGKILL: ${result.stderr}`).toBe(
        "SIGKILL",
      );
      const recovered = recoverAndComplete(world);
      try {
        // Whatever gap N landed in: nothing duplicated, nothing lost.
        assertChaosInvariants(world, recovered);
        // The mixed workload's specific exactly-once ledger:
        expect(
          world.github.effectCounts().get("branch:fixture-repo:camino/issue-2") ?? 0,
        ).toBeLessThanOrEqual(1);
        expect(
          world.testService.environmentCount("env-mixed", "seed-database"),
        ).toBeLessThanOrEqual(1);
      } finally {
        recovered.state.close();
      }
    }
    // The sweep must actually terminate by surviving, and only after
    // covering a meaningful number of gaps (the mixed script has 15
    // instrumented sites; a much smaller count means instrumentation
    // silently vanished).
    expect(completedAt, `no run survived within ${SWEEP_CAP} iterations`).not.toBeNull();
    expect(completedAt!).toBeGreaterThanOrEqual(15);
  }, 300_000);
});
