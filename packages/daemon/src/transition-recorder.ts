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
 * Single-writer: one recorder owns a store at a time. Before every append
 * the recorder checks the store has not advanced beyond its view and throws
 * if it has — detection, not prevention; the durable cross-process recovery
 * lock is WP-104 (CAM-STATE-03).
 */
import type { EntityKind, EventRecord, EventStore, RejectionCode } from "@camino/shared";
import { decideTransition, foldView, applyRecord, verifyReplay } from "@camino/core";
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
    // Recovery is replay: the view exists only as a fold over the log.
    const records = store.read();
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
   * view.
   */
  record(request: RecordRequest): RecordOutcome {
    this.assertStoreNotAdvanced();
    const decision = decideTransition(this.view, {
      entityKind: request.entityKind,
      entityId: request.entityId,
      event: request.event,
      actor: request.actor,
      payload: canonicalize(request.payload ?? {}),
    });
    const record = this.store.append({
      entityKind: request.entityKind,
      entityId: request.entityId,
      event: request.event,
      actor: request.actor,
      cause: request.cause,
      payload: decision.payload,
      fromState: decision.fromState,
      toState: decision.ok ? decision.to : null,
      outcome: decision.ok ? "applied" : "rejected",
      ...(decision.ok ? {} : { rejectionCode: decision.code }),
    });
    this.lastSeq = record.seq;
    if (decision.ok) {
      applyRecord(this.view, record);
      return { ok: true, to: decision.to, ref: decision.ref, record };
    }
    return { ok: false, code: decision.code, record };
  }

  /** Rebuild the view from the log alone and adopt it (recovery path). */
  rebuild(): StateView {
    const records = this.store.read();
    this.view = foldView(records);
    this.lastSeq = records.at(-1)?.seq ?? 0;
    return structuredClone(this.view);
  }

  /** Re-derive the whole log through the decision path; [] means agreement. */
  verify(): ReplayDivergence[] {
    return verifyReplay(this.store.read());
  }

  private assertStoreNotAdvanced(): void {
    const newer = this.store.read({ afterSeq: this.lastSeq });
    if (newer.length > 0) {
      throw new Error(
        `event store advanced beyond this recorder's view (seq ${newer.at(-1)?.seq} > ${this.lastSeq}): ` +
          "a second writer violated the single-writer contract (CAM-STATE-03; the durable recovery lock lands with WP-104). " +
          "Rebuild before recording.",
      );
    }
  }
}

/**
 * JSON round-trip so the decision runs on exactly what will be persisted
 * (drops undefined-valued fields, turns non-finite numbers into null,
 * rejects payloads JSON cannot represent).
 */
function canonicalize(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Event payload must be a plain object");
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch (error) {
    throw new TypeError(`Event payload must be JSON-serializable: ${(error as Error).message}`);
  }
  if (json === undefined) {
    throw new TypeError("Event payload must be JSON-serializable");
  }
  return JSON.parse(json) as Record<string, unknown>;
}
