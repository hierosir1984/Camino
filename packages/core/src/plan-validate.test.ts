import { describe, expect, it } from "vitest";
import { MISSION_TEMPLATES } from "@camino/shared";
import type { ChecklistRowDraft, ClarifyingItemDraft, PlannedIssueDraft } from "@camino/shared";
import {
  checklistProblems,
  clarificationReferenceProblems,
  decidePlanApproval,
  dependencyGraphProblems,
  findDependencyCycle,
  formatCycle,
  plantedAmbiguityCoverage,
  segmentPrd,
  templateProblems,
} from "./plan-validate.js";
import type { PlanGateInput, PrdSegment } from "./plan-validate.js";

// ---------------------------------------------------------------------------
// segmentPrd
// ---------------------------------------------------------------------------

describe("segmentPrd", () => {
  it("assigns S1..Sn in document order", () => {
    const segments = segmentPrd("First sentence. Second sentence.\n\nThird paragraph.");
    expect(segments.map((s) => s.segmentId)).toEqual(["S1", "S2", "S3"]);
    expect(segments.map((s) => s.text)).toEqual([
      "First sentence.",
      "Second sentence.",
      "Third paragraph.",
    ]);
  });

  it("is deterministic: identical input yields identical segments", () => {
    const text = "# Title\n\nBody one. Body two!\n\n- item A\n- item B\n";
    expect(segmentPrd(text)).toEqual(segmentPrd(text));
  });

  it("keeps headings, list items, and table rows as their own segments", () => {
    const segments = segmentPrd(
      "# Exports\nUsers need exports. Deadlines are tight.\n- CSV format\n- Excel later\n| col | val |\n",
    );
    expect(segments.map((s) => s.text)).toEqual([
      "# Exports",
      "Users need exports.",
      "Deadlines are tight.",
      "- CSV format",
      "- Excel later",
      "| col | val |",
    ]);
  });

  it("never sentence-splits a fenced code block", () => {
    const text = "Intro line.\n\n```\nfirst. second. third.\nmore! lines?\n```\n\nOutro.";
    const segments = segmentPrd(text);
    expect(segments).toHaveLength(3);
    expect((segments[1] as PrdSegment).text).toContain("first. second. third.");
  });

  it("never splits inside a decimal (no whitespace follows the point)", () => {
    const segments = segmentPrd("The budget is 3.5 days for the first pass.");
    expect(segments).toHaveLength(1);
  });

  it("splits before a lowercase sentence start — under-splitting is the dangerous direction (r1 finding 6)", () => {
    // The reviewer's counterexample: requiring an uppercase next token let
    // the second requirement hide inside the first one's segment.
    const segments = segmentPrd("Data must be encrypted. iOS users can delete their accounts.");
    expect(segments.map((s) => s.text)).toEqual([
      "Data must be encrypted.",
      "iOS users can delete their accounts.",
    ]);
  });

  it("over-splits abbreviations rather than under-splitting sentences (stated direction)", () => {
    const segments = segmentPrd("Limits apply, e.g. the size bound. Retries are capped.");
    // "e.g." splits — a finer checklist row, never a buried requirement.
    expect(segments.map((s) => s.text)).toEqual([
      "Limits apply, e.g.",
      "the size bound.",
      "Retries are capped.",
    ]);
  });

  it("splits multi-line paragraphs joined by single newlines as one flow", () => {
    const segments = segmentPrd("One sentence spanning\ntwo lines. Another one.");
    expect(segments.map((s) => s.text)).toEqual([
      "One sentence spanning two lines.",
      "Another one.",
    ]);
  });

  it("loses no non-blank text (totality)", () => {
    const text = "# H\nAlpha beta. Gamma!\n\n- one\n- two\n\n```\ncode here\n```\nTail";
    const joined = segmentPrd(text)
      .map((s) => s.text)
      .join(" ");
    for (const word of ["H", "Alpha", "beta", "Gamma", "one", "two", "code", "here", "Tail"]) {
      expect(joined).toContain(word);
    }
  });

  it("returns no segments for blank input", () => {
    expect(segmentPrd("")).toEqual([]);
    expect(segmentPrd("\n\n  \n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// dependency graph
// ---------------------------------------------------------------------------

function issue(id: string, dependsOn: string[] = []): PlannedIssueDraft {
  return {
    planIssueId: id,
    title: `Issue ${id}`,
    goal: `Goal of ${id}.`,
    acceptanceCriteria: [`${id} demonstrably works.`],
    dependsOn,
    interfaces: [],
  };
}

describe("dependency graph (CAM-PLAN-11)", () => {
  it("accepts an acyclic graph", () => {
    const issues = [issue("I1"), issue("I2", ["I1"]), issue("I3", ["I1", "I2"])];
    expect(dependencyGraphProblems(issues)).toEqual([]);
    expect(findDependencyCycle(issues)).toBeNull();
  });

  it("names duplicate ids and unknown references", () => {
    const problems = dependencyGraphProblems([issue("I1"), issue("I1"), issue("I2", ["I9"])]);
    expect(problems).toContain("duplicate issue id I1");
    expect(problems).toContain("issue I2 depends on unknown issue I9");
  });

  it("finds and NAMES a two-node cycle as a closed path", () => {
    const cycle = findDependencyCycle([issue("I1", ["I2"]), issue("I2", ["I1"])]);
    expect(cycle).toEqual(["I1", "I2", "I1"]);
    expect(formatCycle(cycle as string[])).toBe("I1 -> I2 -> I1");
  });

  it("finds a longer cycle reachable only through a chain", () => {
    const cycle = findDependencyCycle([
      issue("I1", ["I2"]),
      issue("I2", ["I3"]),
      issue("I3", ["I4"]),
      issue("I4", ["I2"]),
    ]);
    expect(cycle).toEqual(["I2", "I3", "I4", "I2"]);
  });

  it("reports a self-dependency as a one-node cycle", () => {
    expect(findDependencyCycle([issue("I1", ["I1"])])).toEqual(["I1", "I1"]);
  });

  it("is deterministic regardless of issue order", () => {
    const a = findDependencyCycle([issue("I2", ["I1"]), issue("I1", ["I2"]), issue("I3")]);
    const b = findDependencyCycle([issue("I3"), issue("I1", ["I2"]), issue("I2", ["I1"])]);
    expect(a).toEqual(b);
  });

  it("names a cycle through thousands of issues without exhausting the stack (r1 finding 9)", () => {
    // A 6000-issue chain closed into one loop: the recursive walk this
    // replaced crashed with RangeError instead of refusing with the cycle.
    const n = 6000;
    const big = Array.from({ length: n }, (_, i) =>
      issue(`I${i + 1}`, [i + 1 < n ? `I${i + 2}` : "I1"]),
    );
    const cycle = findDependencyCycle(big);
    expect(cycle).not.toBeNull();
    expect(cycle).toHaveLength(n + 1);
    expect(cycle?.[0]).toBe(cycle?.at(-1));
    // And an equally deep ACYCLIC chain resolves to null, also iteratively.
    const chain = Array.from({ length: n }, (_, i) =>
      issue(`I${i + 1}`, i + 1 < n ? [`I${i + 2}`] : []),
    );
    expect(findDependencyCycle(chain)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checklist + clarification references + template constraints
// ---------------------------------------------------------------------------

const SEGMENTS: PrdSegment[] = [
  { segmentId: "S1", text: "Users can export CSV." },
  { segmentId: "S2", text: "Motivation: customers asked." },
];

function mappedRow(segmentId: string, issues: string[] = ["I1"]): ChecklistRowDraft {
  return {
    segmentId,
    disposition: "mapped",
    proposedStatement: "The system exports CSV.",
    proposedArea: "APP",
    mappedPlanIssueIds: issues,
  };
}

const UNMAPPED_S2: ChecklistRowDraft = {
  segmentId: "S2",
  disposition: "unmapped",
  reason: "context",
};

describe("checklistProblems (CAM-PLAN-02 totality)", () => {
  it("accepts a total checklist", () => {
    expect(checklistProblems(SEGMENTS, [mappedRow("S1"), UNMAPPED_S2], [issue("I1")])).toEqual([]);
  });

  it("names a segment with no row (a silently dropped PRD sentence)", () => {
    const problems = checklistProblems(SEGMENTS, [mappedRow("S1")], [issue("I1")]);
    expect(problems).toContain("segment S2 has no checklist row");
  });

  it("names duplicate rows, unknown segments, and unknown issues", () => {
    const problems = checklistProblems(
      SEGMENTS,
      [mappedRow("S1"), mappedRow("S1", ["I9"]), mappedRow("S7")],
      [issue("I1")],
    );
    expect(problems).toContain("segment S1 appears in more than one checklist row");
    expect(problems).toContain("checklist row for unknown segment S7");
    expect(problems).toContain("segment S1 maps to unknown issue I9");
  });
});

describe("clarificationReferenceProblems", () => {
  it("names unknown segment/issue references and duplicate ids", () => {
    const item: ClarifyingItemDraft = {
      clarificationId: "Q1",
      question: "Which encoding?",
      whyItMatters: "Excel compatibility.",
      assumptionIfUnanswered: "UTF-8.",
      relatedSegmentIds: ["S9"],
      relatedPlanIssueIds: ["I9"],
    };
    const problems = clarificationReferenceProblems([item, item], SEGMENTS, [issue("I1")]);
    expect(problems).toContain("duplicate clarification id Q1");
    expect(problems).toContain("clarification Q1 references unknown segment S9");
    expect(problems).toContain("clarification Q1 references unknown issue I9");
  });
});

describe("templateProblems (CAM-PLAN-07)", () => {
  it("quick-task allows exactly one issue", () => {
    const quickTask = MISSION_TEMPLATES["quick-task"];
    expect(templateProblems(quickTask, [issue("I1")])).toEqual([]);
    expect(templateProblems(quickTask, [issue("I1"), issue("I2")])).toEqual([
      "a quick-task plan allows at most 1 issue(s), got 2",
    ]);
    expect(templateProblems(quickTask, [])).toEqual([
      "a quick-task plan must construct at least one issue",
    ]);
  });

  it("feature allows many issues but not zero", () => {
    const feature = MISSION_TEMPLATES.feature;
    expect(templateProblems(feature, [issue("I1"), issue("I2"), issue("I3")])).toEqual([]);
    expect(templateProblems(feature, [])).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the approval gate (CAM-PLAN-01)
// ---------------------------------------------------------------------------

const Q1: ClarifyingItemDraft = {
  clarificationId: "Q1",
  question: "Which encoding should the CSV use?",
  whyItMatters: "Excel on Windows misreads plain UTF-8.",
  assumptionIfUnanswered: "UTF-8 with BOM.",
  relatedSegmentIds: ["S1"],
  relatedPlanIssueIds: ["I1"],
};

function gateInput(overrides: Partial<PlanGateInput> = {}): PlanGateInput {
  return {
    template: MISSION_TEMPLATES.feature,
    segments: SEGMENTS,
    issues: [issue("I1")],
    clarifications: [Q1],
    checklist: [mappedRow("S1"), UNMAPPED_S2],
    constructionComplete: true,
    reviewAttached: true,
    acknowledgedClarificationIds: new Set(["Q1"]),
    confirmedMappedSegmentIds: new Set(["S1"]),
    flaggedRowsAcknowledged: new Set(["S2"]),
    ...overrides,
  };
}

describe("decidePlanApproval (CAM-PLAN-01/-02/-11)", () => {
  it("approves a complete, fully acknowledged plan with truthful attested facts", () => {
    const decision = decidePlanApproval(gateInput());
    expect(decision).toEqual({ ok: true, attested: { checklistApproved: true, dagAcyclic: true } });
  });

  it("PASSIVE DISPLAY FAILS: an unacknowledged clarification blocks approval by name", () => {
    const decision = decidePlanApproval(gateInput({ acknowledgedClarificationIds: new Set() }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusals).toContainEqual({
        kind: "unacknowledged-clarifications",
        clarificationIds: ["Q1"],
      });
    }
  });

  it("partial acknowledgment still refuses, naming only the missing items", () => {
    const q2: ClarifyingItemDraft = { ...Q1, clarificationId: "Q2" };
    const decision = decidePlanApproval(
      gateInput({
        clarifications: [Q1, q2],
        acknowledgedClarificationIds: new Set(["Q1"]),
      }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusals).toContainEqual({
        kind: "unacknowledged-clarifications",
        clarificationIds: ["Q2"],
      });
    }
  });

  it("a dependency cycle refuses approval with the cycle NAMED", () => {
    const decision = decidePlanApproval(
      gateInput({
        issues: [issue("I1", ["I2"]), issue("I2", ["I1"])],
        checklist: [mappedRow("S1", ["I1"]), UNMAPPED_S2],
      }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      const cycle = decision.refusals.find((r) => r.kind === "dependency-cycle");
      expect(cycle).toEqual({
        kind: "dependency-cycle",
        cycle: ["I1", "I2", "I1"],
        named: "I1 -> I2 -> I1",
      });
    }
  });

  it("unconfirmed mapped rows and unacknowledged flagged rows both refuse", () => {
    const decision = decidePlanApproval(
      gateInput({ confirmedMappedSegmentIds: new Set(), flaggedRowsAcknowledged: null }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusals).toContainEqual({
        kind: "unconfirmed-mapped-rows",
        segmentIds: ["S1"],
      });
      expect(decision.refusals).toContainEqual({
        kind: "flagged-rows-unacknowledged",
        segmentIds: ["S2"],
      });
    }
  });

  it("a STALE flagged-rows acknowledgment does not carry over", () => {
    // David acknowledged flags when only S2 was flagged; S1 later became
    // unmapped too — the acknowledgment must not cover the new flag.
    const decision = decidePlanApproval(
      gateInput({
        checklist: [
          { segmentId: "S1", disposition: "unmapped", reason: "out-of-scope" },
          UNMAPPED_S2,
        ],
        confirmedMappedSegmentIds: new Set(),
        flaggedRowsAcknowledged: new Set(["S2"]),
      }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusals).toContainEqual({
        kind: "flagged-rows-unacknowledged",
        segmentIds: ["S1", "S2"],
      });
    }
  });

  it("incomplete construction and missing review each refuse", () => {
    const noConstruction = decidePlanApproval(gateInput({ constructionComplete: false }));
    expect(noConstruction.ok).toBe(false);
    if (!noConstruction.ok) {
      expect(noConstruction.refusals).toContainEqual({ kind: "construction-incomplete" });
    }
    const noReview = decidePlanApproval(gateInput({ reviewAttached: false }));
    expect(noReview.ok).toBe(false);
    if (!noReview.ok) {
      expect(noReview.refusals).toContainEqual({ kind: "review-missing" });
    }
  });

  it("collects ALL refusals in one decision (the approval screen shows everything)", () => {
    const decision = decidePlanApproval(
      gateInput({
        constructionComplete: false,
        reviewAttached: false,
        acknowledgedClarificationIds: new Set(),
        confirmedMappedSegmentIds: new Set(),
        flaggedRowsAcknowledged: null,
      }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusals.map((r) => r.kind).sort()).toEqual([
        "construction-incomplete",
        "flagged-rows-unacknowledged",
        "review-missing",
        "unacknowledged-clarifications",
        "unconfirmed-mapped-rows",
      ]);
    }
  });

  it("a checklist that is not total refuses (CAM-PLAN-02)", () => {
    const decision = decidePlanApproval(gateInput({ checklist: [mappedRow("S1")] }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      const refusal = decision.refusals.find((r) => r.kind === "checklist-not-total");
      expect(refusal).toBeDefined();
      if (refusal?.kind === "checklist-not-total") {
        expect(refusal.problems).toContain("segment S2 has no checklist row");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// planted-ambiguity coverage (the fixture harness mechanism)
// ---------------------------------------------------------------------------

describe("plantedAmbiguityCoverage", () => {
  const segments: PrdSegment[] = [
    { segmentId: "S1", text: "Users can export their data." },
    { segmentId: "S2", text: "Exports should be fast." },
  ];
  const plantedFast = {
    id: "A1",
    segmentText: "Exports should be fast.",
    summary: "fast is unquantified",
    answerKeyTerms: ["fast", "latency", "seconds"],
  };
  const fastClarification: ClarifyingItemDraft = {
    clarificationId: "Q1",
    question: "How fast is fast — is there a latency target?",
    whyItMatters: "The PRD gives no number to validate against.",
    assumptionIfUnanswered: "Under 5 seconds for 10k records.",
    relatedSegmentIds: ["S2"],
    relatedPlanIssueIds: ["I1"],
  };

  it("covers an ambiguity when a clarification touches its segment AND names an answer-key term", () => {
    const coverage = plantedAmbiguityCoverage([plantedFast], segments, [fastClarification]);
    expect(coverage.covered).toEqual([
      { plantedId: "A1", segmentId: "S2", clarificationIds: ["Q1"] },
    ]);
    expect(coverage.uncovered).toEqual([]);
    expect(coverage.unlocatable).toEqual([]);
  });

  it("SILENT GUESS FAILS: an untouched planted ambiguity lands in uncovered", () => {
    const coverage = plantedAmbiguityCoverage([plantedFast], segments, [
      { ...fastClarification, relatedSegmentIds: ["S1"] }, // the plan asks about something else
    ]);
    expect(coverage.uncovered).toEqual([{ plantedId: "A1", segmentId: "S2" }]);
  });

  it("an IRRELEVANT question on the same segment does not count (r1 finding 2)", () => {
    // The reviewer's counterexample: a question that merely touches the
    // planted segment but asks about something unrelated must not cover.
    const coverage = plantedAmbiguityCoverage([plantedFast], segments, [
      {
        ...fastClarification,
        question: "What color should the export button be?",
        whyItMatters: "Design consistency.",
        assumptionIfUnanswered: "The primary theme color.",
      },
    ]);
    expect(coverage.covered).toEqual([]);
    expect(coverage.uncovered).toEqual([{ plantedId: "A1", segmentId: "S2" }]);
  });

  it("answer-key terms match case-insensitively in the question or the assumption", () => {
    const coverage = plantedAmbiguityCoverage([plantedFast], segments, [
      {
        ...fastClarification,
        question: "What is acceptable here?",
        whyItMatters: "Unbounded expectations.",
        assumptionIfUnanswered: "LATENCY under one second.",
      },
    ]);
    expect(coverage.covered).toHaveLength(1);
  });

  it("a term appearing ONLY in the rationale does not cover (r2 finding 6)", () => {
    const coverage = plantedAmbiguityCoverage([plantedFast], segments, [
      {
        ...fastClarification,
        question: "What color should the export button be?",
        whyItMatters: "Users mentioned fast exports in passing.",
        assumptionIfUnanswered: "The primary theme color.",
      },
    ]);
    expect(coverage.covered).toEqual([]);
    expect(coverage.uncovered).toEqual([{ plantedId: "A1", segmentId: "S2" }]);
  });

  it("blank answer-key terms are manifest drift, not universal matchers (r2 finding 6)", () => {
    const coverage = plantedAmbiguityCoverage(
      [{ ...plantedFast, answerKeyTerms: ["  ", ""] }],
      segments,
      [fastClarification],
    );
    expect(coverage.unlocatable).toEqual(["A1"]);
  });

  it("NFC-normalizes both sides so composed and decomposed forms match (r2 finding 6)", () => {
    const composed = "d\u00e9lai"; // NFC
    const decomposed = "de\u0301lai"; // NFD (e + combining acute)
    expect(composed).not.toBe(decomposed);
    const coverage = plantedAmbiguityCoverage(
      [{ ...plantedFast, answerKeyTerms: [composed] }],
      segments,
      [{ ...fastClarification, question: `Quel ${decomposed} est acceptable?` }],
    );
    expect(coverage.covered).toHaveLength(1);
  });

  it("manifest drift is loud: unmatched segmentText lands in unlocatable", () => {
    const coverage = plantedAmbiguityCoverage(
      [{ ...plantedFast, segmentText: "This sentence is not in the PRD." }],
      segments,
      [],
    );
    expect(coverage.unlocatable).toEqual(["A1"]);
  });

  it("an empty answer key is manifest drift, not a free pass", () => {
    const coverage = plantedAmbiguityCoverage([{ ...plantedFast, answerKeyTerms: [] }], segments, [
      fastClarification,
    ]);
    expect(coverage.unlocatable).toEqual(["A1"]);
    expect(coverage.covered).toEqual([]);
  });

  it("an ambiguous (duplicate) segmentText is unlocatable, not guessed", () => {
    const dupes: PrdSegment[] = [
      { segmentId: "S1", text: "Same text." },
      { segmentId: "S2", text: "Same text." },
    ];
    const coverage = plantedAmbiguityCoverage(
      [{ ...plantedFast, segmentText: "Same text." }],
      dupes,
      [],
    );
    expect(coverage.unlocatable).toEqual(["A1"]);
  });
});

describe("round-3 falsification regressions (core)", () => {
  it("R3-6: a term inside a longer word does not cover (token matching)", () => {
    const segs: PrdSegment[] = [{ segmentId: "S1", text: "The API port is configurable." }];
    const coverage = plantedAmbiguityCoverage(
      [
        {
          id: "A1",
          segmentText: "The API port is configurable.",
          summary: "default port unstated",
          answerKeyTerms: ["port"],
        },
      ],
      segs,
      [
        {
          clarificationId: "Q1",
          question: "What support hours apply?", // "support" contains "port"
          whyItMatters: "Unrelated.",
          assumptionIfUnanswered: "Business hours support.",
          relatedSegmentIds: ["S1"],
          relatedPlanIssueIds: [],
        },
      ],
    );
    expect(coverage.covered).toEqual([]);
    expect(coverage.uncovered).toEqual([{ plantedId: "A1", segmentId: "S1" }]);
  });

  it("R3-7: full-width closers ride their sentence and split", () => {
    const segments = segmentPrd("Data is encrypted。】 Users can delete accounts。");
    expect(segments.map((s) => s.text)).toEqual([
      "Data is encrypted。】",
      "Users can delete accounts。",
    ]);
  });

  it("R3-7: a ~~~ line does not close a ``` fence (delimiter families are distinct)", () => {
    const text =
      "```text\nData is encrypted. Users can delete accounts.\n~~~\nStill fenced.\n```\n\nOutside.";
    const segments = segmentPrd(text);
    expect(segments).toHaveLength(2);
    expect((segments[0] as PrdSegment).text).toContain("Still fenced.");
    expect((segments[1] as PrdSegment).text).toBe("Outside.");
  });
});

describe("round-4 falsification regressions (core)", () => {
  it("R4-4: a longer opener is not closed by a shorter run of the same family", () => {
    const text = "````\ncontent. more.\n```\nstill fenced.\n````\n\nOutside.";
    const segments = segmentPrd(text);
    expect(segments).toHaveLength(2);
    expect((segments[0] as PrdSegment).text).toContain("still fenced.");
    expect((segments[1] as PrdSegment).text).toBe("Outside.");
  });

  it("R4-4: an info-string fence line inside an open fence is content, not a closer", () => {
    const text = [
      "```text",
      "first. second.",
      "```js",
      "still fenced. also fenced.",
      "```",
      "",
      "Users rotate keys. Admins revoke keys.",
    ].join("\n");
    const segments = segmentPrd(text);
    // One fence block (the ```js line rode inside), then the two sentences.
    expect(segments).toHaveLength(3);
    expect((segments[0] as PrdSegment).text).toContain("still fenced. also fenced.");
    expect(segments.map((s) => s.text).slice(1)).toEqual([
      "Users rotate keys.",
      "Admins revoke keys.",
    ]);
  });

  it("R4-4: the CJK bracket closer rides its sentence", () => {
    const segments = segmentPrd("Data is encrypted。〕 Users can delete accounts。");
    expect(segments.map((s) => s.text)).toEqual([
      "Data is encrypted。〕",
      "Users can delete accounts。",
    ]);
  });

  it("R4-7: ordinary inflection matches — 'header' covers 'headers' (prefix >= 4 chars)", () => {
    const segs: PrdSegment[] = [{ segmentId: "S1", text: "Clients are told when limited." }];
    const coverage = plantedAmbiguityCoverage(
      [
        {
          id: "A1",
          segmentText: "Clients are told when limited.",
          summary: "signal unstated",
          answerKeyTerms: ["header"],
        },
      ],
      segs,
      [
        {
          clarificationId: "Q1",
          question: "Which response headers tell clients they are rate limited?",
          whyItMatters: "The PRD names no mechanism.",
          assumptionIfUnanswered: "Retry-After.",
          relatedSegmentIds: ["S1"],
          relatedPlanIssueIds: [],
        },
      ],
    );
    expect(coverage.covered).toHaveLength(1);
  });

  it("R4-7: short anchors stay exact — 'cap' does not match 'capable'", () => {
    const segs: PrdSegment[] = [{ segmentId: "S1", text: "Exports are bounded." }];
    const coverage = plantedAmbiguityCoverage(
      [
        {
          id: "A1",
          segmentText: "Exports are bounded.",
          summary: "bound unstated",
          answerKeyTerms: ["cap"],
        },
      ],
      segs,
      [
        {
          clarificationId: "Q1",
          question: "Is the exporter capable of resuming?",
          whyItMatters: "Unrelated.",
          assumptionIfUnanswered: "Yes.",
          relatedSegmentIds: ["S1"],
          relatedPlanIssueIds: [],
        },
      ],
    );
    expect(coverage.covered).toEqual([]);
  });
});
