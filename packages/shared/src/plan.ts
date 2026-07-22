/**
 * Plan construction vocabulary and mission templates (WP-110,
 * CAM-PLAN-01/-02/-07/-11).
 *
 * The planner streams a plan to the control plane AS IT IS CONSTRUCTED —
 * one `PlanConstructionRecord` at a time — so the board shows issues the
 * moment they exist, not when the plan is finished (CAM-PLAN-01). The
 * records here are that stream's schema; the daemon's planning service
 * validates and persists each one, and the ambiguous-PRD fixture harness
 * replays scripted streams through the identical path.
 *
 * Planner output is creative-model output: it is DATA, never trusted
 * structure (CAM-EXEC-09 posture). Every record passes the total
 * validators below — closed field sets, bounded lengths, closed id
 * grammars — before anything downstream sees it.
 *
 * Id grammars are module-private RegExps behind predicates, with the
 * pattern SOURCE exported for messages and tests. Freezing a RegExp does
 * not close mutation (the legacy `RegExp.prototype.compile()` swaps the
 * pattern before its write throws on a frozen object), so live RegExps
 * never cross the barrel — the requirement-id module's precedent.
 */
import type { MissionRouteName } from "./domain.js";

/** Object.freeze at depth for the small policy tables this module exports. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Mission templates (CAM-PLAN-07)
// ---------------------------------------------------------------------------

export const MISSION_TEMPLATE_NAMES = Object.freeze(["feature", "quick-task"] as const);
export type MissionTemplateName = (typeof MISSION_TEMPLATE_NAMES)[number];

/**
 * The review depth a template's plans owe before approval (CAM-PLAN-03).
 * WP-111 implements the reviewer; the template records which class applies.
 */
export type PlanReviewClass = "full-falsification" | "mini-falsification";

export interface MissionTemplate {
  readonly name: MissionTemplateName;
  /** The Appendix A route missions from this template take. */
  readonly route: MissionRouteName;
  /** Structural bound on plan size; null = no bound. */
  readonly maxIssues: number | null;
  readonly reviewClass: PlanReviewClass;
  readonly description: string;
}

/**
 * Mission templates v1 (CAM-PLAN-07): `feature` and `quick-task`. The
 * refactor / migration / UI-rewrite / greenfield-bootstrap templates are
 * explicitly future scope in the PRD ([F]).
 */
export const MISSION_TEMPLATES: Readonly<Record<MissionTemplateName, MissionTemplate>> = deepFreeze(
  {
    feature: {
      name: "feature",
      route: "integration",
      maxIssues: null,
      reviewClass: "full-falsification",
      description:
        "A PRD-scoped mission on the integration route (A.1): the planner compiles the PRD " +
        "into dependency-ordered issues, each frozen into a hash-referenced contract at plan " +
        "approval; issue PRs target the mission integration branch.",
    },
    "quick-task": {
      name: "quick-task",
      route: "quick-task",
      maxIssues: 1,
      reviewClass: "mini-falsification",
      description:
        "A single bounded task on the quick-task route (A.1b): exactly one issue, a single " +
        "contract, a bounded cross-family mini-review; the mission PR targets main directly.",
    },
  },
);

// ---------------------------------------------------------------------------
// Id grammars (module-private RegExps; predicates + pattern sources exported)
// ---------------------------------------------------------------------------

const PLAN_ISSUE_ID_RE = /^I[1-9]\d{0,3}$/;
const CLARIFICATION_ID_RE = /^Q[1-9]\d{0,3}$/;
const SEGMENT_ID_RE = /^S[1-9]\d{0,4}$/;
const REQUIREMENT_AREA_RE = /^[A-Z]{2,12}$/;

export const PLAN_ISSUE_ID_PATTERN_SOURCE: string = PLAN_ISSUE_ID_RE.source;
export const CLARIFICATION_ID_PATTERN_SOURCE: string = CLARIFICATION_ID_RE.source;
export const SEGMENT_ID_PATTERN_SOURCE: string = SEGMENT_ID_RE.source;
export const REQUIREMENT_AREA_PATTERN_SOURCE: string = REQUIREMENT_AREA_RE.source;

/** "I1"…: the planner's within-plan issue id (durable ids are minted at freeze). */
export function isPlanIssueId(value: string): boolean {
  return PLAN_ISSUE_ID_RE.test(value);
}

/** "Q1"…: a clarifying item's within-plan id. */
export function isClarificationId(value: string): boolean {
  return CLARIFICATION_ID_RE.test(value);
}

/** "S1"…: a PRD segment id, assigned by core's deterministic segmentation. */
export function isSegmentId(value: string): boolean {
  return SEGMENT_ID_RE.test(value);
}

/** The AREA token of a proposed requirement id (CAM-AREA-NN; number minted at confirmation). */
export function isRequirementArea(value: string): boolean {
  return REQUIREMENT_AREA_RE.test(value);
}

// ---------------------------------------------------------------------------
// Declared interfaces (CAM-PLAN-11)
// ---------------------------------------------------------------------------

export const INTERFACE_KINDS = Object.freeze([
  "api",
  "cli",
  "module",
  "schema",
  "event",
  "file-format",
  "other",
] as const);
export type InterfaceKind = (typeof INTERFACE_KINDS)[number];

/**
 * An interface an issue exposes to its dependents. Declared at planning
 * time, frozen onto the contract record at approval, and rendered into
 * dependent issues' context packs (CAM-PLAN-11; WP-113 consumes).
 */
export interface DeclaredInterface {
  readonly name: string;
  readonly kind: InterfaceKind;
  readonly description: string;
}

// ---------------------------------------------------------------------------
// Plan construction records (the stream)
// ---------------------------------------------------------------------------

/** One issue as the planner constructed it (pre-freeze; ids are plan-scoped). */
export interface PlannedIssueDraft {
  readonly planIssueId: string;
  readonly title: string;
  readonly goal: string;
  /** Observable pass/fail checks; frozen verbatim into the contract at approval. */
  readonly acceptanceCriteria: readonly string[];
  /** Plan issue ids that must merge first (CAM-PLAN-11); forward references allowed mid-stream. */
  readonly dependsOn: readonly string[];
  readonly interfaces: readonly DeclaredInterface[];
}

/**
 * A surfaced invented assumption (CAM-PLAN-01): wherever the PRD
 * underdetermined a decision the planner needed, it must ask — recording
 * the exact assumption it will proceed on if David confirms it instead of
 * answering. Every clarifying item must be actively acknowledged before
 * plan approval completes; rendering it on screen is not acknowledgment.
 */
export interface ClarifyingItemDraft {
  readonly clarificationId: string;
  readonly question: string;
  readonly whyItMatters: string;
  /** The precise assumption baked into the plan if David confirms rather than answers. */
  readonly assumptionIfUnanswered: string;
  /** PRD segments whose ambiguity this item surfaces. */
  readonly relatedSegmentIds: readonly string[];
  readonly relatedPlanIssueIds: readonly string[];
}

/** Why a checklist row maps no requirement (the row is then visibly flagged). */
export const UNMAPPED_REASONS = Object.freeze([
  "context", // background/motivation text, not a requirement of this mission
  "non-requirement", // headings, formatting, boilerplate
  "out-of-scope", // requirement-shaped but explicitly outside this mission
  "duplicate", // restates a segment already mapped
] as const);
export type UnmappedReason = (typeof UNMAPPED_REASONS)[number];

/**
 * One row of the requirement checklist diff (CAM-PLAN-02): every PRD
 * segment appears exactly once — either mapped to a proposed intent-ledger
 * entry or visibly flagged as unmapped with a stated reason. Confirming a
 * mapped row is the user action that creates the `accepted` ledger entry;
 * the proposed requirement's number is minted at confirmation
 * (CAM-<area>-NN over the ledger's existing numbers).
 */
export type ChecklistRowDraft =
  | {
      readonly segmentId: string;
      readonly disposition: "mapped";
      /** The requirement restated as a single testable intent statement. */
      readonly proposedStatement: string;
      /** AREA token of the proposed requirement id. */
      readonly proposedArea: string;
      /** Plan issues that implement this requirement. */
      readonly mappedPlanIssueIds: readonly string[];
      readonly note?: string;
    }
  | {
      readonly segmentId: string;
      readonly disposition: "unmapped";
      readonly reason: UnmappedReason;
      readonly note?: string;
    };

/**
 * One record of the construction stream. `construction-complete` ends the
 * stream; the daemon validates plan-level invariants (checklist totality,
 * dependency graph shape, template bounds) at that point.
 */
export type PlanConstructionRecord =
  | { readonly kind: "issue"; readonly issue: PlannedIssueDraft }
  | { readonly kind: "clarification"; readonly clarification: ClarifyingItemDraft }
  | { readonly kind: "checklist-row"; readonly row: ChecklistRowDraft }
  | { readonly kind: "construction-complete" };

export const PLAN_CONSTRUCTION_RECORD_KINDS = Object.freeze([
  "issue",
  "clarification",
  "checklist-row",
  "construction-complete",
] as const);

/**
 * The file a planner worker appends construction records to (one JSON
 * record per line), relative to its workspace root. The runner tails it
 * while the worker runs — streaming-as-constructed without coupling to any
 * vendor CLI's own stream protocol.
 */
export const PLAN_STREAM_FILENAME = "plan-stream.jsonl";

// ---------------------------------------------------------------------------
// Acknowledgments (CAM-PLAN-01: the ACTIVE act, distinct from display)
// ---------------------------------------------------------------------------

/**
 * David's acknowledgment of one clarifying item: answer the question, or
 * confirm the recorded assumption. There is deliberately no third variant —
 * "seen"/"dismissed" would be passive display, which the acceptance
 * criterion explicitly fails.
 */
export type ClarificationResponse =
  | { readonly kind: "answered"; readonly answer: string }
  | { readonly kind: "assumption-confirmed" };

// ---------------------------------------------------------------------------
// Bounds (planner output is data; every field is length-bounded)
// ---------------------------------------------------------------------------

/** Longest free-text field (question, goal, criterion, statement…), in code units. */
export const PLAN_MAX_TEXT_LENGTH = 4000;
/** Longest list (criteria, dependsOn, interfaces, related ids…). */
export const PLAN_MAX_LIST_LENGTH = 100;

function textProblems(field: string, value: unknown, required: boolean): string[] {
  if (value === undefined) return required ? [`${field} is required`] : [];
  if (typeof value !== "string") return [`${field} must be a string`];
  if (required && value.trim().length === 0) return [`${field} must be non-empty`];
  if (value.length > PLAN_MAX_TEXT_LENGTH) {
    return [`${field} exceeds ${PLAN_MAX_TEXT_LENGTH} code units`];
  }
  if (value.includes("\u0000")) return [`${field} contains U+0000, which the stores refuse`];
  return [];
}

/** Sparse holes dodge forEach/map — hunt them by index (r1 finding 7). */
function holeProblems(field: string, value: readonly unknown[]): string[] {
  const problems: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    if (!Object.hasOwn(value, i)) problems.push(`${field}[${i}] is a sparse-array hole`);
  }
  return problems;
}

function idListProblems(
  field: string,
  value: unknown,
  isValid: (id: string) => boolean,
  grammar: string,
): string[] {
  if (!Array.isArray(value)) return [`${field} must be an array`];
  if (value.length > PLAN_MAX_LIST_LENGTH) {
    return [`${field} exceeds ${PLAN_MAX_LIST_LENGTH} entries`];
  }
  const problems: string[] = holeProblems(field, value);
  const seen = new Set<string>();
  value.forEach((entry, i) => {
    if (typeof entry !== "string" || !isValid(entry)) {
      problems.push(`${field}[${i}] must match /${grammar}/`);
      return;
    }
    if (seen.has(entry)) problems.push(`${field}[${i}] duplicates ${entry}`);
    seen.add(entry);
  });
  return problems;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownFieldProblems(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `unknown field ${JSON.stringify(key)}`);
}

function declaredInterfaceProblems(field: string, value: unknown): string[] {
  if (!isPlainRecord(value)) return [`${field} must be an object`];
  const problems = unknownFieldProblems(value, ["name", "kind", "description"]).map(
    (p) => `${field}: ${p}`,
  );
  problems.push(...textProblems(`${field}.name`, value["name"], true));
  problems.push(...textProblems(`${field}.description`, value["description"], true));
  const kind = value["kind"];
  if (typeof kind !== "string" || !(INTERFACE_KINDS as readonly string[]).includes(kind)) {
    problems.push(`${field}.kind must be one of ${INTERFACE_KINDS.join(", ")}`);
  }
  return problems;
}

function plannedIssueProblems(value: unknown): string[] {
  if (!isPlainRecord(value)) return ["issue must be an object"];
  const problems = unknownFieldProblems(value, [
    "planIssueId",
    "title",
    "goal",
    "acceptanceCriteria",
    "dependsOn",
    "interfaces",
  ]).map((p) => `issue: ${p}`);
  const id = value["planIssueId"];
  if (typeof id !== "string" || !isPlanIssueId(id)) {
    problems.push(`issue.planIssueId must match /${PLAN_ISSUE_ID_PATTERN_SOURCE}/`);
  }
  problems.push(...textProblems("issue.title", value["title"], true));
  problems.push(...textProblems("issue.goal", value["goal"], true));
  const criteria = value["acceptanceCriteria"];
  if (!Array.isArray(criteria) || criteria.length === 0) {
    problems.push("issue.acceptanceCriteria must be a non-empty array");
  } else if (criteria.length > PLAN_MAX_LIST_LENGTH) {
    problems.push(`issue.acceptanceCriteria exceeds ${PLAN_MAX_LIST_LENGTH} entries`);
  } else {
    problems.push(...holeProblems("issue.acceptanceCriteria", criteria));
    criteria.forEach((criterion, i) => {
      problems.push(...textProblems(`issue.acceptanceCriteria[${i}]`, criterion, true));
    });
  }
  problems.push(
    ...idListProblems(
      "issue.dependsOn",
      value["dependsOn"],
      isPlanIssueId,
      PLAN_ISSUE_ID_PATTERN_SOURCE,
    ),
  );
  const interfaces = value["interfaces"];
  if (!Array.isArray(interfaces)) {
    problems.push("issue.interfaces must be an array");
  } else if (interfaces.length > PLAN_MAX_LIST_LENGTH) {
    problems.push(`issue.interfaces exceeds ${PLAN_MAX_LIST_LENGTH} entries`);
  } else {
    problems.push(...holeProblems("issue.interfaces", interfaces));
    interfaces.forEach((entry, i) => {
      problems.push(...declaredInterfaceProblems(`issue.interfaces[${i}]`, entry));
    });
  }
  if (
    typeof id === "string" &&
    Array.isArray(value["dependsOn"]) &&
    value["dependsOn"].includes(id)
  ) {
    problems.push(`issue ${id} depends on itself`);
  }
  return problems;
}

function clarificationProblems(value: unknown): string[] {
  if (!isPlainRecord(value)) return ["clarification must be an object"];
  const problems = unknownFieldProblems(value, [
    "clarificationId",
    "question",
    "whyItMatters",
    "assumptionIfUnanswered",
    "relatedSegmentIds",
    "relatedPlanIssueIds",
  ]).map((p) => `clarification: ${p}`);
  const id = value["clarificationId"];
  if (typeof id !== "string" || !isClarificationId(id)) {
    problems.push(`clarification.clarificationId must match /${CLARIFICATION_ID_PATTERN_SOURCE}/`);
  }
  problems.push(...textProblems("clarification.question", value["question"], true));
  problems.push(...textProblems("clarification.whyItMatters", value["whyItMatters"], true));
  problems.push(
    ...textProblems("clarification.assumptionIfUnanswered", value["assumptionIfUnanswered"], true),
  );
  problems.push(
    ...idListProblems(
      "clarification.relatedSegmentIds",
      value["relatedSegmentIds"],
      isSegmentId,
      SEGMENT_ID_PATTERN_SOURCE,
    ),
  );
  problems.push(
    ...idListProblems(
      "clarification.relatedPlanIssueIds",
      value["relatedPlanIssueIds"],
      isPlanIssueId,
      PLAN_ISSUE_ID_PATTERN_SOURCE,
    ),
  );
  return problems;
}

function checklistRowProblems(value: unknown): string[] {
  if (!isPlainRecord(value)) return ["row must be an object"];
  const segmentId = value["segmentId"];
  const problems: string[] = [];
  if (typeof segmentId !== "string" || !isSegmentId(segmentId)) {
    problems.push(`row.segmentId must match /${SEGMENT_ID_PATTERN_SOURCE}/`);
  }
  const disposition = value["disposition"];
  if (disposition === "mapped") {
    problems.push(
      ...unknownFieldProblems(value, [
        "segmentId",
        "disposition",
        "proposedStatement",
        "proposedArea",
        "mappedPlanIssueIds",
        "note",
      ]).map((p) => `row: ${p}`),
    );
    problems.push(...textProblems("row.proposedStatement", value["proposedStatement"], true));
    const area = value["proposedArea"];
    if (typeof area !== "string" || !isRequirementArea(area)) {
      problems.push(`row.proposedArea must match /${REQUIREMENT_AREA_PATTERN_SOURCE}/`);
    }
    problems.push(
      ...idListProblems(
        "row.mappedPlanIssueIds",
        value["mappedPlanIssueIds"],
        isPlanIssueId,
        PLAN_ISSUE_ID_PATTERN_SOURCE,
      ),
    );
    if (Array.isArray(value["mappedPlanIssueIds"]) && value["mappedPlanIssueIds"].length === 0) {
      problems.push("row.mappedPlanIssueIds must name at least one implementing issue");
    }
    problems.push(...textProblems("row.note", value["note"], false));
  } else if (disposition === "unmapped") {
    problems.push(
      ...unknownFieldProblems(value, ["segmentId", "disposition", "reason", "note"]).map(
        (p) => `row: ${p}`,
      ),
    );
    const reason = value["reason"];
    if (typeof reason !== "string" || !(UNMAPPED_REASONS as readonly string[]).includes(reason)) {
      problems.push(`row.reason must be one of ${UNMAPPED_REASONS.join(", ")}`);
    }
    problems.push(...textProblems("row.note", value["note"], false));
  } else {
    problems.push('row.disposition must be "mapped" or "unmapped"');
  }
  return problems;
}

/**
 * Total structural validator for one construction record: every problem
 * named, nothing thrown, nothing coerced. An empty result licenses the
 * cast to PlanConstructionRecord. Cross-record invariants (duplicate ids,
 * unknown references, totality) are the planning service's job — this
 * validator sees one record at a time.
 */
export function planConstructionRecordProblems(value: unknown): string[] {
  if (!isPlainRecord(value)) return ["record must be a plain object"];
  const kind = value["kind"];
  switch (kind) {
    case "issue": {
      const problems = unknownFieldProblems(value, ["kind", "issue"]);
      return [...problems, ...plannedIssueProblems(value["issue"])];
    }
    case "clarification": {
      const problems = unknownFieldProblems(value, ["kind", "clarification"]);
      return [...problems, ...clarificationProblems(value["clarification"])];
    }
    case "checklist-row": {
      const problems = unknownFieldProblems(value, ["kind", "row"]);
      return [...problems, ...checklistRowProblems(value["row"])];
    }
    case "construction-complete":
      return unknownFieldProblems(value, ["kind"]);
    default:
      return [
        `record.kind must be one of ${PLAN_CONSTRUCTION_RECORD_KINDS.join(", ")}, got ${JSON.stringify(kind)}`,
      ];
  }
}

/** Total validator for David's acknowledgment of one clarifying item. */
export function clarificationResponseProblems(value: unknown): string[] {
  if (!isPlainRecord(value)) return ["response must be a plain object"];
  const kind = value["kind"];
  if (kind === "answered") {
    const problems = unknownFieldProblems(value, ["kind", "answer"]);
    return [...problems, ...textProblems("response.answer", value["answer"], true)];
  }
  if (kind === "assumption-confirmed") {
    return unknownFieldProblems(value, ["kind"]);
  }
  return ['response.kind must be "answered" or "assumption-confirmed"'];
}
