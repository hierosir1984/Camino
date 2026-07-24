/**
 * Daemon executable entry (WP-102): `npm run daemon` from the repo root.
 * Startup is fail-closed — a token-file, config, or state-store refusal
 * prints the precise reason and exits non-zero; it is never downgraded to
 * a warning.
 *
 * WP-114 wires the FULL recovery composition into production boot:
 * openRecoveredState opens every durable store under the writer lock, runs
 * intent reconciliation, PlanningService.resumePendingWork(), and lease
 * inspection; the scheduler recovery pass then settles what the dispatch
 * protocol proves never spawned and reports the rest. Two boundaries are
 * wired fail-closed rather than papered over:
 *
 *   - EXTERNAL QUERY TRANSPORTS (GitHub reads) land with WP-119/120. Until
 *     then the transport below REFUSES with the precise reason. With no
 *     external operation ever recorded this is vacuous (reconciliation
 *     consults transports only for intents in the ambiguity window); the
 *     moment a pre-transport store contains one, boot fails loudly instead
 *     of guessing about the outside world.
 *   - Attempts recovery reports as needing a container/group kill-confirm
 *     are LOGGED and left fenced (stale generations rejected; re-grant
 *     refused) — the runner glue that executes real kill-confirms arrives
 *     with the worker-run loop (WP-119); fencing does not wait for it.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { caminoHome, ConfigError, daemonPort, guiDistPath } from "./config.js";
import { openRecoveredState, STATE_FILES } from "./recovery.js";
import type { QueryTransports, RecoveredState } from "./recovery.js";
import { QuotaWindowTracker } from "./routing/window-tracker.js";
import { AttemptScheduler } from "./scheduler/attempt-scheduler.js";
import { RegisterService } from "./register-service.js";
import { startDaemonServer } from "./server.js";
import { loadOrCreateToken, TokenError } from "./token.js";
import { WriterLockHeldError } from "./writer-lock.js";
import { DEFAULT_POLICY_TABLE } from "@camino/shared";

/** Longest a stop signal waits for a graceful close before force-exiting. */
const SHUTDOWN_GRACE_MS = 10000;

/** GitHub reads land with WP-119/120; until then queries refuse loudly. */
const NO_TRANSPORT_MESSAGE =
  "no external-operation query transport is wired yet (lands with WP-119/120) — an intent " +
  "requiring external facts cannot be reconciled; refusing to guess";
const REFUSING_QUERIES: QueryTransports = {
  github: {
    getRef: () => {
      throw new Error(NO_TRANSPORT_MESSAGE);
    },
    observeRef: () => {
      throw new Error(NO_TRANSPORT_MESSAGE);
    },
    findPullRequestsByHead: () => {
      throw new Error(NO_TRANSPORT_MESSAGE);
    },
    isLabelPresent: () => {
      throw new Error(NO_TRANSPORT_MESSAGE);
    },
    findCommentsByMarker: () => {
      throw new Error(NO_TRANSPORT_MESSAGE);
    },
    findWorkflowRunsByCorrelation: () => {
      throw new Error(NO_TRANSPORT_MESSAGE);
    },
  },
};

export async function main(): Promise<void> {
  let port: number;
  let guiRoot: string;
  let tokenLoad: ReturnType<typeof loadOrCreateToken>;
  try {
    port = daemonPort();
    guiRoot = guiDistPath();
    // Creates and permission-verifies the state directory (0700) as a side
    // effect — the stores below open inside the verified directory.
    tokenLoad = loadOrCreateToken();
  } catch (error) {
    if (error instanceof TokenError || error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const stateDir = caminoHome();
  // The one production path that opens Camino's durable state: writer lock,
  // fail-closed replay verification, intent reconciliation, planning
  // resume, lease inspection (WP-104 + WP-110 + WP-114 composition).
  let state: RecoveredState;
  let windows: QuotaWindowTracker | undefined;
  try {
    state = openRecoveredState(stateDir, REFUSING_QUERIES);
  } catch (error) {
    if (error instanceof WriterLockHeldError) {
      console.error(`Refusing to start: ${error.message}`);
      process.exit(1);
    }
    console.error(`Refusing to start: ${(error as Error).message}`);
    process.exit(1);
  }
  let closed = false;
  let teardownFailures: unknown[] = [];
  const closeStores = (): unknown[] => {
    if (closed) return teardownFailures;
    closed = true;
    teardownFailures = [];
    try {
      windows?.close();
    } catch (error) {
      teardownFailures.push(error);
    }
    try {
      state.close();
    } catch (error) {
      teardownFailures.push(error);
    }
    return teardownFailures;
  };

  try {
    windows = new QuotaWindowTracker(join(stateDir, STATE_FILES.windows), {
      writerLock: state.lock,
    });
    const scheduler = new AttemptScheduler({
      recorder: state.recorder,
      events: state.eventStore,
      domain: state.domain,
      contracts: (missionId) => state.planStore.contractsForMission(missionId),
      leases: state.leases,
      windows,
      policyTable: () => DEFAULT_POLICY_TABLE,
      summaries: state.summaries,
    });
    // The scheduler recovery pass: settle what the protocol PROVES never
    // spawned; everything else stays fenced and is reported here. The
    // kill-confirm executor arrives with the worker-run loop (WP-119).
    const recovered = scheduler.recoverInterrupted();
    if (recovered.settledNeverSpawned.length > 0) {
      console.log(
        `Recovery re-queued ${recovered.settledNeverSpawned.length} interrupted dispatch(es): ` +
          recovered.settledNeverSpawned.join(", "),
      );
    }
    for (const interrupted of recovered.requiresKillConfirm) {
      console.warn(
        `Attempt ${interrupted.attemptId} needs a container/group kill-confirm before its ` +
          `environment (${interrupted.environmentId} g${interrupted.leaseGeneration}) can be ` +
          "re-granted; it stays fenced until the worker-run loop (WP-119) settles it.",
      );
    }
    for (const settled of recovered.settledFromDurableOutcome) {
      console.log(
        `Recovery routed attempt ${settled.attemptId} by its durable lease outcome (${settled.outcome}).`,
      );
    }
    for (const awaiting of recovered.succeededAwaitingSubmission) {
      console.warn(
        `Attempt ${awaiting.attemptId} completed successfully before the interruption; its ` +
          "submission resumes when the final head is re-fetched (workspace intact).",
      );
    }
    if (state.planningResume.completedApprovals.length > 0) {
      console.log(
        `Recovery completed ${state.planningResume.completedApprovals.length} interrupted plan approval(s).`,
      );
    }
    if (state.leaseRecovery.lapsed.length > 0) {
      console.warn(
        `${state.leaseRecovery.lapsed.length} lease(s) lapsed past the TTL — fenced pending kill-confirm.`,
      );
    }
    // WP-113: the knowledge store is opened by openRecoveredState above (under
    // the writer lock, fail-closed lifecycle adoption at boot) — a runtime
    // fact through the FULL production composition, not a minimal boot. The
    // dispatch-time invocation (materialize a pack into a worker workspace,
    // record an attempt's candidates/observations, run the promotion sweep)
    // is the remaining WP-114 dispatcher seam; the planning service it needs
    // is now constructed in recovery, so that wiring is a follow-up, not a gap.
  } catch (error) {
    const message = (error as Error).message;
    closeStores();
    console.error(`Refusing to start: ${message}`);
    process.exit(1);
  }

  const register = new RegisterService({
    canonLedger: state.canonLedger,
    canonFacts: state.canonFacts,
    gapDispositions: state.gapDispositions,
    // Honest until repo-head polling lands (WP-121 wires the production
    // context source; issue #29 tracks it).
    contextSource: { current: () => null },
  });

  // Install the shutdown handlers BEFORE binding the listener (round 3, finding
  // 2): startDaemonServer awaits listen(), and a SIGTERM arriving after the
  // socket binds but before the handlers existed would take the default action
  // and kill the daemon ungracefully. The forced-exit path (a hung close) exits
  // NON-ZERO, and a resolved close whose store teardown FAILED also exits
  // non-zero — an unclean shutdown must not report itself as clean.
  let daemon: Awaited<ReturnType<typeof startDaemonServer>> | undefined;
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    const forceExit = setTimeout(() => {
      console.error(
        `Shutdown did not complete within ${SHUTDOWN_GRACE_MS}ms; forcing exit (unclean).`,
      );
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    const done = (code: number): void => {
      clearTimeout(forceExit);
      process.exit(code);
    };
    if (daemon === undefined) {
      // Signalled before the listener bound: nothing to close but the stores.
      const failures = closeStores();
      done(failures.length > 0 ? 1 : 0);
      return;
    }
    daemon.app.close().then(
      () => done(teardownFailures.length > 0 ? 1 : 0),
      (error) => {
        console.error(`Error during shutdown: ${(error as Error).message}`);
        done(1);
      },
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    daemon = await startDaemonServer({
      token: tokenLoad.token,
      guiRoot,
      port,
      register,
      // Stores close whenever the instance closes — signals, /api/shutdown, or
      // a post-listen failure — via a hook registered BEFORE listen.
      onClose: () => void closeStores(),
      // /api/shutdown shares the ONE stop path: the same teardown-aware,
      // force-guarded exit as a signal.
      onShutdownRequest: stop,
      logger: true,
    });
  } catch (error) {
    closeStores();
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(
        `Refusing to start: port ${port} is already in use ` +
          `(another daemon instance? — set CAMINO_PORT to use a different port).`,
      );
      process.exit(1);
    }
    throw error;
  }

  console.log(`Camino daemon listening at ${daemon.url}/`);
  console.log(
    tokenLoad.created
      ? `GUI token created at ${tokenLoad.path} (0600)`
      : `GUI token read from ${tokenLoad.path}`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void main();
}
