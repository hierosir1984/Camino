/**
 * WP-114 scheduler chaos matrix (CAM-STATE-06, the lease clause + the
 * recovery-composition amendment): a REAL `kill -9` at every named gap of
 * the durable dispatch protocol — including the WP-110 approval seam — and
 * after each one the parent recovers exactly as a restarted daemon would:
 *
 *   openRecoveredState  → planning resume (interrupted approvals complete)
 *                         + lease inspection (lapsed = fenced)
 *   recoverInterrupted  → never-spawned settles; live-worker cases are
 *                         REPORTED for a real kill-confirm, never assumed
 *   settleInterrupted   → kill-confirm recorded, THEN the attempt expires
 *
 * Invariants asserted after every kill point (the acceptance bullets):
 *   - stale generations fenced; RE-GRANT ONLY AFTER KILL-CONFIRM — and the
 *     next grant's generation is strictly higher (monotonic, persisted);
 *   - no issue stranded in `claimed`; nothing lost (a follow-up dispatch
 *     proceeds); contracts frozen exactly once whatever the interruption;
 *   - the event log replays and verifies; zero serialization violations.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY_TABLE } from "@camino/shared";
import type { AttemptBudget, TaskFeatures } from "@camino/shared";
import { STATE_FILES, openRecoveredState } from "../recovery.js";
import type { RecoveredState } from "../recovery.js";
import { QuotaWindowTracker } from "../routing/window-tracker.js";
import { AttemptScheduler } from "../scheduler/attempt-scheduler.js";
import { FakeGitHub } from "./fake-github.js";
import { FAKE_STATE_FILES } from "./scripts.js";
import type { KillPointName } from "./kill-points.js";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const CHILD_PATH = fileURLToPath(new URL("./scheduler-chaos-child.ts", import.meta.url));

const FEATURES: TaskFeatures = { template: "feature", riskTier: "medium" };
const BUDGET: AttemptBudget = { wallClockMs: 60_000 };

const SCHEDULER_KILL_POINTS: readonly KillPointName[] = [
  "scheduler-after-plan-approval-recorded",
  "scheduler-after-lease-granted",
  "scheduler-after-issue-claimed",
  "scheduler-after-attempt-recorded",
  "scheduler-after-worker-started",
  "scheduler-before-outcome-recorded",
  "scheduler-after-outcome-recorded",
];

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function prepareWorld(): { dir: string; stateDir: string; github: FakeGitHub } {
  const dir = mkdtempSync(join(tmpdir(), "camino-sched-chaos-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "state"));
  return {
    dir,
    stateDir: join(dir, "state"),
    github: new FakeGitHub(join(dir, FAKE_STATE_FILES.github)),
  };
}

function runChild(
  dir: string,
  killPoint?: KillPointName,
  outcome?: "succeeded" | "requirement-failed",
) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["CAMINO_KILL_POINT"];
  delete env["CAMINO_KILL_OCCURRENCE"];
  delete env["CAMINO_KILL_NTH"];
  delete env["CAMINO_CHAOS_OUTCOME"];
  env["CAMINO_CHAOS_DIR"] = dir;
  if (killPoint !== undefined) env["CAMINO_KILL_POINT"] = killPoint;
  if (outcome !== undefined) env["CAMINO_CHAOS_OUTCOME"] = outcome;
  const result = spawnSync(process.execPath, ["--import", "tsx", CHILD_PATH], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    signal: result.signal,
    completed: (result.stdout ?? "").includes("CHAOS-CHILD-COMPLETE"),
    stderr: result.stderr ?? "",
  };
}

interface RecoveredWorld {
  state: RecoveredState;
  scheduler: AttemptScheduler;
  windows: QuotaWindowTracker;
  missionId: string;
}

/** Recover exactly as a restarted daemon would, then run the scheduler pass. */
function recover(world: { stateDir: string; github: FakeGitHub }): RecoveredWorld {
  const state = openRecoveredState(world.stateDir, { github: world.github });
  cleanups.push(() => state.close());
  const windows = new QuotaWindowTracker(join(world.stateDir, STATE_FILES.windows), {
    writerLock: state.lock,
  });
  cleanups.push(() => windows.close());
  const scheduler = new AttemptScheduler({
    recorder: state.recorder,
    events: state.eventStore,
    domain: state.domain,
    contracts: (m) => state.planStore.contractsForMission(m),
    leases: state.leases,
    windows,
    policyTable: () => DEFAULT_POLICY_TABLE,
    summaries: state.summaries,
  });
  const missions = state.domain.listAllMissions();
  const missionId = missions[0]?.id;
  if (missionId === undefined) throw new Error("chaos world has no mission");
  return { state, scheduler, windows, missionId };
}

/**
 * The external-effect oracle (round-3 finding 11): asserts the EXACT
 * expected number of effect lines for the phase the kill landed in — zero
 * when the child died before the simulated call, exactly one after — plus
 * at-most-once per attempt id in every case. An absent log is only legal
 * when zero effects are expected.
 */
function assertEffects(dir: string, expectedTotal: number): void {
  const path = join(dir, "worker-effects.log");
  const lines = existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
    : [];
  expect(lines.length, `expected ${expectedTotal} external effect(s), saw ${lines.length}`).toBe(
    expectedTotal,
  );
  const seen = new Map<string, number>();
  for (const line of lines) seen.set(line, (seen.get(line) ?? 0) + 1);
  for (const [attemptId, count] of seen) {
    expect(count, `external effect for ${attemptId} applied ${count} times`).toBeLessThanOrEqual(1);
  }
}

/** Effects expected per kill point: the append sits after dispatchNext returns. */
const EFFECTS_BY_POINT: Readonly<Record<string, number>> = {
  "scheduler-after-plan-approval-recorded": 0,
  "scheduler-after-lease-granted": 0,
  "scheduler-after-issue-claimed": 0,
  "scheduler-after-attempt-recorded": 0,
  "scheduler-after-worker-started": 0,
  "scheduler-before-outcome-recorded": 1,
  "scheduler-after-outcome-recorded": 1,
};

function assertUniversalInvariants(r: RecoveredWorld): void {
  // The log replays and verifies (CAM-STATE-05 co-recovery).
  expect(r.state.recorder.verify()).toEqual([]);
  // The WP-103 lane invariants hold over the recovered view.
  const repoId = r.state.domain.listAllMissions()[0]?.repoId as string;
  expect(r.state.serialization.serializationViolations(repoId)).toEqual([]);
  // Contracts frozen EXACTLY once whatever the interruption: two issues,
  // one v1 contract each (the WP-110 approval seam is idempotent).
  const contracts = r.state.planStore.contractsForMission(r.missionId);
  expect(contracts.map((c) => `${c.issueId}@v${c.version}`).sort()).toEqual([
    `${r.missionId}.I1@v1`,
    `${r.missionId}.I2@v1`,
  ]);
  // No issue stranded in claimed after the scheduler recovery pass.
  for (const [issueId] of r.state.recorder.currentView.issues) {
    expect(
      r.state.recorder.currentState("issue", issueId),
      `issue ${issueId} stranded in claimed`,
    ).not.toBe("claimed");
  }
}

/** Bring the recovered mission to `executing` if the kill preceded it. */
function ensureExecuting(r: RecoveredWorld): void {
  if (r.state.recorder.currentState("mission", r.missionId) === "executing") return;
  const outcome = r.state.recorder.record({
    entityKind: "mission",
    entityId: r.missionId,
    event: "integration-branch-created",
    actor: "camino:chaos",
    cause: "post-recovery fixture: branch + PR + onboarding green (A.1#6)",
    payload: { branchCreated: true, missionPrCreated: true, onboardingChecksGreen: true },
  });
  if (!outcome.ok) throw new Error(`could not reach executing after recovery: ${outcome.code}`);
}

describe("scheduler dispatch protocol under kill -9 (deterministic matrix)", () => {
  it("control: the un-killed child completes the whole protocol", () => {
    const world = prepareWorld();
    const result = runChild(world.dir);
    expect(result.stderr).toBe("");
    expect(result.completed).toBe(true);
    const r = recover(world);
    assertUniversalInvariants(r);
    assertEffects(world.dir, 1);
    // The child's requirement-failed outcome routed fully: issue ready
    // with one counted failure and a structured summary on record.
    const issue1 = `${r.missionId}.I1`;
    expect(r.state.recorder.currentState("issue", issue1)).toBe("ready");
    expect(r.state.recorder.currentView.issues.get(issue1)?.failureCount).toBe(1);
    expect(r.state.summaries.forIssue(issue1)).toHaveLength(1);
    expect(
      r.state.leases.current(`validation:${r.state.domain.listAllMissions()[0]?.repoId}`)?.state,
    ).toBe("released");
  });

  it("kill between the durable lease release and outcome recording NEVER fails a succeeded dispatch (round-1 finding 5)", () => {
    const world = prepareWorld();
    const result = runChild(world.dir, "scheduler-before-outcome-recorded", "succeeded");
    expect(result.signal).toBe("SIGKILL");
    const r = recover(world);
    const issue1 = `${r.missionId}.I1`;
    const report = r.scheduler.recoverInterrupted();
    // The lease's durable released outcome (succeeded) is honored: no
    // kill-confirm case, no counted failure, submission awaits the
    // re-fetched head.
    expect(report.requiresKillConfirm).toEqual([]);
    expect(report.succeededAwaitingSubmission).toMatchObject([{ issueId: issue1 }]);
    expect(r.state.recorder.currentView.issues.get(issue1)?.failureCount).toBe(0);
    assertUniversalInvariants(r);
    const awaiting = report.succeededAwaitingSubmission[0];
    if (awaiting === undefined) throw new Error("expected an awaiting entry");
    r.scheduler.completeSucceededInterrupted(awaiting, { finalHeadFetched: true });
    expect(r.state.recorder.currentState("attempt", awaiting.attemptId)).toBe("submitted");
  });

  for (const point of SCHEDULER_KILL_POINTS) {
    it(`kill at ${point}: recovery fences, settles or reports, and work continues`, () => {
      const world = prepareWorld();
      const result = runChild(world.dir, point);
      expect(result.signal).toBe("SIGKILL");
      expect(result.completed).toBe(false);

      const r = recover(world);
      const repoId = r.state.domain.listAllMissions()[0]?.repoId as string;
      const env = `validation:${repoId}`;

      // The scheduler recovery pass: settle what the protocol PROVES never
      // spawned; everything else is reported and settled only after an
      // explicit kill-confirm (re-grant only after kill-confirm).
      const report = r.scheduler.recoverInterrupted();
      for (const interrupted of report.requiresKillConfirm) {
        // The child died under SIGKILL with no spawned worker; the
        // process-group kill-confirm is attested by the parent here the
        // way the daemon's container/group confirm would be.
        r.scheduler.settleInterrupted(interrupted, "process-group");
      }
      const lease = r.state.leases.current(env);
      if (lease !== undefined) {
        expect(lease.state, `lease ${env} left unfenced after ${point}`).not.toBe("held");
      }

      assertUniversalInvariants(r);
      assertEffects(world.dir, EFFECTS_BY_POINT[point] ?? 0);

      // NOTHING IS LOST: the mission proceeds — a follow-up dispatch grants
      // the NEXT monotonic generation and claims the issue again.
      ensureExecuting(r);
      const priorGeneration = lease?.generation ?? 0;
      const decision = r.scheduler.dispatchNext(r.missionId, {
        features: FEATURES,
        budget: BUDGET,
      });
      expect(decision.kind, `no follow-up dispatch after ${point}`).toBe("dispatch");
      if (decision.kind === "dispatch") {
        expect(decision.plan.lease.generation).toBe(priorGeneration + 1);
        expect(decision.plan.issueId).toBe(`${r.missionId}.I1`);
      }
    });
  }
});
