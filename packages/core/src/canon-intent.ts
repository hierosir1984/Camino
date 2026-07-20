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
 * WHAT THE CONSTRUCTION CLAIMS — AND WHAT IT DOES NOT (review round 1,
 * finding 2 sharpened this): the claim is about EVENTS, exactly as
 * CAM-CANON-01's accept criterion states it. A merge, revert, or
 * abandonment EVENT is not expressible as a ledger append: it has no
 * event name in the vocabulary, no payload schema, no transition row,
 * and the schema CHECKs refuse it even as raw SQL. What no store can
 * verify is CALLER INTENT: the six user-action methods are the daemon's
 * internal surface for relaying the user's decisions (the GUI/approval
 * flow of later WPs holds them), and a daemon component that invokes a
 * user-action method WITHOUT a user action is a lying component — the
 * same single-OS-user, in-process trust boundary every Camino store
 * lives behind (WP-104 journal-writer trust; WP-003 boundary-naming
 * precedent). The construction makes the honest path the only
 * expressible path; it cannot make an in-process liar inexpressible,
 * and does not claim to.
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
  // There is deliberately NO descoped → proposed row: the normative
  // grammar (CAM-CANON-03) gives descoped no outgoing edge, so descoped
  // is terminal (review round 1, finding 13 — an earlier re-proposal row
  // was an unlicensed extension). If a later PRD re-introduces a descoped
  // requirement, that is a change-control question for the user (parked
  // in PR #51); until amended, intake mints a fresh requirement id.
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

/**
 * A totality-safe error description (review round 2, finding 10): even
 * reading `error.message` can throw when the thrown value is itself a
 * hostile object with a trapping getter. A catch clause that builds its
 * refusal string from `(error as Error).message` therefore re-throws —
 * the wrapper does not, and neither may this helper.
 */
export function safeErrorLabel(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = error.message;
      if (typeof message === "string") return message;
    }
    const described = String(error);
    return typeof described === "string" ? described : "unprintable error value";
  } catch {
    return "unprintable error value";
  }
}

function stringProblem(field: string, value: unknown, requireNonEmpty = true): string | null {
  if (typeof value !== "string") return `${field} must be a string`;
  if (requireNonEmpty && value.length === 0) return `${field} must be non-empty`;
  if (!value.isWellFormed()) return `${field} contains unpaired surrogate code units`;
  if (value.includes("\u0000")) return `${field} contains an embedded NUL`;
  // Ledger text is SINGLE-LINE by contract: canon renders one line per
  // requirement (review round 1 finding 11; round 2 finding 9 widened
  // this to every Unicode line terminator so a statement cannot smuggle a
  // marker-shaped or list-shaped line into the rendered file).
  if (LINE_TERMINATOR.test(value)) {
    return `${field} must be single-line (no line terminators \u2014 canon renders one line per field)`;
  }
  // Trojan-Source class (review round 3 finding 6): bidi overrides/isolates
  // and the BOM/ZWNBSP can visually REORDER or hide rendered canon text
  // while the bytes stay "faithful", so body comparison would only catch
  // their later removal. Reject them at the source \u2014 canon statements are
  // plain single-line text.
  if (BIDI_OR_FORMAT_CONTROL.test(value)) {
    return `${field} must not contain bidirectional or format control characters`;
  }
  return null;
}

/**
 * Every Unicode line-terminator, not just CR/LF (review round 2, finding
 * 9): U+2028/U+2029 (LINE/PARAGRAPH SEPARATOR), U+0085 (NEL), and the
 * legacy VT/FF all render as visual line breaks.
 */
// eslint-disable-next-line no-control-regex -- matching control-class line terminators is the point
const LINE_TERMINATOR = /[\n\r\u0085\u000b\u000c\u2028\u2029]/;

/**
 * Bidirectional and format controls that can reorder or hide displayed
 * text (the Trojan-Source vulnerability class, CVE-2021-42574; review
 * round 3 finding 6): LRM/RLM, the bidi embeddings/overrides U+202A-E,
 * the isolates U+2066-9, and the BOM / zero-width no-break space U+FEFF.
 */
const BIDI_OR_FORMAT_CONTROL = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

/**
 * Exactly the forms `Date.prototype.toISOString` produces: the four-digit
 * calendar-year form for years 0000-9999, AND the signed six-digit
 * "expanded year" form for instants outside that range (review round 2,
 * finding 8 \u2014 `new Date(Date.UTC(10000, 0, 1)).toISOString()` is
 * `+010000-...`, and a writer using the system clock must produce values
 * its own verifier accepts).
 */
const ISO_UTC_PATTERN = /^([+-]\d{6}|\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A recorded timestamp must be a canonical toISOString form AND
 * round-trip through Date.parse unchanged \u2014 the regex alone admits
 * impossible dates that JavaScript silently normalizes (2026-02-30
 * parses as March 2nd; review round 1, finding 12).
 */
export function recordedAtProblem(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_UTC_PATTERN.test(value)) {
    return `recordedAt must be an ISO-8601 UTC timestamp (toISOString form), got ${JSON.stringify(value)}`;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) {
    return `recordedAt ${JSON.stringify(value)} is not a real instant (does not round-trip through Date)`;
  }
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
 * any input value — including exotic objects whose traps throw (review
 * round 1, finding 15) — every refusal names its reason. Used by the
 * store at write time AND by `verifyLedgerLog` at adoption — one
 * decision path (the WP-101 decide.ts lesson).
 */
export function decideLedgerAppend(
  view: LedgerView,
  input: LedgerAppendInput,
): LedgerAppendDecision {
  try {
    return decideLedgerAppendInner(view, input);
  } catch (error) {
    return {
      ok: false,
      problem: `payload observation threw (${safeErrorLabel(error)}) — hostile or exotic input refused`,
    };
  }
}

function decideLedgerAppendInner(view: LedgerView, input: LedgerAppendInput): LedgerAppendDecision {
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
    if (!Number.isSafeInteger(record.seq) || record.seq <= lastSeq) {
      divergences.push({
        seq: record.seq,
        problem: `seq ${record.seq} is not a safe, strictly increasing integer after ${lastSeq}`,
      });
      continue;
    }
    lastSeq = record.seq;
    const timeIssue = recordedAtProblem(record.recordedAt);
    if (timeIssue !== null) {
      divergences.push({ seq: record.seq, problem: timeIssue });
      continue;
    }
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
