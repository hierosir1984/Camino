// Phase-0 PRD-to-plan probe (WP-002) — prototype evidence toward CAM-PLAN-01/-02/-03.
//
// This is a SPIKE: it de-risks the intake mechanics (PRD text → issues +
// clarifying questions + requirement-checklist diff, with a cross-family
// falsification review attached) and produces the rating packet David scores.
// The durable planner lands in Phase 1 (WP-117/118); the schemas here are the
// prototype's, not the product's.

/** One planned issue compiled from the PRD (CAM-PLAN-01 prototype shape). */
export interface PlannedIssue {
  /** "I1", "I2", … unique within the plan. */
  id: string;
  title: string;
  /** What this issue delivers, in one or two sentences. */
  goal: string;
  /** Observable pass/fail checks — not restatements of the goal. */
  acceptanceCriteria: string[];
  /** Fixture segment tags ("S3") this issue draws its mandate from. */
  mappedSegments: string[];
  /** Issue ids that must land first. */
  dependsOn: string[];
  /** Registry item 18 semantics: high floor = auth/payments/migrations/secrets. */
  riskTier: "low" | "medium" | "high";
}

/**
 * A surfaced assumption (CAM-PLAN-01): wherever the PRD underdetermined a
 * decision the planner needed, it must ask — recording the assumption it will
 * proceed on if David answers "confirm" instead of answering the question.
 */
export interface ClarifyingQuestion {
  /** "Q1", "Q2", … unique within the plan. */
  id: string;
  question: string;
  whyItMatters: string;
  /** The precise assumption baked into the plan if unanswered. */
  assumptionIfUnanswered: string;
  /** Must this be resolved before the plan is approved (vs. before the affected issue starts)? */
  blocking: boolean;
  relatedSegments: string[];
  relatedIssues: string[];
}

/** Proposed intent-ledger entry for a requirement segment (CAM-PLAN-02). */
export interface ProposedLedgerEntry {
  /** "LED-1", … unique within the plan. */
  id: string;
  /** The requirement restated as a single testable intent statement. */
  statement: string;
}

/**
 * One row of the requirement checklist diff (CAM-PLAN-02): every fixture
 * segment appears exactly once, either mapped to a proposed ledger entry or
 * visibly flagged as non-requirement text.
 */
export interface ChecklistEntry {
  /** Segment tag, e.g. "S11". */
  segment: string;
  /** Is this segment a requirement of THIS mission (vs. context/motivation/adjacent)? */
  isRequirement: boolean;
  /** Required iff isRequirement; null flags the segment as non-requirement text. */
  proposedLedgerEntry: ProposedLedgerEntry | null;
  /** Issues that implement this segment (subset of plan issue ids). */
  mappedIssues: string[];
  /** Free-text rationale (why non-requirement, why deferred, …). */
  note?: string;
}

/** The planner's whole deliverable — written by the worker as ./plan.json. */
export interface PlanDocument {
  missionTitle: string;
  issues: PlannedIssue[];
  clarifyingQuestions: ClarifyingQuestion[];
  checklist: ChecklistEntry[];
}

export type FindingSeverity = "blocker" | "major" | "minor";
export type FindingClass =
  | "dropped-requirement"
  | "unstated-assumption"
  | "criteria-defect"
  | "mapping-defect"
  | "scope-creep"
  | "bad-premise"
  | "question-quality"
  | "other";

/** One falsification finding from the cross-family reviewer (CAM-PLAN-03). */
export interface ReviewFinding {
  /** "F1", … unique within the review. */
  id: string;
  severity: FindingSeverity;
  class: FindingClass;
  /** The specific defect claim. */
  claim: string;
  /** Segment/issue refs and reasoning that ground the claim. */
  evidence: string;
  suggestedFix: string;
}

/** The reviewer's whole deliverable — written by the worker as ./review.json. */
export interface ReviewDocument {
  verdict: "approve" | "approve-with-findings" | "reject";
  summary: string;
  findings: ReviewFinding[];
}

/**
 * Provider family per adapter (CAM-PLAN-03: the reviewer must be a DIFFERENT
 * provider than the planner). Mock adapters carry distinct pseudo-families so
 * tests exercise the same assertion path as real runs.
 */
export function adapterFamily(adapterName: string): string {
  if (adapterName.startsWith("mock-planner")) return "mock-family-a";
  if (adapterName.startsWith("mock-reviewer")) return "mock-family-b";
  switch (adapterName) {
    case "claude-code":
      return "anthropic";
    case "codex-cli":
      return "openai";
    case "grok-build":
      return "xai";
    default:
      throw new Error(`unknown adapter family for "${adapterName}"`);
  }
}

/** Throws unless planner and reviewer resolve to different provider families. */
export function assertCrossFamily(plannerName: string, reviewerName: string): void {
  const a = adapterFamily(plannerName);
  const b = adapterFamily(reviewerName);
  if (a === b) {
    throw new Error(
      `CAM-PLAN-03 violation: planner "${plannerName}" and reviewer "${reviewerName}" ` +
        `are the same provider family (${a}) — cross-family review requires different providers`,
    );
  }
}

/**
 * Extract the ordered segment tags ([S1]…[Sn]) from a fixture PRD. Only the
 * canonical form registers: line start, no indentation, no leading zeros —
 * so bracketed text inside quoted schema blobs never becomes a segment.
 *
 * Anything tag-SHAPED that is not canonical (indented, blockquoted, [S01],
 * or a duplicate) is REJECTED loudly instead of silently dropped: a dropped
 * tag would quietly shrink the checklist-totality requirement while the
 * planner still sees the text (review r1c finding 7).
 */
export function parseSegments(fixtureText: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const bad: string[] = [];
  const lines = fixtureText.split(/\r?\n/);
  lines.forEach((line, i) => {
    const canonical = line.match(/^\[S([1-9]\d*)\]/);
    if (canonical) {
      const tag = `S${canonical[1]}`;
      if (seen.has(tag)) bad.push(`line ${i + 1}: duplicate segment tag [${tag}]`);
      else {
        seen.add(tag);
        out.push(tag);
      }
      return;
    }
    if (/^\s*(?:>\s*)*\[S\d+\]/.test(line)) {
      bad.push(
        `line ${i + 1}: noncanonical segment tag (indented/quoted/leading-zero): ` +
          `"${line.trim().slice(0, 40)}"`,
      );
    }
  });
  if (bad.length > 0) {
    throw new Error(
      "fixture segment tags must be canonical line-start [S<n>] and unique:\n" +
        bad.map((b) => `  - ${b}`).join("\n"),
    );
  }
  return out;
}
