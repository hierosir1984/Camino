/**
 * Random-kill runs (WP-104, CAM-STATE-06): the SUPPLEMENT the PRD asks
 * for — they never substitute for the deterministic matrix, and they
 * assert the universal invariants only (exact per-class outcomes belong
 * to the deterministic suite).
 *
 * Two random modes, both seeded and reproducible (round-1 finding 6
 * showed pure wall-clock kills mostly miss the protocol entirely):
 *
 *  1. RANDOM KILL SITE: the child dies at a seeded-random Nth hook
 *     invocation. Draws within the hook count land INSIDE the durable
 *     protocol at a gap nobody named; draws beyond it exercise the
 *     survival path. This SAMPLES sites — the exhaustive sweep
 *     (chaos-sweep.test.ts) is what covers every site, and each fixed
 *     seed is verified to produce at least one genuine kill.
 *  2. RANDOM TIMER: an external SIGKILL after a seeded-random delay —
 *     free to land where no hook exists (inside SQLite commits, fake
 *     state renames, store opening, closing). A kill before or after the
 *     protocol exercises daemon startup/shutdown recovery and is valid
 *     coverage, not a miss; the invariants must hold wherever it lands.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  assertChaosInvariants,
  destroyWorld,
  prepareWorld,
  recoverAndComplete,
  runChaosChild,
  runChaosChildTimedKill,
} from "./harness.js";
import type { ChaosWorld } from "./harness.js";
import { CHAOS_SCRIPTS } from "./scripts.js";

/** Deterministic small PRNG (mulberry32) so a failing seed reproduces. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIXED_MANIFEST = CHAOS_SCRIPTS["mixed"]!.intents.map((intent) => intent.intentId);
/** The mixed script fires 15 hook sites; the range leaves headroom so some rounds survive. */
const NTH_RANGE = 18;

const SEEDS = [104_001, 104_002, 104_003];
const ROUNDS_PER_SEED = 3;

let worlds: ChaosWorld[] = [];
afterEach(() => {
  for (const w of worlds) destroyWorld(w);
  worlds = [];
});

describe("seeded random kill sites (samples protocol gaps; the sweep is the exhaustive cover)", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: random Nth-hook kills leave the invariants intact`, () => {
      const random = mulberry32(seed);
      let kills = 0;
      for (let round = 0; round < ROUNDS_PER_SEED; round += 1) {
        const world = prepareWorld(CHAOS_SCRIPTS["mixed"]);
        worlds.push(world);
        const nth = 1 + Math.floor(random() * NTH_RANGE);
        const result = runChaosChild(world, { mode: "run", script: "mixed", killNth: nth });
        if (!result.completed) {
          expect(result.signal, `nth=${nth} stderr: ${result.stderr}`).toBe("SIGKILL");
          kills += 1;
        }
        const recovered = recoverAndComplete(world);
        try {
          assertChaosInvariants(world, recovered, MIXED_MANIFEST);
        } finally {
          recovered.state.close();
        }
      }
      // The fixed seeds must actually kill: a seed whose every draw
      // survives would be sampling nothing (round 2 finding 7; the
      // round-2 fold of this assertion failed to land — round 3 caught
      // it).
      expect(kills).toBeGreaterThanOrEqual(1);
    }, 120_000);
  }
});

describe("seeded random timers (kills land anywhere, hooked or not)", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: external SIGKILLs at random delays leave the invariants intact`, async () => {
      const random = mulberry32(seed ^ 0x5f3759df);
      for (let round = 0; round < ROUNDS_PER_SEED; round += 1) {
        const world = prepareWorld(CHAOS_SCRIPTS["mixed"]);
        worlds.push(world);
        const delayMs = 10 + Math.floor(random() * 700);
        const result = await runChaosChildTimedKill(
          world,
          { mode: "run", script: "mixed" },
          delayMs,
        );
        // Either the kill landed (SIGKILL — possibly during startup or
        // close, both legitimate windows) or the child finished first.
        if (!result.completed) {
          expect(result.signal, `round ${round} stderr: ${result.stderr}`).toBe("SIGKILL");
        }
        const recovered = recoverAndComplete(world);
        try {
          assertChaosInvariants(world, recovered, MIXED_MANIFEST);
        } finally {
          recovered.state.close();
        }
      }
    }, 120_000);
  }
});
