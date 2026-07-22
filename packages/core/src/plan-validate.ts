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
  /**
   * The segment's text: source characters with heading markers and list
   * bullets kept, single-newline line joins normalized to one space, and
   * leading/trailing whitespace trimmed. Totality is over non-whitespace
   * text — no visible character is ever lost or reordered.
   */
  readonly text: string;
}

/**
 * BOUNDARY, stated plainly: this is a deterministic MECHANICAL splitter,
 * not a linguistic one. Guarantees: every non-blank piece of PRD text lands
 * in exactly one segment, in document order, and identical input always
 * yields identical segments — that totality is what the checklist diff's
 * "every PRD sentence appears exactly once" rests on. The error DIRECTION
 * is chosen deliberately (r1 finding 6): the splitter over-splits rather
 * than under-splits, because an over-split only yields a finer checklist
 * row while an under-split can bury a second requirement inside a segment
 * whose row maps only the first. So every sentence terminator followed by
 * whitespace splits — abbreviations ("e.g. the size") split too, a
 * sentence starting lowercase ("iOS users…") still gets its own segment,
 * semicolon-joined requirements split, Unicode whitespace (no-break space
 * included) counts as a boundary, and typographic closing quotes ride
 * with their sentence. Decimal points never split (no whitespace follows
 * them); a colon deliberately never splits ("Note: …" labels are
 * ubiquitous), so colon-joined independent requirements share one row —
 * a finer-grained mapping is the checklist author's call. Non-guarantee
 * that remains: a mapped row's STATEMENT covering less than its segment's
 * text is a semantic judgment no mechanical check can close — that is what
 * checklist review and the cross-family plan review (WP-111) exist for.
 * Headings, list items, table rows, and fenced code blocks are their own
 * segments (a fence is never sentence-split).
 */
export function segmentPrd(text: string): PrdSegment[] {
  const lines = text.split(/\r\n|\r|\n/);
  // Blocks CARRY their fenced-ness — re-deriving it from the text would
  // re-admit the naive prefix test the opener logic just rejected
  // (r5 finding 5's invalid-opener case).
  const blocks: Array<{ text: string; fenced: boolean }> = [];
  let current: string[] = [];
  // CommonMark fence semantics (r3 finding 7; r4 finding 4): a fence
  // closes only on a line of the SAME delimiter family, at least the
  // OPENING run's length, followed by nothing but whitespace — an info
  // string marks an opener, never a closer, so a ```js line inside an
  // open ```text fence is content.
  let openFence: { family: "`" | "~"; length: number } | null = null;

  const flush = (fenced = false): void => {
    if (current.length > 0) {
      blocks.push({ text: current.join("\n"), fenced });
      current = [];
    }
  };

  const fenceOpener = (line: string): { family: "`" | "~"; length: number } | null => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (match === null) return null;
    const run = match[1] as string;
    const family = run[0] as "`" | "~";
    // CommonMark: a backtick fence's info string may not contain a
    // backtick — such a line is ordinary paragraph text, not a fence
    // opener (r5 finding 5). Tilde info strings carry no such rule.
    if (family === "`" && (match[2] as string).includes("`")) return null;
    return { family, length: run.length };
  };

  const closesFence = (line: string, fence: { family: "`" | "~"; length: number }): boolean => {
    const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (match === null) return false;
    const run = match[1] as string;
    return run[0] === fence.family && run.length >= fence.length;
  };

  for (const line of lines) {
    if (openFence !== null) {
      current.push(line);
      if (closesFence(line, openFence)) {
        openFence = null;
        flush(true);
      }
      continue;
    }
    const opener = fenceOpener(line);
    if (opener !== null) {
      flush();
      current.push(line);
      openFence = opener;
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
  flush(openFence !== null); // an unclosed fence stays a fence block

  const segments: string[] = [];
  for (const block of blocks) {
    if (block.fenced) {
      segments.push(block.text);
      continue;
    }
    segments.push(...splitSentences(block.text.split("\n").join(" ").trim()));
  }

  return segments
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s, i) => ({ segmentId: `S${i + 1}`, text: s }));
}

/**
 * Split after every sentence terminator (+ optional closing quotes or
 * brackets) that is followed by whitespace and further text. No
 * next-character class: requiring an uppercase/digit start let
 * "… encrypted. iOS users …" hide a second requirement in the first one's
 * segment (r1 finding 6). Round-2 hardening (r2 finding 8): terminators
 * include the semicolon (requirement-joining prose) and CJK/fullwidth
 * forms; closers include typographic quotes; the whitespace test is
 * Unicode (\s), so a no-break space no longer buries a sentence.
 */
const SENTENCE_TERMINATORS = new Set([".", "!", "?", ";", "。", "！", "？", "；"]);
const CLOSER_RE = /["')\]”’»›」』】〕〗〙〛〉》）］｣]/;
const WHITESPACE_RE = /\s/;

function splitSentences(block: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < block.length; i += 1) {
    if (!SENTENCE_TERMINATORS.has(block[i] as string)) continue;
    let j = i + 1;
    while (j < block.length && CLOSER_RE.test(block[j] as string)) j += 1;
    let k = j;
    while (k < block.length && WHITESPACE_RE.test(block[k] as string)) k += 1;
    if (k === j || k >= block.length) continue; // no whitespace boundary → not a split point
    out.push(block.slice(start, j));
    start = k;
    i = k - 1;
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
  const ids = new Set(issues.map((i) => i.planIssueId));
  const edges = new Map<string, string[]>();
  for (const issue of [...issues].sort((a, b) => (a.planIssueId < b.planIssueId ? -1 : 1))) {
    edges.set(issue.planIssueId, [...issue.dependsOn].filter((dep) => ids.has(dep)).sort());
  }
  // ITERATIVE DFS with an explicit frame stack: plans are unbounded on the
  // feature template, and a recursive walk overflows the call stack on a
  // few thousand issues — turning the named-cycle refusal into a crash
  // (r1 finding 9).
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  for (const root of edges.keys()) {
    if (state.has(root)) continue;
    const frames: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
    state.set(root, "visiting");
    path.push(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as { id: string; next: number };
      const neighbors = edges.get(frame.id) ?? [];
      if (frame.next >= neighbors.length) {
        frames.pop();
        path.pop();
        state.set(frame.id, "done");
        continue;
      }
      const dep = neighbors[frame.next] as string;
      frame.next += 1;
      const seen = state.get(dep);
      if (seen === "done") continue;
      if (seen === "visiting") {
        const from = path.indexOf(dep);
        return [...path.slice(from), dep];
      }
      state.set(dep, "visiting");
      path.push(dep);
      frames.push({ id: dep, next: 0 });
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
  /**
   * The answer key's anchor terms: a clarification counts as surfacing THIS
   * ambiguity only if it mentions at least one (case-insensitive), so an
   * unrelated question that merely touches the same segment cannot game
   * coverage (r1 finding 2). Lowercase in the manifest.
   */
  readonly answerKeyTerms: readonly string[];
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
 * answer keys — a plan that silently guesses fails here. A clarification
 * covers a planted ambiguity only if it BOTH references the ambiguity's
 * segment AND mentions one of the answer key's anchor terms in its
 * QUESTION or recorded ASSUMPTION — the decision-carrying fields; a term
 * appearing only in the free-text rationale does not count, and an
 * unrelated question on the same sentence does not count (r1 finding 2,
 * r2 finding 6). Anchor matching is a deterministic keyword heuristic,
 * not semantics — it calibrates COOPERATIVE planners against known answer
 * keys and cannot certify relevance against an adversarial one; the
 * manifest author chooses terms that any genuine surfacing of the
 * ambiguity must name, and blank terms are manifest drift.
 * At runtime on real PRDs no answer key exists; there the enforcement is
 * the approval gate above, which forces an active acknowledgment for
 * every ambiguity the planner DID surface. The two are complementary:
 * this check measures surfacing, the gate enforces acknowledgment.
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
  // TOKEN matching, not substring matching (r3 finding 6): "support" must
  // not cover the anchor "port". Both sides NFC-normalize, lowercase, and
  // tokenize on non-letter/digit runs; a term matches when its token
  // sequence appears consecutively in the clarification's tokens.
  const tokens = (text: string): string[] =>
    text
      .normalize("NFC")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 0);
  // An anchor token matches a text token exactly OR as a PREFIX when the
  // anchor is at least 4 characters ("header" matches "headers", "retain"
  // matches "retained"); short anchors stay exact. This is a HEURISTIC
  // with stated failure modes in both directions (r5 finding 6): a
  // non-prefix inflection misses ("policy" does not match "policies") and
  // an unrelated prefix-sharing word matches ("port" matches "portal").
  // Neither is silently absorbed — the manifest author owns the anchors:
  // list inflection variants explicitly where prefixing fails, and choose
  // anchors long or specific enough that prefix collisions do not occur
  // in the fixture's vocabulary. Coverage remains fixture calibration for
  // cooperative planners, not adversarial-proof semantics.
  const tokenMatches = (textToken: string, anchorToken: string): boolean =>
    textToken === anchorToken || (anchorToken.length >= 4 && textToken.startsWith(anchorToken));
  const containsTokenSequence = (
    haystack: readonly string[],
    needle: readonly string[],
  ): boolean => {
    if (needle.length === 0) return false;
    outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
      for (let j = 0; j < needle.length; j += 1) {
        if (!tokenMatches(haystack[i + j] as string, needle[j] as string)) continue outer;
      }
      return true;
    }
    return false;
  };
  for (const ambiguity of planted) {
    const terms = ambiguity.answerKeyTerms.map(tokens).filter((t) => t.length > 0);
    if (terms.length === 0) {
      // An empty or blank answer key would make coverage vacuously
      // gameable ("" is a substring of everything) — manifest drift,
      // reported loudly rather than skipped (r2 finding 6).
      unlocatable.push(ambiguity.id);
      continue;
    }
    const matches = segments.filter((s) => s.text === ambiguity.segmentText);
    if (matches.length !== 1) {
      unlocatable.push(ambiguity.id);
      continue;
    }
    const segmentId = (matches[0] as PrdSegment).segmentId;
    const touching = clarifications
      .filter((c) => {
        if (!c.relatedSegmentIds.includes(segmentId)) return false;
        // Match only the DECISION-carrying fields — the question asked and
        // the assumption recorded. A stray term in the free-text rationale
        // must not cover (r2 finding 6), and token matching means a term
        // inside a longer word never counts (r3 finding 6).
        const text = tokens(`${c.question} ${c.assumptionIfUnanswered}`);
        return terms.some((term) => containsTokenSequence(text, term));
      })
      .map((c) => c.clarificationId);
    if (touching.length > 0) {
      covered.push({ plantedId: ambiguity.id, segmentId, clarificationIds: touching });
    } else {
      uncovered.push({ plantedId: ambiguity.id, segmentId });
    }
  }
  return { covered, uncovered, unlocatable };
}
