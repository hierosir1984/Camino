/**
 * Ambiguous-PRD fixture harness (WP-110, the CAM-PLAN-01 accept mechanism).
 *
 * Each fixture under fixtures/ambiguous-prds/ is a PRD plus a manifest of
 * PLANTED ambiguities with a known answer key. For every fixture this
 * suite proves, through the real planning pipeline (same ingest seam the
 * planner runner uses):
 *
 *   1. Fixture integrity — every planted ambiguity locates exactly one
 *      segment (drift between prd.md and manifest.json fails loudly).
 *   2. A CONFORMING plan (a clarification per planted ambiguity) reaches
 *      approval only after David actively acknowledges every item —
 *      answer or confirm-the-assumption. PASSIVE DISPLAY FAILS: with the
 *      items rendered but unacknowledged, approval refuses and names them.
 *   3. A SILENT-GUESS plan (one clarification omitted per sub-case, the
 *      assumption baked in) FAILS THE FIXTURE: plantedAmbiguityCoverage
 *      reports the uncovered planted ambiguity by id.
 *
 * Boundary, stated: planted ambiguities exist only in fixtures, so (3) is
 * the CALIBRATION check for planners; at runtime on real PRDs the
 * enforcement is (2) — the gate that makes every SURFACED item an active
 * acknowledgment. The two are complementary by design (see
 * plantedAmbiguityCoverage's docstring in @camino/core).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import { plantedAmbiguityCoverage, segmentPrd } from "@camino/core";
import type { PlantedAmbiguity, PrdSegment } from "@camino/core";
import type { ClarifyingItemDraft, MissionRecord } from "@camino/shared";
import { CanonLedgerStore } from "./canon-ledger.js";
import { SqliteDomainStore } from "./domain-store.js";
import { SqliteEventStore } from "./event-store.js";
import { MissionIntake } from "./intake.js";
import { PlanStore } from "./plan-store.js";
import { PlanningService } from "./planning.js";
import { SerializationScheduler } from "./serialization-scheduler.js";
import { TransitionRecorder } from "./transition-recorder.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
  "ambiguous-prds",
);

interface ManifestAmbiguity extends PlantedAmbiguity {
  readonly exampleQuestion: string;
  readonly exampleAssumption: string;
}

interface Manifest {
  readonly fixture: string;
  readonly area: string;
  readonly missionTitle: string;
  readonly plantedAmbiguities: readonly ManifestAmbiguity[];
  readonly requirementSegments: ReadonlyArray<{
    readonly segmentText: string;
    readonly statement: string;
  }>;
}

interface Fixture {
  readonly name: string;
  readonly prd: string;
  readonly manifest: Manifest;
}

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURES_DIR)
    .sort()
    .map((name) => ({
      name,
      prd: readFileSync(join(FIXTURES_DIR, name, "prd.md"), "utf8"),
      manifest: JSON.parse(
        readFileSync(join(FIXTURES_DIR, name, "manifest.json"), "utf8"),
      ) as Manifest,
    }));
}

const FIXTURES = loadFixtures();

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Harness {
  service: PlanningService;
  ledger: CanonLedgerStore;
  recorder: TransitionRecorder;
  mission: MissionRecord;
  sessionId: string;
}

function newHarness(fixture: Fixture): Harness {
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
  const project = domain.createProject("fixtures");
  const repo = domain.createRepo(project.id, fixture.name);
  const result = intake.createFromText({
    repoId: repo.id,
    title: fixture.manifest.missionTitle,
    content: fixture.prd,
    actor: "david",
  });
  if (!result.ok) throw new Error(`intake refused fixture ${fixture.name}: ${result.reason}`);
  const session = service.startSession(result.mission.id, "feature");
  return { service, ledger, recorder, mission: result.mission, sessionId: session.sessionId };
}

function locate(segments: readonly PrdSegment[], text: string, fixture: string): string {
  const matches = segments.filter((s) => s.text === text);
  if (matches.length !== 1) {
    throw new Error(
      `fixture ${fixture}: segment text ${JSON.stringify(text)} matched ${matches.length} segments`,
    );
  }
  return (matches[0] as PrdSegment).segmentId;
}

/**
 * Derive the conforming plan from the manifest: two issues, every
 * requirement segment mapped, everything else unmapped, one clarification
 * per planted ambiguity — omitting those in `silentlyGuess`, which models
 * a planner that baked the assumption in without asking.
 */
function streamPlan(h: Harness, fixture: Fixture, silentlyGuess: ReadonlySet<string>): void {
  const segments = segmentPrd(fixture.prd);
  const requirementIds = new Set(
    fixture.manifest.requirementSegments.map((r) => locate(segments, r.segmentText, fixture.name)),
  );
  h.service.ingest(h.sessionId, {
    kind: "issue",
    issue: {
      planIssueId: "I1",
      title: `${fixture.manifest.missionTitle}: core behavior`,
      goal: "The primary behaviors in the PRD work end to end.",
      acceptanceCriteria: ["Each mapped core behavior is observable in the running app."],
      dependsOn: [],
      interfaces: [
        {
          name: `${fixture.manifest.fixture}-surface`,
          kind: "module",
          description: "the feature module",
        },
      ],
    },
  });
  h.service.ingest(h.sessionId, {
    kind: "issue",
    issue: {
      planIssueId: "I2",
      title: `${fixture.manifest.missionTitle}: operational behavior`,
      goal: "The supporting behaviors in the PRD work end to end.",
      acceptanceCriteria: ["Each mapped supporting behavior is observable in the running app."],
      dependsOn: ["I1"],
      interfaces: [],
    },
  });
  let clarificationNumber = 0;
  for (const planted of fixture.manifest.plantedAmbiguities) {
    if (silentlyGuess.has(planted.id)) continue;
    clarificationNumber += 1;
    h.service.ingest(h.sessionId, {
      kind: "clarification",
      clarification: {
        clarificationId: `Q${clarificationNumber}`,
        question: planted.exampleQuestion,
        whyItMatters: planted.summary,
        assumptionIfUnanswered: planted.exampleAssumption,
        relatedSegmentIds: [locate(segments, planted.segmentText, fixture.name)],
        relatedPlanIssueIds: ["I1"],
      },
    });
  }
  let mappedIndex = 0;
  for (const segment of segments) {
    if (requirementIds.has(segment.segmentId)) {
      const requirement = fixture.manifest.requirementSegments.find(
        (r) => locate(segments, r.segmentText, fixture.name) === segment.segmentId,
      );
      mappedIndex += 1;
      h.service.ingest(h.sessionId, {
        kind: "checklist-row",
        row: {
          segmentId: segment.segmentId,
          disposition: "mapped",
          proposedStatement: requirement?.statement ?? segment.text,
          proposedArea: fixture.manifest.area,
          mappedPlanIssueIds: [mappedIndex % 2 === 1 ? "I1" : "I2"],
        },
      });
    } else {
      h.service.ingest(h.sessionId, {
        kind: "checklist-row",
        row: {
          segmentId: segment.segmentId,
          disposition: "unmapped",
          reason: segment.text.startsWith("#") ? "non-requirement" : "context",
        },
      });
    }
  }
  h.service.ingest(h.sessionId, { kind: "construction-complete" });
  h.service.attachReview(h.sessionId, {
    reviewClass: "full-falsification",
    reviewer: "stub-reviewer",
    verdict: "approve-with-findings",
  });
}

for (const fixture of FIXTURES) {
  describe(`fixture ${fixture.name}`, () => {
    it("has at least three planted ambiguities and locates each in exactly one segment", () => {
      expect(fixture.manifest.plantedAmbiguities.length).toBeGreaterThanOrEqual(3);
      const segments = segmentPrd(fixture.prd);
      const coverage = plantedAmbiguityCoverage(fixture.manifest.plantedAmbiguities, segments, []);
      expect(coverage.unlocatable).toEqual([]);
      for (const requirement of fixture.manifest.requirementSegments) {
        locate(segments, requirement.segmentText, fixture.name); // throws on drift
      }
    });

    it("conforming plan: every planted ambiguity surfaces as a clarifying item", () => {
      const h = newHarness(fixture);
      streamPlan(h, fixture, new Set());
      const view = h.service.planView(h.sessionId);
      const coverage = plantedAmbiguityCoverage(
        fixture.manifest.plantedAmbiguities,
        view.segments,
        view.clarifications,
      );
      expect(coverage.uncovered).toEqual([]);
      expect(coverage.unlocatable).toEqual([]);
      expect(coverage.covered).toHaveLength(fixture.manifest.plantedAmbiguities.length);
    });

    it("PASSIVE DISPLAY FAILS: approval refuses until every item is actively acknowledged", () => {
      const h = newHarness(fixture);
      streamPlan(h, fixture, new Set());
      const view = h.service.planView(h.sessionId);
      // Rendering the approval screen is not acknowledgment.
      const refused = h.service.approvePlan(h.sessionId);
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      const unacknowledged = refused.refusals.find(
        (r) => r.kind === "unacknowledged-clarifications",
      );
      expect(unacknowledged).toBeDefined();
      if (unacknowledged?.kind === "unacknowledged-clarifications") {
        expect(unacknowledged.clarificationIds).toHaveLength(
          fixture.manifest.plantedAmbiguities.length,
        );
      }
      expect(h.service.contractsForMission(h.mission.id)).toEqual([]);

      // Acknowledge all but one — still refused, the remainder named.
      const ids = view.clarifications.map((c) => c.clarificationId);
      for (const id of ids.slice(0, -1)) {
        h.service.acknowledgeClarification(h.sessionId, id, { kind: "assumption-confirmed" });
      }
      const stillRefused = h.service.approvePlan(h.sessionId);
      expect(stillRefused.ok).toBe(false);
      if (!stillRefused.ok) {
        expect(stillRefused.refusals).toContainEqual({
          kind: "unacknowledged-clarifications",
          clarificationIds: [ids.at(-1)],
        });
      }
    });

    it("approval completes after answer-or-confirm on every item, freezing contracts", () => {
      const h = newHarness(fixture);
      streamPlan(h, fixture, new Set());
      const view = h.service.planView(h.sessionId);
      // Mix the two active forms: answer the first, confirm the rest.
      view.clarifications.forEach((c: ClarifyingItemDraft, i: number) => {
        h.service.acknowledgeClarification(
          h.sessionId,
          c.clarificationId,
          i === 0
            ? { kind: "answered", answer: "Resolved: use the stated default." }
            : { kind: "assumption-confirmed" },
        );
      });
      const mapped = view.checklist
        .filter((row) => row.disposition === "mapped")
        .map((row) => row.segmentId);
      h.service.confirmMappedRows(h.sessionId, mapped);
      h.service.acknowledgeFlaggedRows(h.sessionId, view.flaggedSegmentIds);
      const outcome = h.service.approvePlan(h.sessionId);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.contracts.length).toBeGreaterThanOrEqual(2);
      for (const contract of outcome.contracts) {
        expect(contract.contractHash).toMatch(/^[0-9a-f]{64}$/);
      }
      // Confirmations created accepted ledger entries (CAM-PLAN-02).
      const ledgerView = h.ledger.currentView();
      expect(ledgerView.size).toBe(mapped.length);
      for (const entry of ledgerView.values()) {
        expect(entry.disposition).toBe("accepted");
      }
      expect(h.recorder.currentState("mission", h.mission.id)).toBe("approved");
    });

    for (const planted of fixture.manifest.plantedAmbiguities) {
      it(`SILENT GUESS FAILS: omitting the ${planted.id} clarification is caught by coverage`, () => {
        const h = newHarness(fixture);
        streamPlan(h, fixture, new Set([planted.id]));
        const view = h.service.planView(h.sessionId);
        const coverage = plantedAmbiguityCoverage(
          fixture.manifest.plantedAmbiguities,
          view.segments,
          view.clarifications,
        );
        expect(coverage.uncovered.map((u) => u.plantedId)).toEqual([planted.id]);
        // Boundary, demonstrated honestly: the runtime gate alone cannot see
        // a question that was never asked — after acknowledging everything
        // the silent-guess plan WOULD approve. That is exactly what this
        // fixture set exists to catch, and why it is the CAM-PLAN-01 accept
        // mechanism for planner calibration.
        for (const c of view.clarifications) {
          h.service.acknowledgeClarification(h.sessionId, c.clarificationId, {
            kind: "assumption-confirmed",
          });
        }
        const mapped = view.checklist
          .filter((row) => row.disposition === "mapped")
          .map((row) => row.segmentId);
        h.service.confirmMappedRows(h.sessionId, mapped);
        h.service.acknowledgeFlaggedRows(h.sessionId, view.flaggedSegmentIds);
        expect(h.service.approvePlan(h.sessionId).ok).toBe(true);
      });
    }

    it("unmapped PRD sentences are visibly flagged with reasons (CAM-PLAN-02)", () => {
      const h = newHarness(fixture);
      streamPlan(h, fixture, new Set());
      const view = h.service.planView(h.sessionId);
      expect(view.flaggedSegmentIds.length).toBeGreaterThanOrEqual(2);
      for (const segmentId of view.flaggedSegmentIds) {
        const row = view.checklist.find((r) => r.segmentId === segmentId);
        expect(row).toMatchObject({ disposition: "unmapped", flagged: true });
        expect(row && "reason" in row && row.reason.length > 0).toBe(true);
      }
    });
  });
}
