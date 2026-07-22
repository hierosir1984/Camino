/**
 * Daemon executable entry (WP-102): `npm run daemon` from the repo root.
 * Startup is fail-closed — a token-file, config, or state-store refusal
 * prints the precise reason and exits non-zero; it is never downgraded to
 * a warning.
 *
 * WP-122 wires the gap-register surface: the canon-side stores (intent
 * ledger, canon facts, gap dispositions) open under the writer lock and
 * back /api/register. This is deliberately NOT the full recovery
 * composition (openRecoveredState) — reconciliation needs the GitHub
 * query transports, which production startup does not construct yet; the
 * WP that wires real external operations replaces this block with the
 * full path. Until repo-head polling lands, the register's context source
 * reports "unavailable" and the GUI shows the honest empty state.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { CanonFactsStore } from "./canon-facts.js";
import { CanonLedgerStore } from "./canon-ledger.js";
import { caminoHome, ConfigError, daemonPort, guiDistPath } from "./config.js";
import { GapDispositionsStore } from "./gap-dispositions.js";
import { closeAll, STATE_FILES } from "./recovery.js";
import { RegisterService } from "./register-service.js";
import { startDaemonServer } from "./server.js";
import { loadOrCreateToken, TokenError } from "./token.js";
import { WriterLock, WriterLockHeldError } from "./writer-lock.js";

/** Longest a stop signal waits for a graceful close before force-exiting. */
const SHUTDOWN_GRACE_MS = 10000;

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
  let lock: WriterLock;
  try {
    lock = WriterLock.acquire(join(stateDir, STATE_FILES.writerLock));
  } catch (error) {
    if (error instanceof WriterLockHeldError) {
      console.error(`Refusing to start: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  let canonLedger: CanonLedgerStore | undefined;
  let canonFacts: CanonFactsStore | undefined;
  let gapDispositions: GapDispositionsStore | undefined;
  // Best-effort teardown with deterministic precedence, mirroring
  // openRecoveredState (round 1, finding 13: a sequential close left later
  // stores and the writer lock open if an earlier close threw). Every closer
  // runs; the FIRST failure surfaces after cleanup finished. The lock release
  // is last and always attempted.
  let closed = false;
  const closeStores = (): void => {
    if (closed) return; // the onClose hook and a refusal path can both fire
    closed = true;
    const failures = closeAll([
      () => gapDispositions?.close(),
      () => canonFacts?.close(),
      () => canonLedger?.close(),
      () => lock.release(),
    ]);
    if (failures.length > 0) throw failures[0];
  };
  try {
    canonLedger = new CanonLedgerStore(join(stateDir, STATE_FILES.canonLedger), {
      writerLock: lock,
    });
    canonFacts = new CanonFactsStore(join(stateDir, STATE_FILES.canonFacts), { writerLock: lock });
    gapDispositions = new GapDispositionsStore(join(stateDir, STATE_FILES.gapDispositions), {
      writerLock: lock,
    });
  } catch (error) {
    const message = (error as Error).message;
    try {
      closeStores();
    } catch {
      // A teardown failure must not mask the original store-open refusal.
    }
    console.error(`Refusing to start: ${message}`);
    process.exit(1);
  }
  const register = new RegisterService({
    canonLedger,
    canonFacts,
    gapDispositions,
    // Honest until repo-head polling lands (see module header).
    contextSource: { current: () => null },
  });

  let daemon;
  try {
    daemon = await startDaemonServer({
      token: tokenLoad.token,
      guiRoot,
      port,
      register,
      // Stores close whenever the instance closes — signals, /api/shutdown, or
      // a post-listen failure — via a hook registered BEFORE listen (round 1,
      // finding 1). No post-listen addHook here; that crashed the daemon.
      onClose: closeStores,
      logger: true,
    });
  } catch (error) {
    try {
      closeStores();
    } catch {
      // A teardown failure must not mask the original listen refusal.
    }
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(
        `Refusing to start: port ${port} is already in use ` +
          `(another daemon instance? — set CAMINO_PORT to use a different port).`,
      );
      process.exit(1);
    }
    throw error;
  }

  // Install the shutdown handlers BEFORE advertising readiness (round 2,
  // finding 1): a SIGTERM arriving between the "listening" line and the handler
  // registration would otherwise hit the default action and kill the daemon
  // ungracefully. Registered here — after the instance exists, before the user
  // is told it is up — so every signal from the moment readiness is announced
  // is handled.
  //
  // On a stop signal: close the instance (its onClose hook releases the stores +
  // writer lock) and exit. Two portability guards, learned on CI: (1) relying on
  // the event loop draining after close() is not portable — on Linux a lingering
  // handle kept the process alive until the default signal action killed it — so
  // we exit explicitly; (2) close() itself can hang waiting on a connection to
  // drain, so a bounded force-exit timer guarantees a daemon told to stop always
  // stops. The forced path exits NON-ZERO — an unclean shutdown must not report
  // itself as clean (round 2, finding 1).
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
    daemon.app.close().then(
      () => done(0),
      (error) => {
        console.error(`Error during shutdown: ${(error as Error).message}`);
        done(1);
      },
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

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
