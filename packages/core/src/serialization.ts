/**
 * Per-repo serialization primitives (WP-103, CAM-CORE-08) — the pure half.
 *
 * The Appendix A preamble's serialization rule: at most one mission per repo
 * occupies an execution-bearing state (isExecutionBearing in mission.ts,
 * ratified as AMEND-2), plus at most one urgent quick task on the urgent
 * lane (CAM-CORE-08); while the urgent lane actively executes, the primary
 * holder is parked in an interrupt state (the lane clause is AMEND-6,
 * approved 2026-07-19). Additional missions wait in `queued` and activate
 * FIFO when the slot frees. This module derives the FIFO order from the
 * event log alone, consistent with every other derived view (CAM-STATE-01).
 *
 * FIFO position is the seq of the mission's FIRST applied transition into
 * `queued`: a mission that is paused while queued and later resumed re-enters
 * `queued` without losing its place. (The appendix orders activation FIFO
 * without addressing pause/resume re-entry; first-entry order is the
 * stable reading — a pause must not send a mission to the back of the line.)
 *
 * The repo-scoped join (which missions belong to which repo, which occupy
 * which lane) is the daemon scheduler's job — the domain model lives there;
 * this module stays pure over event records.
 */
import type { EventRecord } from "@camino/shared";

/**
 * Map mission id → seq of its first applied transition into `queued`.
 * Missions that never entered `queued` are absent. Records must be in
 * ascending seq order (as EventStore.read returns them).
 */
export function queuedEntrySeqs(records: readonly EventRecord[]): ReadonlyMap<string, number> {
  const entries = new Map<string, number>();
  for (const record of records) {
    if (record.outcome !== "applied") continue;
    if (record.entityKind !== "mission") continue;
    if (record.toState !== "queued") continue;
    if (!entries.has(record.entityId)) entries.set(record.entityId, record.seq);
  }
  return entries;
}

/**
 * Order the given mission ids FIFO by their recorded first entry into
 * `queued`. Ids with no recorded entry sort last (they cannot be activated
 * as head — an honest log records the entry before activation matters);
 * within that group the order falls back to id for determinism.
 */
export function fifoOrder(
  missionIds: readonly string[],
  entrySeqs: ReadonlyMap<string, number>,
): string[] {
  return [...missionIds].sort((a, b) => {
    const seqA = entrySeqs.get(a);
    const seqB = entrySeqs.get(b);
    if (seqA !== undefined && seqB !== undefined) return seqA - seqB;
    if (seqA !== undefined) return -1;
    if (seqB !== undefined) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** An activation that did not go to the FIFO head of its lane at its point in the log. */
export interface ActivationDeviation {
  /** Seq of the `execution-slot-freed` record that deviated. */
  readonly seq: number;
  /** The mission that was activated. */
  readonly missionId: string;
  readonly lane: "primary" | "urgent";
  /**
   * `jumped-queue`: another mission was the lane's FIFO head.
   * `never-queued`: the activated mission was not in the lane's queue at
   * all at that point in the log (r2 finding 10 — such a record cannot come
   * from an honest recorder, but the audit must not certify it).
   */
  readonly reason: "jumped-queue" | "never-queued";
  /** The mission that was the lane's FIFO head at that point (if the queue was non-empty). */
  readonly expectedHeadId?: string;
}

/**
 * Audit every recorded activation against FIFO order (review round 1,
 * finding 4; round 2, finding 10): the Appendix A guard records an ATTESTED
 * `fifoHead` fact, so a false attestation produces an activation that
 * replay happily verifies. This audit re-derives, at each applied
 * `execution-slot-freed` record, which mission actually was the lane's
 * FIFO head among the then-queued missions, and reports every activation
 * that disagrees — including an activation for a mission that was not
 * queued at all. Pure over the log plus the lane assignment (which is
 * domain data — the caller supplies mission id → lane for the repo's
 * missions; ids absent from the map are outside the audit's scope).
 */
export function auditActivationOrder(
  records: readonly EventRecord[],
  laneOf: ReadonlyMap<string, "primary" | "urgent">,
): ActivationDeviation[] {
  const deviations: ActivationDeviation[] = [];
  const firstEntry = new Map<string, number>();
  const queuedNow = new Set<string>();
  for (const record of records) {
    if (record.outcome !== "applied" || record.entityKind !== "mission") continue;
    if (!laneOf.has(record.entityId)) continue;
    if (record.toState === "queued" && !firstEntry.has(record.entityId)) {
      firstEntry.set(record.entityId, record.seq);
    }
    if (record.event === "execution-slot-freed") {
      const lane = laneOf.get(record.entityId) as "primary" | "urgent";
      const contenders = [...queuedNow].filter((id) => laneOf.get(id) === lane);
      const head = fifoOrder(contenders, firstEntry)[0];
      if (!queuedNow.has(record.entityId)) {
        deviations.push({
          seq: record.seq,
          missionId: record.entityId,
          lane,
          reason: "never-queued",
          ...(head === undefined ? {} : { expectedHeadId: head }),
        });
      } else if (head !== undefined && head !== record.entityId) {
        deviations.push({
          seq: record.seq,
          missionId: record.entityId,
          lane,
          reason: "jumped-queue",
          expectedHeadId: head,
        });
      }
    }
    if (record.toState === "queued") queuedNow.add(record.entityId);
    else queuedNow.delete(record.entityId);
  }
  return deviations;
}
