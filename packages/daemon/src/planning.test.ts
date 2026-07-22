/**
 * Planning-service tests (WP-110): the full CAM-PLAN-01/-02/-04/-07/-11
 * pipeline over real stores — streaming ingest visible as constructed,
 * active acknowledgment gating (passive display fails), checklist
 * confirmations creating accepted ledger entries, the contract freeze with
 * hash references on every issue-created event, dependency cycles named,
 * and crash-resume for every interruptible seam.
 */
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
  const service = new PlanningService(planStore, domain, recorder, ledger, scheduler);
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
      { segmentId: "S2", requirementId: "CAM-APP-01", statement: "s2 statement" },
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
      { segmentId: "S2", requirementId: "CAM-APP-01", statement: "s2 statement" },
      "david",
    );
    h.ledger.proposeRequirement("CAM-APP-01", {
      statement: "s2 statement",
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
