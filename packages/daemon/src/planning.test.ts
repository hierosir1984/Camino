/**
 * Planning-service tests (WP-110): the full CAM-PLAN-01/-02/-04/-07/-11
 * pipeline over real stores — streaming ingest visible as constructed,
 * active acknowledgment gating (passive display fails), checklist
 * confirmations creating accepted ledger entries, the contract freeze with
 * hash references on every issue-created event, dependency cycles named,
 * and crash-resume for every interruptible seam.
 */
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { contractHash, contractTermsOf } from "@camino/shared";
import type { ClarifyingItemDraft, MissionRecord, PlannedIssueDraft } from "@camino/shared";
import { CanonLedgerStore } from "./canon-ledger.js";
import { SqliteDomainStore } from "./domain-store.js";
import { SqliteEventStore } from "./event-store.js";
import { MissionIntake } from "./intake.js";
import { PlanStore } from "./plan-store.js";
import { PlanningError, PlanningService } from "./planning.js";
import { SerializationScheduler } from "./serialization-scheduler.js";
import { TransitionRecorder } from "./transition-recorder.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const PRD = [
  "# Notifications",
  "",
  "Users receive a daily summary email. The summary lists new items.",
  "",
  "Motivation: users asked for fewer interruptions.",
].join("\n");
// Segments: S1 heading, S2 daily-summary sentence, S3 list sentence, S4 motivation.

interface Harness {
  domain: SqliteDomainStore;
  events: SqliteEventStore;
  recorder: TransitionRecorder;
  intake: MissionIntake;
  ledger: CanonLedgerStore;
  planStore: PlanStore;
  scheduler: SerializationScheduler;
  service: PlanningService;
  repoId: string;
}

function newHarness(): Harness {
  const domain = new SqliteDomainStore(":memory:");
  const events = new SqliteEventStore(":memory:");
  const ledger = new CanonLedgerStore(":memory:");
  const planStore = new PlanStore(":memory:");
  cleanups.push(() => {
    domain.close();
    events.close();
    ledger.close();
    planStore.close();
  });
  const recorder = new TransitionRecorder(events);
  const intake = new MissionIntake(domain, recorder, events);
  const scheduler = new SerializationScheduler(domain, recorder, events);
  const service = new PlanningService(planStore, domain, recorder, events, ledger, scheduler);
  const project = domain.createProject("demo");
  const repo = domain.createRepo(project.id, "demo");
  return {
    domain,
    events,
    recorder,
    intake,
    ledger,
    planStore,
    scheduler,
    service,
    repoId: repo.id,
  };
}

function newMission(h: Harness, content: string = PRD): MissionRecord {
  const result = h.intake.createFromText({
    repoId: h.repoId,
    title: "Daily summary",
    content,
    actor: "david",
  });
  if (!result.ok) throw new Error(`intake refused: ${result.reason}`);
  return result.mission;
}

function issue(
  id: string,
  dependsOn: string[] = [],
  interfaces: PlannedIssueDraft["interfaces"] = [],
) {
  return {
    kind: "issue" as const,
    issue: {
      planIssueId: id,
      title: `Issue ${id}`,
      goal: `Deliver ${id}.`,
      acceptanceCriteria: [`${id} works end to end.`],
      dependsOn,
      interfaces,
    },
  };
}

const Q1: ClarifyingItemDraft = {
  clarificationId: "Q1",
  question: "What time of day does the summary send?",
  whyItMatters: "The PRD says daily but never says when.",
  assumptionIfUnanswered: "08:00 in the user's timezone.",
  relatedSegmentIds: ["S2"],
  relatedPlanIssueIds: ["I1"],
};

function mappedRow(segmentId: string, statement: string, issues: string[]) {
  return {
    kind: "checklist-row" as const,
    row: {
      segmentId,
      disposition: "mapped" as const,
      proposedStatement: statement,
      proposedArea: "APP",
      mappedPlanIssueIds: issues,
    },
  };
}

function unmappedRow(segmentId: string, reason: "context" | "non-requirement") {
  return {
    kind: "checklist-row" as const,
    row: { segmentId, disposition: "unmapped" as const, reason },
  };
}

const REVIEW = Object.freeze({
  reviewClass: "full-falsification",
  reviewer: "codex-cli",
  verdict: "approve-with-findings",
});

/** Stream the standard two-issue plan up to construction-complete + review. */
function constructPlan(h: Harness, sessionId: string): void {
  h.service.ingest(
    sessionId,
    issue("I1", [], [{ name: "summary-api", kind: "api", description: "GET /summary" }]),
  );
  h.service.ingest(sessionId, { kind: "clarification", clarification: Q1 });
  h.service.ingest(sessionId, issue("I2", ["I1"]));
  h.service.ingest(sessionId, unmappedRow("S1", "non-requirement"));
  h.service.ingest(sessionId, mappedRow("S2", "The system sends a daily summary email.", ["I1"]));
  h.service.ingest(sessionId, mappedRow("S3", "The summary lists new items.", ["I2"]));
  h.service.ingest(sessionId, unmappedRow("S4", "context"));
  h.service.ingest(sessionId, { kind: "construction-complete" });
  h.service.attachReview(sessionId, { ...REVIEW });
}

/** David's three acts, in full. */
function acknowledgeEverything(h: Harness, sessionId: string): void {
  h.service.acknowledgeClarification(sessionId, "Q1", { kind: "answered", answer: "07:30 UTC." });
  h.service.confirmMappedRows(sessionId, ["S2", "S3"]);
  h.service.acknowledgeFlaggedRows(sessionId, ["S1", "S4"]);
}

describe("streaming ingest (CAM-PLAN-01: visible as constructed)", () => {
  it("shows issues in the view the moment they are ingested, before the plan completes", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    expect(h.service.planView(session.sessionId).issues).toHaveLength(0);
    h.service.ingest(session.sessionId, issue("I1"));
    const mid = h.service.planView(session.sessionId);
    expect(mid.issues.map((i) => i.planIssueId)).toEqual(["I1"]);
    expect(mid.status).toBe("constructing");
    h.service.ingest(session.sessionId, issue("I2", ["I1"]));
    expect(h.service.planView(session.sessionId).issues).toHaveLength(2);
  });

  it("mission reaches planned only when construction is complete AND review attached", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    h.service.ingest(session.sessionId, issue("I1"));
    h.service.ingest(session.sessionId, unmappedRow("S1", "non-requirement"));
    h.service.ingest(session.sessionId, mappedRow("S2", "s2", ["I1"]));
    h.service.ingest(session.sessionId, mappedRow("S3", "s3", ["I1"]));
    h.service.ingest(session.sessionId, unmappedRow("S4", "context"));
    expect(h.recorder.currentState("mission", mission.id)).toBe("draft");
    h.service.ingest(session.sessionId, { kind: "construction-complete" });
    expect(h.recorder.currentState("mission", mission.id)).toBe("draft");
    h.service.attachReview(session.sessionId, { ...REVIEW });
    expect(h.recorder.currentState("mission", mission.id)).toBe("planned");
  });

  it("refuses duplicate ids, unknown segments, and post-completion records", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    h.service.ingest(session.sessionId, issue("I1"));
    expect(() => h.service.ingest(session.sessionId, issue("I1"))).toThrow(/duplicate issue id/);
    expect(() => h.service.ingest(session.sessionId, mappedRow("S99", "x", ["I1"]))).toThrow(
      /unknown segment S99/,
    );
    expect(() =>
      h.service.ingest(session.sessionId, {
        kind: "clarification",
        clarification: { ...Q1, relatedSegmentIds: ["S42"] },
      }),
    ).toThrow(/unknown segment S42/);
    h.service.ingest(session.sessionId, unmappedRow("S1", "non-requirement"));
    expect(() => h.service.ingest(session.sessionId, unmappedRow("S1", "context"))).toThrow(
      /already has a checklist row/,
    );
  });

  it("refuses construction-complete while the checklist is not total (CAM-PLAN-02)", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    h.service.ingest(session.sessionId, issue("I1"));
    h.service.ingest(session.sessionId, mappedRow("S2", "s", ["I1"]));
    expect(() => h.service.ingest(session.sessionId, { kind: "construction-complete" })).toThrow(
      /has no checklist row/,
    );
  });

  it("structurally refuses malformed records (planner output is data)", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    expect(() => h.service.ingest(session.sessionId, { kind: "board-takeover" })).toThrow(
      PlanningError,
    );
    expect(() =>
      h.service.ingest(session.sessionId, {
        kind: "issue",
        issue: { planIssueId: "I1", title: "x" },
      }),
    ).toThrow(PlanningError);
  });
});

describe("checklist visibility (CAM-PLAN-02: unmapped rows visibly flagged)", () => {
  it("flags every unmapped row with its reason, and lists flaggedSegmentIds separately", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    const view = h.service.planView(session.sessionId);
    expect(view.flaggedSegmentIds).toEqual(["S1", "S4"]);
    const s4 = view.checklist.find((r) => r.segmentId === "S4");
    expect(s4).toMatchObject({ disposition: "unmapped", flagged: true, reason: "context" });
    expect(s4?.segmentText).toContain("Motivation");
    const s2 = view.checklist.find((r) => r.segmentId === "S2");
    expect(s2).toMatchObject({ disposition: "mapped", confirmed: false, requirementId: null });
  });
});

describe("acknowledgments and confirmations", () => {
  it("confirmations create accepted intent-ledger entries (CAM-PLAN-02)", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    h.service.confirmMappedRows(session.sessionId, ["S2"]);
    const view = h.ledger.currentView();
    expect(view.size).toBe(1);
    const entry = [...view.values()][0];
    expect(entry).toMatchObject({
      requirementId: "CAM-APP-01",
      disposition: "accepted",
      statement: "The system sends a daily summary email.",
    });
    const records = h.ledger.read();
    expect(records.map((r) => r.event)).toEqual(["requirement-proposed", "requirement-accepted"]);
    expect(records[0]?.payload["sourceMissionId"]).toBe(mission.id);
  });

  it("mints sequential ids per area and REUSES an accepted id with the identical statement", () => {
    const h = newHarness();
    const mission = newMission(h);
    // Pre-existing accepted intent with the same statement as S3's proposal.
    h.ledger.proposeRequirement("CAM-APP-07", {
      statement: "The summary lists new items.",
      sourceMissionId: mission.id,
    });
    h.ledger.acceptRequirement("CAM-APP-07");
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    h.service.confirmMappedRows(session.sessionId, ["S2", "S3"]);
    const confirmations = h.planStore.confirmations(session.sessionId);
    const byId = new Map(confirmations.map((c) => [c.segmentId, c.requirementId]));
    expect(byId.get("S2")).toBe("CAM-APP-01"); // minted: 07 taken, 01 free
    expect(byId.get("S3")).toBe("CAM-APP-07"); // reused: identical accepted statement
    // No duplicate ledger entry for the reused requirement.
    expect(h.ledger.read({ requirementId: "CAM-APP-07" })).toHaveLength(2);
  });

  it("refuses confirming a flagged row, double-confirming, or acknowledging twice", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    expect(() => h.service.confirmMappedRows(session.sessionId, ["S1"])).toThrow(
      /flagged unmapped/,
    );
    h.service.confirmMappedRows(session.sessionId, ["S2"]);
    expect(() => h.service.confirmMappedRows(session.sessionId, ["S2"])).toThrow(
      /already confirmed/,
    );
    h.service.acknowledgeClarification(session.sessionId, "Q1", { kind: "assumption-confirmed" });
    expect(() =>
      h.service.acknowledgeClarification(session.sessionId, "Q1", {
        kind: "answered",
        answer: "noon",
      }),
    ).toThrow(/already acknowledged/);
  });

  it("flagged-rows acknowledgment must name the exact current set", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    expect(() => h.service.acknowledgeFlaggedRows(session.sessionId, ["S1"])).toThrow(
      /must name the current unmapped set exactly/,
    );
    h.service.acknowledgeFlaggedRows(session.sessionId, ["S4", "S1"]); // order-insensitive
  });
});

describe("plan approval (CAM-PLAN-01: passive display fails; active acknowledgment gates)", () => {
  it("approves a fully acknowledged plan and freezes hash-referenced contracts", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    acknowledgeEverything(h, session.sessionId);
    const outcome = h.service.approvePlan(session.sessionId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.contracts).toHaveLength(2);
    const [c1, c2] = outcome.contracts;
    expect(c1?.issueId).toBe(`${mission.id}.I1`);
    expect(c1?.contractHash).toBe(contractHash(contractTermsOf(c1!)));
    expect(c1?.requirementIds).toEqual(["CAM-APP-01"]);
    expect(c1?.interfaces).toEqual([
      { name: "summary-api", kind: "api", description: "GET /summary" },
    ]);
    expect(c2?.dependsOn).toEqual([`${mission.id}.I1`]);
    expect(h.recorder.currentState("mission", mission.id)).toBe("approved");
    expect(h.service.planView(session.sessionId).status).toBe("approved");
    // Frozen means retrievable by hash.
    expect(h.service.contractByHash(c1!.contractHash)?.issueId).toBe(c1?.issueId);
  });

  it("PASSIVE DISPLAY FAILS: rendering the view acknowledges nothing; approval refuses by name", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    // "Display" the plan as often as we like…
    for (let i = 0; i < 3; i += 1) h.service.planView(session.sessionId);
    const outcome = h.service.approvePlan(session.sessionId);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals).toContainEqual({
      kind: "unacknowledged-clarifications",
      clarificationIds: ["Q1"],
    });
    // Nothing froze, nothing advanced.
    expect(h.recorder.currentState("mission", mission.id)).toBe("planned");
    expect(h.service.contractsForMission(mission.id)).toEqual([]);
    expect(h.ledger.currentView().size).toBe(0);
  });

  it("every issue-created event carries its contract hash (CAM-PLAN-04 obligation)", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    acknowledgeEverything(h, session.sessionId);
    const outcome = h.service.approvePlan(session.sessionId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    for (const contract of outcome.contracts) {
      const created = h.events
        .read({ entityKind: "issue", entityId: contract.issueId })
        .filter((r) => r.event === "issue-created");
      expect(created).toHaveLength(1);
      expect(created[0]?.payload).toMatchObject({
        origin: "plan-approval",
        contractVersion: contract.version,
        contractHash: contract.contractHash,
      });
    }
    // Dependency-ordered creation states: I1 ready, I2 waiting on it.
    expect(h.recorder.currentState("issue", `${mission.id}.I1`)).toBe("ready");
    expect(h.recorder.currentState("issue", `${mission.id}.I2`)).toBe("waiting-deps");
  });

  it("a dependency cycle refuses approval with the cycle NAMED (CAM-PLAN-11)", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    h.service.ingest(session.sessionId, issue("I1", ["I2"]));
    h.service.ingest(session.sessionId, issue("I2", ["I1"]));
    h.service.ingest(session.sessionId, unmappedRow("S1", "non-requirement"));
    h.service.ingest(session.sessionId, mappedRow("S2", "s2", ["I1"]));
    h.service.ingest(session.sessionId, mappedRow("S3", "s3", ["I2"]));
    h.service.ingest(session.sessionId, unmappedRow("S4", "context"));
    h.service.ingest(session.sessionId, { kind: "construction-complete" });
    h.service.attachReview(session.sessionId, { ...REVIEW });
    h.service.confirmMappedRows(session.sessionId, ["S2", "S3"]);
    h.service.acknowledgeFlaggedRows(session.sessionId, ["S1", "S4"]);
    const outcome = h.service.approvePlan(session.sessionId);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals).toContainEqual({
      kind: "dependency-cycle",
      cycle: ["I1", "I2", "I1"],
      named: "I1 -> I2 -> I1",
    });
    expect(h.recorder.currentState("mission", mission.id)).toBe("planned");
    expect(h.service.contractsForMission(mission.id)).toEqual([]);
  });

  it("declared interfaces persist on the contract and are visible to dependents (CAM-PLAN-11)", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    acknowledgeEverything(h, session.sessionId);
    const outcome = h.service.approvePlan(session.sessionId);
    expect(outcome.ok).toBe(true);
    const dependentView = h.service.dependencyInterfacesFor(`${mission.id}.I2`);
    expect(dependentView).toHaveLength(1);
    expect(dependentView[0]).toMatchObject({
      issueId: `${mission.id}.I1`,
      contractVersion: 1,
      interfaces: [{ name: "summary-api", kind: "api", description: "GET /summary" }],
    });
    expect(dependentView[0]?.contractHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("re-approval of an already-approved session refuses", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    acknowledgeEverything(h, session.sessionId);
    expect(h.service.approvePlan(session.sessionId).ok).toBe(true);
    expect(() => h.service.approvePlan(session.sessionId)).toThrow(/approved and frozen/);
  });

  it("plan rejection returns the mission to draft and a new session can start", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    h.service.rejectPlan(session.sessionId);
    expect(h.recorder.currentState("mission", mission.id)).toBe("draft");
    expect(h.service.planView(session.sessionId).status).toBe("rejected");
    expect(() => h.service.ingest(session.sessionId, issue("I9"))).toThrow(/rejected/);
    const second = h.service.startSession(mission.id, "feature");
    expect(second.sessionId).toBe(`plan-${mission.id}-2`);
  });
});

describe("session lifecycle guards", () => {
  it("refuses a template whose route does not match the mission", () => {
    const h = newHarness();
    const mission = newMission(h);
    expect(() => h.service.startSession(mission.id, "quick-task")).toThrow(/route/);
  });

  it("refuses a second open session and unknown missions", () => {
    const h = newHarness();
    const mission = newMission(h);
    h.service.startSession(mission.id, "feature");
    expect(() => h.service.startSession(mission.id, "feature")).toThrow(/open planning session/);
    expect(() => h.service.startSession("missing", "feature")).toThrow(/does not exist/);
  });
});

describe("quick-task route (CAM-PLAN-07)", () => {
  function quickTaskMission(h: Harness): MissionRecord {
    const result = h.intake.createQuickTask({
      repoId: h.repoId,
      title: "Fix the footer link",
      description: "The footer link points at the old docs page. Point it at the new one.",
      urgent: false,
      actor: "david",
    });
    if (!result.ok) throw new Error(result.reason);
    return result.mission;
  }

  const MINI_REVIEW = Object.freeze({
    reviewClass: "mini-falsification",
    reviewer: "codex-cli",
    verdict: "approve",
    observabilityAdjudicated: true,
    riskTierLow: true,
    neutralConcurred: true,
  });

  function constructQuickTask(h: Harness, sessionId: string): void {
    const view = h.service.planView(sessionId);
    h.service.ingest(sessionId, issue("I1"));
    for (const segment of view.segments) {
      if (segment.segmentId === "S1") {
        h.service.ingest(
          sessionId,
          mappedRow("S1", "The footer link points at the new docs page.", ["I1"]),
        );
      } else {
        h.service.ingest(sessionId, unmappedRow(segment.segmentId, "context"));
      }
    }
    h.service.ingest(sessionId, { kind: "construction-complete" });
  }

  it("a quick-task plan allows exactly one issue", () => {
    const h = newHarness();
    const mission = quickTaskMission(h);
    const session = h.service.startSession(mission.id, "quick-task");
    h.service.ingest(session.sessionId, issue("I1"));
    expect(() => h.service.ingest(session.sessionId, issue("I2"))).not.toThrow();
    expect(() => h.service.ingest(session.sessionId, { kind: "construction-complete" })).toThrow(
      /allows at most 1 issue/,
    );
  });

  it("contract-attached requires observability adjudication; approval consumes reviewer facts", () => {
    const h = newHarness();
    const mission = quickTaskMission(h);
    const session = h.service.startSession(mission.id, "quick-task");
    constructQuickTask(h, session.sessionId);
    // A mini review WITHOUT adjudication leaves the mission in draft.
    h.service.attachReview(session.sessionId, { ...MINI_REVIEW, observabilityAdjudicated: false });
    expect(h.recorder.currentState("mission", mission.id)).toBe("draft");
    h.service.attachReview(session.sessionId, { ...MINI_REVIEW });
    expect(h.recorder.currentState("mission", mission.id)).toBe("planned");
    const view = h.service.planView(session.sessionId);
    h.service.confirmMappedRows(session.sessionId, ["S1"]);
    const flagged = view.flaggedSegmentIds;
    if (flagged.length > 0) h.service.acknowledgeFlaggedRows(session.sessionId, flagged);
    const outcome = h.service.approvePlan(session.sessionId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.contracts).toHaveLength(1);
    expect(outcome.contracts[0]?.template).toBe("quick-task");
    expect(h.recorder.currentState("mission", mission.id)).toBe("approved");
  });

  it("approval refuses when the mini review omits the reviewer facts", () => {
    const h = newHarness();
    const mission = quickTaskMission(h);
    const session = h.service.startSession(mission.id, "quick-task");
    constructQuickTask(h, session.sessionId);
    h.service.attachReview(session.sessionId, {
      reviewClass: "mini-falsification",
      reviewer: "codex-cli",
      verdict: "approve",
      observabilityAdjudicated: true,
    });
    h.service.confirmMappedRows(session.sessionId, ["S1"]);
    const flagged = h.service.planView(session.sessionId).flaggedSegmentIds;
    if (flagged.length > 0) h.service.acknowledgeFlaggedRows(session.sessionId, flagged);
    const outcome = h.service.approvePlan(session.sessionId);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals).toContainEqual({
      kind: "quick-task-review-facts-missing",
      missing: ["riskTierLow", "neutralConcurred"],
    });
  });

  it("a feature template cannot open a session on a quick-task mission", () => {
    const h = newHarness();
    const mission = quickTaskMission(h);
    expect(() => h.service.startSession(mission.id, "feature")).toThrow(/route/);
  });
});

describe("crash resume (the WP-104 idempotency posture)", () => {
  it("completes ledger writes a crash separated from their confirmation rows", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    // Simulate the crash window: the confirmation row is durable but the
    // ledger pair never ran (recorded directly against the store).
    h.planStore.recordConfirmation(
      session.sessionId,
      {
        segmentId: "S2",
        requirementId: "CAM-APP-01",
        statement: "The system sends a daily summary email.",
      },
      "david",
    );
    expect(h.ledger.currentView().size).toBe(0);
    const report = h.service.resumePendingWork();
    expect(report.completedLedgerWrites).toEqual(["CAM-APP-01"]);
    expect(h.ledger.entry("CAM-APP-01")?.disposition).toBe("accepted");
    // Resume is idempotent: nothing more to do on a second run.
    expect(h.service.resumePendingWork().completedLedgerWrites).toEqual([]);
  });

  it("completes a propose-only ledger interruption with the accept", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    h.planStore.recordConfirmation(
      session.sessionId,
      {
        segmentId: "S2",
        requirementId: "CAM-APP-01",
        statement: "The system sends a daily summary email.",
      },
      "david",
    );
    h.ledger.proposeRequirement("CAM-APP-01", {
      statement: "The system sends a daily summary email.",
      sourceMissionId: mission.id,
    });
    h.service.resumePendingWork();
    expect(h.ledger.entry("CAM-APP-01")?.disposition).toBe("accepted");
  });

  it("completes an approval whose freeze a crash interrupted", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    acknowledgeEverything(h, session.sessionId);
    // Simulate the crash: the approval act landed, nothing after it did.
    h.planStore.recordApproval(session.sessionId, "david");
    expect(h.service.contractsForMission(mission.id)).toEqual([]);
    const report = h.service.resumePendingWork();
    expect(report.completedApprovals).toEqual([session.sessionId]);
    expect(h.service.contractsForMission(mission.id)).toHaveLength(2);
    expect(h.recorder.currentState("mission", mission.id)).toBe("approved");
    expect(h.recorder.currentState("issue", `${mission.id}.I1`)).toBe("ready");
    expect(h.service.planView(session.sessionId).status).toBe("approved");
    // Idempotent re-run.
    expect(h.service.resumePendingWork().completedApprovals).toEqual([]);
  });

  it("completes a freeze interrupted AFTER contracts were written but before events", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    acknowledgeEverything(h, session.sessionId);
    h.planStore.recordApproval(session.sessionId, "david");
    // Contracts landed pre-crash; the mission event and issues did not.
    const report1 = h.service.resumePendingWork();
    expect(report1.completedApprovals).toEqual([session.sessionId]);
    // Re-running the whole resume path over the completed state changes nothing.
    const before = h.events.read().length;
    h.service.resumePendingWork();
    expect(h.events.read().length).toBe(before);
  });

  it("records a constructed transition a crash separated from the stream", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    // Write the full stream + review directly to the store, bypassing the
    // service's event recording — the crash-between-store-and-event window.
    h.planStore.appendStream(session.sessionId, "issue", issue("I1"));
    h.planStore.appendStream(
      session.sessionId,
      "checklist-row",
      unmappedRow("S1", "non-requirement"),
    );
    h.planStore.appendStream(session.sessionId, "checklist-row", mappedRow("S2", "s", ["I1"]));
    h.planStore.appendStream(session.sessionId, "checklist-row", mappedRow("S3", "s3", ["I1"]));
    h.planStore.appendStream(session.sessionId, "checklist-row", unmappedRow("S4", "context"));
    h.planStore.appendStream(session.sessionId, "construction-complete", {
      kind: "construction-complete",
    });
    h.planStore.appendStream(session.sessionId, "review-attached", { ...REVIEW });
    expect(h.recorder.currentState("mission", mission.id)).toBe("draft");
    const report = h.service.resumePendingWork();
    expect(report.recordedConstructedTransitions).toEqual([session.sessionId]);
    expect(h.recorder.currentState("mission", mission.id)).toBe("planned");
  });
});

describe("round-1 falsification regressions", () => {
  it("F1: the store itself refuses an approval act without its acts (defense in depth)", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    // A first-party caller reaching past the service cannot record the
    // approval act while acknowledgments are missing.
    expect(() => h.planStore.recordApproval(session.sessionId, "david")).toThrow(
      /approval act refused.*unacknowledged/,
    );
    expect(h.service.contractsForMission(mission.id)).toEqual([]);
    expect(h.recorder.currentState("mission", mission.id)).toBe("planned");
  });

  it("F1: a bare completion marker is refused by the store (no substance, no approval)", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    expect(() => h.planStore.recordApprovalCompletion(session.sessionId)).toThrow(
      /no approval act/,
    );
    expect(h.service.planView(session.sessionId).status).toBe("constructed");
  });

  it("F1: resume REFUSES a raw-forged approval row the gate does not support", () => {
    // The store guards block the API path; forge the row with a raw second
    // connection (file-backed store) and prove resume still refuses.
    const dir = mkdtempSync(join(tmpdir(), "camino-plan-f1-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const storePath = join(dir, "plan.sqlite");
    const domain = new SqliteDomainStore(":memory:");
    const events = new SqliteEventStore(":memory:");
    const ledger = new CanonLedgerStore(":memory:");
    const planStore = new PlanStore(storePath);
    cleanups.push(() => {
      domain.close();
      events.close();
      ledger.close();
      planStore.close();
    });
    const recorder = new TransitionRecorder(events);
    const intake = new MissionIntake(domain, recorder, events);
    const scheduler = new SerializationScheduler(domain, recorder, events);
    const service = new PlanningService(planStore, domain, recorder, events, ledger, scheduler);
    const project = domain.createProject("demo");
    const repo = domain.createRepo(project.id, "demo");
    const result = intake.createFromText({
      repoId: repo.id,
      title: "Daily summary",
      content: PRD,
      actor: "david",
    });
    if (!result.ok) throw new Error(result.reason);
    const session = service.startSession(result.mission.id, "feature");
    const h = { service, recorder, intake, ledger, planStore } as unknown as Harness;
    constructPlan(h, session.sessionId);
    const raw = new Database(storePath);
    raw
      .prepare("INSERT INTO plan_approvals (session_id, actor, recorded_at) VALUES (?, ?, ?)")
      .run(session.sessionId, "david", "2026-07-22T12:00:00.000Z");
    raw.close();
    expect(() => service.resumePendingWork()).toThrow(/gate refuses/);
    expect(service.contractsForMission(result.mission.id)).toEqual([]);
    expect(recorder.currentState("mission", result.mission.id)).toBe("planned");
  });

  it("F3: approval heals a confirmation whose ledger pair an in-process failure lost", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    h.service.acknowledgeClarification(session.sessionId, "Q1", { kind: "assumption-confirmed" });
    // The confirmation rows land without their ledger writes (the injected-
    // failure window the review demonstrated).
    h.planStore.recordConfirmation(
      session.sessionId,
      {
        segmentId: "S2",
        requirementId: "CAM-APP-01",
        statement: "The system sends a daily summary email.",
      },
      "david",
    );
    h.planStore.recordConfirmation(
      session.sessionId,
      { segmentId: "S3", requirementId: "CAM-APP-02", statement: "The summary lists new items." },
      "david",
    );
    h.service.acknowledgeFlaggedRows(session.sessionId, ["S1", "S4"]);
    expect(h.ledger.currentView().size).toBe(0);
    const outcome = h.service.approvePlan(session.sessionId);
    expect(outcome.ok).toBe(true);
    // Approval could not complete while confirmed intent had no accepted entry.
    expect(h.ledger.entry("CAM-APP-01")?.disposition).toBe("accepted");
    expect(h.ledger.entry("CAM-APP-02")?.disposition).toBe("accepted");
  });

  it("F4: a rejection interrupted before its mission event is completed, never resurrected", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    // The crash window: the rejection ROW landed, the mission event did not.
    h.planStore.recordRejection(session.sessionId, "david");
    expect(h.recorder.currentState("mission", mission.id)).toBe("planned");
    const report = h.service.resumePendingWork();
    expect(report.completedRejections).toEqual([session.sessionId]);
    expect(h.recorder.currentState("mission", mission.id)).toBe("draft");
    // No resurrection: the constructed-transition sweep skipped the
    // rejected session, and the mission stays in draft on a second resume.
    expect(h.service.resumePendingWork().recordedConstructedTransitions).toEqual([]);
    expect(h.recorder.currentState("mission", mission.id)).toBe("draft");
    expect(h.service.planView(session.sessionId).status).toBe("rejected");
  });

  it("F5: resume refuses a pre-existing issue whose creation record lacks the contract reference", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    acknowledgeEverything(h, session.sessionId);
    // A foreign issue record occupies the durable id, created without the
    // contract-reference payload the freeze would have written.
    const foreign = h.recorder.record({
      entityKind: "issue",
      entityId: `${mission.id}.I1`,
      event: "issue-created",
      actor: "camino:planner",
      cause: "foreign creation without contract reference",
      payload: { origin: "plan-approval", unmetDependencies: 0 },
    });
    expect(foreign.ok).toBe(true);
    h.planStore.recordApproval(session.sessionId, "david");
    expect(() => h.service.resumePendingWork()).toThrow(/does not reference contract/);
  });

  it("F11: an identical statement signed off as an ASSUMPTION is reused, not duplicated", () => {
    const h = newHarness();
    const mission = newMission(h);
    h.ledger.proposeRequirement("CAM-APP-05", {
      statement: "The system sends a daily summary email.",
      sourceMissionId: mission.id,
    });
    h.ledger.disputeRequirement("CAM-APP-05", { reason: "channel unstated", conflictWith: null });
    h.ledger.resolveDisputeAssumed("CAM-APP-05", { assumption: "Email, pending confirmation." });
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    h.service.confirmMappedRows(session.sessionId, ["S2"]);
    const confirmation = h.planStore.confirmations(session.sessionId)[0];
    expect(confirmation?.requirementId).toBe("CAM-APP-05");
    // No second entry with the same statement exists.
    expect(h.ledger.currentView().size).toBe(1);
  });

  it("F11: an identical statement under a DIFFERENT area refuses instead of aliasing", () => {
    const h = newHarness();
    const mission = newMission(h);
    h.ledger.proposeRequirement("CAM-UI-01", {
      statement: "The system sends a daily summary email.",
      sourceMissionId: mission.id,
    });
    h.ledger.acceptRequirement("CAM-UI-01");
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId); // proposes area APP for S2
    expect(() => h.service.confirmMappedRows(session.sessionId, ["S2"])).toThrow(
      /refusing to alias intent across areas/,
    );
  });

  it("F12: dependency interfaces resolve against a version-pinned dependent contract", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    acknowledgeEverything(h, session.sessionId);
    expect(h.service.approvePlan(session.sessionId).ok).toBe(true);
    const pinned = h.service.dependencyInterfacesFor(`${mission.id}.I2`, 1);
    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.issueId).toBe(`${mission.id}.I1`);
    expect(() => h.service.dependencyInterfacesFor(`${mission.id}.I2`, 7)).toThrow(
      /no contract v7/,
    );
  });
});

describe("round-2 falsification regressions", () => {
  it("R2-2: acts are refused once the approval act exists (state cannot shift under an approval)", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    acknowledgeEverything(h, session.sessionId);
    h.planStore.recordApproval(session.sessionId, "david"); // the crash window, pre-completion
    expect(() =>
      h.service.acknowledgeClarification(session.sessionId, "Q1", { kind: "assumption-confirmed" }),
    ).toThrow(/recorded approval/);
    expect(() => h.service.confirmMappedRows(session.sessionId, ["S2"])).toThrow(
      /recorded approval/,
    );
    expect(() => h.service.acknowledgeFlaggedRows(session.sessionId, ["S1", "S4"])).toThrow(
      /recorded approval/,
    );
  });

  it("R2-5: a rejection is refused while an approval is pending (deterministic conflict resolution)", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    acknowledgeEverything(h, session.sessionId);
    h.planStore.recordApproval(session.sessionId, "david");
    expect(() => h.service.rejectPlan(session.sessionId)).toThrow(/recorded approval/);
    // Resume completes the approval instead — no irreconcilable state.
    const report = h.service.resumePendingWork();
    expect(report.completedApprovals).toEqual([session.sessionId]);
    expect(h.recorder.currentState("mission", mission.id)).toBe("approved");
  });

  it("R2-4: quick-task approval refuses BEFORE the act when reviewer facts are not true", () => {
    const h = newHarness();
    const result = h.intake.createQuickTask({
      repoId: h.repoId,
      title: "Fix the footer link",
      description: "Point the footer link at the new docs page.",
      urgent: false,
      actor: "david",
    });
    if (!result.ok) throw new Error(result.reason);
    const session = h.service.startSession(result.mission.id, "quick-task");
    const segments = h.service.planView(session.sessionId).segments;
    h.service.ingest(session.sessionId, issue("I1"));
    segments.forEach((segment, i) => {
      h.service.ingest(
        session.sessionId,
        i === 0
          ? mappedRow(segment.segmentId, "The footer link points at the new docs page.", ["I1"])
          : unmappedRow(segment.segmentId, "context"),
      );
    });
    h.service.ingest(session.sessionId, { kind: "construction-complete" });
    h.service.attachReview(session.sessionId, {
      reviewClass: "mini-falsification",
      reviewer: "codex-cli",
      observabilityAdjudicated: true,
      riskTierLow: false, // NOT low risk — the A.1b#3 gate cannot pass
      neutralConcurred: true,
    });
    const first = h.service.planView(session.sessionId).segments[0]?.segmentId as string;
    h.service.confirmMappedRows(session.sessionId, [first]);
    const flagged = h.service.planView(session.sessionId).flaggedSegmentIds;
    if (flagged.length > 0) h.service.acknowledgeFlaggedRows(session.sessionId, flagged);
    const outcome = h.service.approvePlan(session.sessionId);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals).toContainEqual({
      kind: "quick-task-review-facts-missing",
      missing: ["riskTierLow"],
    });
    // Nothing froze, nothing is wedged: no approval act, no contracts.
    expect(h.planStore.approval(session.sessionId)).toBeUndefined();
    expect(h.service.contractsForMission(result.mission.id)).toEqual([]);
    expect(() => h.service.resumePendingWork()).not.toThrow();
  });

  it("R2-7: a confirmed requirement descoped since confirmation blocks approval by name", () => {
    const h = newHarness();
    const mission = newMission(h);
    const session = h.service.startSession(mission.id, "feature");
    constructPlan(h, session.sessionId);
    acknowledgeEverything(h, session.sessionId); // ledger now holds accepted entries
    h.ledger.disputeRequirement("CAM-APP-01", { reason: "reconsidering", conflictWith: null });
    h.ledger.descopeRequirement("CAM-APP-01", { reason: "descoped after review" });
    const outcome = h.service.approvePlan(session.sessionId);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals).toContainEqual({
      kind: "confirmed-requirement-not-accepted",
      requirementIds: ["CAM-APP-01"],
    });
    expect(h.service.contractsForMission(mission.id)).toEqual([]);
  });

  it("R2-3: resume reconciliation refuses a completed approval whose contracts were deleted", () => {
    const dir = mkdtempSync(join(tmpdir(), "camino-plan-r2f3-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const storePath = join(dir, "plan.sqlite");
    const domain = new SqliteDomainStore(":memory:");
    const events = new SqliteEventStore(":memory:");
    const ledger = new CanonLedgerStore(":memory:");
    const planStore = new PlanStore(storePath);
    cleanups.push(() => {
      domain.close();
      events.close();
      ledger.close();
      planStore.close();
    });
    const recorder = new TransitionRecorder(events);
    const intake = new MissionIntake(domain, recorder, events);
    const scheduler = new SerializationScheduler(domain, recorder, events);
    const service = new PlanningService(planStore, domain, recorder, events, ledger, scheduler);
    const project = domain.createProject("demo");
    const repo = domain.createRepo(project.id, "demo");
    const result = intake.createFromText({
      repoId: repo.id,
      title: "Daily summary",
      content: PRD,
      actor: "david",
    });
    if (!result.ok) throw new Error(result.reason);
    const session = service.startSession(result.mission.id, "feature");
    const h = { service, recorder, intake, ledger, planStore } as unknown as Harness;
    constructPlan(h, session.sessionId);
    acknowledgeEverything(h, session.sessionId);
    expect(service.approvePlan(session.sessionId).ok).toBe(true);
    expect(() => service.resumePendingWork()).not.toThrow(); // coherent state reconciles
    // History deleted behind the triggers: the completed approval loses its
    // contracts while its marker survives.
    const raw = new Database(storePath);
    raw.exec("DROP TRIGGER contracts_append_only_delete");
    raw.exec("DELETE FROM contracts");
    raw.close();
    expect(() => service.resumePendingWork()).toThrow(/no stored contract/);
  });
});
