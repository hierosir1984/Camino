/**
 * Gap-register projection + disposition decisions (WP-122, CAM-CANON-05 /
 * CAM-CORE-09 / CAM-CORE-10): the pure decision layer of the gap
 * register, mirroring the WP-109 split — decisions here in core, the
 * SQLite disposition log in the daemon (`gap-dispositions.ts`), the HTTP
 * surface in the daemon's register service.
 *
 * THE REGISTER IS A PROJECTION, NEVER A STORE (CAM-CORE-10 by
 * construction): a register row exists exactly when the intent ledger
 * says a requirement carries accepted-family intent AND the status
 * projection (canon-status.ts, over ledger + facts) says that intent is
 * not demonstrably delivered in the register's context. Rows carry the
 * CAM-CANON-05 quadruple — requirement → status tuple → evidence
 * provenance → disposition — where:
 *
 *  - the STATUS TUPLE is `explainRequirementStatus`'s answer, verbatim
 *    (this module never re-derives an axis; a register row can therefore
 *    never disagree with the projection, and the projection reads only
 *    ledger + facts — never repo canon text);
 *  - EVIDENCE PROVENANCE is the requirement's context-relevant fact
 *    records plus the projection rules that fired — the audit trail
 *    behind the tuple, not a restatement of it;
 *  - the GAP DISPOSITION folds the user's disposition events against the
 *    row's CURRENT state (basis binding, below).
 *
 * BASIS BINDING — dispositions recompute like everything else (design
 * §3.1: nothing hand-maintains reverse transitions). Every disposition
 * event records the row's status tuple AND the register context it was
 * taken in. At fold time an event applies only while BOTH still hold:
 *   - the current tuple equals the recorded one — if the gap's character
 *     changes (implementation or evidence moves, intent is re-resolved),
 *     the user's earlier judgment no longer binds and the row recomputes
 *     to `open`;
 *   - the current context equals the recorded one (round 1, finding 7) —
 *     a judgment made in `main` never governs a branch row that happens
 *     to share the tuple, and vice versa.
 * A waiver binds two things more: the exact detector findings it covers
 * (`waivedThroughSeq`), so a NEW finding re-opens the row even at an
 * identical tuple; and the RECENCY of those findings (round 1, finding 5)
 * — the waiver must have been recorded no earlier than the finding at that
 * seq, so a waiver pre-seeded (via the raw store) against a finding that
 * does not yet exist cannot spring to life when a future finding lands at
 * the guessed seq.
 *
 * THE CAM-CANON-05 WAIVER RULE, structural: waivability is DERIVED from
 * evidence provenance — a row is waivable exactly when its outstanding
 * absence suspicions in the register's context are all detector-authored
 * (`camino:detector:*` facts, the CAM-VAL-05 seam). A real unmet
 * requirement (absent / unverified with no detector finding, or a
 * suspicion raised by non-detector machinery such as the reconciler) has
 * `waivableThroughSeq: null`, and `decideGapDisposition` refuses the
 * waiver: it stays open or is descoped by the user through the intent
 * ledger. No flag, no override path.
 */
import {
  ACCEPTED_FAMILY,
  EVIDENCE_STATES,
  GAP_DISPOSITION_EVENTS,
  INTENT_DISPOSITIONS,
  isDetectorActor,
  isRequirementId,
} from "@camino/shared";
import type {
  CanonFactRecord,
  GapDisposition,
  GapDispositionAppendInput,
  GapDispositionEventName,
  GapDispositionRecord,
  ImplementationState,
  StatusContext,
  StatusTuple,
} from "@camino/shared";
import type { LedgerView } from "./canon-intent.js";
import { recordedAtProblem, safeErrorLabel, singleLineTextProblem } from "./canon-intent.js";
import { DAVID_ACTOR } from "./intent-lifecycle.js";
import { explainRequirementStatus, statusContextProblem } from "./canon-status.js";

/** A context-relevant canon fact, as the register's provenance trail cites it. */
export interface GapFactRef {
  readonly seq: number;
  readonly kind: CanonFactRecord["kind"];
  readonly actor: string;
  readonly recordedAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** The disposition event currently governing a row (null while `open`). */
export interface GapDispositionRef {
  readonly seq: number;
  readonly event: GapDispositionEventName;
  readonly recordedAt: string;
  readonly reason: string;
}

/** One register row: the CAM-CANON-05 quadruple plus derived action facts. */
export interface GapRegisterRow {
  readonly requirementId: string;
  /** The last user-accepted statement (what canon renders for this requirement). */
  readonly statement: string;
  /** The documented assumption when intent-disposition is `assumed`. */
  readonly assumption: string | null;
  /** The CAM-CANON-03 tuple, verbatim from the status projection. */
  readonly tuple: StatusTuple;
  /** Projection rules (canon-status.ts) that produced the tuple, sorted. */
  readonly firedRules: readonly string[];
  /** Context-relevant facts for this requirement, seq order (the provenance trail). */
  readonly provenance: readonly GapFactRef[];
  /** Outstanding detector-authored suspicion facts (subset of provenance). */
  readonly detectorFindings: readonly GapFactRef[];
  /**
   * Non-null exactly when the row is waivable (CAM-CANON-05): every
   * outstanding suspicion in this context is detector-authored. The value
   * is the highest such fact seq — what a waiver must bind to.
   */
  readonly waivableThroughSeq: number | null;
  /** The folded gap disposition (design §3.4 vocabulary). */
  readonly disposition: GapDisposition;
  /** The event that produced `disposition`; null while `open`. */
  readonly dispositionRecord: GapDispositionRef | null;
}

export type GapDispositionDecision =
  { readonly ok: true } | { readonly ok: false; readonly problem: string };

const EVENT_TO_DISPOSITION: Readonly<Record<GapDispositionEventName, GapDisposition>> =
  Object.freeze({
    "gap-fix-queued": "fix-queued",
    "gap-disputed": "disputed",
    "gap-false-positive-waived": "false-positive-waived",
    "gap-reopened": "open",
  });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/**
 * Validate a recorded StatusTuple payload fragment (closed shapes — the
 * CAM-CANON-03 vocabularies exactly, nothing else).
 */
export function statusTupleProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return "tuple must be a plain object";
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "disposition,evidence,implementation") {
    return "tuple must carry exactly disposition, implementation, evidence";
  }
  if (!(INTENT_DISPOSITIONS as readonly unknown[]).includes(value["disposition"])) {
    return "tuple.disposition is not an intent disposition";
  }
  if (!(EVIDENCE_STATES as readonly unknown[]).includes(value["evidence"])) {
    return "tuple.evidence is not an evidence state";
  }
  const implementation = value["implementation"];
  if (!isPlainObject(implementation)) return "tuple.implementation must be a plain object";
  const kind = implementation["kind"];
  const implKeys = Object.keys(implementation).sort();
  if (kind === "absent" || kind === "on-main" || kind === "suspected-absent") {
    if (implKeys.join(",") !== "kind") return "tuple.implementation carries unexpected fields";
    return null;
  }
  if (kind === "present-on") {
    if (implKeys.join(",") !== "branch,kind") {
      return "tuple.implementation carries unexpected fields";
    }
    const branch = implementation["branch"];
    if (typeof branch !== "string" || branch.length === 0) {
      return "tuple.implementation.branch must be a non-empty string";
    }
    return null;
  }
  return "tuple.implementation.kind is not an implementation state";
}

function implementationEquals(a: ImplementationState, b: ImplementationState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "present-on" && b.kind === "present-on") return a.branch === b.branch;
  return true;
}

/** Deep equality over the closed StatusTuple shape (the basis-binding comparison). */
export function statusTupleEquals(a: StatusTuple, b: StatusTuple): boolean {
  return (
    a.disposition === b.disposition &&
    a.evidence === b.evidence &&
    implementationEquals(a.implementation, b.implementation)
  );
}

/**
 * Closed payload schemas per gap-disposition event: exactly the listed
 * fields (an unknown field is refused, never dropped — WP-104 precedent).
 *
 * - `tuple` — the status tuple the event binds to (basis binding).
 * - `contextKey` — the register context the event was taken in ("main" or a
 *   branch name; round 1, finding 7): a disposition governs ONLY its own
 *   context, so a main-context judgment can never leak onto a branch that
 *   happens to share the tuple.
 * - `reason` — David's single-line text.
 * - `waivedThroughSeq` (waivers only) — the canon-fact seq of the newest
 *   detector finding the waiver covers.
 *
 * Presence is tested with `Object.hasOwn`, not `key in payload` (round 1,
 * finding 15): a polluted `Object.prototype` carrying `tuple`/`reason` must
 * not satisfy the schema for an object that owns neither.
 */
export function gapDispositionPayloadProblem(
  event: GapDispositionEventName,
  payload: Record<string, unknown>,
): string | null {
  const allowed =
    event === "gap-false-positive-waived"
      ? ["tuple", "contextKey", "reason", "waivedThroughSeq"]
      : ["tuple", "contextKey", "reason"];
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) return `unexpected payload field ${JSON.stringify(key)}`;
  }
  for (const key of allowed) {
    if (!Object.hasOwn(payload, key)) return `missing payload field ${JSON.stringify(key)}`;
  }
  const tupleIssue = statusTupleProblem(payload["tuple"]);
  if (tupleIssue !== null) return tupleIssue;
  const contextIssue = singleLineTextProblem("contextKey", payload["contextKey"]);
  if (contextIssue !== null) return contextIssue;
  const reasonIssue = singleLineTextProblem("reason", payload["reason"]);
  if (reasonIssue !== null) return reasonIssue;
  if (event === "gap-false-positive-waived") {
    const seq = payload["waivedThroughSeq"];
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) {
      return "waivedThroughSeq must be a positive safe integer (a canon-fact seq)";
    }
  }
  return null;
}

/**
 * The context key a fact bears on, for provenance selection. Facts that
 * name a branch directly (requirement-touched, implementation-recorded,
 * mainline-inherited) key on that branch; landed-on-main keys on main;
 * the contextKind-carrying kinds key on their recorded context. This
 * mirrors the projection's own keying (canon-status.ts branchChangeSeq /
 * factContextKey) — selection for DISPLAY, never derivation: the tuple
 * axes come exclusively from explainRequirementStatus.
 */
function factBearsOnContext(fact: CanonFactRecord, contextKey: string): boolean {
  switch (fact.kind) {
    case "requirement-touched":
    case "implementation-recorded":
    case "mainline-inherited":
      return fact.payload["branch"] === contextKey;
    case "landed-on-main":
      return contextKey === "main";
    default:
      return (
        (fact.payload["contextKind"] === "branch" ? fact.payload["branch"] : "main") === contextKey
      );
  }
}

function toFactRef(fact: CanonFactRecord): GapFactRef {
  return {
    seq: fact.seq,
    kind: fact.kind,
    actor: fact.actor,
    recordedAt: fact.recordedAt,
    payload: fact.payload,
  };
}

/**
 * Outstanding suspicion facts for a context: every `absence-suspected`
 * recorded after the last `absence-resolved` for the same context key
 * (matching the projection's I9/I11/I12 fold, which keeps a suspicion
 * outstanding until a resolution clears it).
 */
function outstandingSuspicions(
  facts: readonly CanonFactRecord[],
  contextKey: string,
): CanonFactRecord[] {
  const outstanding: CanonFactRecord[] = [];
  for (const fact of facts) {
    if (!factBearsOnContext(fact, contextKey)) continue;
    if (fact.kind === "absence-suspected") outstanding.push(fact);
    else if (fact.kind === "absence-resolved") outstanding.length = 0;
  }
  return outstanding;
}

/**
 * Refuse fact sets a store could not have produced (non-monotone or
 * unsafe seqs) — same stance as the status projection: the register is
 * defined over store-produced records, and the only order-dependence a
 * bypassing caller could exploit becomes a clean domain error.
 */
function orderBySeqStrict<T extends { readonly seq: number }>(records: readonly T[]): T[] {
  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  let last = 0;
  for (const record of sorted) {
    if (!Number.isSafeInteger(record.seq) || record.seq <= last) {
      throw new Error(
        `malformed record sequence (seq ${String(record.seq)} is not a safe, strictly ` +
          "increasing integer) — the register is defined over store-produced records",
      );
    }
    last = record.seq;
  }
  return sorted;
}

/** True iff the tuple leaves nothing to close: delivered on main and proven live. */
function delivered(tuple: StatusTuple): boolean {
  return tuple.implementation.kind === "on-main" && tuple.evidence === "verified-live";
}

/** The row state a disposition fold binds against (round 1, findings 5/7). */
interface DispositionBasis {
  readonly tuple: StatusTuple;
  /** The register context the row is projected for ("main" or a branch name). */
  readonly contextKey: string;
  /** The row's current waivable-through seq, or null when not waivable. */
  readonly waivableThroughSeq: number | null;
  /** The recordedAt of the fact at `waivableThroughSeq`, for the recency guard. */
  readonly waivableThroughAt: string | null;
}

/**
 * Fold one requirement's disposition events against its CURRENT row state.
 * Events are hygiene-trusted (the store verified shapes); each APPLIES only
 * while its recorded basis still holds — see the module header. Later events
 * with a non-matching basis are skipped, so a judgment made in a different
 * gap state neither governs nor erases an earlier judgment whose state
 * returned.
 *
 * An event binds to THREE things, not one:
 *  - the status tuple it recorded (the visible gap state);
 *  - the CONTEXT it was taken in (round 1, finding 7): a `main` judgment
 *    never governs a branch row that happens to share the tuple;
 *  - for a waiver, the exact detector findings it covers AND their recency
 *    (round 1, finding 5): the waiver must name the row's current
 *    waivable-through seq, and it must have been recorded no earlier than the
 *    finding at that seq — so a waiver pre-seeded (via the raw store) against
 *    a finding that does not yet exist can never spring to life when a future
 *    finding happens to land at the guessed seq.
 */
function foldDisposition(
  events: readonly GapDispositionRecord[],
  basis: DispositionBasis,
): { disposition: GapDisposition; record: GapDispositionRef | null } {
  let disposition: GapDisposition = "open";
  let record: GapDispositionRef | null = null;
  for (const event of events) {
    if (event.payload["contextKey"] !== basis.contextKey) continue;
    if (!statusTupleEquals(event.payload["tuple"] as StatusTuple, basis.tuple)) continue;
    if (event.event === "gap-false-positive-waived") {
      if (event.payload["waivedThroughSeq"] !== basis.waivableThroughSeq) continue;
      if (basis.waivableThroughAt === null) continue;
      if (Date.parse(event.recordedAt) < Date.parse(basis.waivableThroughAt)) continue;
    }
    disposition = EVENT_TO_DISPOSITION[event.event];
    record =
      event.event === "gap-reopened"
        ? null
        : {
            seq: event.seq,
            event: event.event,
            recordedAt: event.recordedAt,
            reason: event.payload["reason"] as string,
          };
  }
  return { disposition, record };
}

/**
 * Project the gap register for a context. Inputs are the intent ledger's
 * folded view, ALL canon facts, and ALL gap-disposition records (the
 * projection groups per requirement); rows come out in requirement-id
 * order. Total over store-produced inputs; hostile inputs are refused as
 * clean domain errors, never silently mis-projected.
 */
export function projectGapRegister(
  view: LedgerView,
  facts: readonly CanonFactRecord[],
  dispositions: readonly GapDispositionRecord[],
  context: StatusContext,
): GapRegisterRow[] {
  const contextIssue = statusContextProblem(context);
  if (contextIssue !== null) throw new Error(`malformed status context: ${contextIssue}`);
  const contextKey = context.kind === "branch" ? context.branch : "main";

  const orderedFacts = orderBySeqStrict(facts);
  const factsByRequirement = new Map<string, CanonFactRecord[]>();
  for (const fact of orderedFacts) {
    const list = factsByRequirement.get(fact.requirementId);
    if (list === undefined) factsByRequirement.set(fact.requirementId, [fact]);
    else list.push(fact);
  }
  const orderedDispositions = orderBySeqStrict(dispositions);
  const dispositionsByRequirement = new Map<string, GapDispositionRecord[]>();
  for (const record of orderedDispositions) {
    const list = dispositionsByRequirement.get(record.requirementId);
    if (list === undefined) dispositionsByRequirement.set(record.requirementId, [record]);
    else list.push(record);
  }

  const rows: GapRegisterRow[] = [];
  for (const [requirementId, entry] of view) {
    if (!(ACCEPTED_FAMILY as readonly string[]).includes(entry.disposition)) continue;
    const requirementFacts = factsByRequirement.get(requirementId) ?? [];
    const explained = explainRequirementStatus(entry, requirementFacts, context);
    if (delivered(explained.tuple)) continue;

    const provenance = requirementFacts
      .filter((fact) => factBearsOnContext(fact, contextKey))
      .map(toFactRef);
    const suspicions = outstandingSuspicions(requirementFacts, contextKey);
    const detectorFindings = suspicions.filter((f) => isDetectorActor(f.actor)).map(toFactRef);
    const waivable =
      suspicions.length > 0 && suspicions.every((f) => isDetectorActor(f.actor))
        ? suspicions[suspicions.length - 1]!
        : null;
    const waivableThroughSeq = waivable?.seq ?? null;

    const folded = foldDisposition(dispositionsByRequirement.get(requirementId) ?? [], {
      tuple: explained.tuple,
      contextKey,
      waivableThroughSeq,
      waivableThroughAt: waivable?.recordedAt ?? null,
    });

    rows.push({
      requirementId,
      statement: entry.acceptedStatement ?? entry.statement,
      assumption: entry.assumption,
      tuple: explained.tuple,
      firedRules: [...explained.fired].sort(),
      provenance,
      detectorFindings,
      waivableThroughSeq,
      disposition: folded.disposition,
      dispositionRecord: folded.record,
    });
  }
  rows.sort((a, b) => (a.requirementId < b.requirementId ? -1 : 1));
  return rows;
}

/**
 * Decide one gap-disposition append against the CURRENT projected rows for a
 * given register context. `contextKey` is the context the `rows` were
 * projected for ("main" or a branch name); the payload's own `contextKey`
 * must match it, so an action can never be recorded against a context other
 * than the one the caller actually projected (round 1, finding 7).
 *
 * Total: never throws on any input value — every refusal names its reason.
 * Used by the daemon's register service at write time; the store itself
 * re-verifies shape hygiene only (it cannot see the other stores — the
 * intent-journal asymmetry, WP-104).
 */
export function decideGapDisposition(
  rows: readonly GapRegisterRow[],
  contextKey: string,
  input: GapDispositionAppendInput,
): GapDispositionDecision {
  try {
    return decideGapDispositionInner(rows, contextKey, input);
  } catch (error) {
    return {
      ok: false,
      problem: `input observation threw (${safeErrorLabel(error)}) — hostile or exotic input refused`,
    };
  }
}

function decideGapDispositionInner(
  rows: readonly GapRegisterRow[],
  contextKey: string,
  input: GapDispositionAppendInput,
): GapDispositionDecision {
  if (typeof input.requirementId !== "string" || !isRequirementId(input.requirementId)) {
    return { ok: false, problem: "requirementId must match the stable-id grammar (CAM-AREA-NN)" };
  }
  if (!(GAP_DISPOSITION_EVENTS as readonly string[]).includes(input.event)) {
    return {
      ok: false,
      problem: `${JSON.stringify(input.event)} is not a gap-disposition event`,
    };
  }
  if (input.actor !== DAVID_ACTOR) {
    return {
      ok: false,
      problem:
        `gap dispositions record user actions and must carry actor ${JSON.stringify(DAVID_ACTOR)} ` +
        `(got ${JSON.stringify(input.actor)}) — CAM-CORE-04`,
    };
  }
  if (!isPlainObject(input.payload)) {
    return { ok: false, problem: "payload must be a plain object" };
  }
  const payloadIssue = gapDispositionPayloadProblem(input.event, input.payload);
  if (payloadIssue !== null) return { ok: false, problem: `${input.event}: ${payloadIssue}` };
  if (input.payload["contextKey"] !== contextKey) {
    return {
      ok: false,
      problem:
        `the disposition names context ${JSON.stringify(input.payload["contextKey"])} but the ` +
        `register was projected for ${JSON.stringify(contextKey)} — a disposition binds to its own context`,
    };
  }

  const row = rows.find((r) => r.requirementId === input.requirementId);
  if (row === undefined) {
    return {
      ok: false,
      problem:
        `${input.requirementId} has no live gap-register row in this context — ` +
        "dispositions attach to open gaps only",
    };
  }
  const recordedTuple = input.payload["tuple"] as StatusTuple;
  if (!statusTupleEquals(recordedTuple, row.tuple)) {
    return {
      ok: false,
      problem:
        "the disposition's recorded tuple does not match the row's current status tuple — " +
        "the register advanced; re-read and disposition the current state (basis binding)",
    };
  }
  if (input.event === "gap-false-positive-waived") {
    if (row.waivableThroughSeq === null) {
      return {
        ok: false,
        problem:
          `${input.requirementId} is not waivable: waivers exist only for detector false ` +
          "positives (CAM-CANON-05) — this row's gap is not backed solely by detector " +
          "findings; it stays open or the user descopes the requirement through the intent ledger",
      };
    }
    if (input.payload["waivedThroughSeq"] !== row.waivableThroughSeq) {
      return {
        ok: false,
        problem:
          `waivedThroughSeq ${String(input.payload["waivedThroughSeq"])} does not name the row's ` +
          `outstanding detector findings (through seq ${row.waivableThroughSeq}) — a waiver binds ` +
          "to the exact findings it waives",
      };
    }
  }
  if (input.event === "gap-reopened" && row.disposition === "open") {
    return { ok: false, problem: `${input.requirementId} is already open — nothing to reopen` };
  }
  return { ok: true };
}

export interface GapDispositionLogDivergence {
  readonly seq: number;
  readonly problem: string;
}

/**
 * Shape-hygiene verification for an entire gap-disposition log (store
 * adoption path — fail-closed like every Camino store). BOUNDARY, stated:
 * this verifies what the log alone can prove — monotone safe seqs, real
 * timestamps, the David actor binding, closed event vocabulary and
 * payload schemas. Whether each event was APPLICABLE when recorded is a
 * cross-store question (ledger + facts at that moment) that a re-open
 * cannot re-ask — the same asymmetry as the WP-104 intent journal; the
 * projection re-judges applicability on every read anyway (basis
 * binding), so a stale-basis row misleads nothing.
 */
export function verifyGapDispositionLog(
  records: readonly GapDispositionRecord[],
): GapDispositionLogDivergence[] {
  const divergences: GapDispositionLogDivergence[] = [];
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
    if (typeof record.requirementId !== "string" || !isRequirementId(record.requirementId)) {
      divergences.push({
        seq: record.seq,
        problem: "requirementId must match the stable-id grammar (CAM-AREA-NN)",
      });
      continue;
    }
    if (!(GAP_DISPOSITION_EVENTS as readonly string[]).includes(record.event)) {
      divergences.push({
        seq: record.seq,
        problem: `${JSON.stringify(record.event)} is not a gap-disposition event`,
      });
      continue;
    }
    if (record.actor !== DAVID_ACTOR) {
      divergences.push({
        seq: record.seq,
        problem: `gap dispositions must carry actor ${JSON.stringify(DAVID_ACTOR)}`,
      });
      continue;
    }
    if (!isPlainObject(record.payload)) {
      divergences.push({ seq: record.seq, problem: "payload must be a plain object" });
      continue;
    }
    const payloadIssue = gapDispositionPayloadProblem(record.event, record.payload);
    if (payloadIssue !== null) {
      divergences.push({ seq: record.seq, problem: `${record.event}: ${payloadIssue}` });
    }
  }
  return divergences;
}
