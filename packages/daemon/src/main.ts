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

  console.log(`Camino daemon listening at ${daemon.url}/`);
  console.log(
    tokenLoad.created
      ? `GUI token created at ${tokenLoad.path} (0600)`
      : `GUI token read from ${tokenLoad.path}`,
  );

  // Handle the shutdown signals explicitly and exit 0 once the instance has
  // closed (its onClose hook releases the stores + writer lock). Relying on the
  // event loop draining after close() is not portable: on Linux a lingering
  // native handle left the process alive until the default signal action killed
  // it, so the exit code was the signal (null), not 0. A daemon told to stop
  // should exit cleanly.
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    daemon.app.close().then(
      () => process.exit(0),
      (error) => {
        console.error(`Error during shutdown: ${(error as Error).message}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void main();
}
