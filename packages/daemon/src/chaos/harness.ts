/**
 * Chaos harness plumbing (WP-104, CAM-STATE-06): world preparation, child
 * spawning, post-mortem recovery, and the universal invariants every
 * kill — named, swept, or random — must leave intact.
 *
 * The invariants are the acceptance criteria stated as code:
 *  - ZERO DUPLICATES: no ledger key records more than one applied effect;
 *    a resettable environment holds each mutation at most once; an
 *    irreversible outbox never exceeds one per mutation without a human
 *    retry authorization.
 *  - ZERO LOST STATE: after recovery plus completion, every intent is
 *    terminal or parked on a human (escalated) — nothing silently stuck.
 *  - EXACTLY-ONCE AMBIGUITY: repeated recovery never duplicates an
 *    ambiguity or escalation row.
 *  - CO-RECOVERY: the event log (WP-101 recorder) replays and verifies
 *    beside the journal — opening recovered state fail-closes on either.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { IntentExecutor } from "../intent-executor.js";
import { openRecoveredState, reconcileIntents } from "../recovery.js";
import type { RecoveredState, RecoveryReport } from "../recovery.js";
import { FakeGitHub } from "./fake-github.js";
import { FakeCatchAll, FakeTestService } from "./fake-services.js";
import type { KillPointName } from "./kill-points.js";
import { FAKE_STATE_FILES } from "./scripts.js";
import type { ChaosScript } from "./scripts.js";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const CHILD_PATH = fileURLToPath(new URL("./chaos-child.ts", import.meta.url));

export interface ChaosWorld {
  readonly dir: string;
  readonly stateDir: string;
  /** Hook-free fakes over the world's files (parent-side seeding + assertions). */
  readonly github: FakeGitHub;
  readonly testService: FakeTestService;
  readonly catchAll: FakeCatchAll;
}

export function prepareWorld(script?: ChaosScript): ChaosWorld {
  const dir = mkdtempSync(join(tmpdir(), "camino-chaos-"));
  mkdirSync(join(dir, "state"));
  const world: ChaosWorld = {
    dir,
    stateDir: join(dir, "state"),
    github: new FakeGitHub(join(dir, FAKE_STATE_FILES.github)),
    testService: new FakeTestService(join(dir, FAKE_STATE_FILES.testService)),
    catchAll: new FakeCatchAll(join(dir, FAKE_STATE_FILES.catchAll)),
  };
  script?.seed(world);
  return world;
}

export function destroyWorld(world: ChaosWorld): void {
  rmSync(world.dir, { recursive: true, force: true });
}

export interface ChildSpawnOptions {
  readonly mode: "run" | "recover";
  readonly script?: string;
  readonly killPoint?: KillPointName;
  readonly killOccurrence?: number;
  readonly killNth?: number;
}

export interface ChildResult {
  readonly signal: NodeJS.Signals | null;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly completed: boolean;
}

function childEnv(world: ChaosWorld, options: ChildSpawnOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Never inherit chaos/kill configuration from the parent context.
  delete env["CAMINO_KILL_POINT"];
  delete env["CAMINO_KILL_OCCURRENCE"];
  delete env["CAMINO_KILL_NTH"];
  env["CAMINO_CHAOS_DIR"] = world.dir;
  env["CAMINO_CHAOS_MODE"] = options.mode;
  if (options.script !== undefined) env["CAMINO_CHAOS_SCRIPT"] = options.script;
  if (options.killPoint !== undefined) env["CAMINO_KILL_POINT"] = options.killPoint;
  if (options.killOccurrence !== undefined) {
    env["CAMINO_KILL_OCCURRENCE"] = String(options.killOccurrence);
  }
  if (options.killNth !== undefined) env["CAMINO_KILL_NTH"] = String(options.killNth);
  return env;
}

/** Spawn the chaos child and wait for it (deterministic kill modes). */
export function runChaosChild(world: ChaosWorld, options: ChildSpawnOptions): ChildResult {
  const result = spawnSync(process.execPath, ["--import", "tsx", CHILD_PATH], {
    cwd: REPO_ROOT,
    env: childEnv(world, options),
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    signal: result.signal,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    completed: (result.stdout ?? "").includes("CHAOS-CHILD-COMPLETE"),
  };
}

/** Spawn the chaos child and SIGKILL it from OUTSIDE after a delay (random runs). */
export async function runChaosChildTimedKill(
  world: ChaosWorld,
  options: ChildSpawnOptions,
  killAfterMs: number,
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CHILD_PATH], {
      cwd: REPO_ROOT,
      env: childEnv(world, options),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`chaos child hung; stderr: ${stderr}`));
    }, 60_000);
    child.on("exit", (status, signal) => {
      clearTimeout(timer);
      clearTimeout(guard);
      resolve({
        signal,
        status,
        stdout,
        stderr,
        completed: stdout.includes("CHAOS-CHILD-COMPLETE"),
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(guard);
      reject(error);
    });
  });
}

export interface RecoveredWorld {
  readonly state: RecoveredState;
  readonly report: RecoveryReport;
  /** Intent ids the completion pass executed. */
  readonly completed: readonly string[];
}

/**
 * Parent-side post-mortem: open recovered state over the child's remains
 * (the lock is free — the child is dead) and complete whatever recovery
 * re-armed, exactly as a restarted daemon would. Caller closes .state.
 */
export function recoverAndComplete(world: ChaosWorld): RecoveredWorld {
  const state = openRecoveredState(world.stateDir, { github: world.github });
  const executor = new IntentExecutor(state.journal, {
    github: world.github,
    testService: world.testService,
    catchAll: world.catchAll,
  });
  const completed: string[] = [];
  for (const intentId of state.report.pendingExecution) {
    executor.execute(intentId);
    completed.push(intentId);
  }
  return { state, report: state.report, completed };
}

/** Count journal rows of one event kind for one intent. */
export function eventCount(state: RecoveredState, intentId: string, event: string): number {
  return state.journal.read({ intentId }).filter((r) => r.event === event).length;
}

/**
 * The universal invariants (see module header). Every chaos run — whatever
 * the kill point — must pass all of them after recovery + completion.
 */
export function assertChaosInvariants(world: ChaosWorld, recovered: RecoveredWorld): void {
  // ZERO DUPLICATES — the fakes' own books, not the daemon's beliefs.
  for (const [key, count] of world.github.effectCounts()) {
    expect(count, `duplicate external effect ${key}`).toBeLessThanOrEqual(1);
  }
  const testState = world.testService.state();
  for (const [envId, env] of Object.entries(testState.environments)) {
    const seen = new Map<string, number>();
    for (const mutation of env.mutations) {
      seen.set(mutation, (seen.get(mutation) ?? 0) + 1);
    }
    for (const [mutation, count] of seen) {
      expect(count, `environment ${envId} holds ${mutation} ${count} times`).toBeLessThanOrEqual(1);
    }
  }
  {
    const seen = new Map<string, number>();
    for (const entry of testState.outbox) {
      const key = `${entry.environmentId}:${entry.mutation}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const [key, count] of seen) {
      expect(count, `irreversible effect ${key} applied ${count} times`).toBeLessThanOrEqual(1);
    }
  }
  {
    const seen = new Map<string, number>();
    for (const effect of world.catchAll.state().effects) {
      seen.set(effect, (seen.get(effect) ?? 0) + 1);
    }
    for (const [key, count] of seen) {
      expect(count, `catch-all effect ${key} applied ${count} times`).toBeLessThanOrEqual(1);
    }
  }

  // ZERO LOST STATE — everything terminal or parked on a human.
  for (const snapshot of recovered.state.journal.nonTerminal()) {
    expect(
      snapshot.status,
      `intent ${snapshot.intentId} silently stuck in ${snapshot.status}`,
    ).toBe("escalated");
  }

  // EXACTLY-ONCE AMBIGUITY + IDEMPOTENT RECOVERY: another pass changes nothing.
  const rowsBefore = recovered.state.journal.read().length;
  reconcileIntents(recovered.state.journal, { github: world.github });
  expect(
    recovered.state.journal.read().length,
    "a second reconciliation pass appended rows (recovery is not idempotent)",
  ).toBe(rowsBefore);
  for (const snapshot of recovered.state.journal.nonTerminal()) {
    const ambiguityRows = eventCount(recovered.state, snapshot.intentId, "ambiguity-recorded");
    expect(ambiguityRows, `intent ${snapshot.intentId} ambiguity rows`).toBeLessThanOrEqual(1);
  }

  // CO-RECOVERY of the event log: replay verification agrees.
  expect(recovered.state.recorder.verify()).toEqual([]);
}
