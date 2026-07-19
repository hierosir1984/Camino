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
 *    state. While the lane is occupied the primary holder sits in
 *    `paused-urgent` (A.1#15) and STILL holds the primary slot — resuming
 *    via A.1#20 when the urgent task lands.
 *
 * The scheduler derives everything from the domain store (which mission
 * belongs to which repo, which lane it schedules on) joined with the
 * recorder's derived view (state, pausedFrom) and the event log (FIFO order
 * = first entry into `queued`, core's queuedEntrySeqs). It never bypasses
 * the recorder: activation is a recorded `execution-slot-freed` transition
 * (A.1#5), and the slot-free facts consumed by plan approval
 * (`executionSlotFreeFor`) are computed here so callers attest honestly.
 *
 * Enforcement boundary, stated plainly: Appendix A guards check ATTESTED
 * facts; the scheduler is the honest source of the slot attestations, and
 * every in-process caller is expected to consult it. A caller that attests
 * a free slot against this module's answer is a daemon bug, not a schema
 * the machine can refuse — the recorded view carries no repo binding, so
 * recorded-context enrichment cannot overwrite slot facts today.
 * `serializationViolations` makes any resulting double-occupancy visible.
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
import type { MissionState } from "@camino/core";
import {
  MISSION_TERMINAL_STATES,
  fifoOrder,
  isExecutionBearing,
  queuedEntrySeqs,
} from "@camino/core";
import type { SqliteDomainStore } from "./domain-store.js";
import type { TransitionRecorder } from "./transition-recorder.js";

export type SchedulingLane = "primary" | "urgent";

/** The actor recorded on scheduler-initiated transitions. */
export const SCHEDULER_ACTOR = "camino:scheduler";

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
  /** Missions waiting in `queued`, FIFO order, both lanes. */
  readonly queued: readonly QueuedEntry[];
  /**
   * Missions in non-execution-bearing active states (draft, planned, a
   * paused-manual that was paused before holding the slot): intake and
   * planning proceed concurrently — they touch no workspace.
   */
  readonly concurrent: readonly { missionId: string; title: string; state: MissionState }[];
}

/** Evidence of a lane invariant breach: more than one holder in one lane. */
export interface SerializationViolation {
  readonly lane: SchedulingLane;
  readonly missionIds: readonly string[];
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

  /** Non-empty exactly when a lane holds more than one execution-bearing mission. */
  serializationViolations(repoId: string): SerializationViolation[] {
    const holders = this.laneHolders(repoId);
    const violations: SerializationViolation[] = [];
    for (const lane of ["primary", "urgent"] as const) {
      if (holders[lane].length > 1) {
        violations.push({ lane, missionIds: holders[lane].map((h) => h.missionId) });
      }
    }
    return violations;
  }

  /**
   * The slot-free fact for THIS mission's plan approval (A.1#3 / A.1b#3
   * `executionSlotFree`): whether the lane the mission schedules on —
   * primary normally, the urgent lane for an urgent quick task — has no
   * holder. Callers pass the answer into the plan-approved payload; the
   * guard-split routes the mission to `approved` (free) or `queued` (taken).
   */
  executionSlotFreeFor(missionId: string): boolean {
    const mission = this.requireMission(missionId);
    const lane: SchedulingLane = mission.urgent ? "urgent" : "primary";
    return this.laneHolders(mission.repoId)[lane].length === 0;
  }

  /** The visible per-repo queue (CAM-CORE-08: a waiting mission waits VISIBLY). */
  repoQueue(repoId: string): RepoQueueView {
    const view = this.recorder.currentView;
    const entrySeqs = queuedEntrySeqs(this.store.read({ entityKind: "mission" }));
    const recordedAtBySeq = new Map<number, string>();
    for (const record of this.store.read({ entityKind: "mission" })) {
      recordedAtBySeq.set(record.seq, record.recordedAt);
    }

    const active: { primary?: LaneHolder; urgent?: LaneHolder } = {};
    const queuedIds: string[] = [];
    const byId = new Map<string, MissionRecord>();
    const concurrent: { missionId: string; title: string; state: MissionState }[] = [];

    for (const mission of this.domain.listMissions(repoId)) {
      const snapshot = view.missions.get(mission.id);
      if (snapshot === undefined) continue; // no creation event yet — intakeOrphans() surfaces these
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
   * FIFO activation (A.1#5): for each lane with no holder, move the head of
   * that lane's `queued` line to `approved` via a recorded
   * `execution-slot-freed` transition. At most one activation per lane per
   * call — the activated mission occupies the slot. Returns what activated.
   */
  activateNext(repoId: string): ActivationOutcome[] {
    const outcomes: ActivationOutcome[] = [];
    for (const lane of ["primary", "urgent"] as const) {
      if (this.laneHolders(repoId)[lane].length > 0) continue;
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
