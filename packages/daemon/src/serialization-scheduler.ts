/**
 * Per-repo serialization scheduler (WP-103, CAM-CORE-08): one active
 * mission per repo, plus the urgent lane, with additional missions waiting
 * visibly in `queued` and activating FIFO when their slot frees.
 *
 * Two scheduling slots per repo, both first-class:
 *  - the PRIMARY slot, held by whichever non-urgent mission is in an
 *    execution-bearing state (core's isExecutionBearing over the recorded
 *    view — Appendix A serialization rule as amended per AMEND-2);
 *  - the URGENT lane, held by an urgent quick task in an execution-bearing
 *    state. While the urgent task ACTIVELY executes, an integration-route
 *    primary holder sits in `paused-urgent` (A.1#15) and STILL holds the
 *    primary slot — resuming via A.1#20 when the urgent task lands. (In the
 *    honest pre-park window the urgent task is merely `approved` beside the
 *    still-executing primary — r3/r4 wording precision.)
 *
 * The urgent lane accepts a mission only when the primary holder (if any)
 * is PARKED or PARKABLE (r1 f3, r2 f1, wording per r3 f8): parked =
 * paused-urgent / paused-external / paused-manual — including a quick task
 * David paused manually, which is deliberately parked even though quick
 * tasks can never be PREEMPTED (A.1b has no urgent-preemption row);
 * parkable = an integration-route mission in `executing`, the one state
 * A.1#15 preempts from. Every other primary holder — a quick task
 * running/validating/merging, or an integration mission in approved /
 * awaiting-merge-approval / merging / escalated / blocked (no preemption
 * row from those states either) — cannot be parked, so an urgent task
 * approved in that window waits in `queued` and activates when the primary
 * becomes parkable, parked, or terminal. (Recorded as a spec observation
 * in the PR; appendix amendments adding preemption rows would be David's
 * change-control call, not this WP's.)
 *
 * The scheduler derives everything from the domain store (which mission
 * belongs to which repo, which lane it schedules on) joined with the
 * recorder's derived view (state, pausedFrom) and the event log (FIFO order
 * = first entry into `queued`, core's queuedEntrySeqs). It never bypasses
 * the recorder: activation is a recorded `execution-slot-freed` transition
 * (A.1#5), and plan approval goes through `approvePlan`, which computes the
 * slot fact and records the transition in ONE synchronous frame — the
 * check cannot interleave with another in-process record (r1 finding 2's
 * check/record race), and a cross-process interleaving is refused by the
 * store's compare-and-swap append (the durable recovery lock is WP-104).
 *
 * Enforcement boundary, stated plainly: Appendix A guards check ATTESTED
 * facts; the scheduler is the honest source of the slot and FIFO facts
 * (`approvePlan`, `activateNext`), and every in-process caller is expected
 * to route through it. A caller that attests its own facts against this
 * module's answers is a daemon bug, not a schema the machine can refuse —
 * the recorded view carries no repo binding, so recorded-context
 * enrichment cannot overwrite these facts today. What the module ships
 * instead is visibility for an ENUMERATED invariant set (r4 finding 7 —
 * not "complete"): `serializationViolations` surfaces per-lane
 * double-occupancy, an urgent holder beside an unadmittable primary, and
 * active urgent execution beside an unparked-but-parkable primary;
 * `auditActivations` re-derives every recorded activation against FIFO
 * order. Recorded missions WITHOUT a domain row are outside lane
 * accounting entirely (they have no repo); `MissionIntake.seamDivergences`
 * reports them (`eventOnlyMissionIds`), not this module.
 *
 * The urgent preemption WORKFLOW — checkpoint-cancel of the running
 * attempt, urgent lands on main first, mission branch merges main back in
 * and revalidates per impact assessment — is CAM-PLAN-10 [P2]: recorded
 * here, deliberately not built. WP-103 ships the lane as a scheduling slot
 * and the state-machine rows (A.1#15/A.1#20 in core, exercised in tests);
 * the orchestration lands with CAM-PLAN-10.
 */
import type { EventStore } from "@camino/shared";
import type { MissionRecord } from "@camino/shared";
import type { ActivationDeviation, MissionState } from "@camino/core";
import {
  MISSION_TERMINAL_STATES,
  auditActivationOrder,
  fifoOrder,
  isExecutionBearing,
  queuedEntrySeqs,
} from "@camino/core";
import type { SqliteDomainStore } from "./domain-store.js";
import type { RecordOutcome, TransitionRecorder } from "./transition-recorder.js";

export type SchedulingLane = "primary" | "urgent";

/** The actor recorded on scheduler-initiated transitions. */
export const SCHEDULER_ACTOR = "camino:scheduler";

/** States in which a holder is actively driving work/validation/merge. */
const ACTIVE_EXECUTION_STATES: readonly MissionState[] = [
  "executing",
  "awaiting-merge-approval",
  "merging",
];

/** States in which a primary holder is parked and the urgent lane may run. */
const PARKED_STATES: readonly MissionState[] = [
  "paused-urgent",
  "paused-external",
  "paused-manual",
];

export interface LaneHolder {
  readonly missionId: string;
  readonly state: MissionState;
}

export interface LaneOccupancy {
  readonly primary?: LaneHolder;
  readonly urgent?: LaneHolder;
}

/** A mission waiting visibly in `queued` (CAM-CORE-08 acceptance). */
export interface QueuedEntry {
  readonly missionId: string;
  readonly title: string;
  readonly lane: SchedulingLane;
  /** Seq of the first transition into `queued` — the FIFO key. */
  readonly queuedSinceSeq: number;
  /** When the mission first entered `queued` (recordedAt of that event). */
  readonly queuedSince: string;
}

export interface RepoQueueView {
  /** Execution-bearing holders per lane (at most one each). */
  readonly active: LaneOccupancy;
  /**
   * Missions waiting in `queued` — DISPLAY ordering: first-entry order
   * across both lanes (each entry names its lane). ACTIVATION order is per
   * lane with the urgent lane first (r5 finding 1) — an urgent task never
   * waits behind older primary missions.
   */
  readonly queued: readonly QueuedEntry[];
  /**
   * Missions in non-execution-bearing active states (draft, planned, a
   * paused-manual that was paused before holding the slot): intake and
   * planning proceed concurrently — they touch no workspace.
   */
  readonly concurrent: readonly { missionId: string; title: string; state: MissionState }[];
}

/** Evidence of a serialization invariant breach (r1 f2/f3, r2 f1, r3 f5). */
export type SerializationViolation =
  | {
      /** More than one execution-bearing holder in one lane. */
      readonly kind: "multi-holder";
      readonly lane: SchedulingLane;
      readonly missionIds: readonly string[];
    }
  | {
      /**
       * The urgent lane holds a mission (in ANY execution-bearing state)
       * beside a primary the lane-admission rule would never have admitted
       * it next to: not parked, and not parkable (r3 finding 5 — e.g. both
       * sides sitting in `approved` via bypassed attestations; the primary
       * can never be parked, so the pair is wedged, not merely early).
       */
      readonly kind: "urgent-beside-unadmittable-primary";
      readonly primaryMissionId: string;
      readonly primaryState: MissionState;
      readonly urgentMissionId: string;
    }
  | {
      /**
       * The urgent lane is ACTIVELY executing while a parkable primary
       * (integration route in `executing`) has not actually been parked —
       * the A.1#15 preemption step was skipped (r2 finding 1).
       */
      readonly kind: "urgent-active-while-primary-unparked";
      readonly primaryMissionId: string;
      readonly primaryState: MissionState;
      readonly urgentMissionId: string;
    };

/** Facts David attests when approving an integration-route plan (A.1#3). */
export interface IntegrationApprovalFacts {
  readonly checklistApproved: boolean;
  readonly dagAcyclic: boolean;
}

/** Facts David attests when approving a quick task (A.1b#3 gates). */
export interface QuickTaskApprovalFacts {
  readonly riskTierLow: boolean;
  readonly neutralConcurred: boolean;
  readonly singleIssue: boolean;
}

export interface ActivationOutcome {
  readonly lane: SchedulingLane;
  readonly missionId: string;
  readonly to: MissionState;
}

export class SerializationScheduler {
  private readonly domain: SqliteDomainStore;
  private readonly recorder: TransitionRecorder;
  private readonly store: EventStore;

  constructor(domain: SqliteDomainStore, recorder: TransitionRecorder, store: EventStore) {
    this.domain = domain;
    this.recorder = recorder;
    this.store = store;
  }

  /**
   * Record David's plan approval with the slot fact computed by the
   * scheduler itself, in one synchronous frame (r1 finding 2): between the
   * slot computation and the recorder append there is no await point, so no
   * other in-process record() can interleave. The guard-split routes the
   * mission to `approved` (slot free) or `queued` (slot taken); the caller
   * attests only the facts that are genuinely theirs (checklist, DAG, or
   * the quick-task gates).
   */
  approvePlan(
    missionId: string,
    actor: string,
    facts: IntegrationApprovalFacts | QuickTaskApprovalFacts,
  ): RecordOutcome {
    const mission = this.requireMission(missionId);
    if (mission.route === "integration" && !("checklistApproved" in facts)) {
      throw new TypeError("integration-route approval requires IntegrationApprovalFacts");
    }
    if (mission.route === "quick-task" && !("riskTierLow" in facts)) {
      throw new TypeError("quick-task approval requires QuickTaskApprovalFacts");
    }
    return this.recorder.record({
      entityKind: "mission",
      entityId: missionId,
      event: "plan-approved",
      actor,
      cause: `plan approval with scheduler-computed slot fact (repo ${mission.repoId})`,
      payload: { ...facts, executionSlotFree: this.executionSlotFreeFor(missionId) },
    });
  }

  /** Which mission (if any) holds each of the repo's two slots right now. */
  laneOccupancy(repoId: string): LaneOccupancy {
    const holders = this.laneHolders(repoId);
    const primary = holders.primary[0];
    const urgent = holders.urgent[0];
    return {
      ...(primary === undefined ? {} : { primary }),
      ...(urgent === undefined ? {} : { urgent }),
    };
  }

  /** Non-empty exactly when a serialization invariant is breached (see the type). */
  serializationViolations(repoId: string): SerializationViolation[] {
    const holders = this.laneHolders(repoId);
    const violations: SerializationViolation[] = [];
    for (const lane of ["primary", "urgent"] as const) {
      if (holders[lane].length > 1) {
        violations.push({
          kind: "multi-holder",
          lane,
          missionIds: holders[lane].map((h) => h.missionId),
        });
      }
    }
    // Cross-lane rules (r1 f3, r2 f1, r3 f5), mirroring the lane-admission
    // rule exactly so no bypassed pairing can report green:
    // (a) an urgent holder beside an UNADMITTABLE primary (not parked, not
    //     parkable) is a wedged pairing regardless of the urgent's state;
    // (b) an ACTIVE urgent beside a parkable-but-unparked primary means the
    //     A.1#15 preemption step was skipped.
    for (const primary of holders.primary) {
      for (const urgent of holders.urgent) {
        if (!this.primaryAdmitsUrgent(primary)) {
          violations.push({
            kind: "urgent-beside-unadmittable-primary",
            primaryMissionId: primary.missionId,
            primaryState: primary.state,
            urgentMissionId: urgent.missionId,
          });
        } else if (
          ACTIVE_EXECUTION_STATES.includes(urgent.state) &&
          !PARKED_STATES.includes(primary.state)
        ) {
          violations.push({
            kind: "urgent-active-while-primary-unparked",
            primaryMissionId: primary.missionId,
            primaryState: primary.state,
            urgentMissionId: urgent.missionId,
          });
        }
      }
    }
    return violations;
  }

  /**
   * The slot-free fact for THIS mission's plan approval (A.1#3 / A.1b#3
   * `executionSlotFree`): whether the lane the mission schedules on —
   * primary normally, the urgent lane for an urgent quick task — can accept
   * it. Admission is SYMMETRIC (r4 finding 1): the urgent lane requires the
   * primary parked or parkable, and the primary slot requires the urgent
   * lane EMPTY — otherwise honest urgent-first scheduling would admit a
   * primary into `approved` beside a running urgent task, a pairing nothing
   * can park (the exact wedged state the violation surface reports).
   * Exposed for inspection/display; approval itself must go through
   * `approvePlan`, which computes this fact in the same synchronous frame
   * as the record (r1 finding 2).
   */
  executionSlotFreeFor(missionId: string): boolean {
    const mission = this.requireMission(missionId);
    const holders = this.laneHolders(mission.repoId);
    if (mission.urgent) return this.urgentLaneAvailable(holders);
    return holders.primary.length === 0 && holders.urgent.length === 0;
  }

  /** The visible per-repo queue (CAM-CORE-08: a waiting mission waits VISIBLY). */
  repoQueue(repoId: string): RepoQueueView {
    const view = this.recorder.currentView;
    const missionRecords = this.store.read({ entityKind: "mission" });
    const entrySeqs = queuedEntrySeqs(missionRecords);
    const recordedAtBySeq = new Map<number, string>();
    for (const record of missionRecords) {
      recordedAtBySeq.set(record.seq, record.recordedAt);
    }

    const active: { primary?: LaneHolder; urgent?: LaneHolder } = {};
    const queuedIds: string[] = [];
    const byId = new Map<string, MissionRecord>();
    const concurrent: { missionId: string; title: string; state: MissionState }[] = [];

    for (const mission of this.domain.listMissions(repoId)) {
      const snapshot = view.missions.get(mission.id);
      if (snapshot === undefined) continue; // no creation event — seamDivergences() surfaces these
      byId.set(mission.id, mission);
      const state = snapshot.state;
      if (isExecutionBearing(state, snapshot.pausedFrom)) {
        const lane: SchedulingLane = mission.urgent ? "urgent" : "primary";
        if (active[lane] === undefined) active[lane] = { missionId: mission.id, state };
        continue;
      }
      if (state === "queued") {
        queuedIds.push(mission.id);
        continue;
      }
      if (!isTerminal(state)) {
        concurrent.push({ missionId: mission.id, title: mission.title, state });
      }
    }

    const queued: QueuedEntry[] = fifoOrder(queuedIds, entrySeqs).map((missionId) => {
      const mission = byId.get(missionId) as MissionRecord;
      const seq = entrySeqs.get(missionId);
      return {
        missionId,
        title: mission.title,
        lane: mission.urgent ? "urgent" : "primary",
        queuedSinceSeq: seq ?? -1,
        queuedSince: seq === undefined ? "" : (recordedAtBySeq.get(seq) ?? ""),
      };
    });

    return { active, queued, concurrent };
  }

  /**
   * FIFO activation (A.1#5): for each lane that can accept a mission, move
   * the head of that lane's `queued` line to `approved` via a recorded
   * `execution-slot-freed` transition. Head computation and record happen
   * in the same synchronous frame (no interleaving in-process). At most one
   * activation per lane per call — the activated mission occupies the slot.
   *
   * Cross-lane order (r5 finding 1): the URGENT lane is considered FIRST —
   * the lane exists to jump the line, and processing primary first let a
   * younger primary mission activate and then (via symmetric admission)
   * block an OLDER queued urgent task. FIFO is per lane; between lanes,
   * urgency wins by construction. The activation audit checks per-lane
   * order only — cross-lane priority is this method's ordering, exercised
   * by tests, not re-derived from the log.
   */
  activateNext(repoId: string): ActivationOutcome[] {
    const outcomes: ActivationOutcome[] = [];
    for (const lane of ["urgent", "primary"] as const) {
      const holders = this.laneHolders(repoId);
      // Same symmetric admission rule as executionSlotFreeFor (r4 finding 1).
      const available =
        lane === "urgent"
          ? this.urgentLaneAvailable(holders)
          : holders.primary.length === 0 && holders.urgent.length === 0;
      if (!available) continue;
      const head = this.queuedHead(repoId, lane);
      if (head === undefined) continue;
      const outcome = this.recorder.record({
        entityKind: "mission",
        entityId: head,
        event: "execution-slot-freed",
        actor: SCHEDULER_ACTOR,
        cause: `serialization: ${lane} slot free on repo ${repoId}; FIFO head activates (A.1#5)`,
        payload: { fifoHead: true },
      });
      if (!outcome.ok) {
        throw new Error(
          `scheduler activation of mission ${head} was refused (${outcome.code}) — ` +
            "the queue view and the machine disagree; refusing to continue",
        );
      }
      outcomes.push({ lane, missionId: head, to: outcome.to as MissionState });
    }
    return outcomes;
  }

  /**
   * Re-derive every recorded activation for this repo against FIFO order
   * (r1 finding 4): a false `fifoHead` attestation produces an activation
   * replay verifies happily; this audit reports it. Empty means every
   * activation went to the then-head of its lane.
   */
  auditActivations(repoId: string): ActivationDeviation[] {
    const laneOf = new Map<string, SchedulingLane>();
    for (const mission of this.domain.listMissions(repoId)) {
      laneOf.set(mission.id, mission.urgent ? "urgent" : "primary");
    }
    return auditActivationOrder(this.store.read({ entityKind: "mission" }), laneOf);
  }

  /**
   * The urgent lane accepts a mission when it has no holder AND every
   * primary holder is parked or parkable (see the module note; r1 finding
   * 3, r2 finding 1): parked = paused-*; parkable = an integration-route
   * mission in `executing` (the only A.1#15 source). Anything else cannot
   * be parked, so an urgent task activating beside it could only run
   * concurrently with it.
   */
  private urgentLaneAvailable(holders: { primary: LaneHolder[]; urgent: LaneHolder[] }): boolean {
    if (holders.urgent.length > 0) return false;
    return holders.primary.every((holder) => this.primaryAdmitsUrgent(holder));
  }

  /** Parked (paused-*) or parkable (integration route in `executing`, the A.1#15 source). */
  private primaryAdmitsUrgent(holder: LaneHolder): boolean {
    if (PARKED_STATES.includes(holder.state)) return true;
    return (
      holder.state === "executing" &&
      this.domain.getMission(holder.missionId)?.route === "integration"
    );
  }

  private queuedHead(repoId: string, lane: SchedulingLane): string | undefined {
    const view = this.recorder.currentView;
    const queuedIds: string[] = [];
    for (const mission of this.domain.listMissions(repoId)) {
      const snapshot = view.missions.get(mission.id);
      if (snapshot === undefined || snapshot.state !== "queued") continue;
      const missionLane: SchedulingLane = mission.urgent ? "urgent" : "primary";
      if (missionLane === lane) queuedIds.push(mission.id);
    }
    if (queuedIds.length === 0) return undefined;
    const entrySeqs = queuedEntrySeqs(this.store.read({ entityKind: "mission" }));
    return fifoOrder(queuedIds, entrySeqs)[0];
  }

  private laneHolders(repoId: string): { primary: LaneHolder[]; urgent: LaneHolder[] } {
    const view = this.recorder.currentView;
    const holders: { primary: LaneHolder[]; urgent: LaneHolder[] } = { primary: [], urgent: [] };
    for (const mission of this.domain.listMissions(repoId)) {
      const snapshot = view.missions.get(mission.id);
      if (snapshot === undefined) continue;
      if (!isExecutionBearing(snapshot.state, snapshot.pausedFrom)) continue;
      const lane: SchedulingLane = mission.urgent ? "urgent" : "primary";
      holders[lane].push({ missionId: mission.id, state: snapshot.state });
    }
    return holders;
  }

  private requireMission(missionId: string): MissionRecord {
    const mission = this.domain.getMission(missionId);
    if (mission === undefined) {
      throw new Error(`mission ${missionId} does not exist in the domain store`);
    }
    return mission;
  }
}

function isTerminal(state: MissionState): boolean {
  return (MISSION_TERMINAL_STATES as readonly MissionState[]).includes(state);
}
