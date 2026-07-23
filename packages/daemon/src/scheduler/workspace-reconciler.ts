/**
 * Retained-workspace reconciliation (WP-114; the WP-107 handoff's
 * reconciliation obligation).
 *
 * WP-107's archival fails CLOSED — retain the workspace and wait — on: a
 * partial/failed destroy; an over-quota workspace; a path past PATH_MAX;
 * and any archive whose durable ledger state cannot be determined from
 * local files. It NEVER auto-recovers those. THIS module is the scheduler
 * half that can: it queries the DURABLE state (the recorder's attempt
 * machine + the archive ledger) and either RESUMES the single archival
 * step (archiveAttempt's own sidecar-identity resume logic runs; the
 * ledger row replays idempotently), COMPLETES it by recording the A.3#8
 * event, or ESCALATES with the staged reason — never destroying on a
 * pathname alone, and never touching a workspace whose environment lease
 * is still HELD (the janitor-honors-lease-generations clause of
 * CAM-STATE-04: reconciliation runs only on unowned environments).
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import type { EnvironmentLeaseStore } from "@camino/shared";
import type { RecordOutcome, TransitionRecorder } from "../transition-recorder.js";
import { SCHEDULER_ACTOR } from "../serialization-scheduler.js";
import { ArchivalError, archiveAttempt, type ArchiveQuotas } from "../worker/archive.js";
import type { ArchiveLedgerStore } from "./archive-ledger.js";

/** Streamed sha-256 of a file (archives can be large; never read whole). */
async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** One attempt's retained workspace, as the caller discovered it. */
export interface RetainedWorkspaceRef {
  readonly issueId: string;
  readonly attemptId: string;
  readonly workspaceDir: string;
  /** The environment the attempt leased (lease honor check). */
  readonly environmentId: string;
  /** Authoritative per-issue attempt ordinal (retention sequence). */
  readonly attemptSeq?: number;
}

export type ReconciliationOutcome =
  | {
      /** Archival ran to completion (fresh, resumed, or re-recorded) and A.3#8 recorded. */
      readonly kind: "archived";
      readonly archivePath: string;
    }
  | {
      /** Fail-closed retention stands; a human (or a later pass) decides. */
      readonly kind: "escalated";
      readonly reason: string;
      readonly stage?: string;
    }
  | {
      /** The environment lease is HELD — reconciliation defers to the owner. */
      readonly kind: "deferred-lease-held";
      readonly holderAttemptId: string;
    }
  | {
      /** The attempt is still active — nothing to reconcile yet. */
      readonly kind: "deferred-attempt-active";
      readonly attemptState: string;
    };

export interface ReconcilerDeps {
  readonly recorder: TransitionRecorder;
  readonly leases: EnvironmentLeaseStore;
  readonly ledger: ArchiveLedgerStore;
  readonly archiveRoot: string;
  readonly quotas?: ArchiveQuotas;
  readonly now?: () => Date;
}

/**
 * Reconcile ONE retained workspace. Decision order:
 *
 *   1. lease honor: a HELD lease on the attempt's environment defers
 *      reconciliation entirely (one fenced owner — the reconciler is not
 *      it);
 *   2. attempt must be TERMINAL (A.3): an active attempt's workspace is
 *      not retained, it is in use;
 *   3. an already-`archived` attempt with a workspace still on disk is an
 *      inconsistency — escalated, never "cleaned up" (the A.3#8 event
 *      records only after the destroy, so this state means the durable
 *      record and the filesystem disagree);
 *   4. otherwise re-run the single archival step: archiveAttempt's own
 *      logic resumes a valid-sidecar destroy, refuses ambiguous partials,
 *      and replays the ledger row idempotently (this store). Success →
 *      A.3#8 recorded here; an ArchivalError → escalation with its stage.
 */
export async function reconcileRetainedWorkspace(
  ref: RetainedWorkspaceRef,
  deps: ReconcilerDeps,
): Promise<ReconciliationOutcome> {
  const lease = deps.leases.current(ref.environmentId);
  if (lease !== undefined && lease.state === "held") {
    return { kind: "deferred-lease-held", holderAttemptId: lease.holderAttemptId };
  }

  const attemptState = deps.recorder.currentState("attempt", ref.attemptId);
  if (attemptState === undefined) {
    return {
      kind: "escalated",
      reason: `attempt ${ref.attemptId} has no durable record — a workspace with no recorded attempt is foreign state`,
    };
  }
  if (attemptState === "archived") {
    return {
      kind: "escalated",
      reason:
        `attempt ${ref.attemptId} is recorded archived but its workspace still exists — the durable ` +
        "record and the filesystem disagree; refusing to destroy anything",
    };
  }
  if (attemptState === "running" || attemptState === "submitted") {
    return { kind: "deferred-attempt-active", attemptState };
  }

  // Consult the DURABLE ledger first (round-1 finding 15 — the whole point
  // of this reconciler is that it can query what the archival step cannot):
  // a recorded row proves A.4#5 step 2 completed. Verify the archive it
  // references before anything else, so the escalation below can name the
  // PRECISE durable state rather than "unknown".
  const ledgerRow = deps.ledger.get(ref.issueId, ref.attemptId);
  if (ledgerRow !== undefined) {
    if (!existsSync(ledgerRow.archivePath)) {
      return {
        kind: "escalated",
        reason:
          `the durable ledger row for ${ref.attemptId} references ${ledgerRow.archivePath} but no ` +
          "archive exists there — the workspace is the last copy; refusing to touch anything",
      };
    }
    const actual = await sha256File(ledgerRow.archivePath);
    if (actual !== ledgerRow.sha256) {
      return {
        kind: "escalated",
        reason:
          `the archive at ${ledgerRow.archivePath} does not match the durable ledger row's sha256 ` +
          `for ${ref.attemptId} (recorded ${ledgerRow.sha256}, actual ${actual}) — refusing to touch anything`,
      };
    }
    // Row durable + archive verified: only the DESTROY may be outstanding.
    // archiveAttempt's own sidecar-identity resume completes it when the
    // directory is provably the archived one; otherwise the refusal below
    // escalates with this verified context attached.
    try {
      const record = await archiveAttempt({
        workspaceDir: ref.workspaceDir,
        archiveRoot: deps.archiveRoot,
        issueId: ref.issueId,
        attemptId: ref.attemptId,
        ...(ref.attemptSeq === undefined ? {} : { attemptSeq: ref.attemptSeq }),
        recordLedgerRow: (row) => {
          deps.ledger.record(row);
        },
        ...(deps.quotas === undefined ? {} : { quotas: deps.quotas }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
      });
      recordArchivalEvent(deps.recorder, ref.attemptId, record.attemptEvent);
      return { kind: "archived", archivePath: record.archivePath };
    } catch (error) {
      if (error instanceof ArchivalError) {
        return {
          kind: "escalated",
          reason:
            `ledger row durable and archive verified for ${ref.attemptId}; the workspace destroy ` +
            `remains blocked: ${error.message}`,
          stage: error.stage,
        };
      }
      throw error;
    }
  }

  try {
    const record = await archiveAttempt({
      workspaceDir: ref.workspaceDir,
      archiveRoot: deps.archiveRoot,
      issueId: ref.issueId,
      attemptId: ref.attemptId,
      ...(ref.attemptSeq === undefined ? {} : { attemptSeq: ref.attemptSeq }),
      recordLedgerRow: (row) => {
        deps.ledger.record(row);
      },
      ...(deps.quotas === undefined ? {} : { quotas: deps.quotas }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
    recordArchivalEvent(deps.recorder, ref.attemptId, record.attemptEvent);
    return { kind: "archived", archivePath: record.archivePath };
  } catch (error) {
    if (error instanceof ArchivalError) {
      // The staged fail-closed refusal classes WP-107 names: over-quota,
      // PATH_MAX, ambiguous partials, destroy failures. Retention stands.
      return { kind: "escalated", reason: error.message, stage: error.stage };
    }
    throw error;
  }
}

/** Record A.3#8 (terminal → archived) with the guard-satisfying payload archiveAttempt built. */
export function recordArchivalEvent(
  recorder: TransitionRecorder,
  attemptId: string,
  attemptEvent: { type: "archival-completed" } & Record<string, unknown>,
): RecordOutcome {
  const { type, ...payload } = attemptEvent;
  const outcome = recorder.record({
    entityKind: "attempt",
    entityId: attemptId,
    event: type,
    actor: SCHEDULER_ACTOR,
    cause: "single archival step completed (A.4#5: archive → ledger row → destroy)",
    payload,
  });
  if (!outcome.ok) {
    throw new Error(
      `archival-completed for attempt ${attemptId} was refused (${outcome.code}) — ` +
        "the archival evidence and the machine disagree; refusing to continue",
    );
  }
  return outcome;
}
