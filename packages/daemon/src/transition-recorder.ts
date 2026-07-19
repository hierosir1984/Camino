/**
 * Transition recorder (WP-101): the daemon-side seam between the pure
 * Appendix A machines (@camino/core) and the append-only event log.
 *
 * Every submitted transition is validated by the machines and recorded —
 * applied transitions as `outcome: "applied"` rows, refused ones as
 * `outcome: "rejected"` rows with the rejection code (illegal transitions
 * are rejected AND logged, CAM-STATE-05). The live view is maintained by
 * applying each appended record through the same fold step replay uses, so
 * a recorder freshly constructed over the same log arrives at an identical
 * view (CAM-STATE-01 — derived views rebuild from the log alone; tested).
 *
 * Recorded-context enrichment: fields the machines declare as recorded
 * context (MISSION_CONTEXT_ENRICHMENT / ISSUE_CONTEXT_ENRICHMENT — e.g.
 * the resume target, the bound approval SHA, failure counters) are always
 * overwritten here from the recorder's own view. Callers cannot supply
 * them; the guards therefore run against what the log records, which is
 * how "prior state (recorded)" and "approvals never transfer between SHAs"
 * (A.4#4) are enforced mechanically.
 *
 * Single-writer: one recorder owns a store at a time. The recovery lock
 * making that durable across processes is WP-104 (CAM-STATE-03).
 */
import type { EntityKind, EventRecord, EventStore, RejectionCode } from "@camino/shared";
import {
  applyRecord,
  ATTEMPT_CREATION_EVENTS,
  attemptMachine,
  exhaustive,
  foldView,
  ISSUE_CONTEXT_ENRICHMENT,
  ISSUE_CREATION_EVENTS,
  issueMachine,
  MISSION_CONTEXT_ENRICHMENT,
  MISSION_CREATION_EVENTS,
  missionMachineFor,
  transition,
  verifyReplay,
} from "@camino/core";
import type {
  EnrichmentSpec,
  MachineDef,
  MachineEvent,
  ReplayDivergence,
  StateView,
} from "@camino/core";

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

  constructor(store: EventStore) {
    this.store = store;
    // Recovery is replay: the view exists only as a fold over the log.
    this.view = foldView(store.read());
  }

  /** Read-only access to the live derived view. */
  get currentView(): StateView {
    return this.view;
  }

  currentState(entityKind: EntityKind, entityId: string): string | undefined {
    return this.snapshotState(entityKind, entityId);
  }

  /**
   * Validate one transition against the machines and record the outcome.
   * Applied and rejected attempts both land in the log; only applied ones
   * change the view.
   */
  record(request: RecordRequest): RecordOutcome {
    const { entityKind, entityId } = request;
    const fromState = this.snapshotState(entityKind, entityId) ?? null;
    const isCreationEvent = this.creationEvents(entityKind).includes(request.event);
    const payload = this.enrich(request);

    if (isCreationEvent && fromState !== null) {
      return this.reject(request, payload, fromState, "already-exists");
    }
    if (!isCreationEvent && fromState === null) {
      return this.reject(request, payload, fromState, "unknown-entity");
    }

    const machine = this.machineFor(entityKind, entityId, request.event);
    const event = { type: request.event, ...payload } as MachineEvent;
    const result = transition(machine, fromState, event);
    if (!result.ok) {
      return this.reject(request, payload, fromState, result.code);
    }

    const record = this.store.append({
      entityKind,
      entityId,
      event: request.event,
      actor: request.actor,
      cause: request.cause,
      payload,
      fromState,
      toState: result.to,
      outcome: "applied",
    });
    applyRecord(this.view, record);
    return { ok: true, to: result.to, ref: result.ref, record };
  }

  /** Rebuild the view from the log alone and adopt it (recovery path). */
  rebuild(): StateView {
    this.view = foldView(this.store.read());
    return this.view;
  }

  /** Re-run the whole log through the machines; [] means log and code agree. */
  verify(): ReplayDivergence[] {
    return verifyReplay(this.store.read());
  }

  private reject(
    request: RecordRequest,
    payload: Readonly<Record<string, unknown>>,
    fromState: string | null,
    code: RejectionCode,
  ): RecordOutcome {
    const record = this.store.append({
      entityKind: request.entityKind,
      entityId: request.entityId,
      event: request.event,
      actor: request.actor,
      cause: request.cause,
      payload,
      fromState,
      toState: null,
      outcome: "rejected",
      rejectionCode: code,
    });
    return { ok: false, code, record };
  }

  private creationEvents(entityKind: EntityKind): readonly string[] {
    switch (entityKind) {
      case "mission":
        return Object.keys(MISSION_CREATION_EVENTS);
      case "issue":
        return ISSUE_CREATION_EVENTS;
      case "attempt":
        return ATTEMPT_CREATION_EVENTS;
      default:
        return exhaustive(entityKind, "entityKind");
    }
  }

  private machineFor(
    entityKind: EntityKind,
    entityId: string,
    event: string,
  ): MachineDef<string, MachineEvent> {
    switch (entityKind) {
      case "mission": {
        const route =
          this.view.missions.get(entityId)?.route ??
          MISSION_CREATION_EVENTS[event] ??
          "integration";
        return missionMachineFor(route) as unknown as MachineDef<string, MachineEvent>;
      }
      case "issue":
        return issueMachine as unknown as MachineDef<string, MachineEvent>;
      case "attempt":
        return attemptMachine as unknown as MachineDef<string, MachineEvent>;
      default:
        return exhaustive(entityKind, "entityKind");
    }
  }

  private enrichmentFor(entityKind: EntityKind, event: string): EnrichmentSpec | undefined {
    switch (entityKind) {
      case "mission":
        return MISSION_CONTEXT_ENRICHMENT[event];
      case "issue":
        return ISSUE_CONTEXT_ENRICHMENT[event];
      case "attempt":
        return undefined;
      default:
        return exhaustive(entityKind, "entityKind");
    }
  }

  /**
   * Fill recorded-context fields from the view, overwriting whatever the
   * caller supplied — recorded context is the recorder's testimony, never
   * the caller's claim.
   */
  private enrich(request: RecordRequest): Record<string, unknown> {
    const payload: Record<string, unknown> = { ...(request.payload ?? {}) };
    const spec = this.enrichmentFor(request.entityKind, request.event);
    if (!spec) return payload;
    const mission = this.view.missions.get(request.entityId);
    const issue = this.view.issues.get(request.entityId);
    let value: unknown;
    switch (spec.source) {
      case "paused-from":
        value = mission?.pausedFrom;
        break;
      case "current-candidate-sha":
        value = mission?.currentCandidateSha;
        break;
      case "approved-candidate-sha":
        value = mission?.approval?.candidateSha;
        break;
      case "next-mission-failure-count":
        value = (mission?.failureCount ?? 0) + 1;
        break;
      case "next-issue-failure-count":
        value = (issue?.failureCount ?? 0) + 1;
        break;
      default:
        return exhaustive(spec.source, "enrichment source");
    }
    if (value === undefined) {
      // Absent recorded context is recorded as absent; the guard rejects.
      delete payload[spec.field];
    } else {
      payload[spec.field] = value;
    }
    return payload;
  }

  private snapshotState(entityKind: EntityKind, entityId: string): string | undefined {
    switch (entityKind) {
      case "mission":
        return this.view.missions.get(entityId)?.state;
      case "issue":
        return this.view.issues.get(entityId)?.state;
      case "attempt":
        return this.view.attempts.get(entityId)?.state;
      default:
        return exhaustive(entityKind, "entityKind");
    }
  }
}
