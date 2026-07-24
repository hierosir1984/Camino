/**
 * Knowledge lifecycle folds (WP-113, CAM-CANON-09; design §3.7) — pure
 * derivations over the knowledge store's append-only event records.
 *
 * One validation source, two call sites (the decide.ts replay pattern):
 * `knowledgeAppendProblems(view, input, atIso)` is what the store runs
 * BEFORE appending, and `foldKnowledge` re-runs the same checks over every
 * stored record — a row the current rules refuse cannot have been produced
 * by the store, so the fold THROWS on it rather than building a wrong view
 * (tamper-evident, not tamper-proof: same stated boundary as the intent
 * ledger).
 *
 * Lifecycle invariants enforced here, not merely documented:
 *  - `approved` is reachable only from `candidate`, only through a human
 *    batch (David) or one of the two deterministic rule-classes, whose
 *    evidence is RE-VERIFIED against the store's own observation events at
 *    the promotion record's position (registry item 6).
 *  - A candidate that deterministically contradicts a STANDING approved
 *    entry (same class, same subjectKey, different claim) cannot be
 *    promoted by ANY authority while the approved entry stands — curation
 *    must retire the approved entry first. This is "escalates to curation
 *    rather than silently coexisting" as a mechanical refusal, and
 *    `knowledgeCurationQueue` is the escalation surface.
 *  - Entries invalidate when a revert removes their commit/base validity.
 *  - Expiry is a read-time filter against the reader's clock; writes that
 *    would be born-expired (or promote an already-expired entry) are
 *    refused using the append clock, so replay verification stays
 *    deterministic.
 */
import type {
  KnowledgeAppendInput,
  KnowledgeEntryInput,
  KnowledgeEntryState,
  KnowledgeEventRecord,
  KnowledgePromotionAuthority,
} from "@camino/shared";
import {
  COMMAND_RULE_MIN_MISSIONS,
  COMMAND_RULE_MIN_SUCCESSES,
  KNOWLEDGE_EVENTS,
  KNOWLEDGE_MAX_TEXT_LENGTH,
  isGitSha,
  knowledgeEntryProblems,
} from "@camino/shared";
import { DAVID_ACTOR } from "./intent-lifecycle.js";

// ---------------------------------------------------------------------------
// View shapes
// ---------------------------------------------------------------------------

/** Success/failure tallies for one command line (rule-class 1 evidence). */
export interface CommandTally {
  /**
   * Count of DISTINCT successful (missionId, attemptId) attempts (r1 finding
   * 6): the same attempt's success replayed does not inflate this, so the
   * ≥3-successes rule cannot be met by resubmitting one observation. "3
   * times" means three independent attempts, not three log rows.
   */
  readonly successes: number;
  readonly failures: number;
  /** Distinct missions with at least one recorded success, sorted. */
  readonly missionsWithSuccess: readonly string[];
}

/** One quarantine confirmation (rule-class 2 evidence), latest per test id. */
export interface QuarantineConfirmation {
  readonly reference: string;
  readonly missionId: string;
  /** The validity world the confirmation was made in; revert-pruned (r2 finding 3). */
  readonly commitSha: string;
  readonly baseSha: string;
  readonly seq: number;
}

export interface KnowledgePromotionRecord {
  readonly authority: KnowledgePromotionAuthority;
  readonly actor: string;
  readonly seq: number;
  readonly recordedAt: string;
}

export interface KnowledgeResolutionRecord {
  readonly kind: "rejected" | "retired";
  readonly reason: string;
  readonly actor: string;
  readonly seq: number;
}

export interface KnowledgeInvalidationRecord {
  readonly revertedSha: string;
  readonly seq: number;
}

/** One entry with its full derived lifecycle position. */
export interface KnowledgeEntrySnapshot {
  readonly entry: KnowledgeEntryInput;
  readonly state: KnowledgeEntryState;
  /** The candidate-recorded row (seq, time) — the entry's provenance anchor. */
  readonly recordedSeq: number;
  readonly recordedAt: string;
  readonly promotion: KnowledgePromotionRecord | null;
  readonly resolution: KnowledgeResolutionRecord | null;
  readonly invalidation: KnowledgeInvalidationRecord | null;
}

export interface KnowledgeView {
  readonly entries: ReadonlyMap<string, KnowledgeEntrySnapshot>;
  readonly commandTallies: ReadonlyMap<string, CommandTally>;
  readonly quarantineConfirmed: ReadonlyMap<string, QuarantineConfirmation>;
  /**
   * Every SHA a revert has removed (r1 finding 8): revert invalidation is
   * not only edge-triggered on entries that exist WHEN the revert folds — a
   * reverted base stays reverted, so a candidate later recorded on it is
   * refused at append rather than resurrecting knowledge whose world is gone.
   */
  readonly revertedShas: ReadonlySet<string>;
  readonly lastSeq: number;
}

/** An empty view (the fold's starting point; also the store's pre-first-append view). */
export function emptyKnowledgeView(): KnowledgeView {
  return {
    entries: new Map(),
    commandTallies: new Map(),
    quarantineConfirmed: new Map(),
    revertedShas: new Set(),
    lastSeq: 0,
  };
}

// ---------------------------------------------------------------------------
// Payload DTOs (validated at append AND at fold, via the same functions)
// ---------------------------------------------------------------------------

export interface CommandObservationPayload {
  readonly commandKey: string;
  readonly missionId: string;
  readonly attemptId: string;
  readonly succeeded: boolean;
  /**
   * The validity world the observation ran in (r2 finding 3): rule-class
   * evidence is pruned when either SHA is reverted, so a success from a world
   * that no longer exists cannot promote a candidate. WP-114's dispatcher has
   * both at dispatch time.
   */
  readonly commitSha: string;
  readonly baseSha: string;
}

export interface QuarantineConfirmationPayload {
  readonly testId: string;
  readonly missionId: string;
  /** Reference to the confirming quarantine artifact (WP-108 seam). */
  readonly reference: string;
  /** The validity world the confirmation was made in (r2 finding 3; revert-pruned). */
  readonly commitSha: string;
  readonly baseSha: string;
}

export interface EntryPromotedPayload {
  readonly entryId: string;
  readonly authority: KnowledgePromotionAuthority;
}

export interface EntryResolutionPayload {
  readonly entryId: string;
  readonly reason: string;
}

export interface ValidityBaseRevertedPayload {
  readonly revertedSha: string;
}

function boundedText(field: string, value: unknown, problems: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    problems.push(`${field} must be a non-empty string`);
    return;
  }
  if (value.length > KNOWLEDGE_MAX_TEXT_LENGTH) {
    problems.push(`${field} exceeds ${KNOWLEDGE_MAX_TEXT_LENGTH} code units`);
  }
  if (value.includes("\u0000")) problems.push(`${field} contains U+0000`);
}

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isoInstantProblem(field: string, value: unknown): string | null {
  if (typeof value !== "string" || !ISO_INSTANT_RE.test(value)) {
    return `${field} must be an ISO-8601 UTC instant (toISOString form)`;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) {
    return `${field} must be an ISO-8601 UTC instant (toISOString form)`;
  }
  return null;
}

function gitShaProblem(field: string, value: unknown, problems: string[]): void {
  if (typeof value !== "string" || !isGitSha(value)) {
    problems.push(`${field} must be a 40-hex lowercase git SHA`);
  }
}

function payloadObject(payload: unknown, problems: string[]): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    problems.push("payload must be a plain object");
    return null;
  }
  return payload as Record<string, unknown>;
}

function unknownFieldProblems(
  record: Record<string, unknown>,
  allowed: readonly string[],
  problems: string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) problems.push(`payload has unknown field ${JSON.stringify(key)}`);
  }
}

function authorityProblems(value: unknown, problems: string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.push("authority must be an object");
    return;
  }
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  if (kind === "human-batch") {
    boundedText("authority.batchId", record["batchId"], problems);
    for (const key of Object.keys(record)) {
      if (!["kind", "batchId"].includes(key)) {
        problems.push(`authority has unknown field ${JSON.stringify(key)}`);
      }
    }
    return;
  }
  if (kind === "rule-command-success" || kind === "rule-quarantine-flaky") {
    for (const key of Object.keys(record)) {
      if (key !== "kind") problems.push(`authority has unknown field ${JSON.stringify(key)}`);
    }
    return;
  }
  problems.push(
    'authority.kind must be "human-batch", "rule-command-success", or "rule-quarantine-flaky"',
  );
}

// ---------------------------------------------------------------------------
// Contradiction (deterministic; the §3.7 escalation trigger)
// ---------------------------------------------------------------------------

/**
 * Deterministic claim conflict: same class, same declared subject, different
 * claim. Defined ONLY over declared (class, subjectKey, claim) triples —
 * semantic contradiction between prose notes without a shared subjectKey is
 * a human-curation concern, never an unattended judgment (stated boundary,
 * @camino/shared knowledge.ts).
 */
export function knowledgeClaimsConflict(a: KnowledgeEntryInput, b: KnowledgeEntryInput): boolean {
  return (
    a.entryClass === b.entryClass &&
    a.subjectKey !== null &&
    b.subjectKey !== null &&
    a.subjectKey === b.subjectKey &&
    a.claim !== b.claim
  );
}

/**
 * Ids of STANDING approved entries the given entry conflicts with, sorted by
 * id. `nowIso` is the reader's clock: an approved entry that has EXPIRED no
 * longer stands (r2 finding 4) — it is invisible in packs, so it must not
 * silently block a fresh contradictory candidate until manually retired.
 */
export function standingApprovedConflicts(
  view: KnowledgeView,
  entry: KnowledgeEntryInput,
  nowIso: string,
): string[] {
  const conflicts: string[] = [];
  for (const [id, snapshot] of view.entries) {
    if (snapshot.state !== "approved") continue;
    if (snapshot.entry.expiresAt <= nowIso) continue;
    if (id === entry.entryId) continue;
    if (knowledgeClaimsConflict(entry, snapshot.entry)) conflicts.push(id);
  }
  return conflicts.sort();
}

/** One curation-queue row: a candidate conflicting with a standing approved entry. */
export interface KnowledgeContradiction {
  readonly candidateId: string;
  readonly approvedEntryId: string;
}

/**
 * The curation queue (CAM-CANON-09): every candidate that deterministically
 * contradicts a standing approved entry. Derived on demand — the conflict
 * dissolves by itself when the approved entry is retired or invalidated,
 * and the candidate stays promotion-blocked until then.
 */
export function knowledgeCurationQueue(
  view: KnowledgeView,
  nowIso: string,
): KnowledgeContradiction[] {
  const queue: KnowledgeContradiction[] = [];
  for (const [candidateId, snapshot] of view.entries) {
    if (snapshot.state !== "candidate") continue;
    if (snapshot.entry.expiresAt <= nowIso) continue;
    for (const approvedEntryId of standingApprovedConflicts(view, snapshot.entry, nowIso)) {
      queue.push({ candidateId, approvedEntryId });
    }
  }
  return queue.sort((a, b) =>
    a.candidateId === b.candidateId
      ? a.approvedEntryId < b.approvedEntryId
        ? -1
        : 1
      : a.candidateId < b.candidateId
        ? -1
        : 1,
  );
}

// ---------------------------------------------------------------------------
// Append validation (the store's pre-append gate; the fold's replay check)
// ---------------------------------------------------------------------------

/**
 * Validate one append against the current view. An empty result licenses
 * the append; anything else is a named refusal. `atIso` is the timestamp
 * the store will record (its clock at append; the record's own
 * `recordedAt` during fold replay) — expiry comparisons use it so replay
 * verification never consults a live clock.
 */
export function knowledgeAppendProblems(
  view: KnowledgeView,
  input: KnowledgeAppendInput,
  atIso: string,
): string[] {
  const problems: string[] = [];
  if (!(KNOWLEDGE_EVENTS as readonly string[]).includes(input.event)) {
    return [`unknown event ${JSON.stringify(input.event)}`];
  }
  boundedText("actor", input.actor, problems);
  const atProblem = isoInstantProblem("recordedAt", atIso);
  if (atProblem !== null) problems.push(atProblem);
  if (problems.length > 0) return problems;

  switch (input.event) {
    case "candidate-recorded": {
      const payload = payloadObject(input.payload, problems);
      if (payload === null) return problems;
      unknownFieldProblems(payload, ["entry"], problems);
      const entryProblems = knowledgeEntryProblems(payload["entry"]);
      problems.push(...entryProblems);
      if (entryProblems.length > 0) return problems;
      const entry = payload["entry"] as KnowledgeEntryInput;
      if (view.entries.has(entry.entryId)) {
        problems.push(`entry ${entry.entryId} already exists`);
      }
      if (entry.expiresAt <= atIso) {
        problems.push(
          `entry ${entry.entryId} would be born expired (expiresAt ${entry.expiresAt} <= ${atIso})`,
        );
      }
      // A candidate whose validity base a revert already removed reports
      // knowledge from a world that is gone — refuse it rather than let a
      // late attempt result resurrect reverted-base knowledge (r1 finding 8).
      if (view.revertedShas.has(entry.validity.commitSha)) {
        problems.push(
          `entry ${entry.entryId} validity commit ${entry.validity.commitSha} was reverted`,
        );
      }
      if (view.revertedShas.has(entry.validity.baseSha)) {
        problems.push(
          `entry ${entry.entryId} validity base ${entry.validity.baseSha} was reverted`,
        );
      }
      return problems;
    }
    case "command-observation": {
      const payload = payloadObject(input.payload, problems);
      if (payload === null) return problems;
      unknownFieldProblems(
        payload,
        ["commandKey", "missionId", "attemptId", "succeeded", "commitSha", "baseSha"],
        problems,
      );
      boundedText("payload.commandKey", payload["commandKey"], problems);
      boundedText("payload.missionId", payload["missionId"], problems);
      boundedText("payload.attemptId", payload["attemptId"], problems);
      if (typeof payload["succeeded"] !== "boolean") {
        problems.push("payload.succeeded must be a boolean");
      }
      gitShaProblem("payload.commitSha", payload["commitSha"], problems);
      gitShaProblem("payload.baseSha", payload["baseSha"], problems);
      return problems;
    }
    case "quarantine-confirmation": {
      const payload = payloadObject(input.payload, problems);
      if (payload === null) return problems;
      unknownFieldProblems(
        payload,
        ["testId", "missionId", "reference", "commitSha", "baseSha"],
        problems,
      );
      boundedText("payload.testId", payload["testId"], problems);
      boundedText("payload.missionId", payload["missionId"], problems);
      boundedText("payload.reference", payload["reference"], problems);
      gitShaProblem("payload.commitSha", payload["commitSha"], problems);
      gitShaProblem("payload.baseSha", payload["baseSha"], problems);
      return problems;
    }
    case "entry-promoted": {
      const payload = payloadObject(input.payload, problems);
      if (payload === null) return problems;
      unknownFieldProblems(payload, ["entryId", "authority"], problems);
      boundedText("payload.entryId", payload["entryId"], problems);
      authorityProblems(payload["authority"], problems);
      if (problems.length > 0) return problems;
      const entryId = payload["entryId"] as string;
      const authority = payload["authority"] as KnowledgePromotionAuthority;
      const snapshot = view.entries.get(entryId);
      if (snapshot === undefined) {
        return [`entry ${entryId} does not exist`];
      }
      if (snapshot.state !== "candidate") {
        return [`entry ${entryId} is ${snapshot.state}, not a candidate`];
      }
      if (snapshot.entry.expiresAt <= atIso) {
        problems.push(
          `entry ${entryId} expired at ${snapshot.entry.expiresAt}; promoting an expired entry is refused`,
        );
      }
      const conflicts = standingApprovedConflicts(view, snapshot.entry, atIso);
      if (conflicts.length > 0) {
        problems.push(
          `entry ${entryId} contradicts standing approved ${conflicts.join(", ")} — ` +
            "curation must retire the approved entry first (CAM-CANON-09: a contradiction " +
            "escalates to curation rather than silently coexisting)",
        );
      }
      if (authority.kind === "human-batch") {
        if (input.actor !== DAVID_ACTOR) {
          problems.push(`human-batch promotion requires actor ${DAVID_ACTOR}, got ${input.actor}`);
        }
      } else if (authority.kind === "rule-command-success") {
        if (snapshot.entry.entryClass !== "command" || snapshot.entry.claim !== "succeeds") {
          problems.push(
            `rule-command-success applies only to command entries claiming succeeds; ` +
              `entry ${entryId} is class ${snapshot.entry.entryClass} claiming ${snapshot.entry.claim}`,
          );
        } else {
          const tally = view.commandTallies.get(snapshot.entry.subjectKey as string);
          const successes = tally?.successes ?? 0;
          const missions = tally?.missionsWithSuccess.length ?? 0;
          if (successes < COMMAND_RULE_MIN_SUCCESSES || missions < COMMAND_RULE_MIN_MISSIONS) {
            problems.push(
              `rule-command-success evidence not met for ${JSON.stringify(snapshot.entry.subjectKey)}: ` +
                `${successes}/${COMMAND_RULE_MIN_SUCCESSES} successes across ` +
                `${missions}/${COMMAND_RULE_MIN_MISSIONS} missions`,
            );
          }
        }
      } else {
        if (snapshot.entry.entryClass !== "flaky-test" || snapshot.entry.claim !== "flaky") {
          problems.push(
            `rule-quarantine-flaky applies only to flaky-test entries claiming flaky; ` +
              `entry ${entryId} is class ${snapshot.entry.entryClass} claiming ${snapshot.entry.claim}`,
          );
        } else if (!view.quarantineConfirmed.has(snapshot.entry.subjectKey as string)) {
          problems.push(
            `rule-quarantine-flaky has no quarantine confirmation on record for ` +
              `${JSON.stringify(snapshot.entry.subjectKey)}`,
          );
        }
      }
      return problems;
    }
    case "entry-rejected":
    case "entry-retired": {
      const payload = payloadObject(input.payload, problems);
      if (payload === null) return problems;
      unknownFieldProblems(payload, ["entryId", "reason"], problems);
      boundedText("payload.entryId", payload["entryId"], problems);
      boundedText("payload.reason", payload["reason"], problems);
      if (input.actor !== DAVID_ACTOR) {
        problems.push(`${input.event} is a curation act and requires actor ${DAVID_ACTOR}`);
      }
      if (problems.length > 0) return problems;
      const entryId = payload["entryId"] as string;
      const snapshot = view.entries.get(entryId);
      if (snapshot === undefined) return [`entry ${entryId} does not exist`];
      if (input.event === "entry-rejected" && snapshot.state !== "candidate") {
        problems.push(`entry ${entryId} is ${snapshot.state}, not a candidate`);
      }
      if (input.event === "entry-retired" && snapshot.state !== "approved") {
        problems.push(`entry ${entryId} is ${snapshot.state}, not approved`);
      }
      return problems;
    }
    case "validity-base-reverted": {
      const payload = payloadObject(input.payload, problems);
      if (payload === null) return problems;
      unknownFieldProblems(payload, ["revertedSha"], problems);
      const sha = payload["revertedSha"];
      if (typeof sha !== "string" || !isGitSha(sha)) {
        problems.push("payload.revertedSha must be a 40-hex lowercase git SHA");
      }
      return problems;
    }
  }
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

interface MutableTally {
  /** Keys `missionId\u0000attemptId` of attempts with a recorded success (deduped). */
  successfulAttempts: Map<string, { missionId: string; commitSha: string; baseSha: string }>;
  failures: number;
}

/**
 * Rebuild the knowledge view from the store's records (ascending seq).
 * Throws on any record the append gate would refuse — a store whose rows
 * fail their own append rules is corrupt, and a wrong view must never be
 * silently built over it (views.ts posture).
 */
export function foldKnowledge(records: readonly KnowledgeEventRecord[]): KnowledgeView {
  const entries = new Map<string, KnowledgeEntrySnapshot>();
  const tallies = new Map<string, MutableTally>();
  const quarantineConfirmed = new Map<string, QuarantineConfirmation>();
  const revertedShas = new Set<string>();
  let lastSeq = 0;

  const liveView = (): KnowledgeView => ({
    entries,
    commandTallies: frozenTallies(tallies),
    quarantineConfirmed,
    revertedShas,
    lastSeq,
  });

  for (const record of records) {
    if (!Number.isSafeInteger(record.seq) || record.seq <= lastSeq) {
      throw new Error(
        `malformed knowledge log: seq ${String(record.seq)} is not strictly increasing after ${lastSeq}`,
      );
    }
    const problems = knowledgeAppendProblems(liveView(), record, record.recordedAt);
    if (problems.length > 0) {
      throw new Error(
        `malformed knowledge log at seq ${record.seq} (${record.event}): ${problems.join("; ")}`,
      );
    }
    lastSeq = record.seq;

    switch (record.event) {
      case "candidate-recorded": {
        const entry = (record.payload as { entry: KnowledgeEntryInput }).entry;
        entries.set(entry.entryId, {
          entry,
          state: "candidate",
          recordedSeq: record.seq,
          recordedAt: record.recordedAt,
          promotion: null,
          resolution: null,
          invalidation: null,
        });
        break;
      }
      case "command-observation": {
        const payload = record.payload as unknown as CommandObservationPayload;
        const tally = tallies.get(payload.commandKey) ?? {
          successfulAttempts: new Map<
            string,
            { missionId: string; commitSha: string; baseSha: string }
          >(),
          failures: 0,
        };
        if (payload.succeeded) {
          // Dedup by (mission, attempt): replaying one attempt's success is
          // not independent evidence (r1 finding 6). Tag the validity world so
          // a revert can prune the success (r2 finding 3).
          tally.successfulAttempts.set(JSON.stringify([payload.missionId, payload.attemptId]), {
            missionId: payload.missionId,
            commitSha: payload.commitSha,
            baseSha: payload.baseSha,
          });
        } else {
          tally.failures += 1;
        }
        tallies.set(payload.commandKey, tally);
        break;
      }
      case "quarantine-confirmation": {
        const payload = record.payload as unknown as QuarantineConfirmationPayload;
        quarantineConfirmed.set(payload.testId, {
          reference: payload.reference,
          missionId: payload.missionId,
          commitSha: payload.commitSha,
          baseSha: payload.baseSha,
          seq: record.seq,
        });
        break;
      }
      case "entry-promoted": {
        const payload = record.payload as unknown as EntryPromotedPayload;
        const snapshot = entries.get(payload.entryId) as KnowledgeEntrySnapshot;
        entries.set(payload.entryId, {
          ...snapshot,
          state: "approved",
          promotion: {
            authority: payload.authority,
            actor: record.actor,
            seq: record.seq,
            recordedAt: record.recordedAt,
          },
        });
        break;
      }
      case "entry-rejected":
      case "entry-retired": {
        const payload = record.payload as unknown as EntryResolutionPayload;
        const snapshot = entries.get(payload.entryId) as KnowledgeEntrySnapshot;
        entries.set(payload.entryId, {
          ...snapshot,
          state: record.event === "entry-rejected" ? "rejected" : "retired",
          resolution: {
            kind: record.event === "entry-rejected" ? "rejected" : "retired",
            reason: payload.reason,
            actor: record.actor,
            seq: record.seq,
          },
        });
        break;
      }
      case "validity-base-reverted": {
        const payload = record.payload as unknown as ValidityBaseRevertedPayload;
        // Remember the reverted SHA so a candidate recorded LATER on it is
        // refused at append (r1 finding 8), not only the entries that exist
        // right now...
        revertedShas.add(payload.revertedSha);
        // ...and invalidate the standing entries whose validity base it is.
        for (const [id, snapshot] of entries) {
          if (snapshot.state !== "candidate" && snapshot.state !== "approved") continue;
          const { commitSha, baseSha } = snapshot.entry.validity;
          if (commitSha !== payload.revertedSha && baseSha !== payload.revertedSha) continue;
          entries.set(id, {
            ...snapshot,
            state: "invalidated",
            invalidation: { revertedSha: payload.revertedSha, seq: record.seq },
          });
        }
        // Prune rule-class EVIDENCE from the reverted world too (r2 finding 3):
        // a command success or a quarantine confirmation whose commit/base was
        // reverted no longer counts, so it cannot promote a fresh candidate.
        for (const tally of tallies.values()) {
          for (const [key, tag] of tally.successfulAttempts) {
            if (tag.commitSha === payload.revertedSha || tag.baseSha === payload.revertedSha) {
              tally.successfulAttempts.delete(key);
            }
          }
        }
        for (const [testId, confirmation] of quarantineConfirmed) {
          if (
            confirmation.commitSha === payload.revertedSha ||
            confirmation.baseSha === payload.revertedSha
          ) {
            quarantineConfirmed.delete(testId);
          }
        }
        break;
      }
    }
  }

  return {
    entries,
    commandTallies: frozenTallies(tallies),
    quarantineConfirmed,
    revertedShas,
    lastSeq,
  };
}

function frozenTallies(tallies: ReadonlyMap<string, MutableTally>): Map<string, CommandTally> {
  const out = new Map<string, CommandTally>();
  for (const [key, tally] of tallies) {
    const missions = new Set<string>();
    for (const tag of tally.successfulAttempts.values()) missions.add(tag.missionId);
    out.set(key, {
      successes: tally.successfulAttempts.size,
      failures: tally.failures,
      missionsWithSuccess: [...missions].sort(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Visibility (the CAM-CANON-09 clauses packs are built from)
// ---------------------------------------------------------------------------

/** The reading attempt's identity: which issue (and its mission) it works for. */
export interface KnowledgeReader {
  readonly missionId: string;
  readonly issueId: string;
}

/** Why an entry is visible to a reader — rendered as its provenance tag class. */
export type KnowledgeVisibility = "approved" | "same-issue-candidate";

export interface VisibleKnowledgeEntry {
  readonly snapshot: KnowledgeEntrySnapshot;
  readonly visibility: KnowledgeVisibility;
}

/**
 * The entries one reading attempt may see (CAM-CANON-09 visibility
 * clauses, both directions):
 *
 *  - APPROVED entries (unexpired, standing) are visible to every reader —
 *    they are the only state that enters OTHER missions' packs.
 *  - CANDIDATE entries are visible ONLY to attempts of the SAME issue
 *    (repair attempts), marked `same-issue-candidate` so the pack renders
 *    them as unvetted sibling observations. Same-issue is matched on the
 *    FULL (missionId, issueId) pair, not the issueId alone (r1 finding 3):
 *    a candidate from mission A cannot reach a reader of mission B even if a
 *    malformed provenance shared the issueId string. The entry validator
 *    also namespaces provenance.issueId under provenance.missionId, so the
 *    two checks agree — but this reader does not rely on that invariant.
 *
 * Rejected, retired, invalidated, and expired entries are visible to no
 * reader. Scope is carried as metadata for the pack to render; area-based
 * FILTERING is deliberately not done here — the issue→area mapping is
 * WP-111's surface and a wrong filter would silently hide approved
 * knowledge, so v1 renders scope and lets the worker judge relevance.
 *
 * Ordering: approved by recordedSeq, then same-issue candidates by
 * recordedSeq — deterministic for pack assembly.
 */
export function visibleKnowledgeFor(
  view: KnowledgeView,
  reader: KnowledgeReader,
  nowIso: string,
): VisibleKnowledgeEntry[] {
  const nowProblem = isoInstantProblem("nowIso", nowIso);
  if (nowProblem !== null) throw new Error(nowProblem);
  const approved: VisibleKnowledgeEntry[] = [];
  const candidates: VisibleKnowledgeEntry[] = [];
  for (const snapshot of view.entries.values()) {
    if (snapshot.entry.expiresAt <= nowIso) continue;
    if (snapshot.state === "approved") {
      approved.push({ snapshot, visibility: "approved" });
    } else if (
      snapshot.state === "candidate" &&
      snapshot.entry.provenance.missionId === reader.missionId &&
      snapshot.entry.provenance.issueId === reader.issueId
    ) {
      candidates.push({ snapshot, visibility: "same-issue-candidate" });
    }
  }
  const bySeq = (a: VisibleKnowledgeEntry, b: VisibleKnowledgeEntry): number =>
    a.snapshot.recordedSeq - b.snapshot.recordedSeq;
  return [...approved.sort(bySeq), ...candidates.sort(bySeq)];
}
