/**
 * Per-repo serialization primitives (WP-103, CAM-CORE-08) — the pure half.
 *
 * The Appendix A preamble's serialization rule: at most one mission per repo
 * occupies an execution-bearing state (isExecutionBearing in mission.ts,
 * ratified as AMEND-2); additional missions wait in `queued` and activate
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
