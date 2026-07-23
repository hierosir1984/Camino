/**
 * Structured attempt-failure handoff (WP-114, CAM-PLAN-09): "failed
 * attempts hand off via structured summaries (not raw transcripts)".
 *
 * The summary is the ONLY cross-attempt handoff artifact: the next attempt
 * (and the WP-113 context pack that briefs it) sees this record, never the
 * worker's transcript. What the schema enforces, stated precisely
 * (falsification round 1, finding 13): the field set is CLOSED (an events
 * array or transcript blob has no field to ride in — unknown fields fail
 * validation), the one prose field is a SINGLE BOUNDED LINE
 * (HEADLINE_MAX_CHARS), and credential-token literals are refused in it.
 * NAMED BOUNDARY: within those bounds the headline's semantic content is
 * whatever the producer derived — a bound on SIZE and SHAPE, not a
 * semantic proof that no transcript fragment appears; producers derive it
 * only through summaryHeadline (first line, control-stripped, scrubbed).
 *
 * Every summary carries the ContractRef it executed under (CAM-PLAN-04 —
 * the attempt-record obligation row in CONTRACT_REFERENCE_OBLIGATIONS) and
 * the routing evidence the failure-handoff policy consumes: which harness/
 * family ran, how it ended, and the counter facts (failure counting itself
 * is the recorder's fold — quota waits never reach it, A.2#5).
 */

import type { BudgetBreachRecord, DispatchOutcome, KillConfirmRecord } from "./adapter.js";
import { contractRefProblems, type ContractRef } from "./contract.js";
import type { ProviderFamily, ReasoningTier } from "./routing.js";
import { PROVIDER_FAMILIES, REASONING_TIERS } from "./routing.js";
import { OFFICIAL_ADAPTER_NAMES } from "./adapter.js";

/** Bumped only by a schema change; consumers refuse generations they don't know. */
export const ATTEMPT_SUMMARY_SCHEMA_VERSION = 1;

/** The one bounded prose field (a classification headline, never a transcript). */
export const HEADLINE_MAX_CHARS = 400;

/**
 * Credential-token literal shapes refused in summary text (round-1 finding
 * 13; boundaries dropped per round-2 finding 12 — `\b` let a token glued
 * to word characters slip through, and `_` is itself a word character).
 * COVERAGE, stated precisely: the current GitHub token prefixes ONLY. A
 * generic long-opaque-token detector is deliberately NOT attempted —
 * 40/64-hex opaque strings are also commit ids and archive hashes, which
 * legitimately appear in summaries; a generic rule is either blind or
 * false-positive-ridden (the regenerating-denylist class). Scrubbed by
 * summaryHeadline and REFUSED by the validator.
 */
const TOKEN_LITERAL_RE = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;
export const TOKEN_LITERAL_PATTERN_SOURCE: string = TOKEN_LITERAL_RE.source;

function containsTokenLiteral(text: string): boolean {
  TOKEN_LITERAL_RE.lastIndex = 0;
  return TOKEN_LITERAL_RE.test(text);
}

const OUTCOMES: readonly DispatchOutcome[] = Object.freeze([
  "succeeded",
  "requirement-failed",
  "quota-blocked",
  "cancelled",
  "killed",
  "killed-budget",
]);

/** The A.3 terminal the routing recorded for the attempt. */
export const SUMMARY_ATTEMPT_TERMINALS = Object.freeze([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "killed-budget",
  "quota-blocked",
] as const);
export type SummaryAttemptTerminal = (typeof SUMMARY_ATTEMPT_TERMINALS)[number];

/**
 * The structured handoff record for one finished attempt. CLOSED field
 * set: adding a field is a schema-version bump.
 */
export interface AttemptSummary {
  readonly schemaVersion: number;
  readonly attemptId: string;
  readonly issueId: string;
  readonly missionId: string;
  /** The contract this attempt executed (CAM-PLAN-04, attempt half). */
  readonly contractRef: ContractRef;
  /** The routing assignment that ran (CAM-ROUTE-02 output tuple). */
  readonly harness: string;
  readonly family: ProviderFamily;
  readonly model: string | null;
  readonly reasoningTier: ReasoningTier;
  /** CAM-EXEC-06 classification of the dispatch. */
  readonly outcome: DispatchOutcome;
  /** The A.3 terminal the scheduler routed the attempt to. */
  readonly attemptTerminal: SummaryAttemptTerminal;
  /** Present on `failed`: the taxonomy class the verdict recorded. */
  readonly failureClass?: string;
  /** Present iff outcome is killed-budget (CAM-EXEC-03 evidence). */
  readonly budgetBreach?: BudgetBreachRecord;
  /** Present when a kill-confirm sequence ran. */
  readonly killConfirm?: Pick<KillConfirmRecord, "groupGone" | "escalatedToSigkill">;
  /** Any rate-limit signal seen on the stream (quota pressure evidence). */
  readonly quotaSignalSeen: boolean;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly streamedEvents: number;
  /** ONE bounded classification line — never transcript content. */
  readonly headline: string;
  /** ISO-8601 UTC instant the summary was recorded. */
  readonly recordedAt: string;
}

function boundedLine(field: string, value: unknown, max: number, problems: string[]): void {
  if (typeof value !== "string") {
    problems.push(`${field} must be a string`);
    return;
  }
  if (value.length > max) problems.push(`${field} exceeds ${max} UTF-16 units`);
  if (value.includes("\n") || value.includes("\r")) {
    problems.push(`${field} must be a single line`);
  }
  if (value.includes("\0")) problems.push(`${field} contains an embedded NUL`);
  if (!value.isWellFormed()) problems.push(`${field} contains unpaired surrogates`);
}

function requiredId(field: string, value: unknown, problems: string[]): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 300) {
    problems.push(`${field} must be a non-empty string of at most 300 UTF-16 units`);
    return;
  }
  boundedLine(field, value, 300, problems);
}

const ALLOWED_FIELDS = Object.freeze([
  "schemaVersion",
  "attemptId",
  "issueId",
  "missionId",
  "contractRef",
  "harness",
  "family",
  "model",
  "reasoningTier",
  "outcome",
  "attemptTerminal",
  "failureClass",
  "budgetBreach",
  "killConfirm",
  "quotaSignalSeen",
  "exitCode",
  "durationMs",
  "streamedEvents",
  "headline",
  "recordedAt",
] as const);

/**
 * Total validator; empty result licenses the cast. Refuses unknown fields
 * — the structural "not raw transcripts" guarantee: there is no field a
 * transcript or event stream could ride in.
 */
export function attemptSummaryProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["attempt summary must be a plain object"];
  }
  const record = value as Record<string, unknown>;
  const problems: string[] = [];
  if (record["schemaVersion"] !== ATTEMPT_SUMMARY_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${ATTEMPT_SUMMARY_SCHEMA_VERSION}`);
  }
  requiredId("attemptId", record["attemptId"], problems);
  requiredId("issueId", record["issueId"], problems);
  requiredId("missionId", record["missionId"], problems);
  problems.push(...contractRefProblems(record["contractRef"]));
  if (!(OFFICIAL_ADAPTER_NAMES as readonly unknown[]).includes(record["harness"])) {
    problems.push(`harness must be one of ${OFFICIAL_ADAPTER_NAMES.join(", ")}`);
  }
  if (!(PROVIDER_FAMILIES as readonly unknown[]).includes(record["family"])) {
    problems.push(`family must be one of ${PROVIDER_FAMILIES.join(", ")}`);
  }
  const model = record["model"];
  if (model !== null && typeof model !== "string") {
    problems.push("model must be null or a string");
  } else if (typeof model === "string") {
    boundedLine("model", model, 200, problems);
  }
  if (!(REASONING_TIERS as readonly unknown[]).includes(record["reasoningTier"])) {
    problems.push(`reasoningTier must be one of ${REASONING_TIERS.join(", ")}`);
  }
  if (!(OUTCOMES as readonly unknown[]).includes(record["outcome"])) {
    problems.push("outcome must be a DispatchOutcome");
  }
  if (!(SUMMARY_ATTEMPT_TERMINALS as readonly unknown[]).includes(record["attemptTerminal"])) {
    problems.push(`attemptTerminal must be one of ${SUMMARY_ATTEMPT_TERMINALS.join(", ")}`);
  }
  if (record["failureClass"] !== undefined) {
    boundedLine("failureClass", record["failureClass"], 200, problems);
  }
  const breach = record["budgetBreach"];
  if (breach !== undefined) {
    if (typeof breach !== "object" || breach === null || Array.isArray(breach)) {
      problems.push("budgetBreach must be a plain object");
    } else {
      const b = breach as Record<string, unknown>;
      if (b["kind"] !== "wall-clock" && b["kind"] !== "tokens") {
        problems.push('budgetBreach.kind must be "wall-clock" or "tokens"');
      }
      if (typeof b["limit"] !== "number" || !Number.isFinite(b["limit"])) {
        problems.push("budgetBreach.limit must be a finite number");
      }
      if (typeof b["observed"] !== "number" || !Number.isFinite(b["observed"])) {
        problems.push("budgetBreach.observed must be a finite number");
      }
      for (const key of Object.keys(b)) {
        if (!["kind", "limit", "observed"].includes(key)) {
          problems.push(`budgetBreach has unknown field ${JSON.stringify(key)}`);
        }
      }
    }
  }
  const kc = record["killConfirm"];
  if (kc !== undefined) {
    if (typeof kc !== "object" || kc === null || Array.isArray(kc)) {
      problems.push("killConfirm must be a plain object");
    } else {
      const k = kc as Record<string, unknown>;
      if (typeof k["groupGone"] !== "boolean")
        problems.push("killConfirm.groupGone must be boolean");
      if (typeof k["escalatedToSigkill"] !== "boolean") {
        problems.push("killConfirm.escalatedToSigkill must be boolean");
      }
      for (const key of Object.keys(k)) {
        if (!["groupGone", "escalatedToSigkill"].includes(key)) {
          problems.push(`killConfirm has unknown field ${JSON.stringify(key)}`);
        }
      }
    }
  }
  if (typeof record["quotaSignalSeen"] !== "boolean") {
    problems.push("quotaSignalSeen must be boolean");
  }
  const exit = record["exitCode"];
  if (exit !== null && (typeof exit !== "number" || !Number.isInteger(exit))) {
    problems.push("exitCode must be null or an integer");
  }
  const duration = record["durationMs"];
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
    problems.push("durationMs must be a finite non-negative number");
  }
  const events = record["streamedEvents"];
  if (typeof events !== "number" || !Number.isInteger(events) || events < 0) {
    problems.push("streamedEvents must be a non-negative integer");
  }
  boundedLine("headline", record["headline"], HEADLINE_MAX_CHARS, problems);
  if (typeof record["headline"] === "string" && containsTokenLiteral(record["headline"])) {
    problems.push("headline contains a credential-token literal");
  }
  const recordedAt = record["recordedAt"];
  if (
    typeof recordedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(recordedAt) ||
    Number.isNaN(Date.parse(recordedAt))
  ) {
    problems.push("recordedAt must be an ISO-8601 UTC instant (Date#toISOString form)");
  }
  for (const key of Object.keys(record)) {
    if (!(ALLOWED_FIELDS as readonly string[]).includes(key)) {
      problems.push(`attempt summary has unknown field ${JSON.stringify(key)}`);
    }
  }
  return problems;
}

/**
 * Derive the single-line bounded headline from a dispatch's final text:
 * first line only, control characters stripped, capped. This is the ONLY
 * path from worker output into a summary — one line, bounded, flattened
 * (the WP-105 sliced-string lesson: copy through a Buffer so a short
 * visible slice cannot retain a large hidden backing).
 */
export function summaryHeadline(finalText: string): string {
  let line: string;
  try {
    const firstLine = String(finalText).split(/[\r\n]/, 1)[0] ?? "";
    // eslint-disable-next-line no-control-regex
    const cleaned = firstLine.replace(/[\u0000-\u001f\u007f]/g, " ");
    // Scrub credential-token literals BEFORE capping (a token straddling
    // the cap must not survive as a recognizable prefix).
    TOKEN_LITERAL_RE.lastIndex = 0;
    const scrubbed = cleaned.replace(TOKEN_LITERAL_RE, "[token-scrubbed]");
    const capped =
      scrubbed.length > HEADLINE_MAX_CHARS ? scrubbed.slice(0, HEADLINE_MAX_CHARS) : scrubbed;
    line = Buffer.from(capped, "utf16le").toString("utf16le");
  } catch {
    line = "";
  }
  return line.isWellFormed() ? line : line.toWellFormed();
}
