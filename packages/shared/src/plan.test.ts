import { describe, expect, it } from "vitest";
import {
  MISSION_TEMPLATE_NAMES,
  MISSION_TEMPLATES,
  PLAN_MAX_TEXT_LENGTH,
  clarificationResponseProblems,
  isClarificationId,
  isPlanIssueId,
  isRequirementArea,
  isSegmentId,
  planConstructionRecordProblems,
} from "./plan.js";
import type { PlanConstructionRecord } from "./plan.js";

describe("MISSION_TEMPLATES (CAM-PLAN-07)", () => {
  it("both v1 templates exist: feature and quick-task", () => {
    expect(MISSION_TEMPLATE_NAMES).toEqual(["feature", "quick-task"]);
    expect(MISSION_TEMPLATES.feature).toBeDefined();
    expect(MISSION_TEMPLATES["quick-task"]).toBeDefined();
  });

  it("feature runs the integration route with unbounded issues and full review", () => {
    const t = MISSION_TEMPLATES.feature;
    expect(t.route).toBe("integration");
    expect(t.maxIssues).toBeNull();
    expect(t.reviewClass).toBe("full-falsification");
  });

  it("quick-task runs the quick-task route with exactly one issue and mini review", () => {
    const t = MISSION_TEMPLATES["quick-task"];
    expect(t.route).toBe("quick-task");
    expect(t.maxIssues).toBe(1);
    expect(t.reviewClass).toBe("mini-falsification");
  });

  it("is frozen at depth (template records are decision tables)", () => {
    expect(Object.isFrozen(MISSION_TEMPLATES)).toBe(true);
    expect(Object.isFrozen(MISSION_TEMPLATES.feature)).toBe(true);
    expect(() => {
      (MISSION_TEMPLATES.feature as { maxIssues: number | null }).maxIssues = 0;
    }).toThrow(TypeError);
    expect(() => {
      (MISSION_TEMPLATES["quick-task"] as { maxIssues: number | null }).maxIssues = 99;
    }).toThrow(TypeError);
  });
});

describe("id grammars", () => {
  it("accepts canonical ids and rejects near-misses", () => {
    expect(isPlanIssueId("I1")).toBe(true);
    expect(isPlanIssueId("I9999")).toBe(true);
    for (const bad of ["I0", "I01", "i1", "I", "I1x", "1", "I12345"]) {
      expect(isPlanIssueId(bad), bad).toBe(false);
    }
    expect(isClarificationId("Q1")).toBe(true);
    expect(isClarificationId("Q01")).toBe(false);
    expect(isSegmentId("S1")).toBe(true);
    expect(isSegmentId("S00001")).toBe(false);
    expect(isRequirementArea("APP")).toBe(true);
    expect(isRequirementArea("A")).toBe(false);
    expect(isRequirementArea("app")).toBe(false);
    expect(isRequirementArea("TOOLONGAREANAME")).toBe(false);
  });
});

function issueRecord(overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "issue",
    issue: {
      planIssueId: "I1",
      title: "Build the exporter",
      goal: "CSV export works end to end.",
      acceptanceCriteria: ["Clicking export downloads a CSV."],
      dependsOn: [],
      interfaces: [],
      ...overrides,
    },
  };
}

describe("planConstructionRecordProblems", () => {
  it("accepts each well-formed record kind", () => {
    expect(planConstructionRecordProblems(issueRecord())).toEqual([]);
    expect(
      planConstructionRecordProblems({
        kind: "clarification",
        clarification: {
          clarificationId: "Q1",
          question: "Which encoding should the CSV use?",
          whyItMatters: "Excel on Windows misreads UTF-8 without a BOM.",
          assumptionIfUnanswered: "UTF-8 with BOM.",
          relatedSegmentIds: ["S3"],
          relatedPlanIssueIds: ["I1"],
        },
      }),
    ).toEqual([]);
    expect(
      planConstructionRecordProblems({
        kind: "checklist-row",
        row: {
          segmentId: "S1",
          disposition: "mapped",
          proposedStatement: "The system exports records as CSV.",
          proposedArea: "APP",
          mappedPlanIssueIds: ["I1"],
        },
      }),
    ).toEqual([]);
    expect(
      planConstructionRecordProblems({
        kind: "checklist-row",
        row: { segmentId: "S2", disposition: "unmapped", reason: "context" },
      }),
    ).toEqual([]);
    expect(planConstructionRecordProblems({ kind: "construction-complete" })).toEqual([]);
  });

  it("names every problem instead of stopping at the first", () => {
    const problems = planConstructionRecordProblems(
      issueRecord({ planIssueId: "bad", title: "", acceptanceCriteria: [] }),
    );
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });

  it("refuses unknown fields (closed record shapes)", () => {
    const record = issueRecord() as { issue: Record<string, unknown> };
    record.issue["smuggled"] = true;
    expect(planConstructionRecordProblems(record).some((p) => p.includes("unknown field"))).toBe(
      true,
    );
    expect(planConstructionRecordProblems({ kind: "construction-complete", extra: 1 })).not.toEqual(
      [],
    );
  });

  it("refuses a self-dependent issue", () => {
    const problems = planConstructionRecordProblems(issueRecord({ dependsOn: ["I1"] }));
    expect(problems.some((p) => p.includes("depends on itself"))).toBe(true);
  });

  it("bounds text length and refuses embedded NUL (planner output is data)", () => {
    expect(
      planConstructionRecordProblems(issueRecord({ title: "x".repeat(PLAN_MAX_TEXT_LENGTH + 1) })),
    ).not.toEqual([]);
    expect(planConstructionRecordProblems(issueRecord({ goal: "a\u0000b" }))).not.toEqual([]);
  });

  it("refuses a mapped row with no implementing issues, a bad area, or a bad reason", () => {
    expect(
      planConstructionRecordProblems({
        kind: "checklist-row",
        row: {
          segmentId: "S1",
          disposition: "mapped",
          proposedStatement: "s",
          proposedArea: "APP",
          mappedPlanIssueIds: [],
        },
      }),
    ).not.toEqual([]);
    expect(
      planConstructionRecordProblems({
        kind: "checklist-row",
        row: {
          segmentId: "S1",
          disposition: "mapped",
          proposedStatement: "s",
          proposedArea: "bad-area",
          mappedPlanIssueIds: ["I1"],
        },
      }),
    ).not.toEqual([]);
    expect(
      planConstructionRecordProblems({
        kind: "checklist-row",
        row: { segmentId: "S1", disposition: "unmapped", reason: "because" },
      }),
    ).not.toEqual([]);
  });

  it("is total over junk", () => {
    for (const junk of [null, undefined, 3, "issue", [], { kind: "board" }]) {
      const problems = planConstructionRecordProblems(junk);
      expect(Array.isArray(problems)).toBe(true);
      expect(problems).not.toEqual([]);
    }
  });

  it("an empty result licenses the PlanConstructionRecord cast (type-level check)", () => {
    const value: unknown = issueRecord();
    if (planConstructionRecordProblems(value).length === 0) {
      const record = value as PlanConstructionRecord;
      expect(record.kind).toBe("issue");
    }
  });
});

describe("clarificationResponseProblems", () => {
  it("accepts the two active acknowledgment forms", () => {
    expect(clarificationResponseProblems({ kind: "answered", answer: "Use UTF-8." })).toEqual([]);
    expect(clarificationResponseProblems({ kind: "assumption-confirmed" })).toEqual([]);
  });

  it("refuses passive or malformed responses — there is no 'seen' variant", () => {
    expect(clarificationResponseProblems({ kind: "seen" })).not.toEqual([]);
    expect(clarificationResponseProblems({ kind: "answered", answer: "" })).not.toEqual([]);
    expect(clarificationResponseProblems({ kind: "answered" })).not.toEqual([]);
    expect(
      clarificationResponseProblems({ kind: "assumption-confirmed", note: "extra" }),
    ).not.toEqual([]);
    expect(clarificationResponseProblems(null)).not.toEqual([]);
  });
});
