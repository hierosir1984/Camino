/**
 * Intent-ledger lifecycle (WP-109, CAM-CANON-01): the pure decision layer
 * of the Living Canon's intent ledger, mirroring the WP-101/WP-104 split —
 * decisions here in core, the SQLite shell in the daemon
 * (`canon-ledger.ts`).
 *
 * THE CAM-CANON-01 CONSTRUCTION ARGUMENT, stated precisely so a review
 * can attack it:
 *
 *  1. **Closed vocabulary.** The ledger's six events are the design's
 *     enumerated user actions (intake, dispute answers, descope
 *     approvals). Merge, revert, abandonment, external edits, and probe
 *     results have NO event name here — a code-lifecycle observation
 *     cannot be expressed as a ledger append at the type level, is
 *     refused by `decideLedgerAppend` at the value level, and is refused
 *     by the store's SQL CHECK at the schema level.
 *  2. **User-authority binding.** Every ledger row is actor-bound to
 *     DAVID_ACTOR (design invariant 6: "the user's PRD text and explicit
 *     confirmations are the only sources of intent"). Decision rows
 *     (accept / dispute answers / descope) record his explicit
 *     confirmations; proposal and dispute rows record what HIS submitted
 *     PRD text surfaced during the intake he drives. System components
 *     never hold the pen: an append claiming `camino:*` or `worker:*`
 *     authority is refused here and by the schema. (This binds authority,
 *     not process identity — the daemon writes the row mechanically when
 *     David acts through the GUI, exactly like the WP-101 David rows.)
 *  3. **Type-separated folds.** `foldLedgerView` consumes
 *     `LedgerEventRecord` only. Canon FACTS (`canon-status.ts`) and
 *     WP-101 entity events are different types with different stores;
 *     the status projection takes disposition exclusively from the
 *     ledger view. No fact sequence can alter what `renderCanon`
 *     (canon-render.ts) or the disposition column produce.
 *
 * What this does NOT claim: a daemon bug could always write bytes into a
 * SQLite file it owns. The claim is that no CODE PATH exists that turns a
 * merge/revert/abandon event into a ledger mutation — the vocabulary,
 * the decision layer, the schema, and the store's method surface (six
 * named user-action methods, no generic append) would each have to be
 * changed deliberately to create one.
 */
import { LEDGER_EVENTS, REQUIREMENT_ID_PATTERN } from "@camino/shared";
import type {
  IntentDisposition,
  LedgerAppendInput,
  LedgerEventName,
  LedgerEventRecord,
} from "@camino/shared";
import { DAVID_ACTOR } from "./intent-lifecycle.js";

/**
 * The disposition transition table (CAM-CANON-03 grammar + the
 * CAM-CANON-10 descope rule), one row per legal (from, event) pair.
 * `from: null` is entry — a requirement id with no live ledger entry.
 * The fixture walks in canon-intent.test.ts assert bidirectional
 * coverage against this table: every row walked, every walk step a row.
 */
export interface DispositionTransition {
  readonly row: string;
  readonly from: IntentDisposition | null;
  readonly event: LedgerEventName;
  readonly to: IntentDisposition;
  /** Which design/PRD sentence licenses this row. */
  readonly basis: string;
}

export const DISPOSITION_TRANSITIONS: readonly DispositionTransition[] = [
  {
    row: "D1",
    from: null,
    event: "requirement-proposed",
    to: "proposed",
    basis: "§3.1 intake: PRD text surfaces requirements as proposed",
  },
  {
    row: "D2",
    from: "descoped",
    event: "requirement-proposed",
    to: "proposed",
    basis: "stable requirement ids: a later PRD may re-propose a descoped requirement",
  },
  {
    row: "D3",
    from: "proposed",
    event: "requirement-accepted",
    to: "accepted",
    basis: "CAM-CANON-03: proposed → accepted (intake confirmation, CAM-PLAN-02)",
  },
  {
    row: "D4",
    from: "proposed",
    event: "requirement-disputed",
    to: "disputed",
    basis: "CAM-CANON-03: proposed → disputed (intake contradiction diff)",
  },
  {
    row: "D5",
    from: "accepted",
    event: "requirement-disputed",
    to: "disputed",
    basis: "§3.5 intake contradiction diff against existing accepted canon",
  },
  {
    row: "D6",
    from: "resolved-accepted",
    event: "requirement-disputed",
    to: "disputed",
    basis: "§3.5 intake contradiction diff against existing accepted canon",
  },
  {
    row: "D7",
    from: "assumed",
    event: "requirement-disputed",
    to: "disputed",
    basis: "§3.5 intake contradiction diff against existing accepted canon",
  },
  {
    row: "D8",
    from: "disputed",
    event: "dispute-resolved-accepted",
    to: "resolved-accepted",
    basis: "CAM-CANON-03: disputed → resolved-accepted (dispute answer)",
  },
  {
    row: "D9",
    from: "disputed",
    event: "dispute-assumed",
    to: "assumed",
    basis: "CAM-CANON-03: disputed → assumed (user signs off a documented assumption)",
  },
  {
    row: "D10",
    from: "disputed",
    event: "requirement-descoped",
    to: "descoped",
    basis: "CAM-CANON-03: disputed → descoped (descope approval)",
  },
  {
    row: "D11",
    from: "proposed",
    event: "requirement-descoped",
    to: "descoped",
    basis: "CAM-CANON-05: requirements stay open or are descoped by the user",
  },
  {
    row: "D12",
    from: "accepted",
    event: "requirement-descoped",
    to: "descoped",
    basis: "CAM-CANON-10: an accepted requirement may be explicitly descoped (user action)",
  },
  {
    row: "D13",
    from: "resolved-accepted",
    event: "requirement-descoped",
    to: "descoped",
    basis: "CAM-CANON-10 applies to all accepted-family dispositions",
  },
  {
    row: "D14",
    from: "assumed",
    event: "requirement-descoped",
    to: "descoped",
    basis: "CAM-CANON-10 applies to all accepted-family dispositions",
  },
] as const;

/** The folded state of one requirement's intent. */
export interface LedgerViewEntry {
  readonly requirementId: string;
  disposition: IntentDisposition;
  /** The current intent statement (from the proposal, possibly revised by a dispute answer). */
  statement: string;
  /** The documented assumption, when disposition is `assumed`. */
  assumption: string | null;
  /**
   * The statement as of the last accepted-family disposition, or null if
   * the requirement was never accepted in its current proposal cycle.
   * This is what canon text renders for a disputed-but-previously-accepted
   * requirement (the last intent the user actually accepted — the pending
   * dispute question has not changed intent yet, CAM-CANON-01).
   */
  acceptedStatement: string | null;
  lastSeq: number;
}

/** Folded ledger: one entry per requirement id. */
export type LedgerView = Map<string, LedgerViewEntry>;

export type LedgerAppendDecision =
  { readonly ok: true } | { readonly ok: false; readonly problem: string };

export interface LedgerLogDivergence {
  readonly seq: number;
  readonly problem: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function stringProblem(field: string, value: unknown, requireNonEmpty = true): string | null {
  if (typeof value !== "string") return `${field} must be a string`;
  if (requireNonEmpty && value.length === 0) return `${field} must be non-empty`;
  if (!value.isWellFormed()) return `${field} contains unpaired surrogate code units`;
  if (value.includes("\u0000")) return `${field} contains an embedded NUL`;
  return null;
}

/** Provenance references (e.g. the intake mission id) obey a closed token grammar. */
const SOURCE_REF_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function sourceRefProblem(field: string, value: unknown): string | null {
  if (typeof value !== "string") return `${field} must be a string`;
  if (!SOURCE_REF_PATTERN.test(value)) return `${field} must match ${SOURCE_REF_PATTERN}`;
  return null;
}

/**
 * Closed payload schemas per ledger event: exactly the listed fields, no
 * extras (an unknown field is refused, never silently dropped — WP-104
 * precedent). Every string field carries the hygiene checks (non-empty,
 * well-formed, no NUL).
 */
function payloadProblem(event: LedgerEventName, payload: Record<string, unknown>): string | null {
  const keys = Object.keys(payload).sort();
  const expect = (allowed: readonly string[], optional: readonly string[] = []): string | null => {
    for (const key of keys) {
      if (!allowed.includes(key) && !optional.includes(key)) {
        return `unexpected payload field ${JSON.stringify(key)}`;
      }
    }
    for (const key of allowed) {
      if (!keys.includes(key)) return `missing payload field ${JSON.stringify(key)}`;
    }
    return null;
  };
  switch (event) {
    case "requirement-proposed": {
      return (
        expect(["statement", "sourceMissionId"]) ??
        stringProblem("statement", payload["statement"]) ??
        sourceRefProblem("sourceMissionId", payload["sourceMissionId"])
      );
    }
    case "requirement-accepted": {
      return expect([]);
    }
    case "requirement-disputed": {
      const shape = expect(["reason", "conflictWith"]);
      if (shape !== null) return shape;
      const reason = stringProblem("reason", payload["reason"]);
      if (reason !== null) return reason;
      const conflictWith = payload["conflictWith"];
      if (conflictWith !== null) {
        if (typeof conflictWith !== "string" || !REQUIREMENT_ID_PATTERN.test(conflictWith)) {
          return "conflictWith must be null or a requirement id (CAM-AREA-NN)";
        }
      }
      return null;
    }
    case "dispute-resolved-accepted": {
      const shape = expect(["resolution"], ["statement"]);
      if (shape !== null) return shape;
      const resolution = stringProblem("resolution", payload["resolution"]);
      if (resolution !== null) return resolution;
      if ("statement" in payload) {
        return stringProblem("statement", payload["statement"]);
      }
      return null;
    }
    case "dispute-assumed": {
      return expect(["assumption"]) ?? stringProblem("assumption", payload["assumption"]);
    }
    case "requirement-descoped": {
      return expect(["reason"]) ?? stringProblem("reason", payload["reason"]);
    }
  }
}

function transitionFor(
  from: IntentDisposition | null,
  event: LedgerEventName,
): DispositionTransition | undefined {
  return DISPOSITION_TRANSITIONS.find((row) => row.from === from && row.event === event);
}

/**
 * Decide one ledger append over the folded view. Total: never throws on
 * any input value; every refusal names its reason. Used by the store at
 * write time AND by `verifyLedgerLog` at adoption — one decision path
 * (the WP-101 decide.ts lesson).
 */
export function decideLedgerAppend(
  view: LedgerView,
  input: LedgerAppendInput,
): LedgerAppendDecision {
  const requirementProblem = ((): string | null => {
    if (typeof input.requirementId !== "string") return "requirementId must be a string";
    if (!REQUIREMENT_ID_PATTERN.test(input.requirementId)) {
      return `requirementId must match the stable-id grammar ${REQUIREMENT_ID_PATTERN} (CAM-AREA-NN)`;
    }
    return null;
  })();
  if (requirementProblem !== null) return { ok: false, problem: requirementProblem };

  if (!(LEDGER_EVENTS as readonly string[]).includes(input.event)) {
    return {
      ok: false,
      problem:
        `${JSON.stringify(input.event)} is not a ledger event — the intent ledger records ` +
        "user actions only (CAM-CANON-01); code-lifecycle observations are canon facts",
    };
  }

  if (input.actor !== DAVID_ACTOR) {
    return {
      ok: false,
      problem:
        `ledger rows record user actions and must carry actor ${JSON.stringify(DAVID_ACTOR)} ` +
        `(got ${JSON.stringify(input.actor)}) — system components never mutate intent (CAM-CANON-01)`,
    };
  }

  if (!isPlainObject(input.payload)) {
    return { ok: false, problem: "payload must be a plain object" };
  }
  const payloadIssue = payloadProblem(input.event, input.payload);
  if (payloadIssue !== null) {
    return { ok: false, problem: `${input.event}: ${payloadIssue}` };
  }

  const entry = view.get(input.requirementId);
  const from = entry?.disposition ?? null;
  const row = transitionFor(from, input.event);
  if (row === undefined) {
    const state = from === null ? "no ledger entry" : `disposition ${JSON.stringify(from)}`;
    return {
      ok: false,
      problem: `${input.event} is not legal from ${state} for ${input.requirementId} (no DISPOSITION_TRANSITIONS row)`,
    };
  }
  return { ok: true };
}

/**
 * Apply one already-decided record to the view (mutating). Callers must
 * have run `decideLedgerAppend` first; this function trusts the record
 * exactly as far as the shared decision path validated it.
 */
export function applyLedgerRecord(view: LedgerView, record: LedgerEventRecord): void {
  const existing = view.get(record.requirementId);
  switch (record.event) {
    case "requirement-proposed": {
      view.set(record.requirementId, {
        requirementId: record.requirementId,
        disposition: "proposed",
        statement: record.payload["statement"] as string,
        assumption: null,
        acceptedStatement: null,
        lastSeq: record.seq,
      });
      return;
    }
    case "requirement-accepted": {
      const entry = existing as LedgerViewEntry;
      entry.disposition = "accepted";
      entry.acceptedStatement = entry.statement;
      entry.assumption = null;
      entry.lastSeq = record.seq;
      return;
    }
    case "requirement-disputed": {
      const entry = existing as LedgerViewEntry;
      entry.disposition = "disputed";
      entry.lastSeq = record.seq;
      return;
    }
    case "dispute-resolved-accepted": {
      const entry = existing as LedgerViewEntry;
      entry.disposition = "resolved-accepted";
      const revised = record.payload["statement"];
      if (typeof revised === "string") entry.statement = revised;
      entry.acceptedStatement = entry.statement;
      entry.assumption = null;
      entry.lastSeq = record.seq;
      return;
    }
    case "dispute-assumed": {
      const entry = existing as LedgerViewEntry;
      entry.disposition = "assumed";
      entry.assumption = record.payload["assumption"] as string;
      entry.acceptedStatement = entry.statement;
      entry.lastSeq = record.seq;
      return;
    }
    case "requirement-descoped": {
      const entry = existing as LedgerViewEntry;
      entry.disposition = "descoped";
      entry.acceptedStatement = null;
      entry.assumption = null;
      entry.lastSeq = record.seq;
      return;
    }
  }
}

/** Fold a ledger log into a view. Records must already be verified (see verifyLedgerLog). */
export function foldLedgerView(records: readonly LedgerEventRecord[]): LedgerView {
  const view: LedgerView = new Map();
  for (const record of records) {
    applyLedgerRecord(view, record);
  }
  return view;
}

/**
 * Re-derive an entire ledger log through the same decision path used at
 * write time. Any row the lifecycle would have refused is a divergence —
 * the store refuses to adopt such a log at open (fail-closed, the WP-101
 * recovery invariant carried over).
 */
export function verifyLedgerLog(records: readonly LedgerEventRecord[]): LedgerLogDivergence[] {
  const divergences: LedgerLogDivergence[] = [];
  const view: LedgerView = new Map();
  let lastSeq = 0;
  for (const record of records) {
    if (!Number.isInteger(record.seq) || record.seq <= lastSeq) {
      divergences.push({
        seq: record.seq,
        problem: `seq ${record.seq} is not strictly increasing after ${lastSeq}`,
      });
      continue;
    }
    lastSeq = record.seq;
    const decision = decideLedgerAppend(view, {
      requirementId: record.requirementId,
      event: record.event,
      actor: record.actor,
      payload: record.payload,
    });
    if (!decision.ok) {
      divergences.push({ seq: record.seq, problem: decision.problem });
      continue;
    }
    applyLedgerRecord(view, record);
  }
  return divergences;
}
