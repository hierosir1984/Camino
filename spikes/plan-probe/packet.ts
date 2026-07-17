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

function isUnfilled(value: string): boolean {
  const v = value.trim();
  return v.length === 0 || /^_+$/.test(v);
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
    "_planner misclassified as non-requirement; the adversarial review in section D adjudicates_",
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

  // --- D. adversarial review ---
  push(
    "## D. Cross-family adversarial review (attached — CAM-PLAN-03)",
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
  checklistUsable: "yes" | "no" | null;
  checklistNote: string | null;
  reviewMinutes: number | null;
  budgetMinutes: number;
  withinBudget: boolean | null;
  approvable: boolean;
  meetsGoodBar: boolean;
}

function normalizeRating(value: string): "good" | "obviously-fine" | "invalid" {
  const v = value
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "");
  if (/^obviously[\s-]?fine\b/.test(v)) return "obviously-fine";
  if (/^good\b/.test(v)) return "good";
  return "invalid";
}

/**
 * Parse a (possibly filled) packet and compute the probe's acceptance state.
 * `expectedQuestionIds` (from plan.json) guards against marker lines being
 * accidentally deleted while editing the packet.
 */
export function checkPacket(markdown: string, expectedQuestionIds?: string[]): PacketCheck {
  const ratings = new Map<string, string>();
  const acks = new Map<string, string>();
  for (const m of markdown.matchAll(/^RATING-(Q\d+):[ \t]*(.*)$/gm)) {
    ratings.set(`Q${m[1]!.slice(1)}`, m[2] ?? "");
  }
  for (const m of markdown.matchAll(/^ACK-(Q\d+):[ \t]*(.*)$/gm)) {
    acks.set(`Q${m[1]!.slice(1)}`, m[2] ?? "");
  }

  const questionIds = [...ratings.keys()];
  const missingQuestions = (expectedQuestionIds ?? []).filter((q) => !ratings.has(q));

  let good = 0;
  let obviouslyFine = 0;
  const unrated: string[] = [];
  const invalidRatings: string[] = [];
  const unacked: string[] = [];
  for (const q of questionIds) {
    const raw = ratings.get(q) ?? "";
    if (isUnfilled(raw)) {
      unrated.push(q);
    } else {
      const norm = normalizeRating(raw);
      if (norm === "good") good++;
      else if (norm === "obviously-fine") obviouslyFine++;
      else invalidRatings.push(q);
    }
    const ack = acks.get(q) ?? "";
    if (isUnfilled(ack)) unacked.push(q);
  }

  const usableMatch = markdown.match(/^CHECKLIST-USABLE:[ \t]*(.*)$/m);
  const usableRaw = usableMatch?.[1] ?? "";
  let checklistUsable: "yes" | "no" | null = null;
  if (!isUnfilled(usableRaw)) {
    if (/^yes\b/i.test(usableRaw.trim())) checklistUsable = "yes";
    else if (/^no\b/i.test(usableRaw.trim())) checklistUsable = "no";
  }
  const noteMatch = markdown.match(/^CHECKLIST-NOTE:[ \t]*(.*)$/m);
  const noteRaw = noteMatch?.[1] ?? "";
  const checklistNote = isUnfilled(noteRaw) ? null : noteRaw.trim();

  const minutesMatch = markdown.match(/^REVIEW-MINUTES:[ \t]*(.*)$/m);
  const minutesRaw = minutesMatch?.[1] ?? "";
  let reviewMinutes: number | null = null;
  if (!isUnfilled(minutesRaw)) {
    const n = Number.parseInt(minutesRaw.trim(), 10);
    if (Number.isFinite(n) && n >= 0) reviewMinutes = n;
  }

  const total = questionIds.length;
  const goodPct = total === 0 ? 0 : Math.round((good / total) * 1000) / 10;
  const approvable =
    total > 0 &&
    unrated.length === 0 &&
    invalidRatings.length === 0 &&
    unacked.length === 0 &&
    missingQuestions.length === 0 &&
    checklistUsable !== null &&
    reviewMinutes !== null;

  return {
    questionIds,
    good,
    obviouslyFine,
    goodPct,
    unrated,
    invalidRatings,
    unacked,
    missingQuestions,
    checklistUsable,
    checklistNote,
    reviewMinutes,
    budgetMinutes: ATTENTION_BUDGET_MINUTES,
    withinBudget: reviewMinutes === null ? null : reviewMinutes <= ATTENTION_BUDGET_MINUTES,
    approvable,
    meetsGoodBar: total > 0 && goodPct >= 70,
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
    if (check.checklistUsable === null) lines.push("  - CHECKLIST-USABLE not answered (yes|no)");
    if (check.reviewMinutes === null) lines.push("  - REVIEW-MINUTES not recorded");
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
  return lines.join("\n");
}
