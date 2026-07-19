/**
 * Intent lifecycle (WP-104): the pure decision layer of the intent
 * journal, mirroring the WP-101 split — decisions here in core, the
 * SQLite shell in the daemon.
 *
 * The lifecycle is deliberately small and closed:
 *
 *   recorded ──► execution-started ──► confirmed            (terminal)
 *      ▲                │        └──► failed                (terminal)
 *      │                ├──► re-armed ──► (recorded)
 *      │                └──► ambiguity-recorded ──► escalated
 *      │                                               │
 *      ├──── retry-authorized (David) ◄────────────────┤
 *      │                                               └──► abandoned
 *      └─ (re-armed / retry-authorized fold back to executable)   (terminal, David)
 *
 * Everything a later decision needs is validated at the moment it is
 * appended: `recorded` rows must carry a complete, closed-schema
 * operation spec (the §4.4 reconciliation keys are IN the spec — the log
 * is the decision record, CAM-STATE-03); the two human rows are
 * actor-bound to David exactly like the WP-101 David rows; and
 * `verifyIntentLog` re-derives every recorded row through the same
 * `decideIntentAppend` used at write time, so a journal whose history the
 * lifecycle disagrees with is refused at open (fail-closed recovery, the
 * WP-101 invariant carried over).
 */
import {
  INTENT_EVENTS,
  INTENT_ID_PATTERN,
  LABEL_DESIRED_STATES,
  OPERATION_CLASSES,
  OPERATION_TARGET_KINDS,
  intentMarkerToken,
} from "@camino/shared";
import type {
  ExternalOperationSpec,
  IntentEventName,
  IntentEventRecord,
  IntentStatus,
  OperationResult,
} from "@camino/shared";

/** How a confirmation or failure came about. */
export const INTENT_RESOLUTION_ROUTES = ["response", "reconciliation"] as const;
export type IntentResolutionRoute = (typeof INTENT_RESOLUTION_ROUTES)[number];

/** The folded state of one intent. */
export interface IntentViewEntry {
  readonly intentId: string;
  status: IntentStatus;
  readonly spec: ExternalOperationSpec;
  /** How many times execution has ever started (at-most-once evidence). */
  executionStartedCount: number;
  /** The recorded result of the last confirmation, if any. */
  result: OperationResult | null;
  confirmedVia: IntentResolutionRoute | null;
  /** The last durably recorded ambiguity reason, if any. */
  ambiguityReason: string | null;
  lastSeq: number;
}

/** Folded journal: one entry per intent id. */
export type IntentView = Map<string, IntentViewEntry>;

/** What a journal writer submits; the store assigns seq and recordedAt. */
export interface IntentAppendInput {
  readonly intentId: string;
  readonly event: IntentEventName;
  readonly actor: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type IntentAppendDecision =
  { readonly ok: true } | { readonly ok: false; readonly problem: string };

export interface IntentLogDivergence {
  readonly seq: number;
  readonly problem: string;
}

/** The actor string the David-bound rows require (WP-101 convention). */
export const DAVID_ACTOR = "david";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Intent ids obey the closed grammar (round 2 finding 1): the token-
 * containment proof in @camino/shared external-ops depends on ids never
 * carrying the delimiter characters, so the grammar is enforced wherever
 * an id enters the decision path — every append and every replay.
 */
function intentIdProblem(value: unknown): string | null {
  if (typeof value !== "string") return "intentId must be a string";
  if (!INTENT_ID_PATTERN.test(value)) {
    return `intentId must match ${INTENT_ID_PATTERN} (Camino-generated ids only — the marker-token containment proof depends on this grammar)`;
  }
  return null;
}

function stringProblem(field: string, value: unknown, requireNonEmpty = true): string | null {
  if (typeof value !== "string") return `${field} must be a string`;
  if (requireNonEmpty && value.length === 0) return `${field} must be non-empty`;
  if (!value.isWellFormed()) return `${field} contains unpaired surrogate code units`;
  if (value.includes("\u0000")) return `${field} contains an embedded NUL`;
  return null;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;

function shaProblem(field: string, value: unknown): string | null {
  const base = stringProblem(field, value);
  if (base !== null) return base;
  if (!SHA_PATTERN.test(value as string)) {
    return `${field} must be a 40-character lowercase hex SHA`;
  }
  return null;
}

function positiveIntegerProblem(field: string, value: unknown): string | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return `${field} must be a positive integer`;
  }
  return null;
}

/**
 * Closed-schema validation: exactly the declared keys, every one shaped as
 * declared. Extra keys are refused — a spec is a durable decision record,
 * and an unvalidated field would become an unvalidated decision later.
 */
function closedSchemaProblem(
  value: Record<string, unknown>,
  declared: readonly string[],
): string | null {
  for (const key of Object.keys(value)) {
    if (!declared.includes(key)) return `unexpected field ${JSON.stringify(key)}`;
  }
  for (const key of declared) {
    if (!(key in value)) return `missing field ${JSON.stringify(key)}`;
  }
  return null;
}

export type SpecValidation =
  | { readonly ok: true; readonly spec: ExternalOperationSpec }
  | { readonly ok: false; readonly problem: string };

/**
 * Validate an unknown value as a complete §4.4 operation spec. Field-level
 * string discipline matches the WP-103 durable boundary (well-formed
 * UTF-16, no embedded NUL) so every recorded decision round-trips exactly.
 *
 * When `intentId` is supplied (the journal's recorded-row path always
 * supplies it), the marker-keyed classes are BOUND to it: bodyMarker /
 * marker / correlationId must equal the intent's own id, and marked
 * bodies must embed the DELIMITED token form. An unbound marker is how a
 * reconciler confirms someone else's effect (review round 1, finding 1).
 */
export function validateOperationSpec(value: unknown, intentId?: string): SpecValidation {
  if (!isPlainObject(value)) {
    return { ok: false, problem: "operation spec must be a plain object" };
  }
  const op = value["op"];
  if (typeof op !== "string" || !(OPERATION_CLASSES as readonly string[]).includes(op)) {
    return {
      ok: false,
      problem: `op must be one of the §4.4 operation classes, got ${JSON.stringify(op)}`,
    };
  }
  const problem =
    specFieldsProblem(value, op as ExternalOperationSpec["op"]) ??
    (intentId === undefined
      ? null
      : intentBindingProblem(value, op as ExternalOperationSpec["op"], intentId));
  if (problem !== null) {
    return { ok: false, problem: `${op}: ${problem}` };
  }
  return { ok: true, spec: value as unknown as ExternalOperationSpec };
}

/**
 * The reconciliation keys that claim to be "the intent UUID" must BE the
 * intent's id, and marked bodies must carry the delimited token (prefix-
 * collision-proof) rather than a bare substring.
 */
function intentBindingProblem(
  value: Record<string, unknown>,
  op: ExternalOperationSpec["op"],
  intentId: string,
): string | null {
  switch (op) {
    case "pr-create": {
      if (value["bodyMarker"] !== intentId) {
        return `bodyMarker must equal the intent id ${JSON.stringify(intentId)} (the marker IS the intent UUID)`;
      }
      if (!(value["body"] as string).includes(intentMarkerToken(intentId))) {
        return `body must embed the delimited marker token ${intentMarkerToken(intentId)}`;
      }
      return null;
    }
    case "comment-post": {
      if (value["marker"] !== intentId) {
        return `marker must equal the intent id ${JSON.stringify(intentId)} (the marker IS the intent UUID)`;
      }
      if (!(value["body"] as string).includes(intentMarkerToken(intentId))) {
        return `body must embed the delimited marker token ${intentMarkerToken(intentId)}`;
      }
      return null;
    }
    case "workflow-dispatch": {
      if (value["correlationId"] !== intentId) {
        return `correlationId must equal the intent id ${JSON.stringify(intentId)} (camino_intent_id is the intent's own id)`;
      }
      return null;
    }
    default:
      return null;
  }
}

function specFieldsProblem(
  value: Record<string, unknown>,
  op: ExternalOperationSpec["op"],
): string | null {
  switch (op) {
    case "branch-create": {
      return (
        closedSchemaProblem(value, ["op", "repo", "branch", "targetSha"]) ??
        stringProblem("repo", value["repo"]) ??
        stringProblem("branch", value["branch"]) ??
        shaProblem("targetSha", value["targetSha"])
      );
    }
    case "push": {
      return (
        closedSchemaProblem(value, ["op", "repo", "ref", "intendedSha", "expectedBaseSha"]) ??
        stringProblem("repo", value["repo"]) ??
        stringProblem("ref", value["ref"]) ??
        shaProblem("intendedSha", value["intendedSha"]) ??
        shaProblem("expectedBaseSha", value["expectedBaseSha"])
      );
    }
    case "pr-create": {
      const base =
        closedSchemaProblem(value, [
          "op",
          "repo",
          "headBranch",
          "baseBranch",
          "title",
          "bodyMarker",
          "body",
        ]) ??
        stringProblem("repo", value["repo"]) ??
        stringProblem("headBranch", value["headBranch"]) ??
        stringProblem("baseBranch", value["baseBranch"]) ??
        stringProblem("title", value["title"]) ??
        stringProblem("bodyMarker", value["bodyMarker"]) ??
        stringProblem("body", value["body"]);
      if (base !== null) return base;
      if (!(value["body"] as string).includes(value["bodyMarker"] as string)) {
        return "body must embed bodyMarker — the marker IS the corroboration mechanism";
      }
      return null;
    }
    case "merge-by-push": {
      return (
        closedSchemaProblem(value, ["op", "repo", "targetRef", "mergeSha", "expectedBaseSha"]) ??
        stringProblem("repo", value["repo"]) ??
        stringProblem("targetRef", value["targetRef"]) ??
        shaProblem("mergeSha", value["mergeSha"]) ??
        shaProblem("expectedBaseSha", value["expectedBaseSha"])
      );
    }
    case "label-set": {
      const base =
        closedSchemaProblem(value, [
          "op",
          "repo",
          "targetKind",
          "targetNumber",
          "label",
          "desired",
        ]) ??
        stringProblem("repo", value["repo"]) ??
        stringProblem("label", value["label"]) ??
        positiveIntegerProblem("targetNumber", value["targetNumber"]);
      if (base !== null) return base;
      if (!(OPERATION_TARGET_KINDS as readonly unknown[]).includes(value["targetKind"])) {
        return `targetKind must be one of ${OPERATION_TARGET_KINDS.join("/")}`;
      }
      if (!(LABEL_DESIRED_STATES as readonly unknown[]).includes(value["desired"])) {
        return `desired must be one of ${LABEL_DESIRED_STATES.join("/")}`;
      }
      return null;
    }
    case "comment-post": {
      const base =
        closedSchemaProblem(value, [
          "op",
          "repo",
          "targetKind",
          "targetNumber",
          "body",
          "marker",
        ]) ??
        stringProblem("repo", value["repo"]) ??
        stringProblem("body", value["body"]) ??
        stringProblem("marker", value["marker"]) ??
        positiveIntegerProblem("targetNumber", value["targetNumber"]);
      if (base !== null) return base;
      if (!(OPERATION_TARGET_KINDS as readonly unknown[]).includes(value["targetKind"])) {
        return `targetKind must be one of ${OPERATION_TARGET_KINDS.join("/")}`;
      }
      if (!(value["body"] as string).includes(value["marker"] as string)) {
        return "body must embed marker — the embedded UUID is the reconciliation key";
      }
      return null;
    }
    case "workflow-dispatch": {
      return (
        closedSchemaProblem(value, ["op", "repo", "workflow", "ref", "correlationId"]) ??
        stringProblem("repo", value["repo"]) ??
        stringProblem("workflow", value["workflow"]) ??
        stringProblem("ref", value["ref"]) ??
        stringProblem("correlationId", value["correlationId"])
      );
    }
    case "test-service-mutation": {
      const base =
        closedSchemaProblem(value, ["op", "environmentId", "mutation", "irreversible"]) ??
        stringProblem("environmentId", value["environmentId"]) ??
        stringProblem("mutation", value["mutation"]);
      if (base !== null) return base;
      if (typeof value["irreversible"] !== "boolean") {
        return "irreversible must be a boolean — the flag decides recovery, so it is declared at intent time";
      }
      return null;
    }
    case "catch-all": {
      return (
        closedSchemaProblem(value, ["op", "description"]) ??
        stringProblem("description", value["description"])
      );
    }
  }
}

function resultProblem(field: string, value: unknown): string | null {
  if (!isPlainObject(value)) return `${field} must be a plain object`;
  for (const [key, entry] of Object.entries(value)) {
    const kind = typeof entry;
    if (entry !== null && kind !== "string" && kind !== "number" && kind !== "boolean") {
      return `${field}.${key} must be a primitive (string/number/boolean/null)`;
    }
    if (kind === "number" && !Number.isFinite(entry as number)) {
      return `${field}.${key} must be a finite number`;
    }
  }
  return null;
}

function routeProblem(value: unknown): string | null {
  if (!(INTENT_RESOLUTION_ROUTES as readonly unknown[]).includes(value)) {
    return `via must be one of ${INTENT_RESOLUTION_ROUTES.join("/")}`;
  }
  return null;
}

/** Per-event payload validation (closed schemas throughout). */
function eventPayloadProblem(
  event: IntentEventName,
  payload: Record<string, unknown>,
  intentId: string,
): string | null {
  switch (event) {
    case "recorded": {
      const validation = validateOperationSpec(payload, intentId);
      return validation.ok ? null : validation.problem;
    }
    case "execution-started": {
      return closedSchemaProblem(payload, []);
    }
    case "confirmed": {
      return (
        closedSchemaProblem(payload, ["via", "result", "note"]) ??
        routeProblem(payload["via"]) ??
        resultProblem("result", payload["result"]) ??
        stringProblem("note", payload["note"])
      );
    }
    case "failed": {
      return (
        closedSchemaProblem(payload, ["via", "reason"]) ??
        routeProblem(payload["via"]) ??
        stringProblem("reason", payload["reason"])
      );
    }
    case "re-armed": {
      const base =
        closedSchemaProblem(payload, ["note", "resetBeforeUse"]) ??
        stringProblem("note", payload["note"]);
      if (base !== null) return base;
      if (typeof payload["resetBeforeUse"] !== "boolean") {
        return "resetBeforeUse must be a boolean";
      }
      return null;
    }
    case "ambiguity-recorded":
    case "escalated":
    case "retry-authorized":
    case "abandoned": {
      return closedSchemaProblem(payload, ["reason"]) ?? stringProblem("reason", payload["reason"]);
    }
  }
}

/**
 * Which folded statuses each event may be appended from. `recorded`
 * requires the intent NOT to exist yet; everything else requires it.
 */
const EVENT_LEGAL_FROM: Readonly<Record<Exclude<IntentEventName, "recorded">, IntentStatus[]>> = {
  "execution-started": ["recorded"],
  confirmed: ["execution-started"],
  failed: ["execution-started"],
  "re-armed": ["execution-started"],
  "ambiguity-recorded": ["execution-started"],
  escalated: ["ambiguity-recorded"],
  "retry-authorized": ["escalated"],
  abandoned: ["escalated"],
};

/** The rows only David may append (mirrors the WP-101 David-actor binding). */
const DAVID_BOUND_EVENTS: readonly IntentEventName[] = ["retry-authorized", "abandoned"];

/**
 * THE append decision: journal writes and log verification share it, so
 * the write path and the recovery path cannot drift (the WP-101
 * one-decision-path invariant, applied to the journal).
 */
export function decideIntentAppend(
  view: IntentView,
  input: IntentAppendInput,
): IntentAppendDecision {
  const idProblem = intentIdProblem(input.intentId);
  if (idProblem !== null) return { ok: false, problem: idProblem };
  const actorProblem = stringProblem("actor", input.actor);
  if (actorProblem !== null) return { ok: false, problem: actorProblem };
  if (!(INTENT_EVENTS as readonly string[]).includes(input.event)) {
    return { ok: false, problem: `unknown intent event ${JSON.stringify(input.event)}` };
  }
  if (!isPlainObject(input.payload)) {
    return { ok: false, problem: "payload must be a plain object" };
  }
  const payloadProblem = eventPayloadProblem(input.event, input.payload, input.intentId);
  if (payloadProblem !== null) {
    return { ok: false, problem: `${input.event} payload: ${payloadProblem}` };
  }
  const existing = view.get(input.intentId);
  if (input.event === "recorded") {
    if (existing !== undefined) {
      return {
        ok: false,
        problem: `intent ${input.intentId} already exists (status ${existing.status}) — intent ids are unique forever`,
      };
    }
    return { ok: true };
  }
  if (existing === undefined) {
    return {
      ok: false,
      problem: `intent ${input.intentId} has no recorded row — ${input.event} cannot be its first event`,
    };
  }
  const legalFrom = EVENT_LEGAL_FROM[input.event];
  if (!legalFrom.includes(existing.status)) {
    return {
      ok: false,
      problem:
        `${input.event} is not legal from status ${existing.status} ` +
        `(legal from: ${legalFrom.join(", ")})`,
    };
  }
  if (DAVID_BOUND_EVENTS.includes(input.event) && input.actor !== DAVID_ACTOR) {
    return {
      ok: false,
      problem: `${input.event} is David's decision — actor must be ${JSON.stringify(DAVID_ACTOR)}, got ${JSON.stringify(input.actor)}`,
    };
  }
  return { ok: true };
}

/** Status after an event (legality already decided). */
function statusAfter(event: IntentEventName): IntentStatus {
  switch (event) {
    case "recorded":
    case "re-armed":
    case "retry-authorized":
      return "recorded";
    case "execution-started":
      return "execution-started";
    case "confirmed":
      return "confirmed";
    case "failed":
      return "failed";
    case "ambiguity-recorded":
      return "ambiguity-recorded";
    case "escalated":
      return "escalated";
    case "abandoned":
      return "abandoned";
  }
}

/**
 * Fold one legal record into the view (the same step replay uses —
 * callers must have decided legality first).
 */
export function applyIntentRecord(view: IntentView, record: IntentEventRecord): void {
  if (record.event === "recorded") {
    const validation = validateOperationSpec(record.payload, record.intentId);
    if (!validation.ok) {
      // decideIntentAppend admitted the row, so this cannot happen; refuse
      // loudly rather than fold a spec-less intent.
      throw new Error(
        `recorded row seq ${record.seq} carries an invalid spec: ${validation.problem}`,
      );
    }
    view.set(record.intentId, {
      intentId: record.intentId,
      status: "recorded",
      spec: validation.spec,
      executionStartedCount: 0,
      result: null,
      confirmedVia: null,
      ambiguityReason: null,
      lastSeq: record.seq,
    });
    return;
  }
  const entry = view.get(record.intentId);
  if (entry === undefined) {
    throw new Error(`fold reached ${record.event} for unknown intent ${record.intentId}`);
  }
  entry.status = statusAfter(record.event);
  entry.lastSeq = record.seq;
  if (record.event === "execution-started") {
    entry.executionStartedCount += 1;
  }
  if (record.event === "confirmed") {
    entry.result = record.payload["result"] as OperationResult;
    entry.confirmedVia = record.payload["via"] as IntentResolutionRoute;
  }
  if (record.event === "ambiguity-recorded") {
    entry.ambiguityReason = record.payload["reason"] as string;
  }
}

/** Rebuild the view from records alone (ascending seq); throws on illegal history. */
export function foldIntentView(records: readonly IntentEventRecord[]): IntentView {
  const view: IntentView = new Map();
  for (const record of records) {
    const decision = decideIntentAppend(view, {
      intentId: record.intentId,
      event: record.event,
      actor: record.actor,
      payload: record.payload,
    });
    if (!decision.ok) {
      throw new Error(`intent log seq ${record.seq}: ${decision.problem}`);
    }
    applyIntentRecord(view, record);
  }
  return view;
}

/**
 * Re-derive the whole journal through the same decision path and report
 * every disagreement instead of throwing (forensics surface; the journal
 * uses it to refuse adoption fail-closed).
 */
export function verifyIntentLog(records: readonly IntentEventRecord[]): IntentLogDivergence[] {
  const divergences: IntentLogDivergence[] = [];
  const view: IntentView = new Map();
  let lastSeq = 0;
  for (const record of records) {
    if (record.seq <= lastSeq) {
      divergences.push({
        seq: record.seq,
        problem: `seq is not strictly increasing (previous ${lastSeq})`,
      });
      continue;
    }
    lastSeq = record.seq;
    const decision = decideIntentAppend(view, {
      intentId: record.intentId,
      event: record.event,
      actor: record.actor,
      payload: record.payload,
    });
    if (!decision.ok) {
      divergences.push({ seq: record.seq, problem: decision.problem });
      continue;
    }
    applyIntentRecord(view, record);
  }
  return divergences;
}
