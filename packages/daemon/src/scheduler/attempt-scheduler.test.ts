/**
 * AttemptScheduler tests (WP-114) over REAL stores and the REAL planning
 * pipeline: contracts frozen by PlanningService approval, mission driven
 * to `executing` through the recorder, leases in SQLite. The acceptance
 * criteria exercised verbatim:
 *
 *  - CAM-PLAN-12: an issue with an unmerged dependency is never
 *    dispatched; at no time do two attempts run for one mission; a
 *    contract-edit fixture re-checks dependent readiness before
 *    re-dispatch.
 *  - CAM-PLAN-09: structured summaries (never transcripts); 2 same-family
 *    failures switch families; 4 escalate; quota waits never count.
 *  - CAM-STATE-04: dispatch grants monotonic lease generations; the
 *    A.3#1 record carries the generation; re-grant only after
 *    kill-confirm in recovery.
 *  - CAM-ROUTE-06: dispatch pauses at QUOTA_PAUSE_THRESHOLD; quota
 *    exhaustion queues (`queued-quota`), never fails work.
 *  - CAM-PLAN-04 (attempt half): every attempt record carries its
 *    ContractRef.
 *  - WP-107 routing: killed-budget → escalated, never auto-retry;
 *    killConfirmed:false → the A.2#24 cleanup-failed path.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY_TABLE,
  QUOTA_PAUSE_THRESHOLD,
  contractHash,
  contractTermsOf,
  harnessFamily,
} from "@camino/shared";
import type { AttemptBudget, DispatchRecord, ProviderFamily, TaskFeatures } from "@camino/shared";
import { CanonLedgerStore } from "../canon-ledger.js";
import { SqliteDomainStore } from "../domain-store.js";
import { SqliteEventStore } from "../event-store.js";
import { MissionIntake } from "../intake.js";
import { PlanStore } from "../plan-store.js";
import { PlanningService } from "../planning.js";
import { SerializationScheduler } from "../serialization-scheduler.js";
import { TransitionRecorder } from "../transition-recorder.js";
import type { ProviderWindowState } from "../routing/window-tracker.js";
import { AttemptScheduler, QUOTA_PROBE_BACKOFF_MS } from "./attempt-scheduler.js";
import type { AttemptDispatchPlan } from "./attempt-scheduler.js";
import { SqliteLeaseStore } from "./lease-store.js";
import { AttemptSummaryStore } from "./summary-store.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const ACTOR = "camino:test";
const FEATURES: TaskFeatures = { template: "feature", riskTier: "medium" };
const BUDGET: AttemptBudget = { wallClockMs: 60_000, tokens: 100_000 };

const PRD = [
  "# Notifications",
  "",
  "Users receive a daily summary email. The summary lists new items.",
  "",
  "Motivation: users asked for fewer interruptions.",
].join("\n");

/** Settable fake of the WP-106 window-state surface. */
class FakeWindows {
  states = new Map<ProviderFamily, ProviderWindowState>();
  recorded: Array<{ family: ProviderFamily; dispatchId: string; outcome: string }> = [];
  windowState(family: ProviderFamily): ProviderWindowState {
    return (
      this.states.get(family) ?? {
        family,
        windows: [],
        lastQuotaBlockedAt: null,
        lastQuotaSignalAt: null,
      }
    );
  }
  recordDispatch(
    family: ProviderFamily,
    input: { dispatchId: string; outcome: DispatchRecord["outcome"] },
  ): void {
    this.recorded.push({ family, dispatchId: input.dispatchId, outcome: input.outcome });
  }
  pause(family: ProviderFamily, consumption: number): void {
    this.states.set(family, {
      family,
      windows: [
        {
          shape: { id: "test-window", kind: "rolling", durationMs: 3_600_000 },
          estimatedConsumption: consumption,
          basis: "usage-fraction",
          observedUsageMs: 0,
          capacityEstimateMs: 1,
        },
      ],
      lastQuotaBlockedAt: null,
      lastQuotaSignalAt: null,
    });
  }
  exhaustNoShape(family: ProviderFamily, at: string): void {
    this.states.set(family, {
      family,
      windows: [],
      lastQuotaBlockedAt: at,
      lastQuotaSignalAt: at,
    });
  }
  clear(family: ProviderFamily): void {
    this.states.delete(family);
  }
}

interface Harness {
  events: SqliteEventStore;
  recorder: TransitionRecorder;
  domain: SqliteDomainStore;
  planStore: PlanStore;
  leases: SqliteLeaseStore;
  summaries: AttemptSummaryStore;
  windows: FakeWindows;
  scheduler: AttemptScheduler;
  clock: { ms: number };
  missionId: string;
  repoId: string;
  issue1: string;
  issue2: string;
  hookLog: string[];
}

/** Full real-pipeline world: intake → plan → approve → executing. */
function newWorld(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "camino-sched-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const clock = { ms: Date.parse("2026-07-23T10:00:00.000Z") };
  const now = () => new Date(clock.ms);
  const events = new SqliteEventStore(join(dir, "events.sqlite"), { now });
  const domain = new SqliteDomainStore(join(dir, "domain.sqlite"), { now });
  const ledger = new CanonLedgerStore(join(dir, "canon-ledger.sqlite"), { now });
  const planStore = new PlanStore(join(dir, "plan-store.sqlite"), { now });
  const leases = new SqliteLeaseStore(join(dir, "leases.sqlite"), { writerLock: null, now });
  const summaries = new AttemptSummaryStore(join(dir, "attempt-summaries.sqlite"), {
    writerLock: null,
  });
  cleanups.push(() => {
    summaries.close();
    leases.close();
    planStore.close();
    ledger.close();
    domain.close();
    events.close();
  });
  const recorder = new TransitionRecorder(events);
  const intake = new MissionIntake(domain, recorder, events);
  const serialization = new SerializationScheduler(domain, recorder, events);
  const planning = new PlanningService(planStore, domain, recorder, events, ledger, serialization, {
    now,
  });
  const project = domain.createProject("demo");
  const repo = domain.createRepo(project.id, "demo");

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
      interfaces: [{ name: "summary-api", kind: "api", description: "GET /summary" }],
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
  const approved = planning.approvePlan(session.sessionId);
  if (!approved.ok) {
    throw new Error(`approval refused: ${JSON.stringify(approved.refusals)}`);
  }
  const record = recorder.record({
    entityKind: "mission",
    entityId: missionId,
    event: "integration-branch-created",
    actor: ACTOR,
    cause: "test fixture: branch + mission PR + onboarding green (A.1#6)",
    payload: { branchCreated: true, missionPrCreated: true, onboardingChecksGreen: true },
  });
  if (!record.ok) throw new Error(`fixture could not reach executing: ${record.code}`);

  const windows = new FakeWindows();
  const hookLog: string[] = [];
  const scheduler = new AttemptScheduler({
    recorder,
    events,
    domain,
    contracts: (m) => planStore.contractsForMission(m),
    leases,
    windows,
    policyTable: () => DEFAULT_POLICY_TABLE,
    summaries,
    now,
    killHook: (point) => hookLog.push(point),
  });
  return {
    events,
    recorder,
    domain,
    planStore,
    leases,
    summaries,
    windows,
    scheduler,
    clock,
    missionId,
    repoId: repo.id,
    issue1: `${missionId}.I1`,
    issue2: `${missionId}.I2`,
    hookLog,
  };
}

function record(
  h: Harness,
  entityKind: "mission" | "issue" | "attempt",
  entityId: string,
  event: string,
  payload: Record<string, unknown>,
  actor: string = ACTOR,
): void {
  const outcome = h.recorder.record({
    entityKind,
    entityId,
    event,
    actor,
    cause: `fixture ${event}`,
    payload,
  });
  if (!outcome.ok) throw new Error(`fixture ${event} on ${entityId} refused: ${outcome.code}`);
}

function dispatchRecord(
  outcome: DispatchRecord["outcome"],
  overrides: Partial<DispatchRecord> = {},
): DispatchRecord {
  return {
    adapter: "claude-code",
    outcome,
    spawned: true,
    streamedEvents: 3,
    finalText: "one line of classified result\nplus transcript-ish lines that must not persist",
    committedSha: outcome === "succeeded" ? "a".repeat(40) : null,
    envPosture: {
      keys: ["PATH"],
      githubCredentialKeys: [],
      gitGlobalNeutralized: true,
      strippedKeys: [],
      credentialRootKeys: [],
    },
    exitCode: outcome === "succeeded" ? 0 : 1,
    durationMs: 1500,
    events: [],
    quotaSignalSeen: false,
    ...overrides,
  };
}

/** Dispatch I-next and simulate the runner's lifecycle settle + outcome. */
function runAttempt(
  h: Harness,
  outcome: DispatchRecord["outcome"],
  opts: {
    recordOverrides?: Partial<DispatchRecord>;
    releaseLease?: boolean;
    finalHeadFetched?: boolean;
  } = {},
): { plan: AttemptDispatchPlan; routing: ReturnType<AttemptScheduler["recordOutcome"]> } {
  const decision = h.scheduler.dispatchNext(h.missionId, { features: FEATURES, budget: BUDGET });
  if (decision.kind !== "dispatch") {
    throw new Error(`expected a dispatch, got ${JSON.stringify(decision)}`);
  }
  const plan = decision.plan;
  const rec = dispatchRecord(outcome, opts.recordOverrides);
  if (opts.releaseLease !== false) {
    // The dispatch lifecycle settles the lease strictly after group-gone;
    // simulated here exactly as dispatch() would.
    void h.scheduler.leaseHandle(plan).release({ groupGone: true, outcome: rec.outcome });
  }
  const routing = h.scheduler.recordOutcome(plan, rec, {
    finalHeadFetched: opts.finalHeadFetched ?? true,
  });
  return { plan, routing };
}

/** Walk a successfully-submitted issue through verdict → merge (fixture side). */
function mergeSubmittedIssue(h: Harness, issueId: string, attemptId: string): void {
  record(h, "attempt", attemptId, "verdict-recorded", {
    quarantineAndValidationComplete: true,
    verdict: "pass",
  });
  record(h, "issue", issueId, "final-head-submitted", { quarantinePassed: true });
  record(h, "issue", issueId, "validation-green", { freshnessHolds: true });
  record(
    h,
    "issue",
    issueId,
    "merge-approved",
    { authority: "david", target: "mission-branch", baseCheckPassed: true },
    "david",
  );
}

describe("CAM-PLAN-12 — readiness and sequential dispatch", () => {
  it("dispatches the dependency-ordered first ready issue with a leased attempt", () => {
    const h = newWorld();
    const decision = h.scheduler.dispatchNext(h.missionId, { features: FEATURES, budget: BUDGET });
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") return;
    expect(decision.plan.issueId).toBe(h.issue1);
    expect(decision.plan.attemptId).toBe(`${h.issue1}.a1`);
    expect(decision.plan.environmentId).toBe(`validation:${h.repoId}`);
    expect(decision.plan.lease.generation).toBe(1);
    expect(h.recorder.currentState("issue", h.issue1)).toBe("implementing");
    expect(h.recorder.currentState("attempt", decision.plan.attemptId)).toBe("running");
    // The protocol's kill hooks fired in order (chaos kills in every gap).
    expect(h.hookLog).toEqual([
      "scheduler-after-lease-granted",
      "scheduler-after-issue-claimed",
      "scheduler-after-attempt-recorded",
      "scheduler-after-worker-started",
    ]);
  });

  it("an issue with an unmerged dependency is NEVER dispatched", () => {
    const h = newWorld();
    // I1 succeeded but NOT merged yet: I2 stays waiting-deps → no dispatch.
    const { plan } = runAttempt(h, "succeeded");
    expect(plan.issueId).toBe(h.issue1);
    const next = h.scheduler.dispatchNext(h.missionId, { features: FEATURES, budget: BUDGET });
    expect(next.kind).toBe("held");
    expect(h.recorder.currentState("issue", h.issue2)).toBe("waiting-deps");
  });

  it("at no time do two attempts run for one mission (sequential slot)", () => {
    const h = newWorld();
    const first = h.scheduler.dispatchNext(h.missionId, { features: FEATURES, budget: BUDGET });
    expect(first.kind).toBe("dispatch");
    // I1 is implementing with a live attempt: dispatchNext refuses.
    const second = h.scheduler.dispatchNext(h.missionId, { features: FEATURES, budget: BUDGET });
    expect(second).toMatchObject({
      kind: "held",
      hold: { kind: "attempt-active", issueId: h.issue1 },
    });
  });

  it("dispatches the dependent only after its dependency is MERGED", () => {
    const h = newWorld();
    const { plan } = runAttempt(h, "succeeded");
    mergeSubmittedIssue(h, h.issue1, plan.attemptId);
    record(h, "issue", h.issue2, "dependency-merged", { allDepsMerged: true });
    const next = h.scheduler.dispatchNext(h.missionId, { features: FEATURES, budget: BUDGET });
    expect(next.kind).toBe("dispatch");
    if (next.kind === "dispatch") expect(next.plan.issueId).toBe(h.issue2);
  });

  it("contract-edit fixture: dependent readiness is RE-CHECKED before re-dispatch", () => {
    const h = newWorld();
    const { plan } = runAttempt(h, "succeeded");
    mergeSubmittedIssue(h, h.issue1, plan.attemptId);
    record(h, "issue", h.issue2, "dependency-merged", { allDepsMerged: true });
    // EDIT: I2's contract v2 adds a dependency on a NEW issue I3 whose
    // contract exists but is not merged. The recorded `ready` on I2
    // predates the edit — dispatch must re-check, hold, and not dispatch.
    const c2 = h.planStore.latestContract(h.issue2);
    if (c2 === undefined) throw new Error("fixture: missing I2 contract");
    const session = h.planStore.sessionsForMission(h.missionId)[0];
    if (session === undefined) throw new Error("fixture: missing session");
    const i3Terms = {
      ...contractTermsOf(c2),
      issueId: `${h.missionId}.I3`,
      title: "Issue I3",
      dependsOn: [],
    };
    const i3 = {
      ...i3Terms,
      contractHash: contractHash(i3Terms),
      frozenAt: c2.frozenAt,
      approvedBy: "david",
    };
    h.planStore.insertContract(i3, session.sessionId);
    record(h, "issue", `${h.missionId}.I3`, "issue-created", {
      origin: "plan-approval",
      unmetDependencies: 0,
      contractVersion: 1,
      contractHash: i3.contractHash,
    });
    // I3 must not be the one dispatched instead — park it.
    record(h, "issue", `${h.missionId}.I3`, "provider-window-exhausted", {});
    const v2Terms = {
      ...contractTermsOf(c2),
      version: 2,
      dependsOn: [h.issue1, `${h.missionId}.I3`].sort(),
    };
    const v2 = {
      ...v2Terms,
      contractHash: contractHash(v2Terms),
      frozenAt: c2.frozenAt,
      approvedBy: "david",
    };
    h.planStore.insertContract(v2, session.sessionId);

    const held = h.scheduler.dispatchNext(h.missionId, { features: FEATURES, budget: BUDGET });
    expect(held).toMatchObject({
      kind: "held",
      hold: {
        kind: "ready-issue-has-unmet-deps",
        issueId: h.issue2,
        unmet: [`${h.missionId}.I3`],
      },
    });
  });

  it("a mission not in `executing` dispatches NOTHING (lane interaction)", () => {
    const h = newWorld();
    record(h, "mission", h.missionId, "urgent-preemption", {});
    expect(h.recorder.currentState("mission", h.missionId)).toBe("paused-urgent");
    const decision = h.scheduler.dispatchNext(h.missionId, { features: FEATURES, budget: BUDGET });
    expect(decision).toMatchObject({ kind: "idle", reason: "mission-not-executing" });
    record(h, "mission", h.missionId, "interruption-resolved", { affectedIssuesHandled: true });
    expect(h.scheduler.dispatchNext(h.missionId, { features: FEATURES, budget: BUDGET }).kind).toBe(
      "dispatch",
    );
  });
});

describe("CAM-PLAN-04 attempt half + CAM-ROUTE-02 — the A.3#1 record", () => {
  it("the attempt record carries the ContractRef and the policy assignment", () => {
    const h = newWorld();
    const decision = h.scheduler.dispatchNext(h.missionId, { features: FEATURES, budget: BUDGET });
    if (decision.kind !== "dispatch") throw new Error("expected dispatch");
    const contract = h.planStore.latestContract(h.issue1);
    const rows = h.events.read({ entityKind: "attempt", entityId: decision.plan.attemptId });
    const created = rows.find((r) => r.event === "attempt-dispatched" && r.outcome === "applied");
    expect(created).toBeDefined();
    expect(created?.payload["contractRef"]).toEqual({
      issueId: h.issue1,
      contractVersion: 1,
      contractHash: contract?.contractHash,
    });
    expect(created?.payload["assignment"]).toEqual({
      harness: "claude-code",
      model: null,
      reasoningTier: "high",
    });
    expect(created?.payload["leaseGeneration"]).toBe(1);
  });
});

describe("CAM-ROUTE-06 — quota-aware pausing", () => {
  it("pauses dispatch at QUOTA_PAUSE_THRESHOLD and queues the issue visibly", () => {
    const h = newWorld();
    h.windows.pause("anthropic", QUOTA_PAUSE_THRESHOLD);
    const decision = h.scheduler.dispatchNext(h.missionId, { features: FEATURES, budget: BUDGET });
    expect(decision).toMatchObject({
      kind: "quota-paused",
      issueId: h.issue1,
      family: "anthropic",
    });
    expect(h.recorder.currentState("issue", h.issue1)).toBe("queued-quota");
    // Below the threshold there is no pause.
    h.windows.pause("anthropic", QUOTA_PAUSE_THRESHOLD - 0.01);
    expect(h.scheduler.quotaPauseFor("anthropic")).toBeNull();
  });

  it("frees queued-quota work when the gate clears (never counted as failure)", () => {
    const h = newWorld();
    h.windows.pause("anthropic", 1);
    h.scheduler.dispatchNext(h.missionId, { features: FEATURES, budget: BUDGET });
    expect(h.recorder.currentState("issue", h.issue1)).toBe("queued-quota");
    h.windows.clear("anthropic");
    const released = h.scheduler.releaseQuotaWaits(h.missionId, FEATURES);
    expect(released).toEqual([h.issue1]);
    expect(h.recorder.currentState("issue", h.issue1)).toBe("ready");
    expect(h.recorder.currentView.issues.get(h.issue1)?.failureCount).toBe(0);
    expect(h.scheduler.dispatchNext(h.missionId, { features: FEATURES, budget: BUDGET }).kind).toBe(
      "dispatch",
    );
  });

  it("an exhausted family with NO shape pauses until the probe backoff elapses", () => {
    const h = newWorld();
    const blockedAt = new Date(h.clock.ms - 1000).toISOString();
    h.windows.exhaustNoShape("anthropic", blockedAt);
    expect(h.scheduler.quotaPauseFor("anthropic")).toMatchObject({
      reason: "exhausted-horizon-unknown",
    });
    h.clock.ms += QUOTA_PROBE_BACKOFF_MS;
    expect(h.scheduler.quotaPauseFor("anthropic")).toBeNull();
  });

  it("a quota-blocked OUTCOME queues the issue and never touches the failure counter", () => {
    const h = newWorld();
    const { routing } = runAttempt(h, "quota-blocked");
    expect(routing.attemptTerminal).toBe("quota-blocked");
    expect(h.recorder.currentState("issue", h.issue1)).toBe("queued-quota");
    expect(h.recorder.currentView.issues.get(h.issue1)?.failureCount).toBe(0);
    // The wait resolves to ready; the next dispatch mints attempt 2 with
    // the SAME family (no switch — quota waits feed no counters).
    h.scheduler.releaseQuotaWaits(h.missionId, FEATURES);
    const next = h.scheduler.dispatchNext(h.missionId, { features: FEATURES, budget: BUDGET });
    if (next.kind !== "dispatch") throw new Error("expected dispatch");
    expect(next.plan.familySwitched).toBe(false);
    expect(next.plan.family).toBe("anthropic");
  });
});

describe("CAM-PLAN-09 — failure handoff", () => {
  it("a failed attempt hands off a structured summary, not a transcript", () => {
    const h = newWorld();
    const { plan, routing } = runAttempt(h, "requirement-failed");
    expect(routing.attemptTerminal).toBe("failed");
    expect(h.recorder.currentState("attempt", plan.attemptId)).toBe("failed");
    expect(h.recorder.currentState("issue", h.issue1)).toBe("ready");
    expect(h.recorder.currentView.issues.get(h.issue1)?.failureCount).toBe(1);
    const summary = h.summaries.get(plan.attemptId);
    expect(summary).toBeDefined();
    expect(summary?.contractRef.issueId).toBe(h.issue1);
    expect(summary?.headline).toBe("one line of classified result");
    // Structurally transcript-free: the record has no events/transcript
    // field at all, and the multi-line finalText was reduced to one line.
    expect(JSON.stringify(summary)).not.toContain("transcript-ish");
  });

  it("two same-family failures switch families; four escalate; the lease stays monotonic", () => {
    const h = newWorld();
    const a1 = runAttempt(h, "requirement-failed");
    expect(a1.plan.family).toBe("anthropic");
    const a2 = runAttempt(h, "requirement-failed");
    expect(a2.plan.family).toBe("anthropic");
    expect(a2.plan.familySwitched).toBe(false);
    // failureCount is now 2: the third attempt runs on a DIFFERENT family.
    const a3 = runAttempt(h, "requirement-failed");
    expect(a3.plan.familySwitched).toBe(true);
    expect(a3.plan.family).not.toBe("anthropic");
    expect(harnessFamily(a3.plan.assignment.harness)).toBe(a3.plan.family);
    // The switched harness runs its own default model.
    expect(a3.plan.assignment.model).toBeNull();
    // Fourth failure → escalated (A.2#9b): no fifth dispatch.
    const a4 = runAttempt(h, "requirement-failed");
    expect(a4.plan.familySwitched).toBe(true);
    expect(h.recorder.currentState("issue", h.issue1)).toBe("escalated");
    expect(h.recorder.currentView.issues.get(h.issue1)?.failureCount).toBe(4);
    const fifth = h.scheduler.dispatchNext(h.missionId, { features: FEATURES, budget: BUDGET });
    expect(fifth.kind).toBe("held");
    // Lease generations stayed monotonic across the four attempts.
    expect(h.leases.current(`validation:${h.repoId}`)?.generation).toBe(4);
  });

  it("the switch avoids the LAST FAILED family, not merely the table's", () => {
    const h = newWorld();
    runAttempt(h, "requirement-failed");
    runAttempt(h, "requirement-failed");
    const a3 = runAttempt(h, "requirement-failed");
    // a3 ran on the switched family and failed; a4 must avoid THAT family.
    const a4 = runAttempt(h, "requirement-failed");
    expect(a4.plan.family).not.toBe(a3.plan.family);
  });
});

describe("WP-107 outcome routing — budget breach and unconfirmed kills", () => {
  it("killed-budget with kill-confirm → escalated, never auto-retried", () => {
    const h = newWorld();
    const { plan, routing } = runAttempt(h, "killed-budget", {
      recordOverrides: {
        budgetBreach: { kind: "wall-clock", limit: 60_000, observed: 61_000 },
        killConfirm: { requested: true, escalatedToSigkill: true, groupGone: true, elapsedMs: 40 },
      },
    });
    expect(routing).toMatchObject({ attemptTerminal: "killed-budget", issueTo: "escalated" });
    expect(h.recorder.currentState("attempt", plan.attemptId)).toBe("killed-budget");
    expect(h.recorder.currentState("issue", h.issue1)).toBe("escalated");
    expect(h.summaries.get(plan.attemptId)?.budgetBreach).toEqual({
      kind: "wall-clock",
      limit: 60_000,
      observed: 61_000,
    });
    // NEVER auto-retry: nothing is dispatchable now.
    expect(h.scheduler.dispatchNext(h.missionId, { features: FEATURES, budget: BUDGET }).kind).toBe(
      "held",
    );
    // Only David's answer re-opens the issue (A.2#21a).
    record(h, "issue", h.issue1, "escalation-answered", { resolution: "retry" }, "david");
    expect(h.recorder.currentState("issue", h.issue1)).toBe("ready");
  });

  it("killed-budget WITHOUT kill-confirm → cleanup-failed path; lease held; settled only after a real confirm", () => {
    const h = newWorld();
    const { plan, routing } = runAttempt(h, "killed-budget", {
      releaseLease: false, // the lifecycle held the lease (group unconfirmed)
      recordOverrides: {
        budgetBreach: { kind: "tokens", limit: 100_000, observed: 120_000 },
        killConfirm: { requested: true, escalatedToSigkill: true, groupGone: false, elapsedMs: 40 },
      },
    });
    expect(routing).toMatchObject({ attemptTerminal: "running", cleanupFailed: true });
    expect(h.recorder.currentState("issue", h.issue1)).toBe("blocked");
    expect(h.recorder.currentState("attempt", plan.attemptId)).toBe("running");
    // The environment is FENCED: no re-grant while the kill is unconfirmed.
    const env = `validation:${h.repoId}`;
    expect(h.leases.current(env)?.state).toBe("held");
    expect(h.leases.grant(env, "someone-else")).toMatchObject({ ok: false });
    // A REAL kill-confirm (container scope) settles attempt + lease.
    const settled = h.scheduler.confirmKillAndSettle(plan, "container");
    expect(settled.attemptTerminal).toBe("killed-budget");
    expect(h.recorder.currentState("attempt", plan.attemptId)).toBe("killed-budget");
    expect(h.leases.current(env)?.state).toBe("kill-confirmed");
    expect(h.leases.grant(env, "next-attempt").ok).toBe(true);
  });

  it("a cancelled attempt (pause) writes its summary and re-queues the issue", () => {
    const h = newWorld();
    const { plan, routing } = runAttempt(h, "cancelled");
    expect(routing.attemptTerminal).toBe("cancelled");
    expect(h.recorder.currentState("attempt", plan.attemptId)).toBe("cancelled");
    expect(h.recorder.currentState("issue", h.issue1)).toBe("ready");
    expect(h.summaries.get(plan.attemptId)?.failureClass).toBe("cancelled:pause");
    expect(h.recorder.currentView.issues.get(h.issue1)?.failureCount).toBe(0);
  });

  it("a succeeded dispatch parks the attempt at submitted for quarantine/validation", () => {
    const h = newWorld();
    const { plan, routing } = runAttempt(h, "succeeded");
    expect(routing.attemptTerminal).toBe("succeeded");
    expect(h.recorder.currentState("attempt", plan.attemptId)).toBe("submitted");
    expect(h.recorder.currentState("issue", h.issue1)).toBe("implementing");
    expect(h.summaries.get(plan.attemptId)).toBeUndefined(); // summaries are FAILURE handoff
  });

  it("recordOutcome is idempotent per attempt (replay converges, no duplicates)", () => {
    const h = newWorld();
    const decision = h.scheduler.dispatchNext(h.missionId, { features: FEATURES, budget: BUDGET });
    if (decision.kind !== "dispatch") throw new Error("expected dispatch");
    const rec = dispatchRecord("requirement-failed");
    void h.scheduler.leaseHandle(decision.plan).release({ groupGone: true, outcome: rec.outcome });
    h.scheduler.recordOutcome(decision.plan, rec, { finalHeadFetched: true });
    const eventsBefore = h.events.read().length;
    const summariesBefore = h.summaries.forIssue(h.issue1).length;
    h.scheduler.recordOutcome(decision.plan, rec, { finalHeadFetched: true });
    expect(h.events.read().length).toBe(eventsBefore);
    expect(h.summaries.forIssue(h.issue1).length).toBe(summariesBefore);
    expect(h.recorder.currentState("attempt", decision.plan.attemptId)).toBe("failed");
  });
});

describe("dispatch contention on the environment lease", () => {
  it("returns lease-unavailable while a fenced owner exists (cross-lane serialization)", () => {
    const h = newWorld();
    // Another owner (say the urgent lane's quick task) holds the repo's
    // validation environment.
    const foreign = h.leases.grant(`validation:${h.repoId}`, "urgent.quick.a1");
    expect(foreign.ok).toBe(true);
    const decision = h.scheduler.dispatchNext(h.missionId, { features: FEATURES, budget: BUDGET });
    expect(decision).toMatchObject({ kind: "lease-unavailable", issueId: h.issue1 });
    // Nothing was recorded: the issue is still ready, no attempt exists.
    expect(h.recorder.currentState("issue", h.issue1)).toBe("ready");
  });
});

describe("recovery (CAM-STATE-06) — the scheduler half", () => {
  it("settles a claimed-without-worker-start dispatch as never-spawned and re-queues", () => {
    const h = newWorld();
    // Reproduce the exact durable state a kill between protocol steps 2–4
    // leaves: lease granted + issue claimed (+ attempt recorded), no
    // worker-started. Recorded here directly — the chaos suite produces
    // the same state with a real SIGKILL.
    const grant = h.leases.grant(`validation:${h.repoId}`, `${h.issue1}.a1`);
    if (!grant.ok) throw new Error("fixture grant failed");
    record(h, "issue", h.issue1, "dispatched", {
      sequentialSlotFree: true,
      missionExecuting: true,
      attemptId: `${h.issue1}.a1`,
      environmentId: `validation:${h.repoId}`,
      leaseGeneration: 1,
    });
    record(h, "attempt", `${h.issue1}.a1`, "attempt-dispatched", {
      leaseGranted: true,
      leaseGeneration: 1,
      environmentId: `validation:${h.repoId}`,
      issueId: h.issue1,
    });
    const report = h.scheduler.recoverInterrupted();
    expect(report.settledNeverSpawned).toEqual([h.issue1]);
    expect(report.requiresKillConfirm).toEqual([]);
    expect(h.recorder.currentState("issue", h.issue1)).toBe("ready");
    expect(h.recorder.currentState("attempt", `${h.issue1}.a1`)).toBe("expired");
    expect(h.leases.current(`validation:${h.repoId}`)).toMatchObject({
      state: "kill-confirmed",
      killConfirmSource: "never-spawned",
    });
    // Re-dispatch works — and the generation is the NEXT one (monotonic).
    const next = h.scheduler.dispatchNext(h.missionId, { features: FEATURES, budget: BUDGET });
    if (next.kind !== "dispatch") throw new Error("expected dispatch");
    expect(next.plan.lease.generation).toBe(2);
    expect(next.plan.attemptId).toBe(`${h.issue1}.a2`);
  });

  it("REPORTS an implementing attempt for a real kill-confirm; settleInterrupted counts the failure", () => {
    const h = newWorld();
    const decision = h.scheduler.dispatchNext(h.missionId, { features: FEATURES, budget: BUDGET });
    if (decision.kind !== "dispatch") throw new Error("expected dispatch");
    // Daemon dies here; the worker may still be running. Recovery reports;
    // it NEVER settles without a real kill-confirm.
    const report = h.scheduler.recoverInterrupted();
    expect(report.settledNeverSpawned).toEqual([]);
    expect(report.requiresKillConfirm).toMatchObject([
      { issueId: h.issue1, attemptId: decision.plan.attemptId, leaseGeneration: 1 },
    ]);
    expect(h.leases.grant(`validation:${h.repoId}`, "x")).toMatchObject({ ok: false });
    // After the container kill-confirm ran:
    const interrupted = report.requiresKillConfirm[0];
    if (interrupted === undefined) throw new Error("expected an interrupted attempt");
    h.scheduler.settleInterrupted(interrupted, "container");
    expect(h.recorder.currentState("attempt", decision.plan.attemptId)).toBe("expired");
    expect(h.recorder.currentState("issue", h.issue1)).toBe("ready");
    expect(h.recorder.currentView.issues.get(h.issue1)?.failureCount).toBe(1);
    expect(h.leases.current(`validation:${h.repoId}`)?.state).toBe("kill-confirmed");
    // never-spawned cannot be attested past worker-started.
    expect(() => h.scheduler.settleInterrupted(interrupted, "never-spawned")).toThrow(
      /never-spawned/,
    );
  });
});

describe("window-ledger feed", () => {
  it("feeds every outcome through the WP-106 tracker keyed by attempt id", () => {
    const h = newWorld();
    const { plan } = runAttempt(h, "requirement-failed");
    expect(h.windows.recorded).toEqual([
      { family: "anthropic", dispatchId: plan.attemptId, outcome: "requirement-failed" },
    ]);
  });
});
