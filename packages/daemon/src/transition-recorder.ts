/**
 * Transition recorder (WP-101): the daemon-side seam between the pure
 * Appendix A decision path (@camino/core decideTransition) and the
 * append-only event log.
 *
 * The recorder itself decides nothing: it canonicalizes the caller payload
 * (a JSON round-trip, so guards evaluate exactly the representation that is
 * persisted), hands the request to core's `decideTransition` over its
 * derived view, appends the outcome — applied transitions AND refused ones,
 * with their rejection codes (illegal transitions are rejected and logged,
 * CAM-STATE-05) — and folds applied records into its view with the same
 * step replay uses, so a recorder freshly constructed over the same log
 * arrives at an identical view (CAM-STATE-01; tested). `verify()` re-derives
 * the whole log through the identical decision path.
 *
 * Recorded context (resume targets, candidate/packet bindings, failure
 * counters) is enriched inside the decision path from the recorded view;
 * caller-supplied values for those fields — and for the reserved fields
 * "type"/"actor" — never reach a guard.
 *
 * Single-writer: one recorder owns a store at a time. Every append is a
 * compare-and-swap against the recorder's known last seq, atomic with the
 * insert inside the store's transaction; a second writer's interleaving
 * refuses rather than corrupts. The durable cross-process recovery lock is
 * WP-104 (CAM-STATE-03).
 */
import type { EntityKind, EventRecord, EventStore, RejectionCode } from "@camino/shared";
import {
  decideTransition,
  foldView,
  applyRecord,
  verifyReplay,
  RESERVED_PAYLOAD_FIELDS,
} from "@camino/core";
import type { ReplayDivergence, StateView } from "@camino/core";

export interface RecordRequest {
  readonly entityKind: EntityKind;
  readonly entityId: string;
  readonly event: string;
  readonly actor: string;
  readonly cause: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export type RecordOutcome =
  | { readonly ok: true; readonly to: string; readonly ref: string; readonly record: EventRecord }
  | { readonly ok: false; readonly code: RejectionCode; readonly record: EventRecord };

export class TransitionRecorder {
  private readonly store: EventStore;
  private view: StateView;
  private lastSeq: number;

  constructor(store: EventStore) {
    this.store = store;
    // Recovery is replay, and it is fail-closed: a log the decision path
    // disagrees with (forged rows, states no machine knows, source-state
    // mismatches) is refused rather than silently adopted. Forensics on a
    // refused log go through core's foldView/verifyReplay directly.
    const records = store.read();
    assertLogVerifies(records);
    this.view = foldView(records);
    this.lastSeq = records.at(-1)?.seq ?? 0;
  }

  /**
   * A snapshot copy of the derived view. Mutating it cannot influence the
   * recorder — recorded context is read from the recorder's private view.
   */
  get currentView(): StateView {
    return structuredClone(this.view);
  }

  currentState(entityKind: EntityKind, entityId: string): string | undefined {
    switch (entityKind) {
      case "mission":
        return this.view.missions.get(entityId)?.state;
      case "issue":
        return this.view.issues.get(entityId)?.state;
      case "attempt":
        return this.view.attempts.get(entityId)?.state;
    }
  }

  /**
   * Decide one transition through core and record the outcome. Applied and
   * rejected attempts both land in the log; only applied ones change the
   * view. Malformed payloads — reserved fields, shapes JSON cannot hold as
   * a plain object — are refused AND logged, never thrown past silently.
   */
  record(request: RecordRequest): RecordOutcome {
    // Snapshot the request exactly once: exotic caller objects (accessor
    // properties returning different values per read) must not let the
    // decision see one request and the durable record another.
    const { entityKind, entityId, event, actor, cause } = request;
    const payload = canonicalize(request.payload ?? {});
    const decision = decideTransition(this.view, {
      entityKind,
      entityId,
      event,
      actor,
      payload,
    });
    // Atomic single-writer append: the store checks-and-inserts in one
    // transaction against the recorder's known last seq (CAM-STATE-03;
    // the durable cross-process recovery lock lands with WP-104).
    const record = this.store.append(
      {
        entityKind,
        entityId,
        event,
        actor,
        cause,
        payload: decision.payload,
        fromState: decision.fromState,
        toState: decision.ok ? decision.to : null,
        outcome: decision.ok ? "applied" : "rejected",
        ...(decision.ok ? {} : { rejectionCode: decision.code }),
      },
      { expectedLastSeq: this.lastSeq },
    );
    this.lastSeq = record.seq;
    if (decision.ok) {
      applyRecord(this.view, record);
      return { ok: true, to: decision.to, ref: decision.ref, record };
    }
    return { ok: false, code: decision.code, record };
  }

  /** Rebuild the view from the log alone and adopt it (recovery path, fail-closed). */
  rebuild(): StateView {
    const records = this.store.read();
    assertLogVerifies(records);
    this.view = foldView(records);
    this.lastSeq = records.at(-1)?.seq ?? 0;
    return structuredClone(this.view);
  }

  /** Re-derive the whole log through the decision path; [] means agreement. */
  verify(): ReplayDivergence[] {
    return verifyReplay(this.store.read());
  }
}

/** Recovery refuses logs the decision path disagrees with (CAM-STATE-05). */
function assertLogVerifies(records: Parameters<typeof verifyReplay>[0]): void {
  const divergences = verifyReplay(records);
  if (divergences.length > 0) {
    const detail = divergences
      .slice(0, 5)
      .map((d) => `seq ${d.seq}: ${d.problem}`)
      .join("; ");
    throw new Error(
      `event log fails replay verification (${divergences.length} divergence(s)) — refusing to adopt it: ${detail}`,
    );
  }
}

/**
 * A stand-in payload for requests whose payload JSON cannot hold as a plain
 * object at all (BigInt values, toJSON returning a non-object, non-object
 * inputs, property traps that throw). It deliberately carries a reserved
 * key so the decision path — today and on every future replay of the
 * record — lands on the same `malformed-payload` refusal (replay-stable by
 * construction).
 */
const UNREPRESENTABLE_PAYLOAD: Readonly<Record<string, unknown>> = {
  type: null,
  malformedPayload: "payload was not representable as a plain JSON object",
};

/**
 * JSON round-trip so the decision runs on exactly what will be persisted
 * (drops undefined-valued fields, turns non-finite numbers into null).
 * Reserved keys present on the RAW payload are preserved (as null when
 * JSON would drop them) so the reserved-field refusal cannot be dodged
 * with an undefined value; payloads JSON cannot represent at all become
 * UNREPRESENTABLE_PAYLOAD, which the decision path refuses and logs.
 */
function canonicalize(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
  // Every interaction with the caller's object can hit a trap (accessors
  // that delete themselves, Proxy handlers that throw): capture reserved-key
  // presence FIRST, and treat any exception anywhere as an unrepresentable
  // payload — refused and logged, never thrown past.
  try {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return { ...UNREPRESENTABLE_PAYLOAD };
    }
    const reservedPresent = RESERVED_PAYLOAD_FIELDS.filter((key) =>
      Object.prototype.hasOwnProperty.call(payload, key),
    );
    const json = JSON.stringify(payload);
    if (json === undefined) {
      return { ...UNREPRESENTABLE_PAYLOAD };
    }
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...UNREPRESENTABLE_PAYLOAD };
    }
    const canonical = parsed as Record<string, unknown>;
    for (const reserved of reservedPresent) {
      canonical[reserved] = canonical[reserved] ?? null;
    }
    return canonical;
  } catch {
    return { ...UNREPRESENTABLE_PAYLOAD };
  }
}
