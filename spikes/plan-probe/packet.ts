// The rating packet: the spike's stand-in for the plan-approval screen.
//
// Rendering enforces the two approval-shape invariants this probe prototypes:
//   - CAM-PLAN-03: a packet cannot exist without the cross-family review
//     attached (renderPacket throws without one);
//   - CAM-PLAN-01: approval cannot complete passively — checkPacket refuses
//     `approvable` until EVERY clarifying question is actively acknowledged
//     (answered or its recorded assumption confirmed) and rated.
import type { PlanDocument, ReviewDocument } from "./types.js";
import { flaggedNonRequirements, uncoveredRequirements } from "./validate.js";

export interface PacketInput {
  plan: PlanDocument;
  review: ReviewDocument;
  plannerName: string;
  plannerFamily: string;
  reviewerName: string;
  reviewerFamily: string;
  fixtureRel: string;
  generatedAt: string;
}

export const ATTENTION_BUDGET_MINUTES = 45; // CAM-OBS-02: per mission plan

const UNFILLED = "____";

/** Empty, or nothing but underscores and whitespace ("__ __" included — r1c #8). */
function isUnfilled(value: string): boolean {
  return /^[_\s]*$/.test(value);
}

export function renderPacket(input: PacketInput): string {
  const { plan, review } = input;
  if (!review || !Array.isArray(review.findings)) {
    throw new Error(
      "CAM-PLAN-03: refusing to render a rating packet without the cross-family review attached",
    );
  }
  const lines: string[] = [];
  const push = (...ls: string[]) => lines.push(...ls);

  push(
    `# WP-002 rating packet — ${plan.missionTitle}`,
    "",
    `Planner: **${input.plannerName}** (${input.plannerFamily}) · Reviewer: **${input.reviewerName}** (${input.reviewerFamily}) · Fixture: \`${input.fixtureRel}\``,
    `Generated: ${input.generatedAt}`,
    "",
    "> **How to rate this packet (the WP-002 / PRD §7 item 2 exit):**",
    "> 1. Note the time you start.",
    "> 2. Read sections A–D the way you would a plan-approval screen.",
    "> 3. In section B, fill BOTH lines under every question:",
    "> `RATING-Q<n>:` → `good` (genuine ambiguity — worth your time) or `obviously-fine`",
    "> (the planner should have decided this itself, or the answer is obvious).",
    "> `ACK-Q<n>:` → your answer, or `confirm` to accept the recorded assumption as-is.",
    "> 4. In section C, fill `CHECKLIST-USABLE:` (`yes`/`no`) — could you confirm intent from that table?",
    "> 5. Fill the timer block below, then run `npm run spike:plan-probe:check` (it verifies",
    "> completeness and computes the ≥70%-good score).",
    "",
    "## Review timer",
    "",
    `REVIEW-START: ${UNFILLED}`,
    `REVIEW-END: ${UNFILLED}`,
    `REVIEW-MINUTES: ${UNFILLED}`,
    "",
    `_Budget: ${ATTENTION_BUDGET_MINUTES} minutes per mission plan (CAM-OBS-02); this recording is the baseline data point._`,
    "",
  );

  // --- A. issues ---
  push(`## A. Proposed issues (${plan.issues.length})`, "");
  for (const issue of plan.issues) {
    const deps = issue.dependsOn.length > 0 ? issue.dependsOn.join(", ") : "—";
    push(
      `### ${issue.id} — ${issue.title} \`[risk: ${issue.riskTier}]\``,
      "",
      issue.goal,
      "",
      "Acceptance criteria:",
      ...issue.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`),
      "",
      `Mandate: ${issue.mappedSegments.join(", ")} · Depends on: ${deps}`,
      "",
    );
  }

  // --- B. clarifying questions ---
  const qs = plan.clarifyingQuestions;
  push(
    `## B. Clarifying questions — rate and acknowledge EVERY one (${qs.length})`,
    "",
    "`good` = a genuine ambiguity the PRD left open; asking was worth your attention.",
    "`obviously-fine` = the planner could safely have decided this itself.",
    "**≥70% rated good** is the question-quality bar (PRD §7, Phase-0 item 2); the full exit",
    "also requires checklist usability confirmed and review time recorded.",
    "",
  );
  if (qs.length === 0) {
    push(
      "_The planner surfaced no clarifying questions. There is nothing to rate — the probe is_",
      "_inconclusive on question quality and that itself is a finding._",
      "",
    );
  }
  for (const q of qs) {
    const related = [
      q.relatedSegments.length > 0 ? q.relatedSegments.join(", ") : null,
      q.relatedIssues.length > 0 ? `→ ${q.relatedIssues.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    push(
      `### ${q.id} — ${q.question}${q.blocking ? " `[blocking]`" : ""}`,
      "",
      `- Why it matters: ${q.whyItMatters}`,
      `- Assumption if unanswered: ${q.assumptionIfUnanswered}`,
      ...(related ? [`- Related: ${related}`] : []),
      "",
      `RATING-${q.id}: ${UNFILLED}`,
      `ACK-${q.id}: ${UNFILLED}`,
      "",
    );
  }

  // --- C. checklist diff ---
  const nonReq = flaggedNonRequirements(plan);
  const uncovered = uncoveredRequirements(plan);
  const reqRows = plan.checklist.filter((c) => c.isRequirement);
  push(
    "## C. Requirement checklist diff (CAM-PLAN-02)",
    "",
    "Every fixture segment, dispositioned. Requirements map to proposed intent-ledger entries;",
    "everything else is visibly flagged as non-requirement text.",
    "",
    "### C1. Requirements → proposed intent-ledger entries",
    "",
    "| Segment | Ledger entry | Statement | Implemented by |",
    "|---|---|---|---|",
  );
  for (const row of reqRows) {
    const led = row.proposedLedgerEntry;
    const issues = row.mappedIssues.length > 0 ? row.mappedIssues.join(", ") : "⚠ none";
    push(`| ${row.segment} | ${led?.id ?? "?"} | ${led?.statement ?? "?"} | ${issues} |`);
  }
  push(
    "",
    "### C2. Flagged as non-requirement text (the CAM-PLAN-02 visible flag)",
    "",
    "| Segment | Planner's note |",
    "|---|---|",
  );
  for (const row of nonReq) {
    push(`| ${row.segment} | ${row.note ?? "—"} |`);
  }
  push(
    "",
    "### C3. ⚠ Requirement segments not covered by any issue",
    "",
    "_Computed from the planner's OWN isRequirement classification — it cannot see a segment the_",
    "_planner misclassified as non-requirement; the falsification review in section D adjudicates_",
    "_the classification itself._",
    "",
  );
  if (uncovered.length === 0) {
    push(
      "None — every row the planner classified as a requirement maps to at least one issue.",
      "",
    );
  } else {
    for (const row of uncovered) {
      push(`- **${row.segment}** — ${row.note ?? "no note recorded"}`);
    }
    push("");
  }
  push(
    "Could you confirm mission intent from this table (accept/adjust ledger entries, spot the",
    "flagged text) without going back to the raw PRD?",
    "",
    `CHECKLIST-USABLE: ${UNFILLED}`,
    `CHECKLIST-NOTE: ${UNFILLED}`,
    "",
  );

  // --- D. falsification review ---
  push(
    "## D. Cross-family falsification review (attached — CAM-PLAN-03)",
    "",
    `Reviewer: **${input.reviewerName}** (${input.reviewerFamily}, planner family: ${input.plannerFamily}) · Verdict: **${review.verdict}**`,
    "",
    review.summary,
    "",
  );
  if (review.findings.length === 0) {
    push("No findings recorded.", "");
  }
  for (const f of review.findings) {
    push(
      `### ${f.id} \`[${f.severity} · ${f.class}]\` — ${f.claim}`,
      "",
      `- Evidence: ${f.evidence}`,
      `- Suggested fix: ${f.suggestedFix}`,
      "",
    );
  }

  push(
    "---",
    "",
    "_This packet is the spike's stand-in for the plan-approval screen: per CAM-PLAN-01 the plan_",
    "_is not approvable while any question above is unrated or unacknowledged, and per CAM-PLAN-03_",
    "_it could not have been rendered without section D attached._",
    "",
  );
  return lines.join("\n");
}

export interface PacketCheck {
  questionIds: string[];
  good: number;
  obviouslyFine: number;
  goodPct: number;
  unrated: string[];
  invalidRatings: string[];
  unacked: string[];
  missingQuestions: string[];
  /** Marker ids present in the packet text but NOT in the plan (review r1c #3). */
  unexpectedQuestions: string[];
  /** Marker names appearing more than once — ambiguous, never scored (r1c #3/#8). */
  duplicateMarkers: string[];
  checklistUsable: "yes" | "no" | null;
  checklistNote: string | null;
  reviewMinutes: number | null;
  budgetMinutes: number;
  withinBudget: boolean | null;
  approvable: boolean;
  meetsGoodBar: boolean;
  /** The FULL PRD §7 item-2 exit: complete ∧ ≥70% good ∧ checklist usable=yes ∧ time recorded. */
  phase0ExitPass: boolean;
}

/** Exact-match rating values; "good-ish" and friends are invalid (r1c #8). */
function normalizeRating(value: string): "good" | "obviously-fine" | "invalid" {
  const v = value
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "")
    .replace(/\s+/g, " ");
  if (v === "obviously-fine" || v === "obviously fine") return "obviously-fine";
  if (v === "good") return "good";
  return "invalid";
}

/** Collect every marker occurrence so duplicates are visible, not last-wins. */
function collectMarkers(markdown: string, name: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = new RegExp(`^${name}-(Q\\d+):[ \\t]*(.*)$`, "gm");
  for (const m of markdown.matchAll(re)) {
    const id = `Q${m[1]!.slice(1)}`;
    const list = out.get(id) ?? [];
    list.push(m[2] ?? "");
    out.set(id, list);
  }
  return out;
}

function singleValue(markdown: string, marker: string): { raw: string; count: number } {
  const matches = [...markdown.matchAll(new RegExp(`^${marker}:[ \\t]*(.*)$`, "gm"))];
  return { raw: matches[matches.length - 1]?.[1] ?? "", count: matches.length };
}

/**
 * Does the packet carry ANY human-entered value — a rating (valid or not), an
 * acknowledgment, a checklist answer or note, or any timer field? Used by the
 * overwrite guards: recorded human input is never silently clobbered, whether
 * or not it parses (review r1c finding 5).
 */
export function packetCarriesInput(markdown: string): boolean {
  for (const name of ["RATING", "ACK"]) {
    for (const values of collectMarkers(markdown, name).values()) {
      if (values.some((v) => !isUnfilled(v))) return true;
    }
  }
  for (const marker of [
    "CHECKLIST-USABLE",
    "CHECKLIST-NOTE",
    "REVIEW-START",
    "REVIEW-END",
    "REVIEW-MINUTES",
  ]) {
    if (!isUnfilled(singleValue(markdown, marker).raw)) return true;
  }
  return false;
}

/**
 * Parse a (possibly filled) packet and compute the probe's acceptance state.
 * `expectedQuestionIds` (from plan.json) is the authoritative question set:
 * markers for ids outside it are flagged, never scored — packet TEXT (e.g.
 * quoted reviewer prose in section D) must not be able to mint questions or
 * move the ≥70% figure (review r1c finding 3).
 */
export function checkPacket(markdown: string, expectedQuestionIds?: string[]): PacketCheck {
  const ratings = collectMarkers(markdown, "RATING");
  const acks = collectMarkers(markdown, "ACK");

  const found = [...new Set([...ratings.keys(), ...acks.keys()])];
  const expected = expectedQuestionIds ?? [...ratings.keys()];
  const questionIds = [...expected];
  const missingQuestions = expected.filter((q) => !ratings.has(q));
  const unexpectedQuestions = found.filter((q) => !expected.includes(q));

  const duplicateMarkers: string[] = [];
  for (const [id, values] of ratings) if (values.length > 1) duplicateMarkers.push(`RATING-${id}`);
  for (const [id, values] of acks) if (values.length > 1) duplicateMarkers.push(`ACK-${id}`);

  let good = 0;
  let obviouslyFine = 0;
  const unrated: string[] = [];
  const invalidRatings: string[] = [];
  const unacked: string[] = [];
  for (const q of questionIds) {
    const ratingValues = ratings.get(q);
    const raw = ratingValues?.length === 1 ? ratingValues[0]! : "";
    if (ratingValues === undefined || isUnfilled(raw)) {
      if (ratingValues !== undefined && ratingValues.length > 1) {
        // duplicated marker: already flagged; never scored
      }
      unrated.push(q);
    } else {
      const norm = normalizeRating(raw);
      if (norm === "good") good++;
      else if (norm === "obviously-fine") obviouslyFine++;
      else invalidRatings.push(q);
    }
    const ackValues = acks.get(q);
    const ack = ackValues?.length === 1 ? ackValues[0]! : "";
    if (ackValues === undefined || isUnfilled(ack)) unacked.push(q);
  }

  const usableRaw = singleValue(markdown, "CHECKLIST-USABLE").raw;
  let checklistUsable: "yes" | "no" | null = null;
  if (!isUnfilled(usableRaw)) {
    if (/^yes\b/i.test(usableRaw.trim())) checklistUsable = "yes";
    else if (/^no\b/i.test(usableRaw.trim())) checklistUsable = "no";
  }
  const noteRaw = singleValue(markdown, "CHECKLIST-NOTE").raw;
  const checklistNote = isUnfilled(noteRaw) ? null : noteRaw.trim();

  // Integer minutes only (an optional "min"/"minutes" suffix is tolerated);
  // "45.5" or prose is unparsed, not silently truncated (r1c #8).
  const minutesRaw = singleValue(markdown, "REVIEW-MINUTES").raw;
  let reviewMinutes: number | null = null;
  if (!isUnfilled(minutesRaw)) {
    const m = minutesRaw.trim().match(/^(\d+)\s*(?:min(?:ute)?s?)?$/i);
    if (m) reviewMinutes = Number.parseInt(m[1]!, 10);
  }

  const total = questionIds.length;
  const goodPct = total === 0 ? 0 : Math.round((good / total) * 1000) / 10;
  const approvable =
    total > 0 &&
    unrated.length === 0 &&
    invalidRatings.length === 0 &&
    unacked.length === 0 &&
    missingQuestions.length === 0 &&
    unexpectedQuestions.length === 0 &&
    duplicateMarkers.length === 0 &&
    checklistUsable !== null &&
    reviewMinutes !== null;
  const meetsGoodBar = total > 0 && goodPct >= 70;

  return {
    questionIds,
    good,
    obviouslyFine,
    goodPct,
    unrated,
    invalidRatings,
    unacked,
    missingQuestions,
    unexpectedQuestions,
    duplicateMarkers,
    checklistUsable,
    checklistNote,
    reviewMinutes,
    budgetMinutes: ATTENTION_BUDGET_MINUTES,
    withinBudget: reviewMinutes === null ? null : reviewMinutes <= ATTENTION_BUDGET_MINUTES,
    approvable,
    meetsGoodBar,
    // The conjunctive PRD §7 item-2 exit (r1c #4): completeness alone is not a pass.
    phase0ExitPass: approvable && meetsGoodBar && checklistUsable === "yes",
  };
}

/** Human summary of a check, for the CLI and the run report. */
export function describeCheck(check: PacketCheck): string {
  const lines: string[] = [];
  if (check.approvable) {
    lines.push(
      "Packet COMPLETE — every question rated + acknowledged, checklist + timer recorded.",
    );
  } else {
    lines.push("Packet INCOMPLETE — approval cannot complete (CAM-PLAN-01):");
    if (check.questionIds.length === 0) lines.push("  - no RATING-Q* markers found");
    if (check.missingQuestions.length > 0)
      lines.push(`  - missing question blocks: ${check.missingQuestions.join(", ")}`);
    if (check.unrated.length > 0) lines.push(`  - unrated: ${check.unrated.join(", ")}`);
    if (check.invalidRatings.length > 0)
      lines.push(
        `  - invalid ratings (want good|obviously-fine): ${check.invalidRatings.join(", ")}`,
      );
    if (check.unacked.length > 0) lines.push(`  - unacknowledged: ${check.unacked.join(", ")}`);
    if (check.unexpectedQuestions.length > 0)
      lines.push(
        `  - markers for questions NOT in the plan (ignored, must be removed): ` +
          check.unexpectedQuestions.join(", "),
      );
    if (check.duplicateMarkers.length > 0)
      lines.push(`  - duplicated markers (ambiguous): ${check.duplicateMarkers.join(", ")}`);
    if (check.checklistUsable === null) lines.push("  - CHECKLIST-USABLE not answered (yes|no)");
    if (check.reviewMinutes === null)
      lines.push("  - REVIEW-MINUTES not recorded (integer minutes)");
  }
  const rated = check.good + check.obviouslyFine;
  lines.push(
    `Ratings: ${check.good} good / ${check.obviouslyFine} obviously-fine of ${check.questionIds.length} ` +
      `(${check.goodPct}% good) — ${check.meetsGoodBar ? "MEETS" : "below"} the ≥70% bar`,
  );
  if (rated < check.questionIds.length) {
    lines.push(`  (${check.questionIds.length - rated} not yet rated)`);
  }
  if (check.reviewMinutes !== null) {
    lines.push(
      `Review time: ${check.reviewMinutes} min vs ${check.budgetMinutes} min budget — ` +
        `${check.withinBudget ? "within" : "OVER"} budget (CAM-OBS-02 baseline)`,
    );
  }
  if (check.checklistUsable !== null) {
    lines.push(
      `Checklist usability: ${check.checklistUsable}${check.checklistNote ? ` — ${check.checklistNote}` : ""}`,
    );
  }
  lines.push(
    `Phase-0 item-2 exit (conjunctive): ${check.phase0ExitPass ? "PASS" : "not passed"} — ` +
      `needs complete packet ∧ ≥70% good ∧ checklist usable=yes ∧ time recorded.`,
  );
  return lines.join("\n");
}
