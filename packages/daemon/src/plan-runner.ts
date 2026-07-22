/**
 * Planner runner (WP-110): drives a WP-105 worker adapter to compile a
 * PRD into a plan, streaming construction records into the planning
 * service AS THE WORKER EMITS THEM (CAM-PLAN-01 "streaming to the board
 * as constructed").
 *
 * Protocol — harness-agnostic by design: the worker appends one JSON
 * construction record per line to `plan-stream.jsonl` in its workspace,
 * and the runner tails that file while the dispatch runs. Coupling to a
 * file the worker writes (not to each vendor CLI's own event stream)
 * means every adapter — Claude Code, Codex CLI, Grok Build, mock — uses
 * one protocol, and the ingest path is byte-identical to the scripted
 * fixture path the CI suite exercises.
 *
 * Worker output is DATA (CAM-EXEC-09): every line passes the shared total
 * validator plus the service's cross-record checks; a refused line is
 * recorded in the run record and never crashes the daemon. The planner
 * holds no repository credentials and never touches the stores — the
 * service seam is the only write path, and it validates everything.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAN_STREAM_FILENAME } from "@camino/shared";
import type { AdapterSpec, DispatchOutcome } from "@camino/shared";
import { dispatch } from "./dispatch/lifecycle.js";
import type { DispatchOptions } from "./dispatch/lifecycle.js";
import { PlanningError, PlanningService } from "./planning.js";

/** One refused stream line: the line number and the named reason. */
export interface RefusedLine {
  readonly line: number;
  readonly problem: string;
}

export interface PlannerRunRecord {
  readonly outcome: DispatchOutcome;
  /** Records accepted into the plan store, in arrival order. */
  readonly ingested: number;
  /** Lines the validators or cross-record checks refused (named reasons). */
  readonly refused: readonly RefusedLine[];
  /** True when the session's construction-complete record landed. */
  readonly constructionComplete: boolean;
}

export interface PlannerRunOptions {
  readonly adapter: AdapterSpec;
  readonly service: PlanningService;
  readonly sessionId: string;
  /** Parent directory for the planner workspace (a temp dir by default). */
  readonly workdirRoot?: string;
  /** Tail poll interval, ms. */
  readonly pollMs?: number;
  /** Hard wall-clock cap for the dispatch. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Sink for raw transcript lines (the dispatch's onLine). */
  readonly onLine?: DispatchOptions["onLine"];
  /** Keep the workspace for inspection instead of removing it. */
  readonly keepWorkspace?: boolean;
}

/** The planner worker's instructions: inputs on disk, the stream protocol, the mandate. */
export function plannerPrompt(input: { missionTitle: string; template: string }): string {
  return [
    `You are the Camino planner. Compile the PRD for mission "${input.missionTitle}"`,
    `(template: ${input.template}) into an executable plan.`,
    "",
    "Inputs in your working directory:",
    "  - plan-input/prd.md — the PRD text, verbatim.",
    "  - plan-input/segments.json — the PRD split into segments, each with a",
    "    segmentId; every checklist row and clarification references these ids.",
    "",
    `Output protocol: append one JSON object per line to ./${PLAN_STREAM_FILENAME}`,
    "as you work — each record the moment you have it, not batched at the end.",
    "Record shapes:",
    '  {"kind":"issue","issue":{"planIssueId":"I1","title":…,"goal":…,"acceptanceCriteria":[…],"dependsOn":["I…"],"interfaces":[{"name":…,"kind":"api|cli|module|schema|event|file-format|other","description":…}]}}',
    '  {"kind":"clarification","clarification":{"clarificationId":"Q1","question":…,"whyItMatters":…,"assumptionIfUnanswered":…,"relatedSegmentIds":["S…"],"relatedPlanIssueIds":["I…"]}}',
    '  {"kind":"checklist-row","row":{"segmentId":"S…","disposition":"mapped","proposedStatement":…,"proposedArea":"AREA","mappedPlanIssueIds":["I…"]}}',
    '  {"kind":"checklist-row","row":{"segmentId":"S…","disposition":"unmapped","reason":"context|non-requirement|out-of-scope|duplicate"}}',
    '  {"kind":"construction-complete"}',
    "",
    "Mandate:",
    "  - Every segment gets exactly one checklist row; segments that state no",
    "    requirement of this mission are unmapped with the honest reason.",
    "  - Acceptance criteria are observable pass/fail checks, not restatements.",
    "  - Wherever the PRD underdetermines a decision you need, emit a",
    "    clarification carrying the exact assumption you would otherwise bake",
    "    in. Do not silently guess: an assumption without a clarification is a",
    "    planning defect.",
    "  - Dependencies between issues use dependsOn; keep the graph acyclic.",
    "  - Declare the interfaces each issue exposes to its dependents.",
    `  - Finish with the construction-complete record, then exit.`,
  ].join("\n");
}

/**
 * Run one planner compile over the session. Resolves when the dispatch
 * settles and the stream file is fully drained. The workspace is removed
 * afterwards unless keepWorkspace is set.
 */
export async function runPlannerCompile(options: PlannerRunOptions): Promise<PlannerRunRecord> {
  const { adapter, service, sessionId } = options;
  const pollMs = options.pollMs ?? 150;
  const brief = service.sessionBrief(sessionId);
  const workdir = mkdtempSync(join(options.workdirRoot ?? tmpdir(), "camino-plan-"));
  const refused: RefusedLine[] = [];
  let ingested = 0;
  let offset = 0;
  let lineNumber = 0;
  const streamPath = join(workdir, PLAN_STREAM_FILENAME);

  let shrunk = false;

  const ingestLine = (line: string): void => {
    lineNumber += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      refused.push({ line: lineNumber, problem: "not valid JSON" });
      return;
    }
    try {
      service.ingest(sessionId, parsed);
      ingested += 1;
    } catch (error) {
      if (error instanceof PlanningError) {
        refused.push({ line: lineNumber, problem: error.message });
        return;
      }
      throw error;
    }
  };

  /**
   * Drain the unseen suffix. Mid-run only COMPLETE (newline-terminated)
   * lines are consumed; on the FINAL drain — after the worker exited, so
   * the file can no longer grow — an unterminated last line is a finished
   * record and is ingested too (r1 finding 10: an EOF record without a
   * trailing newline must not be silently dropped). A file that SHRINKS
   * below the consumed offset is a protocol violation (the worker rewrote
   * history): refused by name once, then ignored — never silently re-read.
   */
  const drain = (final: boolean): void => {
    if (shrunk) return;
    try {
      statSync(streamPath);
    } catch {
      return; // not created yet
    }
    // Offsets are string (code-unit) indices throughout — the byte size from
    // stat is only an existence probe, never compared against them.
    const text = readFileSync(streamPath, "utf8");
    if (text.length < offset) {
      shrunk = true;
      refused.push({
        line: lineNumber + 1,
        problem:
          `stream file shrank from consumed offset ${offset} to ${text.length} — ` +
          "the worker rewrote history; further records refused",
      });
      return;
    }
    const unseen = text.slice(offset);
    const lastNewline = unseen.lastIndexOf("\n");
    const complete = lastNewline === -1 ? "" : unseen.slice(0, lastNewline);
    if (lastNewline !== -1) {
      offset += lastNewline + 1;
      for (const line of complete.split("\n")) ingestLine(line);
    }
    if (final) {
      const tail = text.slice(offset);
      if (tail.trim().length > 0) {
        offset = text.length;
        ingestLine(tail);
      }
    }
  };

  try {
    mkdirSync(join(workdir, "plan-input"));
    writeFileSync(join(workdir, "plan-input", "prd.md"), brief.content);
    writeFileSync(
      join(workdir, "plan-input", "segments.json"),
      JSON.stringify(brief.segments, null, 2) + "\n",
    );

    const dispatchPromise = dispatch(
      adapter,
      {
        workdir,
        prompt: plannerPrompt({ missionTitle: brief.missionTitle, template: brief.template }),
      },
      {
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.onLine !== undefined ? { onLine: options.onLine } : {}),
      },
    );

    let settled = false;
    const settle = dispatchPromise.then(
      (record) => {
        settled = true;
        return record;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );
    while (!settled) {
      drain(false);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    const record = await settle;
    drain(true); // final drain after exit — including an unterminated last record
    return {
      outcome: record.outcome,
      ingested,
      refused,
      constructionComplete: service.planView(sessionId).status !== "constructing",
    };
  } finally {
    if (options.keepWorkspace !== true) {
      rmSync(workdir, { recursive: true, force: true });
    }
  }
}
