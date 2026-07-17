// Structural validation of worker-written JSON deliverables. Hand-rolled and
// total (never throws on hostile input): every defect is returned as a
// human-readable error string, so the run report can show the worker's output
// AND exactly why it was rejected.
import type {
  ChecklistEntry,
  ClarifyingQuestion,
  PlanDocument,
  PlannedIssue,
  ReviewDocument,
  ReviewFinding,
} from "./types.js";

/**
 * Tolerant reader for a worker-written JSON file: strips a single wrapping
 * markdown code fence if present (some CLIs wrap file writes in ```json …
 * ``` despite instructions). Anything else must be plain JSON.
 */
export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const lines = trimmed.split("\n");
  if (lines.length >= 2 && lines[lines.length - 1]!.trim().startsWith("```")) {
    return lines.slice(1, -1).join("\n").trim();
  }
  return trimmed;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Parse + validate a plan document against the fixture's segment set. */
export function parsePlan(
  raw: string,
  segments: string[],
): { plan: PlanDocument | null; errors: string[] } {
  let obj: unknown;
  try {
    obj = JSON.parse(extractJson(raw));
  } catch (err) {
    return { plan: null, errors: [`plan.json is not valid JSON: ${String(err)}`] };
  }
  const errors = validatePlan(obj, segments);
  return errors.length === 0 ? { plan: obj as PlanDocument, errors: [] } : { plan: null, errors };
}

export function validatePlan(obj: unknown, segments: string[]): string[] {
  const errors: string[] = [];
  if (!isRecord(obj)) return ["plan is not a JSON object"];

  if (!nonEmpty(obj["missionTitle"])) errors.push("missionTitle missing/empty");

  // --- issues ---
  const issues = obj["issues"];
  const issueIds = new Set<string>();
  if (!Array.isArray(issues) || issues.length === 0) {
    errors.push("issues must be a non-empty array");
  } else {
    if (issues.length > 12) errors.push(`issues: ${issues.length} exceeds the 12-issue cap`);
    issues.forEach((it: unknown, i: number) => {
      const where = `issues[${i}]`;
      if (!isRecord(it)) {
        errors.push(`${where} is not an object`);
        return;
      }
      const issue = it as Partial<PlannedIssue>;
      if (!nonEmpty(issue.id)) errors.push(`${where}.id missing`);
      else if (issueIds.has(issue.id)) errors.push(`${where}.id "${issue.id}" duplicated`);
      else issueIds.add(issue.id);
      if (!nonEmpty(issue.title)) errors.push(`${where}.title missing`);
      if (!nonEmpty(issue.goal)) errors.push(`${where}.goal missing`);
      if (!isStringArray(issue.acceptanceCriteria) || issue.acceptanceCriteria.length === 0) {
        errors.push(`${where}.acceptanceCriteria must be a non-empty string array`);
      }
      if (!isStringArray(issue.mappedSegments) || issue.mappedSegments.length === 0) {
        errors.push(`${where}.mappedSegments must be a non-empty string array`);
      } else {
        for (const s of issue.mappedSegments) {
          if (!segments.includes(s)) errors.push(`${where}.mappedSegments: unknown segment "${s}"`);
        }
      }
      if (!isStringArray(issue.dependsOn)) errors.push(`${where}.dependsOn must be a string array`);
      if (issue.riskTier !== "low" && issue.riskTier !== "medium" && issue.riskTier !== "high") {
        errors.push(`${where}.riskTier must be low|medium|high`);
      }
    });
    // dependsOn refs checked after all ids are known
    issues.forEach((it: unknown, i: number) => {
      if (!isRecord(it)) return;
      const issue = it as Partial<PlannedIssue>;
      if (!isStringArray(issue.dependsOn)) return;
      for (const dep of issue.dependsOn) {
        if (!issueIds.has(dep)) errors.push(`issues[${i}].dependsOn: unknown issue "${dep}"`);
        if (dep === issue.id) errors.push(`issues[${i}].dependsOn: self-dependency`);
      }
    });
  }

  // --- clarifying questions ---
  const questions = obj["clarifyingQuestions"];
  if (!Array.isArray(questions)) {
    errors.push("clarifyingQuestions must be an array");
  } else {
    const qIds = new Set<string>();
    questions.forEach((q: unknown, i: number) => {
      const where = `clarifyingQuestions[${i}]`;
      if (!isRecord(q)) {
        errors.push(`${where} is not an object`);
        return;
      }
      const cq = q as Partial<ClarifyingQuestion>;
      if (!nonEmpty(cq.id)) errors.push(`${where}.id missing`);
      else if (qIds.has(cq.id)) errors.push(`${where}.id "${cq.id}" duplicated`);
      else qIds.add(cq.id);
      if (!nonEmpty(cq.question)) errors.push(`${where}.question missing`);
      if (!nonEmpty(cq.whyItMatters)) errors.push(`${where}.whyItMatters missing`);
      if (!nonEmpty(cq.assumptionIfUnanswered)) {
        errors.push(
          `${where}.assumptionIfUnanswered missing — a question without its recorded` +
            ` assumption cannot be confirmed-instead-of-answered (CAM-PLAN-01)`,
        );
      }
      if (typeof cq.blocking !== "boolean") errors.push(`${where}.blocking must be boolean`);
      if (!isStringArray(cq.relatedSegments))
        errors.push(`${where}.relatedSegments must be a string array`);
      if (!isStringArray(cq.relatedIssues))
        errors.push(`${where}.relatedIssues must be a string array`);
      else
        for (const ref of cq.relatedIssues) {
          if (!issueIds.has(ref)) errors.push(`${where}.relatedIssues: unknown issue "${ref}"`);
        }
    });
  }

  // --- checklist: exactly one row per fixture segment (the diff is total) ---
  const checklist = obj["checklist"];
  if (!Array.isArray(checklist)) {
    errors.push("checklist must be an array");
  } else {
    const seen = new Map<string, number>();
    const ledgerIds = new Set<string>();
    checklist.forEach((row: unknown, i: number) => {
      const where = `checklist[${i}]`;
      if (!isRecord(row)) {
        errors.push(`${where} is not an object`);
        return;
      }
      const entry = row as Partial<ChecklistEntry>;
      if (!nonEmpty(entry.segment)) {
        errors.push(`${where}.segment missing`);
        return;
      }
      seen.set(entry.segment, (seen.get(entry.segment) ?? 0) + 1);
      if (!segments.includes(entry.segment)) {
        errors.push(`${where}.segment "${entry.segment}" not in the fixture`);
      }
      if (typeof entry.isRequirement !== "boolean") {
        errors.push(`${where}.isRequirement must be boolean`);
      }
      const led = entry.proposedLedgerEntry;
      if (entry.isRequirement === true) {
        if (!isRecord(led) || !nonEmpty(led["id"]) || !nonEmpty(led["statement"])) {
          errors.push(
            `${where}: requirement segment "${entry.segment}" needs a proposedLedgerEntry` +
              ` with id + statement (CAM-PLAN-02)`,
          );
        } else if (ledgerIds.has(String(led["id"]))) {
          errors.push(`${where}.proposedLedgerEntry.id "${String(led["id"])}" duplicated`);
        } else {
          ledgerIds.add(String(led["id"]));
        }
      } else if (entry.isRequirement === false && led !== null && led !== undefined) {
        errors.push(
          `${where}: non-requirement segment "${entry.segment}" must have proposedLedgerEntry null` +
            ` — flagging IS the signal (CAM-PLAN-02)`,
        );
      }
      if (!isStringArray(entry.mappedIssues)) {
        errors.push(`${where}.mappedIssues must be a string array`);
      } else {
        for (const ref of entry.mappedIssues) {
          if (!issueIds.has(ref)) errors.push(`${where}.mappedIssues: unknown issue "${ref}"`);
        }
      }
    });
    for (const s of segments) {
      const n = seen.get(s) ?? 0;
      if (n === 0)
        errors.push(`checklist: fixture segment ${s} has no row — silent gap (CAM-PLAN-02)`);
      if (n > 1) errors.push(`checklist: fixture segment ${s} appears ${n} times`);
    }
    for (const s of seen.keys()) {
      if (!segments.includes(s)) errors.push(`checklist: row for unknown segment "${s}"`);
    }
  }

  return errors;
}

/** Requirement rows no issue implements — rendered loudly in the packet. */
export function uncoveredRequirements(plan: PlanDocument): ChecklistEntry[] {
  return plan.checklist.filter((c) => c.isRequirement && c.mappedIssues.length === 0);
}

/** Non-requirement rows — the "unmapped text visibly flagged" half of CAM-PLAN-02. */
export function flaggedNonRequirements(plan: PlanDocument): ChecklistEntry[] {
  return plan.checklist.filter((c) => !c.isRequirement);
}

/** Parse + validate a review document. */
export function parseReview(raw: string): { review: ReviewDocument | null; errors: string[] } {
  let obj: unknown;
  try {
    obj = JSON.parse(extractJson(raw));
  } catch (err) {
    return { review: null, errors: [`review.json is not valid JSON: ${String(err)}`] };
  }
  const errors = validateReview(obj);
  return errors.length === 0
    ? { review: obj as ReviewDocument, errors: [] }
    : { review: null, errors };
}

const SEVERITIES = ["blocker", "major", "minor"];
const FINDING_CLASSES = [
  "dropped-requirement",
  "unstated-assumption",
  "criteria-defect",
  "mapping-defect",
  "scope-creep",
  "bad-premise",
  "question-quality",
  "other",
];

export function validateReview(obj: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(obj)) return ["review is not a JSON object"];
  const verdict = obj["verdict"];
  if (verdict !== "approve" && verdict !== "approve-with-findings" && verdict !== "reject") {
    errors.push("verdict must be approve|approve-with-findings|reject");
  }
  if (!nonEmpty(obj["summary"])) errors.push("summary missing/empty");
  const findings = obj["findings"];
  if (!Array.isArray(findings)) {
    errors.push("findings must be an array");
    return errors;
  }
  const ids = new Set<string>();
  findings.forEach((f: unknown, i: number) => {
    const where = `findings[${i}]`;
    if (!isRecord(f)) {
      errors.push(`${where} is not an object`);
      return;
    }
    const finding = f as Partial<ReviewFinding>;
    if (!nonEmpty(finding.id)) errors.push(`${where}.id missing`);
    else if (ids.has(finding.id)) errors.push(`${where}.id "${finding.id}" duplicated`);
    else ids.add(finding.id);
    if (!SEVERITIES.includes(String(finding.severity))) {
      errors.push(`${where}.severity must be blocker|major|minor`);
    }
    if (!FINDING_CLASSES.includes(String(finding.class))) {
      errors.push(`${where}.class "${String(finding.class)}" unknown`);
    }
    if (!nonEmpty(finding.claim)) errors.push(`${where}.claim missing`);
    if (!nonEmpty(finding.evidence)) errors.push(`${where}.evidence missing`);
    if (!nonEmpty(finding.suggestedFix)) errors.push(`${where}.suggestedFix missing`);
  });
  if (verdict === "approve" && findings.length > 0) {
    errors.push('verdict "approve" contradicts a non-empty findings list');
  }
  return errors;
}
