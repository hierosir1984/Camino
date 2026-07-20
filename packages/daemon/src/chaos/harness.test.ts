/**
 * The chaos oracle's own honesty (WP-104, round-4 regressions): the
 * universal invariants must REJECT worlds that lie — a confirmed intent
 * with no external effect, a failed intent whose effect exists — not
 * merely pass the worlds our suites produce. These tests drive the oracle
 * directly with forged-but-lifecycle-legal journals.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IntentJournal } from "../intent-journal.js";
import {
  assertChaosInvariants,
  destroyWorld,
  prepareWorld,
  recoverAndComplete,
} from "./harness.js";
import type { ChaosWorld } from "./harness.js";

const SHA_A = "a".repeat(40);

let worlds: ChaosWorld[] = [];
afterEach(() => {
  for (const w of worlds) destroyWorld(w);
  worlds = [];
});

function worldWithJournal(): { world: ChaosWorld; journalPath: string } {
  const world = prepareWorld();
  worlds.push(world);
  mkdirSync(world.stateDir, { recursive: true });
  return { world, journalPath: join(world.stateDir, "intents.sqlite") };
}

describe("the oracle rejects lying journals (round 4, finding 2)", () => {
  it("a lifecycle-legal CONFIRMED intent with no external effect fails the invariants", () => {
    const { world, journalPath } = worldWithJournal();
    const journal = new IntentJournal(journalPath);
    // A perfectly legal walk — but no transport ever ran, so the world
    // holds nothing. The oracle must refuse to call this "zero lost state".
    journal.append({
      intentId: "forged-1",
      event: "recorded",
      actor: "x",
      payload: { op: "branch-create", repo: "r", branch: "b1", targetSha: SHA_A },
    });
    journal.append({ intentId: "forged-1", event: "execution-started", actor: "x", payload: {} });
    journal.append({
      intentId: "forged-1",
      event: "confirmed",
      actor: "x",
      payload: { via: "response", result: { branch: "b1", sha: SHA_A }, note: "forged" },
    });
    journal.close();
    const recovered = recoverAndComplete(world);
    try {
      expect(() => assertChaosInvariants(world, recovered, ["forged-1"])).toThrow(
        /branch is not at the intended SHA/,
      );
    } finally {
      recovered.state.close();
    }
  });

  it("a lifecycle-legal FAILED intent whose effect exists fails the invariants", () => {
    const { world, journalPath } = worldWithJournal();
    // The effect exists externally...
    world.github.seedCommit("r", SHA_A);
    world.github.createBranch({ op: "branch-create", repo: "r", branch: "b1", targetSha: SHA_A });
    // ...but the journal claims the intent failed cleanly.
    const journal = new IntentJournal(journalPath);
    journal.append({
      intentId: "liar-1",
      event: "recorded",
      actor: "x",
      payload: { op: "branch-create", repo: "r", branch: "b1", targetSha: SHA_A },
    });
    journal.append({ intentId: "liar-1", event: "execution-started", actor: "x", payload: {} });
    journal.append({
      intentId: "liar-1",
      event: "failed",
      actor: "x",
      payload: { via: "response", reason: "claims the branch was never created" },
    });
    journal.close();
    const recovered = recoverAndComplete(world);
    try {
      expect(() => assertChaosInvariants(world, recovered, ["liar-1"])).toThrow(
        /external effect was applied/,
      );
    } finally {
      recovered.state.close();
    }
  });
});
