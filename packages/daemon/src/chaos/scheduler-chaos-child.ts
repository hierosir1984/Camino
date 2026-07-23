/**
 * WP-114 scheduler chaos child: runs the REAL planning + dispatch protocol
 * over file-backed stores in CAMINO_CHAOS_DIR/state, with the armed kill
 * hook firing in every protocol gap — a real `kill -9` at whichever point
 * the matrix requests (see chaos/kill-points.ts):
 *
 *   scheduler-after-plan-approval-recorded  (approval act durable, freeze not run)
 *   scheduler-after-lease-granted           (lease durable, issue not claimed)
 *   scheduler-after-issue-claimed           (A.2#3 durable, attempt not recorded)
 *   scheduler-after-attempt-recorded        (A.3#1 durable, worker-started not)
 *   scheduler-after-worker-started          (A.2#6 durable, worker not spawned)
 *   scheduler-before-outcome-recorded       (worker done, outcome not recorded)
 *   scheduler-after-outcome-recorded        (routing complete)
 *
 * The parent (scheduler-dispatch-chaos.test.ts) recovers over the remains
 * exactly as a restarted daemon would — openRecoveredState (planning
 * resume + lease inspection) then AttemptScheduler.recoverInterrupted —
 * and asserts the CAM-STATE-04/-06 invariants.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_POLICY_TABLE } from "@camino/shared";
import type { AttemptBudget, DispatchRecord, TaskFeatures } from "@camino/shared";
import { CanonLedgerStore } from "../canon-ledger.js";
import { SqliteDomainStore } from "../domain-store.js";
import { SqliteEventStore } from "../event-store.js";
import { MissionIntake } from "../intake.js";
import { PlanStore } from "../plan-store.js";
import { PlanningService } from "../planning.js";
import { STATE_FILES } from "../recovery.js";
import { QuotaWindowTracker } from "../routing/window-tracker.js";
import { AttemptScheduler } from "../scheduler/attempt-scheduler.js";
import { SqliteLeaseStore } from "../scheduler/lease-store.js";
import { AttemptSummaryStore } from "../scheduler/summary-store.js";
import { SerializationScheduler } from "../serialization-scheduler.js";
import { TransitionRecorder } from "../transition-recorder.js";
import { WriterLock } from "../writer-lock.js";
import { armedKillHook } from "./kill-points.js";

const PRD = [
  "# Notifications",
  "",
  "Users receive a daily summary email. The summary lists new items.",
  "",
  "Motivation: users asked for fewer interruptions.",
].join("\n");

const FEATURES: TaskFeatures = { template: "feature", riskTier: "medium" };
const BUDGET: AttemptBudget = { wallClockMs: 60_000 };

function main(): void {
  const dir = process.env["CAMINO_CHAOS_DIR"];
  if (dir === undefined) throw new Error("CAMINO_CHAOS_DIR is required");
  const stateDir = join(dir, "state");
  const hook = armedKillHook();

  // The production posture: the child holds the writer lock; a SIGKILL
  // releases it via the kernel, so the parent's recovery can acquire it.
  const lock = WriterLock.acquire(join(stateDir, STATE_FILES.writerLock));
  const events = new SqliteEventStore(join(stateDir, STATE_FILES.events), { writerLock: lock });
  const domain = new SqliteDomainStore(join(stateDir, STATE_FILES.domain));
  const ledger = new CanonLedgerStore(join(stateDir, STATE_FILES.canonLedger), {
    writerLock: lock,
  });
  const planStore = new PlanStore(join(stateDir, STATE_FILES.planStore), { writerLock: lock });
  const leases = new SqliteLeaseStore(join(stateDir, STATE_FILES.leases), { writerLock: lock });
  const summaries = new AttemptSummaryStore(join(stateDir, STATE_FILES.attemptSummaries), {
    writerLock: lock,
  });
  const windows = new QuotaWindowTracker(join(stateDir, STATE_FILES.windows), {
    writerLock: lock,
  });
  const recorder = new TransitionRecorder(events);
  const intake = new MissionIntake(domain, recorder, events);
  const serialization = new SerializationScheduler(domain, recorder, events);
  const planning = new PlanningService(planStore, domain, recorder, events, ledger, serialization);

  const project = domain.createProject("chaos");
  const repo = domain.createRepo(project.id, "chaos");
  const created = intake.createFromText({
    repoId: repo.id,
    title: "Daily summary",
    content: PRD,
    actor: "david",
  });
  if (!created.ok) throw new Error(`intake refused: ${created.reason}`);
  const missionId = created.mission.id;

  const session = planning.startSession(missionId, "feature");
  planning.ingest(session.sessionId, {
    kind: "issue",
    issue: {
      planIssueId: "I1",
      title: "Issue I1",
      goal: "Deliver I1.",
      acceptanceCriteria: ["I1 works end to end."],
      dependsOn: [],
      interfaces: [],
    },
  });
  planning.ingest(session.sessionId, {
    kind: "issue",
    issue: {
      planIssueId: "I2",
      title: "Issue I2",
      goal: "Deliver I2.",
      acceptanceCriteria: ["I2 works end to end."],
      dependsOn: ["I1"],
      interfaces: [],
    },
  });
  planning.ingest(session.sessionId, {
    kind: "checklist-row",
    row: { segmentId: "S1", disposition: "unmapped", reason: "non-requirement" },
  });
  planning.ingest(session.sessionId, {
    kind: "checklist-row",
    row: {
      segmentId: "S2",
      disposition: "mapped",
      proposedStatement: "The system sends a daily summary email.",
      proposedArea: "APP",
      mappedPlanIssueIds: ["I1"],
    },
  });
  planning.ingest(session.sessionId, {
    kind: "checklist-row",
    row: {
      segmentId: "S3",
      disposition: "mapped",
      proposedStatement: "The summary lists new items.",
      proposedArea: "APP",
      mappedPlanIssueIds: ["I2"],
    },
  });
  planning.ingest(session.sessionId, {
    kind: "checklist-row",
    row: { segmentId: "S4", disposition: "unmapped", reason: "context" },
  });
  planning.ingest(session.sessionId, { kind: "construction-complete" });
  planning.attachReview(session.sessionId, {
    reviewClass: "full-falsification",
    reviewer: "codex-cli",
    verdict: "approve-with-findings",
  });
  planning.confirmMappedRows(session.sessionId, ["S2", "S3"]);
  planning.acknowledgeFlaggedRows(session.sessionId, ["S1", "S4"]);

  // The WP-110 approval seam, split exactly where a crash can land: the
  // approval ACT is durable, the freeze/completion has not run. The kill
  // matrix dies HERE; the no-kill run (and every later-point run) completes
  // it through the same one resume path recovery uses.
  planStore.recordApproval(session.sessionId, "david");
  hook("scheduler-after-plan-approval-recorded");
  planning.resumePendingWork();

  const branched = recorder.record({
    entityKind: "mission",
    entityId: missionId,
    event: "integration-branch-created",
    actor: "camino:chaos",
    cause: "chaos fixture: branch + PR + onboarding green (A.1#6)",
    payload: { branchCreated: true, missionPrCreated: true, onboardingChecksGreen: true },
  });
  if (!branched.ok) throw new Error(`could not reach executing: ${branched.code}`);

  const scheduler = new AttemptScheduler({
    recorder,
    events,
    domain,
    contracts: (m) => planStore.contractsForMission(m),
    leases,
    windows,
    policyTable: () => DEFAULT_POLICY_TABLE,
    summaries,
    killHook: hook,
  });

  const decision = scheduler.dispatchNext(missionId, { features: FEATURES, budget: BUDGET });
  if (decision.kind !== "dispatch") {
    throw new Error(`expected a dispatch, got ${JSON.stringify(decision)}`);
  }

  // No real worker is spawned in the chaos matrix — the "worker run" is
  // simulated between the two outcome-side kill points, exactly where the
  // real external call sits in the protocol. (The REAL process-kill paths
  // are proven elsewhere: WP-105's kill-confirm suite for process groups
  // and the supervisor's docker suite for containers; this matrix owns
  // the DURABLE-PROTOCOL invariants under kill -9.)
  //
  // CAMINO_CHAOS_OUTCOME selects the simulated outcome: the succeeded
  // variant exists to pin round-1 finding 5 — a crash between the durable
  // lease release (outcome recorded) and the outcome routing must NEVER
  // be recovered as a failure.
  const outcome =
    process.env["CAMINO_CHAOS_OUTCOME"] === "succeeded" ? "succeeded" : "requirement-failed";
  const record: DispatchRecord = {
    adapter: "claude-code",
    outcome,
    spawned: true,
    streamedEvents: 1,
    finalText: outcome === "succeeded" ? "chaos worker done" : "chaos worker failed",
    committedSha: outcome === "succeeded" ? "a".repeat(40) : null,
    envPosture: {
      keys: [],
      githubCredentialKeys: [],
      gitGlobalNeutralized: true,
      strippedKeys: [],
      credentialRootKeys: [],
    },
    exitCode: 1,
    durationMs: 10,
    events: [],
    quotaSignalSeen: false,
  };
  // The simulated worker's REAL side effect (round-2 finding 13): one
  // append per dispatched attempt, exactly where the external call sits.
  // The parent asserts each attempt id appears AT MOST ONCE whatever the
  // kill point — the §4.4 zero-duplicates posture over a genuine effect.
  // (Real-backend assertion of the full matrix is WP-126 per the plan's
  // WP-104 timing note; this matrix is the fake-backed half it names.)
  appendFileSync(join(dir, "worker-effects.log"), `${decision.plan.attemptId}\n`);
  void scheduler.leaseHandle(decision.plan).release({ groupGone: true, outcome: record.outcome });
  scheduler.recordOutcome(decision.plan, record, { finalHeadFetched: true });

  console.log("CHAOS-CHILD-COMPLETE");
  summaries.close();
  leases.close();
  windows.close();
  planStore.close();
  ledger.close();
  domain.close();
  events.close();
  lock.release();
}

main();
