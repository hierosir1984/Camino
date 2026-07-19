/**
 * Random-kill runs (WP-104, CAM-STATE-06): the SUPPLEMENT the PRD asks
 * for — they never substitute for the deterministic matrix. A seeded
 * PRNG picks external SIGKILL delays; wherever the kill happens to land
 * (including inside SQLite commits and fake-state renames, which no
 * named hook covers), recovery must satisfy the same universal
 * invariants. Assertions are invariant-based only: exact outcomes per
 * class belong to the deterministic suite.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  assertChaosInvariants,
  destroyWorld,
  prepareWorld,
  recoverAndComplete,
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

const SEEDS = [104_001, 104_002, 104_003];
const KILLS_PER_SEED = 3;

let worlds: ChaosWorld[] = [];
afterEach(() => {
  for (const w of worlds) destroyWorld(w);
  worlds = [];
});

describe("seeded random-kill runs (supplement, never substitute)", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: external SIGKILLs at random delays leave the invariants intact`, async () => {
      const random = mulberry32(seed);
      for (let round = 0; round < KILLS_PER_SEED; round += 1) {
        const world = prepareWorld(CHAOS_SCRIPTS["mixed"]);
        worlds.push(world);
        // Child lifetime is roughly 100-400ms of protocol work after
        // ~startup; spread kills across that whole window (startup
        // included — killing during store opening is a legitimate gap).
        const delayMs = 10 + Math.floor(random() * 700);
        const result = await runChaosChildTimedKill(
          world,
          { mode: "run", script: "mixed" },
          delayMs,
        );
        // Either the kill landed (SIGKILL) or the child beat the timer
        // (completed) — both are valid rounds; invariants must hold
        // regardless.
        if (!result.completed) {
          expect(result.signal, `round ${round} stderr: ${result.stderr}`).toBe("SIGKILL");
        }
        const recovered = recoverAndComplete(world);
        try {
          assertChaosInvariants(world, recovered);
        } finally {
          recovered.state.close();
        }
      }
    }, 120_000);
  }
});
