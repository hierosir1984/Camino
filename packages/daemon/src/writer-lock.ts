/**
 * Durable cross-process single-writer lock (WP-104, CAM-STATE-03).
 *
 * WP-101 left a promise in the recorder and the event store: the CAS
 * append detects a second writer in-process, and "the durable
 * cross-process recovery lock lands with WP-104". This is that lock.
 *
 * Mechanism: a dedicated SQLite database whose only job is to be locked.
 * Acquisition opens a connection and holds `BEGIN EXCLUSIVE` for the
 * lifetime of the handle — SQLite's exclusive file lock, enforced by the
 * kernel across processes ON A LOCAL FILESYSTEM WITH WORKING LOCKS (the
 * platforms Camino targets: macOS/APFS and Linux local filesystems, both
 * exercised by this suite). SQLite itself documents that network
 * filesystems — NFS especially — ship broken or missing lock
 * implementations; a state directory on a network mount is OUT OF
 * CONTRACT for the whole daemon, not just this lock (round 2, finding
 * 5). The properties that make this the right primitive:
 *
 *  - **Held = alive.** The lock exists only while the owning process
 *    holds the connection. `kill -9` closes the file descriptors and the
 *    kernel releases the lock — there is no stale-lockfile state, no PID
 *    file, no mtime staleness heuristic to get wrong. A crashed daemon
 *    never blocks its successor; a live daemon blocks every COOPERATING
 *    acquirer (the integration constraint below bounds "always").
 *  - **Fail-closed, instant refusal.** Acquisition sets busy_timeout to 0
 *    before `BEGIN EXCLUSIVE`: a held lock refuses immediately with a
 *    message naming the file. A held lock means another daemon process is
 *    alive right now — waiting for it would be wrong, not slow.
 *  - **No content protocol.** The database body carries a single marker
 *    row for diagnosability; nothing reads it for decisions. The kernel
 *    lock is the entire semantics.
 *
 * Scope, stated honestly: this serializes cooperating Camino processes
 * (two daemons, a daemon and a recovery run). A hostile local process
 * that opens the SQLite stores directly bypasses any advisory lock — that
 * is the same single-OS-user trust boundary the state directory's 0700
 * mode names (WP-102), not something a lock file can add to.
 *
 * INTEGRATION CONSTRAINT (review round 1, finding 9 — the POSIX advisory
 * lock hazards SQLite itself documents): the guarantee holds only while
 * every process touches the lock FILE exclusively through this class.
 * Two same-user misuse patterns void it silently: (a) opening and then
 * closing ANY other file descriptor on the lock file's inode from the
 * holder's own process (POSIX drops all of that process's locks on the
 * inode at that close — SQLite guards its own connections, not foreign
 * ones), and (b) unlinking/renaming the lock file (a later acquirer
 * locks a NEW inode and both "hold the lock"). No Camino code opens,
 * unlinks, or renames this path outside WriterLock, and the state
 * directory is not a shared scratch area — the constraint is named here
 * (WP-003 boundary-naming precedent) so later WPs never add such code,
 * rather than chased with unwinnable inode self-checks.
 *
 * Recovery and every store write run under this lock: the daemon's
 * composition path (recovery.ts) acquires it before opening the event
 * store and the intent journal, and both stores assert the handle is
 * still held before each append (in-process defense-in-depth beneath the
 * kernel guarantee, alongside the WP-101 CAS which stays in place).
 */
import Database from "better-sqlite3";

/** The narrow surface stores depend on (structural, to avoid coupling). */
export interface HeldWriterLock {
  readonly held: boolean;
  assertHeld(context: string): void;
}

/** Refusal to acquire: another process holds the lock right now. */
export class WriterLockHeldError extends Error {
  constructor(path: string) {
    super(
      `another process holds the Camino writer lock (${path}) — a second daemon or recovery ` +
        "run is alive right now; refusing to open the state stores beside it (CAM-STATE-03)",
    );
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lock_marker (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  purpose  TEXT NOT NULL
);
INSERT OR IGNORE INTO lock_marker (id, purpose)
  VALUES (1, 'Camino single-writer lock — the value is the kernel file lock, not this row');
`;

export class WriterLock implements HeldWriterLock {
  private db: Database.Database | null;
  private readonly path: string;

  private constructor(db: Database.Database, path: string) {
    this.db = db;
    this.path = path;
  }

  /**
   * Acquire the lock or throw `WriterLockHeldError` IMMEDIATELY — the busy
   * handler is off for every step, so contention at any point (even two
   * daemons racing the very first creation of the marker table) refuses
   * one side instantly instead of waiting. A held lock means another
   * daemon is alive; waiting for it is never the right behavior.
   */
  static acquire(path: string): WriterLock {
    const db = new Database(path);
    try {
      db.pragma("busy_timeout = 0");
      const marker = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lock_marker'")
        .get();
      if (marker === undefined) {
        db.exec(SCHEMA);
      }
      db.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      db.close();
      if ((error as { code?: string }).code === "SQLITE_BUSY") {
        throw new WriterLockHeldError(path);
      }
      throw error;
    }
    return new WriterLock(db, path);
  }

  get held(): boolean {
    return this.db !== null;
  }

  /** Stores call this before every append: a released lock is a programming bug surfaced loudly. */
  assertHeld(context: string): void {
    if (this.db === null || !this.db.inTransaction) {
      throw new Error(
        `${context} attempted without the writer lock held (${this.path}) — ` +
          "writes must only happen inside the daemon composition that acquired it (CAM-STATE-03)",
      );
    }
  }

  /** Release and close. Idempotent; the kernel also releases on process death. */
  release(): void {
    if (this.db === null) return;
    try {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
    } finally {
      this.db.close();
      this.db = null;
    }
  }
}
