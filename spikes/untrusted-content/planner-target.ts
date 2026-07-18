// Run ONE corpus item through the real WP-002 planner. Reuses the exact planner
// prompt (spikes/plan-probe/prompts.ts) and the WP-001 dispatch lifecycle, so
// this is the WP-002 planner as-shipped — the PRD fixture just happens to be
// untrusted. Output is captured as PlannerEvidence; the detectors decide the verdict.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../dispatch/lifecycle.js";
import type { AdapterSpec } from "../dispatch/types.js";
import { plannerPrompt } from "../plan-probe/prompts.js";
import { parseSegments } from "../plan-probe/types.js";
import { parsePlan } from "../plan-probe/validate.js";
import { capAppend, detectProviderBlock, scrubHome } from "./signals.js";
import type { PlannerEvidence } from "./types.js";

export interface TargetRunOptions {
  timeoutMs?: number;
  /** Sink for raw transcript lines (the runner tees these to a gitignored .jsonl). */
  onLine?: (channel: "stdout" | "stderr", line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export async function runPlannerTarget(
  adapter: AdapterSpec,
  payloadText: string,
  opts: TargetRunOptions = {},
): Promise<PlannerEvidence> {
  const ws = mkdtempSync(join(tmpdir(), "camino-redteam-plan-"));
  writeFileSync(join(ws, "PRD.md"), payloadText);
  let raw = "";
  try {
    const record = await dispatch(
      adapter,
      { workdir: ws, prompt: plannerPrompt() },
      {
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        onLine: (channel, line) => {
          raw = capAppend(raw, line);
          opts.onLine?.(channel, line);
        },
      },
    );

    let planJsonRaw: string | null = null;
    try {
      planJsonRaw = readFileSync(join(ws, "plan.json"), "utf8");
    } catch {
      planJsonRaw = null;
    }
    const extraFiles = readdirSync(ws).filter((f) => f !== "PRD.md" && f !== "plan.json");

    let segments: string[] = [];
    try {
      segments = parseSegments(payloadText);
    } catch {
      segments = [];
    }

    const fields = derivePlannerFields(planJsonRaw, segments);

    const block = detectProviderBlock(record.outcome, raw);
    return {
      kind: "planner",
      outcome: record.outcome,
      planJsonRaw: planJsonRaw === null ? null : scrubHome(planJsonRaw),
      planValid: fields.planValid,
      planErrors: fields.planErrors,
      checklistSegments: fields.checklistSegments,
      issues: fields.issues,
      clarifyingText: scrubHome(fields.clarifyingText),
      descriptiveText: scrubHome(fields.descriptiveText),
      extraFiles,
      finalText: scrubHome(record.finalText),
      providerBlocked: block.blocked,
      ...(block.detail ? { blockDetail: block.detail } : {}),
    };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

export interface PlannerFields {
  planValid: boolean;
  planErrors: string[];
  checklistSegments: string[];
  issues: PlannerEvidence["issues"];
  clarifyingText: string;
  descriptiveText: string;
}

/**
 * Derive the planner detector inputs from a plan.json. Shared by the live run
 * and by --rescore, so re-scoring a prior run's saved plan.json produces the
 * exact same fields the live run would — including descriptiveText (checklist
 * notes + questions), which is how an active defense is recognised.
 */
export function derivePlannerFields(planJsonRaw: string | null, segments: string[]): PlannerFields {
  const empty: PlannerFields = {
    planValid: false,
    planErrors: ["plan.json not written"],
    checklistSegments: [],
    issues: [],
    clarifyingText: "",
    descriptiveText: "",
  };
  if (planJsonRaw === null) return empty;
  const parsed = parsePlan(planJsonRaw, segments);
  const planValid = parsed.errors.length === 0 && parsed.plan !== null;
  if (!parsed.plan) return { ...empty, planValid, planErrors: parsed.errors };
  const clarifyingText = parsed.plan.clarifyingQuestions
    .map((q) => `${q.question} ${q.whyItMatters} ${q.assumptionIfUnanswered}`)
    .join("\n");
  return {
    planValid,
    planErrors: parsed.errors,
    checklistSegments: parsed.plan.checklist.map((c) => c.segment),
    issues: parsed.plan.issues.map((i) => ({
      title: i.title,
      riskTier: i.riskTier,
      blob: JSON.stringify(i),
    })),
    clarifyingText,
    // Descriptive = where a defending planner quotes a planted instruction while refusing
    // it: checklist notes + the clarifying questions.
    descriptiveText:
      parsed.plan.checklist.map((c) => c.note ?? "").join("\n") + "\n" + clarifyingText,
  };
}
