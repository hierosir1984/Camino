/**
 * Recovery composition (WP-104, CAM-STATE-03/06): the one production path
 * that opens Camino's durable state, and the reconciliation pass that
 * settles every unconfirmed intent after a crash.
 *
 * Ordering is the contract, and it is fail-closed at every step:
 *
 *   1. Acquire the durable cross-process WRITER LOCK — or refuse, because
 *      a held lock means another daemon/recovery process is alive right
 *      now. Everything after this line runs single-writer by kernel
 *      guarantee, which is what "recovery runs under a single-writer
 *      lock" means.
 *   2. Open the event store and the transition recorder. The recorder's
 *      constructor replays and VERIFIES the whole event log through the
 *      core decision path and refuses divergence (WP-101, unchanged).
 *   3. Open the intent journal, which likewise refuses a history the
 *      intent lifecycle disagrees with.
 *   4. Reconcile: for every non-terminal intent, gather external facts
 *      through the READ-ONLY query transport, decide through core's
 *      decideReconciliation, and append the resolution. External facts
 *      come from queries; decisions come from the log — the reconciler
 *      reads intended SHAs, markers, and desired states out of the
 *      recorded intent, never re-derives them, and the transport it holds
 *      has no mutating method to call (enforced by type).
 *
 * Reconciliation is IDEMPOTENT by construction: it processes only
 * statuses that need work (`execution-started`, `ambiguity-recorded`),
 * appends move intents to statuses it no longer touches, and a crash
 * anywhere inside it (the chaos suite kills there too) leaves a journal
 * the next reconciliation pass finishes without duplicating a row —
 * "exactly one recorded ambiguity per genuinely ambiguous case" survives
 * repeated recovery.
 *
 * What recovery does NOT do: it never re-executes anything itself.
 * Intents whose effect is provably absent are re-armed and REPORTED
 * (`pendingExecution`); performing them is the executor's job under the
 * caller's control. Lease inspection and environment reset-on-resume
 * assertions belong to WP-114/WP-115 per the plan's timing note.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { decideReconciliation, statusOnlyVerdict } from "@camino/core";
import type { IntentSnapshot, ObservedFacts, ReconcileVerdict } from "@camino/core";
import type { ExternalOperationSpec, GitHubQueryTransport } from "@camino/shared";
import { CanonFactsStore } from "./canon-facts.js";
import { CanonLedgerStore } from "./canon-ledger.js";
import { SqliteEventStore } from "./event-store.js";
import { GapDispositionsStore } from "./gap-dispositions.js";
import { IntentJournal } from "./intent-journal.js";
import { TransitionRecorder } from "./transition-recorder.js";
import { WriterLock } from "./writer-lock.js";

/** The read-only surfaces reconciliation may consult. */
export interface QueryTransports {
  readonly github: GitHubQueryTransport;
}

export interface ReconciledIntent {
  readonly intentId: string;
  readonly op: ExternalOperationSpec["op"];
  readonly verdict: ReconcileVerdict["kind"];
  readonly detail: string;
}

export interface RecoveryReport {
  /** Every verdict applied or observed this pass, in journal order. */
  readonly reconciled: readonly ReconciledIntent[];
  /** Intents executable after this pass (recorded / re-armed). */
  readonly pendingExecution: readonly string[];
  /** Intents parked on a human decision (escalated). */
  readonly awaitingHuman: readonly string[];
}

export interface RecoveredState {
  readonly lock: WriterLock;
  readonly eventStore: SqliteEventStore;
  readonly recorder: TransitionRecorder;
  readonly journal: IntentJournal;
  /** WP-109: the Living Canon's intent ledger (user actions only, CAM-CANON-01). */
  readonly canonLedger: CanonLedgerStore;
  /** WP-109: per-requirement observations the status projection folds (CAM-CANON-03). */
  readonly canonFacts: CanonFactsStore;
  /** WP-122: David's gap-register disposition events (CAM-CANON-05). */
  readonly gapDispositions: GapDispositionsStore;
  readonly report: RecoveryReport;
  close(): void;
}

export interface RecoveryOptions {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  /** Chaos seam: fires at named points inside reconciliation. */
  readonly hook?: (point: string) => void;
  /** Actor recorded on reconciliation appends. */
  readonly actor?: string;
}

/**
 * The durable state directory's file names.
 *
 * FROZEN, and this one is load-bearing beyond tidiness: `writerLock` selects
 * the file whose kernel lock IS the single-writer guarantee (CAM-STATE-04).
 * `as const` is compile-time only, so on the unfrozen record a package-root
 * importer could retarget `writerLock` between two openRecoveredState calls
 * and end up with TWO recovered-state owners over one state directory — each
 * holding a lock on a different file, neither fencing the other. That needs
 * no deep import and no gated-object mutation (the named WP-107 boundary),
 * just the public barrel. Freezing closes it; reads are unaffected.
 */
export const STATE_FILES = Object.freeze({
  writerLock: "writer-lock.sqlite",
  events: "events.sqlite",
  intents: "intents.sqlite",
  canonLedger: "canon-ledger.sqlite",
  canonFacts: "canon-facts.sqlite",
  gapDispositions: "gap-dispositions.sqlite",
} as const);

/**
 * Open Camino's durable state under the writer lock and reconcile. THE
 * production composition path: everything that writes the stores runs
 * behind the lock this acquires. The state directory must already exist —
 * creating and permission-verifying it is the WP-102 startup surface's
 * job (token.ts verifyStateDir), not recovery's.
 */
export function openRecoveredState(
  stateDir: string,
  queries: QueryTransports,
  options: RecoveryOptions = {},
): RecoveredState {
  if (!existsSync(stateDir)) {
    throw new Error(
      `state directory ${stateDir} does not exist — recovery opens state, it does not create ` +
        "the directory (WP-102 startup owns that, with its permission verification)",
    );
  }
  const lock = WriterLock.acquire(join(stateDir, STATE_FILES.writerLock));
  let eventStore: SqliteEventStore | undefined;
  let journal: IntentJournal | undefined;
  let canonLedger: CanonLedgerStore | undefined;
  let canonFacts: CanonFactsStore | undefined;
  let gapDispositions: GapDispositionsStore | undefined;
  try {
    eventStore = new SqliteEventStore(join(stateDir, STATE_FILES.events), {
      ...(options.now === undefined ? {} : { now: options.now }),
      writerLock: lock,
    });
    // Fail-closed replay verification happens inside the constructor (WP-101).
    const recorder = new TransitionRecorder(eventStore);
    journal = new IntentJournal(join(stateDir, STATE_FILES.intents), {
      ...(options.now === undefined ? {} : { now: options.now }),
      writerLock: lock,
    });
    // WP-109: the canon stores open under the same lock; both run their
    // fail-closed adoption verification in their constructors. Canon has
    // no reconciliation step here — the ledger records user actions only
    // (nothing to reconcile against the outside world), and fact
    // reconciliation is the CAM-CANON-06 reconciler's job (later WP).
    canonLedger = new CanonLedgerStore(join(stateDir, STATE_FILES.canonLedger), {
      ...(options.now === undefined ? {} : { now: options.now }),
      writerLock: lock,
    });
    canonFacts = new CanonFactsStore(join(stateDir, STATE_FILES.canonFacts), {
      ...(options.now === undefined ? {} : { now: options.now }),
      writerLock: lock,
    });
    // WP-122: the gap-disposition log opens under the same lock, with the
    // same fail-closed shape verification in its constructor.
    gapDispositions = new GapDispositionsStore(join(stateDir, STATE_FILES.gapDispositions), {
      ...(options.now === undefined ? {} : { now: options.now }),
      writerLock: lock,
    });
    const report = reconcileIntents(journal, queries, options);
    const openJournal = journal;
    const openStore = eventStore;
    const openCanonLedger = canonLedger;
    const openCanonFacts = canonFacts;
    const openGapDispositions = gapDispositions;
    return {
      lock,
      eventStore,
      recorder,
      journal,
      canonLedger,
      canonFacts,
      gapDispositions,
      report,
      close(): void {
        // Exception-safe teardown (review round 1 finding 14; round 2
        // finding 11 folded the lock release into the guarded set; round
        // 3 finding 7 corrected the guarantee's wording): every closer
        // runs to best effort, and the FIRST failure — deterministically
        // the earliest in list order — surfaces after cleanup finished,
        // never masked by a later one. WriterLock.release() itself closes
        // the connection in a `finally`, so the kernel lock is released
        // even if its rollback throws; the guard here additionally means a
        // hypothetical throwing release cannot mask an earlier store-close
        // failure. This is best-effort invocation with deterministic
        // precedence, not a proof that every underlying handle closed.
        const failures = closeAll([
          () => openGapDispositions.close(),
          () => openCanonFacts.close(),
          () => openCanonLedger.close(),
          () => openJournal.close(),
          () => openStore.close(),
          () => lock.release(),
        ]);
        if (failures.length > 0) throw failures[0];
      },
    };
  } catch (error) {
    // Same guarantee on the constructor-refusal path: best-effort close
    // of everything opened so far INCLUDING the lock release, and the
    // ORIGINAL refusal (not a secondary close/release failure) rethrown.
    closeAll([
      () => gapDispositions?.close(),
      () => canonFacts?.close(),
      () => canonLedger?.close(),
      () => journal?.close(),
      () => eventStore?.close(),
      () => lock.release(),
    ]);
    throw error;
  }
}

/** Run every closer, collecting failures instead of aborting the chain. */
export function closeAll(closers: ReadonlyArray<() => void>): unknown[] {
  const failures: unknown[] = [];
  for (const closer of closers) {
    try {
      closer();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/**
 * The reconciliation pass. Public on its own so the daemon can re-run it
 * while alive (e.g. after a lost-response execution outcome) — the same
 * one path recovery uses.
 */
export function reconcileIntents(
  journal: IntentJournal,
  queries: QueryTransports,
  options: RecoveryOptions = {},
): RecoveryReport {
  const hook = options.hook ?? (() => {});
  const actor = options.actor ?? "camino:recovery";
  const reconciled: ReconciledIntent[] = [];
  const pendingExecution: string[] = [];
  const awaitingHuman: string[] = [];
  // PASS-WIDE two-phase ordering (round-1 finding 8; made pass-wide by
  // round-2 finding 3): ALL status-only work — provably unsent intents,
  // half-appended escalation pairs — resolves before the FIRST external
  // query, so a query failure on one intent can never block status-only
  // work on another. Only the ambiguity window pays for queries, and a
  // query throw still aborts the pass loudly (reconciling an
  // execution-started intent without facts would be a guess); everything
  // this pass appended stays idempotent for the retry.
  const worklist = journal.nonTerminal();
  const needFacts: IntentSnapshot[] = [];
  for (const snapshot of worklist) {
    const verdict = statusOnlyVerdict(snapshot);
    if (verdict === null) {
      needFacts.push(snapshot);
      continue;
    }
    applyVerdict(journal, snapshot, verdict, actor, hook, {
      reconciled,
      pendingExecution,
      awaitingHuman,
    });
  }
  for (const snapshot of needFacts) {
    const verdict = decideReconciliation(snapshot, gatherFacts(snapshot.spec, queries));
    applyVerdict(journal, snapshot, verdict, actor, hook, {
      reconciled,
      pendingExecution,
      awaitingHuman,
    });
  }
  return { reconciled, pendingExecution, awaitingHuman };
}

/** Gather the class's facts through the read-only query surface. */
function gatherFacts(spec: ExternalOperationSpec, queries: QueryTransports): ObservedFacts {
  switch (spec.op) {
    case "branch-create":
      return { op: spec.op, branchSha: queries.github.getRef(spec.repo, spec.branch) };
    case "push":
      return { op: spec.op, refSha: queries.github.getRef(spec.repo, spec.ref) };
    case "pr-create":
      return {
        op: spec.op,
        pullRequests: queries.github.findPullRequestsByHead(spec.repo, spec.headBranch),
      };
    case "merge-by-push": {
      // ONE observation (round-1 finding 4): the SHA and the ancestry
      // answer come from the same query, so a ref move between two calls
      // can never hand the verdict contradictory facts.
      const observed = queries.github.observeRef(spec.repo, spec.targetRef, spec.mergeSha);
      return {
        op: spec.op,
        targetAtOrPastMerge: observed.atOrPastAncestor,
        targetSha: observed.refSha,
      };
    }
    case "label-set":
      return {
        op: spec.op,
        labelPresent: queries.github.isLabelPresent(
          spec.repo,
          spec.targetKind,
          spec.targetNumber,
          spec.label,
        ),
      };
    case "comment-post":
      return {
        op: spec.op,
        comments: queries.github.findCommentsByMarker(
          spec.repo,
          spec.targetKind,
          spec.targetNumber,
          spec.marker,
        ),
      };
    case "workflow-dispatch":
      return {
        op: spec.op,
        runs: queries.github.findWorkflowRunsByCorrelation(spec.repo, spec.correlationId),
      };
    case "test-service-mutation":
      return { op: spec.op };
    case "catch-all":
      return { op: spec.op };
  }
}

function applyVerdict(
  journal: IntentJournal,
  snapshot: IntentSnapshot,
  verdict: ReconcileVerdict,
  actor: string,
  hook: (point: string) => void,
  out: {
    reconciled: ReconciledIntent[];
    pendingExecution: string[];
    awaitingHuman: string[];
  },
): void {
  const { intentId, spec } = snapshot;
  const record = (detail: string): void => {
    out.reconciled.push({ intentId, op: spec.op, verdict: verdict.kind, detail });
  };
  switch (verdict.kind) {
    case "confirmed-external": {
      journal.append({
        intentId,
        event: "confirmed",
        actor,
        payload: { via: "reconciliation", result: verdict.result, note: verdict.note },
      });
      hook("recovery-after-resolution-append");
      record(verdict.note);
      return;
    }
    case "re-arm": {
      journal.append({
        intentId,
        event: "re-armed",
        actor,
        payload: { note: verdict.note, resetBeforeUse: verdict.resetBeforeUse },
      });
      hook("recovery-after-resolution-append");
      out.pendingExecution.push(intentId);
      record(verdict.note);
      return;
    }
    case "ambiguous": {
      journal.append({
        intentId,
        event: "ambiguity-recorded",
        actor,
        payload: { reason: verdict.reason },
      });
      hook("recovery-between-ambiguity-and-escalation");
      journal.append({ intentId, event: "escalated", actor, payload: { reason: verdict.reason } });
      hook("recovery-after-resolution-append");
      out.awaitingHuman.push(intentId);
      record(verdict.reason);
      return;
    }
    case "failed-terminal": {
      journal.append({
        intentId,
        event: "failed",
        actor,
        payload: { via: "reconciliation", reason: verdict.reason },
      });
      hook("recovery-after-resolution-append");
      record(verdict.reason);
      return;
    }
    case "complete-escalation": {
      // A crash landed between the ambiguity row and its escalation row —
      // finish the pair using the recorded reason (the log's decision).
      const reason = journal.entry(intentId)?.ambiguityReason ?? "ambiguity recorded (reason row)";
      journal.append({ intentId, event: "escalated", actor, payload: { reason } });
      hook("recovery-after-resolution-append");
      out.awaitingHuman.push(intentId);
      record(reason);
      return;
    }
    case "pending-execution": {
      out.pendingExecution.push(intentId);
      // The detail is audit text — it must reflect the REAL history
      // (round-1 finding 12): re-armed and retry-authorized intents fold
      // back to `recorded` but their barrier DID run before.
      const started = journal.entry(intentId)?.executionStartedCount ?? 0;
      record(
        started === 0
          ? "recorded, barrier absent — provably never sent; executable as-is"
          : `executable again after reconciliation/authorization (${started} prior execution start(s))`,
      );
      return;
    }
    case "awaiting-human": {
      out.awaitingHuman.push(intentId);
      record("escalated — waiting on the human decision");
      return;
    }
    case "already-resolved":
      // nonTerminal() filtered these; nothing to do.
      return;
  }
}
