/**
 * Pure planning decisions (WP-110, CAM-PLAN-01/-02/-11): PRD segmentation,
 * dependency-graph validation with the cycle NAMED, checklist totality,
 * template constraints, and the plan-approval gate.
 *
 * Everything here is a pure function over values; persistence and event
 * wiring live in the daemon's planning service, which calls these to decide
 * and then records the outcome. The gate is the CAM-PLAN-01 mechanism: it
 * refuses approval while any surfaced clarifying item lacks an ACTIVE
 * acknowledgment — rendering an item on screen changes nothing here, so
 * passive display cannot pass by construction.
 */
import type {
  ChecklistRowDraft,
  ClarifyingItemDraft,
  MissionTemplate,
  PlannedIssueDraft,
} from "@camino/shared";

// ---------------------------------------------------------------------------
// PRD segmentation (CAM-PLAN-02: the checklist is total over these segments)
// ---------------------------------------------------------------------------

export interface PrdSegment {
  /** "S1"… in document order. */
  readonly segmentId: string;
  /** The segment's text, verbatim (heading markers and list bullets kept). */
  readonly text: string;
}

/**
 * BOUNDARY, stated plainly: this is a deterministic MECHANICAL splitter,
 * not a linguistic one. Guarantees: every non-blank piece of PRD text lands
 * in exactly one segment, in document order, and identical input always
 * yields identical segments — that totality is what the checklist diff's
 * "every PRD sentence appears exactly once" rests on. Non-guarantees: an
 * abbreviation ("e.g. the size") may split a sentence in two, and a
 * sentence missing terminal punctuation joins its block; over-splitting
 * yields finer checklist rows, under-splitting a coarser row — neither
 * loses text. Headings, list items, table rows, and fenced code blocks are
 * their own segments (a fence is never sentence-split).
 */
export function segmentPrd(text: string): PrdSegment[] {
  const lines = text.split(/\r\n|\r|\n/);
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = (): void => {
    if (current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
    }
  };

  for (const line of lines) {
    const fenceDelimiter = /^ {0,3}(```|~~~)/.test(line);
    if (inFence) {
      current.push(line);
      if (fenceDelimiter) {
        inFence = false;
        flush();
      }
      continue;
    }
    if (fenceDelimiter) {
      flush();
      current.push(line);
      inFence = true;
      continue;
    }
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    const heading = /^ {0,3}#{1,6}\s/.test(line);
    const listItem = /^\s*(?:[-*+]|\d{1,3}[.)])\s/.test(line);
    const tableRow = /^\s*\|/.test(line);
    if (heading || listItem || tableRow) {
      flush();
      current.push(line);
      if (heading || tableRow) flush();
      continue;
    }
    current.push(line);
  }
  flush();

  const segments: string[] = [];
  for (const block of blocks) {
    if (/^ {0,3}(```|~~~)/.test(block)) {
      segments.push(block);
      continue;
    }
    segments.push(...splitSentences(block.split("\n").join(" ").trim()));
  }

  return segments
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s, i) => ({ segmentId: `S${i + 1}`, text: s }));
}

/** Split after [.!?] (+ optional closing quotes/brackets) before a capital/digit/quote. */
function splitSentences(block: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < block.length; i += 1) {
    const ch = block[i] as string;
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    let j = i + 1;
    while (j < block.length && /["')\]]/.test(block[j] as string)) j += 1;
    let k = j;
    while (k < block.length && (block[k] === " " || block[k] === "\t")) k += 1;
    if (k === j || k >= block.length) continue; // no whitespace boundary → not a split point
    if (/[A-Z0-9"'([]/.test(block[k] as string)) {
      out.push(block.slice(start, j));
      start = k;
      i = k - 1;
    }
  }
  out.push(block.slice(start));
  return out;
}

// ---------------------------------------------------------------------------
// Dependency graph (CAM-PLAN-11)
// ---------------------------------------------------------------------------

/**
 * Structural problems that make the graph unevaluable: duplicate issue
 * ids and references to issues that do not exist. (Self-dependencies are
 * refused per record at ingest; they surface here too as one-node cycles.)
 */
export function dependencyGraphProblems(issues: readonly PlannedIssueDraft[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const issue of issues) {
    if (ids.has(issue.planIssueId)) {
      problems.push(`duplicate issue id ${issue.planIssueId}`);
    }
    ids.add(issue.planIssueId);
  }
  for (const issue of issues) {
    for (const dep of issue.dependsOn) {
      if (!ids.has(dep)) {
        problems.push(`issue ${issue.planIssueId} depends on unknown issue ${dep}`);
      }
    }
  }
  return problems;
}

/**
 * The first dependency cycle by deterministic order (ids sorted, neighbors
 * sorted), returned as a closed path — e.g. ["I2", "I4", "I2"] reads
 * "I2 depends on I4, which depends on I2" — or null when the graph is
 * acyclic. Call after dependencyGraphProblems is empty; unknown references
 * are ignored here rather than guessed at.
 */
export function findDependencyCycle(issues: readonly PlannedIssueDraft[]): string[] | null {
  const edges = new Map<string, string[]>();
  for (const issue of [...issues].sort((a, b) => (a.planIssueId < b.planIssueId ? -1 : 1))) {
    edges.set(
      issue.planIssueId,
      [...issue.dependsOn].filter((dep) => issues.some((i) => i.planIssueId === dep)).sort(),
    );
  }
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of edges.get(id) ?? []) {
      const seen = state.get(dep);
      if (seen === "done") continue;
      if (seen === "visiting") {
        const from = stack.indexOf(dep);
        return [...stack.slice(from), dep];
      }
      const cycle = visit(dep);
      if (cycle !== null) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const id of edges.keys()) {
    if (!state.has(id)) {
      const cycle = visit(id);
      if (cycle !== null) return cycle;
    }
  }
  return null;
}

/** Render a cycle path for refusal messages: "I2 -> I4 -> I2". */
export function formatCycle(cycle: readonly string[]): string {
  return cycle.join(" -> ");
}

// ---------------------------------------------------------------------------
// Checklist totality (CAM-PLAN-02) and template constraints (CAM-PLAN-07)
// ---------------------------------------------------------------------------

/**
 * The checklist is total over the PRD's segments: every segment exactly
 * once, no rows for segments that do not exist, and mapped rows reference
 * issues that exist. Every problem is named.
 */
export function checklistProblems(
  segments: readonly PrdSegment[],
  rows: readonly ChecklistRowDraft[],
  issues: readonly PlannedIssueDraft[],
): string[] {
  const problems: string[] = [];
  const segmentIds = new Set(segments.map((s) => s.segmentId));
  const issueIds = new Set(issues.map((i) => i.planIssueId));
  const seen = new Set<string>();
  for (const row of rows) {
    if (!segmentIds.has(row.segmentId)) {
      problems.push(`checklist row for unknown segment ${row.segmentId}`);
    }
    if (seen.has(row.segmentId)) {
      problems.push(`segment ${row.segmentId} appears in more than one checklist row`);
    }
    seen.add(row.segmentId);
    if (row.disposition === "mapped") {
      for (const issueId of row.mappedPlanIssueIds) {
        if (!issueIds.has(issueId)) {
          problems.push(`segment ${row.segmentId} maps to unknown issue ${issueId}`);
        }
      }
    }
  }
  for (const segment of segments) {
    if (!seen.has(segment.segmentId)) {
      problems.push(`segment ${segment.segmentId} has no checklist row`);
    }
  }
  return problems;
}

/** Clarification references must point at real segments and issues. */
export function clarificationReferenceProblems(
  clarifications: readonly ClarifyingItemDraft[],
  segments: readonly PrdSegment[],
  issues: readonly PlannedIssueDraft[],
): string[] {
  const problems: string[] = [];
  const segmentIds = new Set(segments.map((s) => s.segmentId));
  const issueIds = new Set(issues.map((i) => i.planIssueId));
  const seen = new Set<string>();
  for (const item of clarifications) {
    if (seen.has(item.clarificationId)) {
      problems.push(`duplicate clarification id ${item.clarificationId}`);
    }
    seen.add(item.clarificationId);
    for (const segmentId of item.relatedSegmentIds) {
      if (!segmentIds.has(segmentId)) {
        problems.push(
          `clarification ${item.clarificationId} references unknown segment ${segmentId}`,
        );
      }
    }
    for (const issueId of item.relatedPlanIssueIds) {
      if (!issueIds.has(issueId)) {
        problems.push(`clarification ${item.clarificationId} references unknown issue ${issueId}`);
      }
    }
  }
  return problems;
}

/** Template structural constraints (CAM-PLAN-07): issue-count bounds. */
export function templateProblems(
  template: MissionTemplate,
  issues: readonly PlannedIssueDraft[],
): string[] {
  const problems: string[] = [];
  if (issues.length === 0) {
    problems.push(`a ${template.name} plan must construct at least one issue`);
  }
  if (template.maxIssues !== null && issues.length > template.maxIssues) {
    problems.push(
      `a ${template.name} plan allows at most ${template.maxIssues} issue(s), got ${issues.length}`,
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The approval gate (CAM-PLAN-01/-02/-11)
// ---------------------------------------------------------------------------

/** Everything the gate decides over — assembled by the daemon from its stores. */
export interface PlanGateInput {
  readonly template: MissionTemplate;
  readonly segments: readonly PrdSegment[];
  readonly issues: readonly PlannedIssueDraft[];
  readonly clarifications: readonly ClarifyingItemDraft[];
  readonly checklist: readonly ChecklistRowDraft[];
  readonly constructionComplete: boolean;
  /** A falsification review artifact is attached (CAM-PLAN-03; WP-111 supplies it). */
  readonly reviewAttached: boolean;
  /** Clarifications David has ACTIVELY acknowledged (answered or assumption-confirmed). */
  readonly acknowledgedClarificationIds: ReadonlySet<string>;
  /** Mapped rows David has confirmed (each confirmation created an accepted ledger entry). */
  readonly confirmedMappedSegmentIds: ReadonlySet<string>;
  /**
   * The exact unmapped segment ids David's latest flagged-rows acknowledgment
   * covered, or null if none was recorded. Approval requires it to match the
   * checklist's CURRENT unmapped set — an acknowledgment of a stale flag list
   * does not carry over.
   */
  readonly flaggedRowsAcknowledged: ReadonlySet<string> | null;
}

export type ApprovalRefusal =
  | { readonly kind: "construction-incomplete" }
  | { readonly kind: "review-missing" }
  | { readonly kind: "template-violation"; readonly problems: readonly string[] }
  | { readonly kind: "checklist-not-total"; readonly problems: readonly string[] }
  | { readonly kind: "clarification-references-invalid"; readonly problems: readonly string[] }
  | { readonly kind: "dependency-graph-invalid"; readonly problems: readonly string[] }
  | {
      readonly kind: "dependency-cycle";
      readonly cycle: readonly string[];
      /** "I2 -> I4 -> I2" — the named cycle the refusal shows (CAM-PLAN-11). */
      readonly named: string;
    }
  | { readonly kind: "unacknowledged-clarifications"; readonly clarificationIds: readonly string[] }
  | { readonly kind: "unconfirmed-mapped-rows"; readonly segmentIds: readonly string[] }
  | { readonly kind: "flagged-rows-unacknowledged"; readonly segmentIds: readonly string[] };

/**
 * The facts an approval act may truthfully attest after an ok gate — the
 * integration-route guard inputs of A.1#3 (the scheduler computes the slot
 * fact itself).
 */
export interface GateAttestedFacts {
  readonly checklistApproved: true;
  readonly dagAcyclic: true;
}

export type ApprovalDecision =
  | { readonly ok: true; readonly attested: GateAttestedFacts }
  | { readonly ok: false; readonly refusals: readonly ApprovalRefusal[] };

/**
 * Decide plan approval. Returns ALL refusals, not the first, so the
 * approval screen can show David everything that still blocks. The
 * decision is pure: the same input always decides identically, and there
 * is no code path from "clarification exists but is unacknowledged" to
 * an ok result — that absence is the CAM-PLAN-01 guarantee.
 */
export function decidePlanApproval(input: PlanGateInput): ApprovalDecision {
  const refusals: ApprovalRefusal[] = [];

  if (!input.constructionComplete) refusals.push({ kind: "construction-incomplete" });
  if (!input.reviewAttached) refusals.push({ kind: "review-missing" });

  const template = templateProblems(input.template, input.issues);
  if (template.length > 0) refusals.push({ kind: "template-violation", problems: template });

  const checklist = checklistProblems(input.segments, input.checklist, input.issues);
  if (checklist.length > 0) refusals.push({ kind: "checklist-not-total", problems: checklist });

  const clarificationRefs = clarificationReferenceProblems(
    input.clarifications,
    input.segments,
    input.issues,
  );
  if (clarificationRefs.length > 0) {
    refusals.push({ kind: "clarification-references-invalid", problems: clarificationRefs });
  }

  const graph = dependencyGraphProblems(input.issues);
  if (graph.length > 0) {
    refusals.push({ kind: "dependency-graph-invalid", problems: graph });
  } else {
    const cycle = findDependencyCycle(input.issues);
    if (cycle !== null) {
      refusals.push({ kind: "dependency-cycle", cycle, named: formatCycle(cycle) });
    }
  }

  const unacknowledged = input.clarifications
    .map((c) => c.clarificationId)
    .filter((id) => !input.acknowledgedClarificationIds.has(id))
    .sort();
  if (unacknowledged.length > 0) {
    refusals.push({ kind: "unacknowledged-clarifications", clarificationIds: unacknowledged });
  }

  const mappedIds = input.checklist
    .filter((row) => row.disposition === "mapped")
    .map((row) => row.segmentId);
  const unconfirmed = mappedIds.filter((id) => !input.confirmedMappedSegmentIds.has(id)).sort();
  if (unconfirmed.length > 0) {
    refusals.push({ kind: "unconfirmed-mapped-rows", segmentIds: unconfirmed });
  }

  const flagged = input.checklist
    .filter((row) => row.disposition === "unmapped")
    .map((row) => row.segmentId)
    .sort();
  if (flagged.length > 0) {
    const acknowledged =
      input.flaggedRowsAcknowledged !== null &&
      flagged.length === input.flaggedRowsAcknowledged.size &&
      flagged.every((id) => input.flaggedRowsAcknowledged?.has(id));
    if (!acknowledged) {
      refusals.push({ kind: "flagged-rows-unacknowledged", segmentIds: flagged });
    }
  }

  if (refusals.length > 0) return { ok: false, refusals };
  return { ok: true, attested: { checklistApproved: true, dagAcyclic: true } };
}

// ---------------------------------------------------------------------------
// Planted-ambiguity coverage (the CAM-PLAN-01 fixture harness check)
// ---------------------------------------------------------------------------

/** One planted ambiguity from a fixture manifest. */
export interface PlantedAmbiguity {
  readonly id: string;
  /** The exact segment text the ambiguity lives in (located by exact match). */
  readonly segmentText: string;
  readonly summary: string;
}

export interface AmbiguityCoverage {
  readonly covered: ReadonlyArray<{
    readonly plantedId: string;
    readonly segmentId: string;
    readonly clarificationIds: readonly string[];
  }>;
  /** Planted ambiguities no clarifying item touches — a SILENT GUESS. */
  readonly uncovered: ReadonlyArray<{ readonly plantedId: string; readonly segmentId: string }>;
  /**
   * Manifest entries whose segmentText matched no segment or several — the
   * fixture and its manifest have drifted; the harness must fail these
   * loudly rather than skip them.
   */
  readonly unlocatable: readonly string[];
}

/**
 * The fixture-set mechanism behind CAM-PLAN-01's accept criterion, and its
 * BOUNDARY, stated plainly: planted ambiguities are known only in
 * fixtures, so this check CALIBRATES planners against PRDs with known
 * answer keys — a plan that silently guesses fails here. At runtime on
 * real PRDs no answer key exists; there the enforcement is the approval
 * gate above, which forces an active acknowledgment for every ambiguity
 * the planner DID surface. The two are complementary: this check measures
 * surfacing, the gate enforces acknowledgment.
 */
export function plantedAmbiguityCoverage(
  planted: readonly PlantedAmbiguity[],
  segments: readonly PrdSegment[],
  clarifications: readonly ClarifyingItemDraft[],
): AmbiguityCoverage {
  const covered: Array<{
    plantedId: string;
    segmentId: string;
    clarificationIds: string[];
  }> = [];
  const uncovered: Array<{ plantedId: string; segmentId: string }> = [];
  const unlocatable: string[] = [];
  for (const ambiguity of planted) {
    const matches = segments.filter((s) => s.text === ambiguity.segmentText);
    if (matches.length !== 1) {
      unlocatable.push(ambiguity.id);
      continue;
    }
    const segmentId = (matches[0] as PrdSegment).segmentId;
    const touching = clarifications
      .filter((c) => c.relatedSegmentIds.includes(segmentId))
      .map((c) => c.clarificationId);
    if (touching.length > 0) {
      covered.push({ plantedId: ambiguity.id, segmentId, clarificationIds: touching });
    } else {
      uncovered.push({ plantedId: ambiguity.id, segmentId });
    }
  }
  return { covered, uncovered, unlocatable };
}
