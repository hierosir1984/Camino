/**
 * Chaos child process (WP-104, CAM-STATE-06): a real daemon-shaped
 * process the kill-point suite spawns and murders.
 *
 * It does exactly what a daemon does with durable state, in order:
 * acquire the writer lock, open + replay-verify the stores, reconcile,
 * complete whatever recovery re-armed, then run the script's intents —
 * with the armed kill hook threaded through every layer so a named (or
 * nth) protocol point SIGKILLs the process mid-stride. The parent test
 * owns seeding, post-mortem recovery, and every assertion.
 *
 * Environment protocol:
 *   CAMINO_CHAOS_DIR     working dir (state/ + fake state files)
 *   CAMINO_CHAOS_MODE    "run" (script intents) | "recover" (open + reconcile
 *                        + complete re-armed work only)
 *   CAMINO_CHAOS_SCRIPT  script name (run mode)
 *   CAMINO_KILL_POINT / CAMINO_KILL_OCCURRENCE / CAMINO_KILL_NTH — see
 *   kill-points.ts
 *
 * Prints CHAOS-CHILD-COMPLETE on a run the kill never fired in (the
 * parent uses it to distinguish "survived" from "died silently early").
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { IntentExecutor } from "../intent-executor.js";
import { openRecoveredState } from "../recovery.js";
import { FakeGitHub } from "./fake-github.js";
import { FakeCatchAll, FakeTestService } from "./fake-services.js";
import { armedKillHook } from "./kill-points.js";
import { CHAOS_SCRIPTS, FAKE_STATE_FILES } from "./scripts.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be set for the chaos child`);
  }
  return value;
}

function main(): void {
  const dir = requireEnv("CAMINO_CHAOS_DIR");
  const mode = requireEnv("CAMINO_CHAOS_MODE");
  const hook = armedKillHook();
  const github = new FakeGitHub(join(dir, FAKE_STATE_FILES.github), { hook });
  const testService = new FakeTestService(join(dir, FAKE_STATE_FILES.testService), { hook });
  const catchAll = new FakeCatchAll(join(dir, FAKE_STATE_FILES.catchAll), { hook });
  const state = openRecoveredState(join(dir, "state"), { github }, { hook });
  try {
    const executor = new IntentExecutor(state.journal, { github, testService, catchAll }, { hook });
    // Complete whatever reconciliation re-armed (recover mode's whole job;
    // trivially empty on a fresh run).
    for (const intentId of state.report.pendingExecution) {
      executor.execute(intentId);
    }
    if (mode === "run") {
      const script = CHAOS_SCRIPTS[requireEnv("CAMINO_CHAOS_SCRIPT")];
      if (script === undefined) {
        throw new Error(`unknown chaos script ${process.env["CAMINO_CHAOS_SCRIPT"]}`);
      }
      script.recorderSetup?.(state.recorder);
      for (const intent of script.intents) {
        executor.submit(intent.intentId, intent.spec);
        hook("after-intent-recorded");
        executor.execute(intent.intentId);
      }
    } else if (mode !== "recover") {
      throw new Error(`unknown chaos mode ${mode}`);
    }
  } finally {
    state.close();
  }
  // Printed strictly AFTER close (round-1 finding 6): "completed" must
  // mean the stores and the lock were released cleanly, so a kill landing
  // during close can never masquerade as a completed run.
  console.log("CHAOS-CHILD-COMPLETE");
}

// Run only when spawned as a process — importing this module (e.g. for
// FAKE_STATE_FILES re-exports) must never start a chaos run.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
