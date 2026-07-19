/**
 * Derived views — pure folds over the append-only event log (CAM-STATE-01:
 * derived views are rebuildable from events alone). The daemon's recorder
 * maintains its live view by applying each appended record through the SAME
 * `applyRecord` step used by `foldView`, so the incremental view and a
 * from-scratch rebuild cannot diverge by construction (and tests assert it).
 *
 * Rejected records never change a view — they are evidence, not state.
 *
 * Log re-verification lives in decide.ts (`verifyReplay`), which re-derives
 * every row through the same decision path the recorder uses.
 */
import type { EventRecord } from "@camino/shared";
import type { MissionRoute, MissionState } from "./mission.js";
import { MISSION_CREATION_EVENTS, MISSION_STATES } from "./mission.js";
import type { IssueState } from "./issue.js";
import { ISSUE_STATES } from "./issue.js";
import type { AttemptState } from "./attempt.js";
import { ATTEMPT_STATES } from "./attempt.js";

export interface MissionSnapshot {
  state: MissionState;
  route: MissionRoute;
  /** The state held when David paused (first pause wins); resume returns here. */
  pausedFrom?: MissionState;
  /** The current merge-candidate SHA (set by gate-green / green rebuild). */
  currentCandidateSha?: string;
  /** The current candidate's packet hash — the other half of the A.4#4 pair. */
  currentPacketHash?: string;
  /** The bound approval (A.4#4); cleared on rebuild or return to executing. */
  approval?: { candidateSha: string; packetHash: string };
  /** Quick-task validation failures (A.1b#6); recorded, never counts quota waits. */
  failureCount: number;
}

export interface IssueSnapshot {
  state: IssueState;
  /** Attempt + validation failures (A.2#9/#14); quota waits never count (A.2#5). */
  failureCount: number;
}

export interface AttemptSnapshot {
  state: AttemptState;
}

export interface StateView {
  missions: Map<string, MissionSnapshot>;
  issues: Map<string, IssueSnapshot>;
  attempts: Map<string, AttemptSnapshot>;
}

export function emptyView(): StateView {
  return { missions: new Map(), issues: new Map(), attempts: new Map() };
}

function payloadString(record: EventRecord, field: string): string | undefined {
  const value = record.payload[field];
  return typeof value === "string" ? value : undefined;
}

function payloadNumber(record: EventRecord, field: string): number | undefined {
  const value = record.payload[field];
  return typeof value === "number" ? value : undefined;
}

function malformed(record: EventRecord, problem: string): Error {
  return new Error(`Malformed event log at seq ${record.seq}: ${problem}`);
}

/**
 * Apply one applied record to the view (mutates `view`). Rejected records
 * are ignored. Throws on a log that could not have been produced by the
 * recorder (fail loud rather than build a wrong view).
 */
export function applyRecord(view: StateView, record: EventRecord): void {
  if (record.outcome !== "applied") return;
  if (record.toState === null) throw malformed(record, "applied record without toState");

  // Structural integrity of the durable row itself: the target must be a
  // known state of the entity's machine, and a transition's recorded source
  // must agree with the folded snapshot — a log violating either could not
  // have been produced by the recorder (fail loud, never silently adopt).
  const knownStates: readonly string[] =
    record.entityKind === "mission"
      ? MISSION_STATES
      : record.entityKind === "issue"
        ? ISSUE_STATES
        : ATTEMPT_STATES;
  if (!knownStates.includes(record.toState)) {
    throw malformed(record, `unknown ${record.entityKind} state ${JSON.stringify(record.toState)}`);
  }

  switch (record.entityKind) {
    case "mission": {
      const toState = record.toState as MissionState;
      let snapshot = view.missions.get(record.entityId);
      if (record.fromState === null) {
        if (snapshot) throw malformed(record, `duplicate creation of mission ${record.entityId}`);
        const route = MISSION_CREATION_EVENTS[record.event];
        if (!route) throw malformed(record, `unknown mission creation event ${record.event}`);
        snapshot = { state: toState, route, failureCount: 0 };
        view.missions.set(record.entityId, snapshot);
        return;
      }
      if (!snapshot) throw malformed(record, `event for unknown mission ${record.entityId}`);
      if (record.fromState !== snapshot.state) {
        throw malformed(
          record,
          `recorded fromState ${JSON.stringify(record.fromState)} disagrees with the folded state ${JSON.stringify(snapshot.state)}`,
        );
      }
      const fromState = record.fromState as MissionState;
      snapshot.state = toState;
      // Manual pause bookkeeping: first pause wins; cleared on leaving.
      if (toState === "paused-manual") {
        if (fromState !== "paused-manual" && snapshot.pausedFrom === undefined) {
          snapshot.pausedFrom = fromState;
        }
      } else {
        snapshot.pausedFrom = undefined;
      }
      // Candidate identity and approval binding (A.4#4).
      if (record.event === "mission-gate-green" || record.event === "quick-validation-green") {
        snapshot.currentCandidateSha = payloadString(record, "candidateSha");
        snapshot.currentPacketHash = payloadString(record, "packetHash");
      }
      if (record.event === "candidate-rebuilt" && record.payload["green"] === true) {
        snapshot.currentCandidateSha = payloadString(record, "newCandidateSha");
        snapshot.currentPacketHash = payloadString(record, "newPacketHash");
      }
      if (toState === "awaiting-merge-approval" || toState === "executing") {
        // A new candidate requires a new approval; returning to executing
        // (rejection, red rebuild) likewise invalidates any binding.
        snapshot.approval = undefined;
      }
      if (record.event === "mission-merge-approved") {
        const candidateSha = payloadString(record, "candidateSha");
        const packetHash = payloadString(record, "packetHash");
        if (!candidateSha || !packetHash) {
          throw malformed(record, "approval without candidateSha/packetHash");
        }
        snapshot.approval = { candidateSha, packetHash };
      }
      if (record.event === "quick-validation-red") {
        const recorded = payloadNumber(record, "failureCount");
        if (recorded === undefined)
          throw malformed(record, "quick-validation-red without failureCount");
        snapshot.failureCount = recorded;
      }
      return;
    }
    case "issue": {
      const toState = record.toState as IssueState;
      let snapshot = view.issues.get(record.entityId);
      if (record.fromState === null) {
        if (snapshot) throw malformed(record, `duplicate creation of issue ${record.entityId}`);
        snapshot = { state: toState, failureCount: 0 };
        view.issues.set(record.entityId, snapshot);
        return;
      }
      if (!snapshot) throw malformed(record, `event for unknown issue ${record.entityId}`);
      if (record.fromState !== snapshot.state) {
        throw malformed(
          record,
          `recorded fromState ${JSON.stringify(record.fromState)} disagrees with the folded state ${JSON.stringify(snapshot.state)}`,
        );
      }
      snapshot.state = toState;
      if (record.event === "attempt-failed" || record.event === "validation-failed") {
        const recorded = payloadNumber(record, "failureCount");
        if (recorded === undefined) throw malformed(record, `${record.event} without failureCount`);
        snapshot.failureCount = recorded;
      }
      return;
    }
    case "attempt": {
      const toState = record.toState as AttemptState;
      const snapshot = view.attempts.get(record.entityId);
      if (record.fromState === null) {
        if (snapshot) throw malformed(record, `duplicate creation of attempt ${record.entityId}`);
        view.attempts.set(record.entityId, { state: toState });
        return;
      }
      if (!snapshot) throw malformed(record, `event for unknown attempt ${record.entityId}`);
      if (record.fromState !== snapshot.state) {
        throw malformed(
          record,
          `recorded fromState ${JSON.stringify(record.fromState)} disagrees with the folded state ${JSON.stringify(snapshot.state)}`,
        );
      }
      snapshot.state = toState;
      return;
    }
  }
}

/** Rebuild the full view from the log alone (records in ascending seq order). */
export function foldView(records: readonly EventRecord[]): StateView {
  const view = emptyView();
  for (const record of records) applyRecord(view, record);
  return view;
}
