// The planner and reviewer worker prompts. Pure builders so tests can assert
// the load-bearing instructions (schema, no-silent-assumptions rule, the
// falsification mandate) are actually present in what gets dispatched.

/** JSON shape shown to the planner verbatim (kept in sync with types.ts). */
export const PLAN_SCHEMA_TEXT = `{
  "missionTitle": string,
  "issues": [
    {
      "id": "I1",                       // unique, I<n>
      "title": string,
      "goal": string,                   // one or two sentences
      "acceptanceCriteria": [string],   // observable pass/fail checks, >=1
      "mappedSegments": ["S3"],         // fixture segment tags this issue draws its mandate from, >=1
      "dependsOn": ["I2"],              // may be []
      "riskTier": "low" | "medium" | "high"
    }
  ],
  "clarifyingQuestions": [
    {
      "id": "Q1",                       // unique, Q<n>
      "question": string,
      "whyItMatters": string,           // what changes in the plan depending on the answer
      "assumptionIfUnanswered": string, // the PRECISE assumption baked into the plan meanwhile
      "blocking": boolean,              // must be resolved before plan approval (vs before the affected issue starts)
      "relatedSegments": ["S5"],
      "relatedIssues": ["I2"]
    }
  ],
  "checklist": [                        // EXACTLY one row per [S*] segment in PRD.md
    {
      "segment": "S9",
      "isRequirement": boolean,         // is this segment an obligation of THIS mission?
      "proposedLedgerEntry": { "id": "LED-1", "statement": string } | null,
                                        // required iff isRequirement; null flags non-requirement text
      "mappedIssues": ["I1"],           // issues implementing it (may be [] with a note, e.g. deferred)
      "note": string                    // optional rationale
    }
  ]
}`;

/** JSON shape shown to the reviewer verbatim (kept in sync with types.ts). */
export const REVIEW_SCHEMA_TEXT = `{
  "verdict": "approve" | "approve-with-findings" | "reject",
  "summary": string,                    // 2-4 sentences, the review's overall claim
  "findings": [
    {
      "id": "F1",                       // unique, F<n>
      "severity": "blocker" | "major" | "minor",
      "class": "dropped-requirement" | "unstated-assumption" | "criteria-defect"
             | "mapping-defect" | "scope-creep" | "bad-premise" | "question-quality" | "other",
      "claim": string,                  // the specific defect
      "evidence": string,               // segment/issue refs + reasoning grounding it
      "suggestedFix": string
    }
  ]
}`;

export function plannerPrompt(): string {
  return `You are the mission planner for Camino, a local-first mission-control tool that executes PRDs end-to-end on coding agents. Compile the PRD in this directory into an executable mission plan.

Read ./PRD.md fully. It is segmented: every substantive block starts with a tag like [S7]. Your plan must account for EVERY segment.

Write EXACTLY ONE file, ./plan.json — plain UTF-8 JSON, no markdown fences, no comments — conforming to this schema:

${PLAN_SCHEMA_TEXT}

Hard rules:
1. Checklist completeness: exactly one checklist row per [S*] segment in PRD.md, including context/motivation segments (those get isRequirement=false, proposedLedgerEntry=null, and a note saying why). A missing or duplicated segment row is a planning defect.
2. NO SILENT ASSUMPTIONS — this is the core discipline. Wherever the PRD underdetermines something you had to decide to make the plan concrete, record a clarifyingQuestion whose assumptionIfUnanswered states precisely what the plan currently assumes. An assumption baked into an issue without a question is a planning defect.
3. No padding questions: do not ask anything answerable from the PRD text itself. Every question must be one whose answer plausibly changes the plan.
4. Acceptance criteria are observable checks a reviewer could verify pass/fail — never restatements of the goal, and not passable by a stub.
5. Mission scale: 3–6 issues, each independently implementable and reviewable; dependsOn only where a real ordering exists.
6. riskTier per issue: low = internal/docs/tests; medium = user-observable behavior; high floor = auth/payments/data-migrations/secrets handling.
7. Scope discipline: this mission covers this PRD only. If a segment is context about surrounding systems rather than an obligation of this mission, mark it isRequirement=false and say why in its note — do not invent issues for it.
8. Do not modify PRD.md. Do not write any file other than ./plan.json.

Keep any streamed commentary brief; ./plan.json is the deliverable.`;
}

export function reviewerPrompt(): string {
  return `You are the cross-family falsification plan reviewer for Camino (CAM-PLAN-03). A planner from a DIFFERENT model family compiled ./PRD.md into ./plan.json. Your mandate is FALSIFICATION: find defects, ambiguities, missing requirements, and bad premises in that plan. You are not a commenter — every finding must be a specific defect claim with evidence, and a soft review that misses a real defect is a failed review.

Read ./PRD.md (segment-tagged: blocks start with [S7]-style tags) and ./plan.json.

Hunt specifically, in this order:
- dropped-requirement: a requirement segment whose obligations are NOT actually delivered by any issue's acceptance criteria. Check segment by segment — the checklist may CLAIM coverage the criteria don't deliver.
- unstated-assumption: a decision baked into issues or criteria that the PRD does not determine and that no clarifyingQuestion surfaces.
- criteria-defect: acceptance criteria that are unobservable, tautological, or passable by a stub implementation.
- mapping-defect: checklist rows misclassified (a requirement marked non-requirement, or vice versa), wrong issue mappings, or ledger statements that do not faithfully restate their segment.
- scope-creep: issues or criteria with no mandate in any segment.
- bad-premise: the plan relies on a claim about the PRD or its context that is false.
- question-quality: clarifyingQuestions that are padding (answerable from the PRD text) — name each.

Write EXACTLY ONE file, ./review.json — plain UTF-8 JSON, no markdown fences, no comments — conforming to this schema:

${REVIEW_SCHEMA_TEXT}

Severity: blocker = the plan should not be approved until fixed; major = must be fixed before the affected issue executes; minor = worth recording.
Verdict "approve" is only valid with ZERO findings.
Do not modify PRD.md or plan.json. Do not write any file other than ./review.json.

Keep any streamed commentary brief; ./review.json is the deliverable.`;
}
