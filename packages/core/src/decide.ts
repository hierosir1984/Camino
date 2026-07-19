/**
 * The single transition-decision path (WP-101, hardened per review round 1).
 *
 * `decideTransition` is the ONLY place a transition request becomes an
 * outcome: the daemon recorder calls it before appending, and `verifyReplay`
 * re-runs it over every recorded row — so the recorder and the replay
 * verifier cannot drift, and a log whose rows disagree with a fresh
 * re-derivation (forged enrichment, forged source state, mislabeled
 * rejection) is reported as divergent.
 *
 * Decision steps, in order:
 * 1. Reserved fields: a caller payload carrying "type" or "actor" is
 *    malformed — those are the decision layer's own fields ("type" is the
 *    event discriminator; "actor" is copied from the envelope so guards can
 *    bind rows like "David approves" to the recorded actor). Refused with
 *    `malformed-payload`, and the offending payload is preserved as
 *    evidence, which also keeps replay stable.
 * 2. Recorded-context enrichment: fields the machines declare
 *    (MISSION_CONTEXT_ENRICHMENT / ISSUE_CONTEXT_ENRICHMENT) are
 *    overwritten from the derived view — never trusted from the caller.
 * 3. Existence: creation events on existing entities → `already-exists`;
 *    non-creation events on unknown entities → `unknown-entity`.
 * 4. The pure machine decides (illegal-transition / guard-rejected /
 *    applied).
 *
 * Payload contract: inputs must already be JSON-canonical (the recorder
 * canonicalizes via a JSON round-trip before deciding, so guards evaluate
 * exactly the representation that is persisted; replay inputs come from
 * JSON.parse and are canonical by construction).
 */
import type { EntityKind, EventRecord, RejectionCode } from "@camino/shared";
import type { EnrichmentSpec, MachineDef, MachineEvent } from "./machine.js";
import { RESERVED_PAYLOAD_FIELDS, transition } from "./machine.js";
import { exhaustive } from "./exhaustive.js";
import {
  MISSION_CONTEXT_ENRICHMENT,
  MISSION_CREATION_EVENTS,
  missionMachineFor,
} from "./mission.js";
import { ISSUE_CONTEXT_ENRICHMENT, ISSUE_CREATION_EVENTS, issueMachine } from "./issue.js";
import { ATTEMPT_CREATION_EVENTS, attemptMachine } from "./attempt.js";
import type { StateView } from "./views.js";
import { applyRecord, emptyView } from "./views.js";

export interface DecisionInput {
  readonly entityKind: EntityKind;
  readonly entityId: string;
  readonly event: string;
  /** The envelope actor; injected into the machine event as the reserved `actor` field. */
  readonly actor: string;
  /** JSON-canonical caller payload (see the payload contract above). */
  readonly payload: Readonly<Record<string, unknown>>;
}

export type Decision =
  | {
      readonly ok: true;
      readonly to: string;
      readonly ref: string;
      readonly fromState: string | null;
      /** The payload as decided (enriched, reserved fields excluded) — what gets persisted. */
      readonly payload: Record<string, unknown>;
    }
  | {
      readonly ok: false;
      readonly code: RejectionCode;
      readonly fromState: string | null;
      readonly payload: Record<string, unknown>;
    };

export function decideTransition(view: StateView, input: DecisionInput): Decision {
  const fromState = snapshotState(view, input.entityKind, input.entityId) ?? null;

  // 1. Reserved fields are the decision layer's own.
  for (const reserved of RESERVED_PAYLOAD_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input.payload, reserved)) {
      return {
        ok: false,
        code: "malformed-payload",
        fromState,
        payload: { ...input.payload },
      };
    }
  }

  // 2. Recorded context comes from the view, never the caller.
  const payload: Record<string, unknown> = { ...input.payload };
  for (const spec of enrichmentFor(input.entityKind, input.event)) {
    const value = enrichmentValue(view, input.entityKind, input.entityId, spec);
    if (value === undefined) {
      // Absent recorded context is recorded as absent; the guard rejects.
      delete payload[spec.field];
    } else {
      payload[spec.field] = value;
    }
  }

  // 3. Creation/existence discipline.
  const isCreationEvent = creationEvents(input.entityKind).includes(input.event);
  if (isCreationEvent && fromState !== null) {
    return { ok: false, code: "already-exists", fromState, payload };
  }
  if (!isCreationEvent && fromState === null) {
    return { ok: false, code: "unknown-entity", fromState, payload };
  }

  // 4. The pure machine decides. The event object carries the reserved
  //    fields last so nothing in the payload can shadow them.
  const machine = machineFor(view, input.entityKind, input.entityId, input.event);
  const event = { ...payload, actor: input.actor, type: input.event } as MachineEvent;
  const result = transition(machine, fromState, event);
  if (!result.ok) {
    return { ok: false, code: result.code, fromState, payload };
  }
  return { ok: true, to: result.to, ref: result.ref, fromState, payload };
}

export interface ReplayDivergence {
  readonly seq: number;
  readonly problem: string;
}

/**
 * Re-derive every recorded row through `decideTransition` over a fold of
 * the preceding rows and report any disagreement: outcome, target state,
 * source state, rejection code, or recorded payload (enrichment included).
 * An empty result means the log and the code agree (CAM-STATE-05's
 * code-vs-log half). The daemon may run this at recovery.
 */
export function verifyReplay(records: readonly EventRecord[]): ReplayDivergence[] {
  const divergences: ReplayDivergence[] = [];
  const view = emptyView();
  for (const record of records) {
    const decision = decideTransition(view, {
      entityKind: record.entityKind,
      entityId: record.entityId,
      event: record.event,
      actor: record.actor,
      payload: record.payload,
    });
    if (decision.fromState !== record.fromState) {
      divergences.push({
        seq: record.seq,
        problem: `recorded fromState ${JSON.stringify(record.fromState)} but the fold says ${JSON.stringify(decision.fromState)}`,
      });
    }
    if (record.outcome === "applied") {
      if (!decision.ok) {
        divergences.push({
          seq: record.seq,
          problem: `applied as ${record.toState} but the decision now rejects (${decision.code})`,
        });
      } else {
        if (decision.to !== record.toState) {
          divergences.push({
            seq: record.seq,
            problem: `applied as ${record.toState} but the decision now targets ${decision.to}`,
          });
        }
        if (!jsonEqual(decision.payload, record.payload)) {
          divergences.push({
            seq: record.seq,
            problem: "recorded payload diverges from re-derived recorded context",
          });
        }
      }
      applyRecord(view, record);
    } else if (decision.ok) {
      divergences.push({
        seq: record.seq,
        problem: `rejected (${record.rejectionCode}) but the decision now applies to ${decision.to}`,
      });
    } else {
      if (decision.code !== record.rejectionCode) {
        divergences.push({
          seq: record.seq,
          problem: `rejected as ${record.rejectionCode} but the decision now rejects as ${decision.code}`,
        });
      }
      if (!jsonEqual(decision.payload, record.payload)) {
        divergences.push({
          seq: record.seq,
          problem: "recorded rejection payload diverges from re-derived recorded context",
        });
      }
    }
  }
  return divergences;
}

/** Structural equality over JSON-canonical values (arrays never equal objects). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>).sort();
    const bKeys = Object.keys(b as Record<string, unknown>).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key, i) =>
        key === bKeys[i] &&
        jsonEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

function creationEvents(entityKind: EntityKind): readonly string[] {
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

function machineFor(
  view: StateView,
  entityKind: EntityKind,
  entityId: string,
  event: string,
): MachineDef<string, MachineEvent> {
  switch (entityKind) {
    case "mission": {
      const route =
        view.missions.get(entityId)?.route ?? MISSION_CREATION_EVENTS[event] ?? "integration";
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

function enrichmentFor(entityKind: EntityKind, event: string): readonly EnrichmentSpec[] {
  switch (entityKind) {
    case "mission":
      return MISSION_CONTEXT_ENRICHMENT[event] ?? [];
    case "issue":
      return ISSUE_CONTEXT_ENRICHMENT[event] ?? [];
    case "attempt":
      return [];
    default:
      return exhaustive(entityKind, "entityKind");
  }
}

function enrichmentValue(
  view: StateView,
  entityKind: EntityKind,
  entityId: string,
  spec: EnrichmentSpec,
): unknown {
  const mission = entityKind === "mission" ? view.missions.get(entityId) : undefined;
  const issue = entityKind === "issue" ? view.issues.get(entityId) : undefined;
  switch (spec.source) {
    case "paused-from":
      return mission?.pausedFrom;
    case "current-candidate-sha":
      return mission?.currentCandidateSha;
    case "current-packet-hash":
      return mission?.currentPacketHash;
    case "approved-candidate-sha":
      return mission?.approval?.candidateSha;
    case "next-mission-failure-count":
      return (mission?.failureCount ?? 0) + 1;
    case "next-issue-failure-count":
      return (issue?.failureCount ?? 0) + 1;
    default:
      return exhaustive(spec.source, "enrichment source");
  }
}

function snapshotState(
  view: StateView,
  entityKind: EntityKind,
  entityId: string,
): string | undefined {
  switch (entityKind) {
    case "mission":
      return view.missions.get(entityId)?.state;
    case "issue":
      return view.issues.get(entityId)?.state;
    case "attempt":
      return view.attempts.get(entityId)?.state;
    default:
      return exhaustive(entityKind, "entityKind");
  }
}
