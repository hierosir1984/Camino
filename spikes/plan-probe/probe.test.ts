// Every mechanic of the plan probe proven zero-quota against the mock CLI:
// segment parsing, plan/review validation (incl. the silent-coverage-gap
// rejection), cross-family enforcement, packet rendering + the
// acknowledge-before-approval gate, and the full pipeline end-to-end.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { adapterFamily, assertCrossFamily, parseSegments } from "./types.js";
import type { PlanDocument, ReviewDocument } from "./types.js";
import { extractJson, parsePlan, parseReview, validatePlan, validateReview } from "./validate.js";
import { plannerPrompt, reviewerPrompt } from "./prompts.js";
import { checkPacket, renderPacket } from "./packet.js";
import { mockProbeAdapter } from "./mock.js";
import { rerenderProbe, runProbe } from "./run.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixture", "evidence-viewer-v0.md");
const fixtureText = readFileSync(FIXTURE, "utf8");
const SEGS = parseSegments(fixtureText);

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function validPlan(): PlanDocument {
  return {
    missionTitle: "Evidence viewer v0",
    issues: [
      {
        id: "I1",
        title: "Loader",
        goal: "Load packets.",
        acceptanceCriteria: ["Rejects packets without per-item identity."],
        mappedSegments: [SEGS[0]!],
        dependsOn: [],
        riskTier: "medium",
      },
      {
        id: "I2",
        title: "Renderer",
        goal: "Render packets.",
        acceptanceCriteria: ["Advisory vs gating visually distinct (Playwright)."],
        mappedSegments: [SEGS[1]!],
        dependsOn: ["I1"],
        riskTier: "medium",
      },
    ],
    clarifyingQuestions: [
      {
        id: "Q1",
        question: "Packet source in v0?",
        whyItMatters: "Loader vs API client.",
        assumptionIfUnanswered: "JSON files under .camino/packets/.",
        blocking: true,
        relatedSegments: [SEGS[0]!],
        relatedIssues: ["I1"],
      },
      {
        id: "Q2",
        question: "Which artifacts render inline?",
        whyItMatters: "Renderer scope.",
        assumptionIfUnanswered: "Logs + screenshots inline.",
        blocking: false,
        relatedSegments: [],
        relatedIssues: [],
      },
      {
        id: "Q3",
        question: "Is a fixture packet acceptable for v0 development?",
        whyItMatters: "No real packets exist yet.",
        assumptionIfUnanswered: "Yes, a seeded fixture packet.",
        blocking: false,
        relatedSegments: [],
        relatedIssues: [],
      },
    ],
    checklist: SEGS.map((segment, i) => ({
      segment,
      isRequirement: i % 2 === 0,
      proposedLedgerEntry:
        i % 2 === 0 ? { id: `LED-${i + 1}`, statement: `Deliver ${segment}.` } : null,
      mappedIssues: i % 2 === 0 ? [i % 4 === 0 ? "I1" : "I2"] : [],
      ...(i % 2 === 0 ? {} : { note: "context only" }),
    })),
  };
}

function validReview(): ReviewDocument {
  return {
    verdict: "approve-with-findings",
    summary: "One real gap.",
    findings: [
      {
        id: "F1",
        severity: "major",
        class: "unstated-assumption",
        claim: "Storage assumed.",
        evidence: "I1 vs no question.",
        suggestedFix: "Ask about retention.",
      },
    ],
  };
}

describe("fixture + segment parsing", () => {
  it("parses the fixture's segment tags in order", () => {
    expect(SEGS.length).toBeGreaterThanOrEqual(10);
    expect(SEGS[0]).toBe("S1");
    expect(new Set(SEGS).size).toBe(SEGS.length);
  });

  it("does not mistake bracketed schema text for segments", () => {
    // The fixture quotes `commands[{cmd, …}]` etc. inside S11 — only
    // line-start [S<n>] tags may register.
    expect(SEGS.every((s) => /^S\d+$/.test(s))).toBe(true);
  });
});

describe("plan validation", () => {
  it("accepts a structurally valid plan", () => {
    expect(validatePlan(validPlan(), SEGS)).toEqual([]);
  });

  it("rejects a checklist that silently drops a segment (CAM-PLAN-02)", () => {
    const plan = validPlan();
    plan.checklist = plan.checklist.filter((r) => r.segment !== SEGS[SEGS.length - 1]);
    const errors = validatePlan(plan, SEGS);
    expect(errors.join("\n")).toContain(`${SEGS[SEGS.length - 1]} has no row`);
  });

  it("rejects duplicated segment rows and unknown segments", () => {
    const plan = validPlan();
    plan.checklist.push(plan.checklist[0]!);
    plan.issues[0]!.mappedSegments = ["S999"];
    const errors = validatePlan(plan, SEGS).join("\n");
    expect(errors).toContain("appears 2 times");
    expect(errors).toContain('unknown segment "S999"');
  });

  it("requires a ledger entry on requirement rows and null on non-requirement rows", () => {
    const plan = validPlan();
    const req = plan.checklist.find((r) => r.isRequirement)!;
    req.proposedLedgerEntry = null;
    const nonReq = plan.checklist.find((r) => !r.isRequirement)!;
    nonReq.proposedLedgerEntry = { id: "LED-X", statement: "should not be here" };
    const errors = validatePlan(plan, SEGS).join("\n");
    expect(errors).toContain("needs a proposedLedgerEntry");
    expect(errors).toContain("must have proposedLedgerEntry null");
  });

  it("rejects an assumption-free question (CAM-PLAN-01 confirm-or-answer)", () => {
    const plan = validPlan();
    plan.clarifyingQuestions[0]!.assumptionIfUnanswered = "";
    expect(validatePlan(plan, SEGS).join("\n")).toContain("assumptionIfUnanswered");
  });

  it("rejects unknown issue refs and self-dependencies", () => {
    const plan = validPlan();
    plan.issues[1]!.dependsOn = ["I1", "I2", "I9"];
    const errors = validatePlan(plan, SEGS).join("\n");
    expect(errors).toContain('unknown issue "I9"');
    expect(errors).toContain("self-dependency");
  });

  it("parsePlan tolerates a fenced file but rejects broken JSON", () => {
    const fenced = "```json\n" + JSON.stringify(validPlan()) + "\n```";
    expect(parsePlan(fenced, SEGS).errors).toEqual([]);
    expect(parsePlan("{nope", SEGS).errors[0]).toContain("not valid JSON");
    expect(extractJson("```json\n{}\n```")).toBe("{}");
  });
});

describe("review validation", () => {
  it("accepts a valid review and rejects bad enums / contradictory approve", () => {
    expect(validateReview(validReview())).toEqual([]);
    const bad = { ...validReview(), verdict: "lgtm" };
    expect(validateReview(bad).join("\n")).toContain("verdict");
    const contradictory = { ...validReview(), verdict: "approve" };
    expect(validateReview(contradictory).join("\n")).toContain("contradicts");
    expect(parseReview(JSON.stringify(validReview())).review?.verdict).toBe(
      "approve-with-findings",
    );
  });
});

describe("cross-family enforcement (CAM-PLAN-03)", () => {
  it("maps real adapters to provider families", () => {
    expect(adapterFamily("claude-code")).toBe("anthropic");
    expect(adapterFamily("codex-cli")).toBe("openai");
    expect(adapterFamily("grok-build")).toBe("xai");
    expect(() => adapterFamily("mystery-cli")).toThrow(/unknown adapter family/);
  });

  it("rejects same-family pairings, accepts cross-family", () => {
    expect(() => assertCrossFamily("claude-code", "claude-code")).toThrow(/same provider family/);
    expect(() => assertCrossFamily("claude-code", "codex-cli")).not.toThrow();
    expect(() => assertCrossFamily("mock-planner:plan", "mock-reviewer:review")).not.toThrow();
  });

  it("runProbe refuses a same-family pairing before dispatching anything", async () => {
    await expect(
      runProbe(
        mockProbeAdapter("planner", "plan"),
        mockProbeAdapter("planner", "review"),
        FIXTURE,
        {
          outDir: tmp("probe-samefam-"),
        },
      ),
    ).rejects.toThrow(/CAM-PLAN-03/);
  });
});

describe("prompts carry the load-bearing instructions", () => {
  it("planner: schema, single-file, no-silent-assumptions, checklist totality", () => {
    const p = plannerPrompt();
    expect(p).toContain("./plan.json");
    expect(p).toContain("NO SILENT ASSUMPTIONS");
    expect(p).toContain("exactly one checklist row per [S*] segment");
    expect(p).toContain('"assumptionIfUnanswered"');
    expect(p).toContain("Do not write any file other than ./plan.json");
  });

  it("reviewer: falsification mandate, finding classes, single-file", () => {
    const r = reviewerPrompt();
    expect(r).toContain("FALSIFICATION");
    expect(r).toContain("dropped-requirement");
    expect(r).toContain("question-quality");
    expect(r).toContain("./review.json");
    expect(r).toContain("Do not modify PRD.md or plan.json");
  });
});

describe("rating packet", () => {
  const packetInput = () => ({
    plan: validPlan(),
    review: validReview(),
    plannerName: "claude-code",
    plannerFamily: "anthropic",
    reviewerName: "codex-cli",
    reviewerFamily: "openai",
    fixtureRel: "spikes/plan-probe/fixture/evidence-viewer-v0.md",
    generatedAt: "2026-07-17T00:00:00Z",
  });

  it("refuses to render without the cross-family review attached", () => {
    const input = packetInput();
    // A JS caller (or a bug) passing no review must be stopped at runtime too.
    expect(() => renderPacket({ ...input, review: undefined as never })).toThrow(/CAM-PLAN-03/);
  });

  it("renders every question with rating + acknowledgment markers and the review findings", () => {
    const md = renderPacket(packetInput());
    for (const q of ["Q1", "Q2", "Q3"]) {
      expect(md).toContain(`RATING-${q}: ____`);
      expect(md).toContain(`ACK-${q}: ____`);
    }
    expect(md).toContain("REVIEW-MINUTES: ____");
    expect(md).toContain("CHECKLIST-USABLE: ____");
    // Honesty framing from code-review r1: coverage lines are relative to the
    // planner's own classification, and ≥70% is only one conjunct of the exit.
    expect(md).toContain("planner's OWN isRequirement classification");
    expect(md).toContain("the full exit");
    expect(md).toContain("Cross-family adversarial review");
    expect(md).toContain("F1");
    expect(md).toContain("Flagged as non-requirement text");
  });

  it("an unfilled packet is NOT approvable (active acknowledgment — CAM-PLAN-01)", () => {
    const check = checkPacket(renderPacket(packetInput()), ["Q1", "Q2", "Q3"]);
    expect(check.approvable).toBe(false);
    expect(check.unrated).toEqual(["Q1", "Q2", "Q3"]);
    expect(check.unacked).toEqual(["Q1", "Q2", "Q3"]);
  });

  it("a filled packet computes the ≥70% bar from ratings", () => {
    let md = renderPacket(packetInput());
    md = md
      .replace("RATING-Q1: ____", "RATING-Q1: good")
      .replace("RATING-Q2: ____", "RATING-Q2: good")
      .replace("RATING-Q3: ____", "RATING-Q3: obviously-fine")
      .replace("ACK-Q1: ____", "ACK-Q1: packets come from the daemon API")
      .replace("ACK-Q2: ____", "ACK-Q2: confirm")
      .replace("ACK-Q3: ____", "ACK-Q3: confirm")
      .replace("REVIEW-MINUTES: ____", "REVIEW-MINUTES: 22")
      .replace("CHECKLIST-USABLE: ____", "CHECKLIST-USABLE: yes");
    const check = checkPacket(md, ["Q1", "Q2", "Q3"]);
    expect(check.approvable).toBe(true);
    expect(check.good).toBe(2);
    expect(check.obviouslyFine).toBe(1);
    expect(check.goodPct).toBeCloseTo(66.7, 1);
    expect(check.meetsGoodBar).toBe(false); // 2/3 < 70%
    expect(check.reviewMinutes).toBe(22);
    expect(check.withinBudget).toBe(true);

    const upgraded = checkPacket(md.replace("RATING-Q3: obviously-fine", "RATING-Q3: good"), [
      "Q1",
      "Q2",
      "Q3",
    ]);
    expect(upgraded.goodPct).toBe(100);
    expect(upgraded.meetsGoodBar).toBe(true);
  });

  it("flags deleted question blocks and invalid rating values", () => {
    let md = renderPacket(packetInput());
    md = md
      .replace(/### Q3[\s\S]*?ACK-Q3: ____\n/, "")
      .replace("RATING-Q1: ____", "RATING-Q1: fine I guess")
      .replace("ACK-Q1: ____", "ACK-Q1: confirm")
      .replace("RATING-Q2: ____", "RATING-Q2: good")
      .replace("ACK-Q2: ____", "ACK-Q2: confirm")
      .replace("REVIEW-MINUTES: ____", "REVIEW-MINUTES: 10")
      .replace("CHECKLIST-USABLE: ____", "CHECKLIST-USABLE: yes");
    const check = checkPacket(md, ["Q1", "Q2", "Q3"]);
    expect(check.missingQuestions).toEqual(["Q3"]);
    expect(check.invalidRatings).toEqual(["Q1"]);
    expect(check.approvable).toBe(false);
  });
});

describe("pipeline end-to-end (mock adapters, zero quota)", () => {
  it("valid planner + reviewer → validated artifacts + rating packet", async () => {
    const outDir = tmp("probe-e2e-");
    const evidence = await runProbe(
      mockProbeAdapter("planner", "plan"),
      mockProbeAdapter("reviewer", "review"),
      FIXTURE,
      { outDir, packetPath: join(outDir, "RATING-PACKET.md"), timeoutMs: 30_000 },
    );
    expect(evidence.mechanicsOk).toBe(true);
    expect(evidence.planner.outcome).toBe("succeeded");
    expect(evidence.planner.validationErrors).toEqual([]);
    expect(evidence.planner.streamedEvents).toBeGreaterThan(0);
    expect(evidence.reviewer?.validationErrors).toEqual([]);
    expect(evidence.crossFamily.plannerFamily).not.toBe(evidence.crossFamily.reviewerFamily);
    expect(evidence.review?.verdict).toBe("approve-with-findings");

    const plan = JSON.parse(readFileSync(join(outDir, "plan.json"), "utf8")) as PlanDocument;
    expect(plan.checklist.length).toBe(SEGS.length);
    const packet = readFileSync(join(outDir, "RATING-PACKET.md"), "utf8");
    expect(checkPacket(packet).approvable).toBe(false); // fresh packet: nothing rated yet
    const report = readFileSync(join(outDir, "REPORT.md"), "utf8");
    expect(report).toContain("Cross-family (CAM-PLAN-03)");
    expect(report).toContain("awaiting David's ratings");
  });

  it("a coverage-gap plan is rejected and the reviewer is never dispatched", async () => {
    const outDir = tmp("probe-gap-");
    const evidence = await runProbe(
      mockProbeAdapter("planner", "plan-coverage-gap"),
      mockProbeAdapter("reviewer", "review"),
      FIXTURE,
      { outDir, packetPath: join(outDir, "RATING-PACKET.md"), timeoutMs: 30_000 },
    );
    expect(evidence.mechanicsOk).toBe(false);
    expect(evidence.planner.validationErrors.join("\n")).toContain("has no row");
    expect(evidence.reviewer).toBeNull(); // no quota wasted reviewing an invalid plan
    expect(evidence.packet).toBeNull();
    const report = readFileSync(join(outDir, "REPORT.md"), "utf8");
    expect(report).toContain("NOT rendered");
  });

  it("a fenced plan file still validates (tolerant reader)", async () => {
    const outDir = tmp("probe-fenced-");
    const evidence = await runProbe(
      mockProbeAdapter("planner", "plan-fenced"),
      mockProbeAdapter("reviewer", "review"),
      FIXTURE,
      { outDir, packetPath: join(outDir, "RATING-PACKET.md"), timeoutMs: 30_000 },
    );
    expect(evidence.mechanicsOk).toBe(true);
    expect(evidence.planner.validationErrors).toEqual([]);
  });

  it("a missing deliverable is reported, not crashed on", async () => {
    const outDir = tmp("probe-missing-");
    const evidence = await runProbe(
      mockProbeAdapter("planner", "plan-missing"),
      mockProbeAdapter("reviewer", "review"),
      FIXTURE,
      { outDir, packetPath: join(outDir, "RATING-PACKET.md"), timeoutMs: 30_000 },
    );
    expect(evidence.mechanicsOk).toBe(false);
    expect(evidence.planner.validationErrors).toEqual(["worker did not write plan.json"]);
  });

  it("rerender regenerates from committed artifacts but refuses to clobber ratings", async () => {
    const outDir = tmp("probe-rerender-");
    const packetPath = join(outDir, "RATING-PACKET.md");
    await runProbe(
      mockProbeAdapter("planner", "plan"),
      mockProbeAdapter("reviewer", "review"),
      FIXTURE,
      { outDir, packetPath, timeoutMs: 30_000 },
    );
    // Unfilled packet → rerender is allowed and mechanics stay OK.
    const re = rerenderProbe({ outDir, fixturePath: FIXTURE, packetPath });
    expect(re.mechanicsOk).toBe(true);
    expect(re.review?.verdict).toBe("approve-with-findings");
    // Fill one rating → rerender must refuse without force.
    const filled = readFileSync(packetPath, "utf8").replace("RATING-Q1: ____", "RATING-Q1: good");
    writeFileSync(packetPath, filled);
    expect(() => rerenderProbe({ outDir, fixturePath: FIXTURE, packetPath })).toThrow(
      /refusing to overwrite/,
    );
    // force overrides deliberately.
    expect(
      rerenderProbe({ outDir, fixturePath: FIXTURE, packetPath, force: true }).mechanicsOk,
    ).toBe(true);
  });

  it("an invalid review blocks the packet (no review attached → no approval surface)", async () => {
    const outDir = tmp("probe-badreview-");
    const evidence = await runProbe(
      mockProbeAdapter("planner", "plan"),
      mockProbeAdapter("reviewer", "review-bad-verdict"),
      FIXTURE,
      { outDir, packetPath: join(outDir, "RATING-PACKET.md"), timeoutMs: 30_000 },
    );
    expect(evidence.mechanicsOk).toBe(false);
    expect(evidence.reviewer?.validationErrors.join("\n")).toContain("verdict");
    expect(evidence.packet).toBeNull();
  });
});
