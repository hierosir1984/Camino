/**
 * Durable archive ledger (WP-114): the destination of WP-107's
 * `recordLedgerRow` callback — step 2 of the single archival step (A.4#5:
 * archive written → LEDGER ROW REFERENCING IT → workspace destroyed).
 *
 * This is the store the workspace reconciler can QUERY (which the archival
 * step itself cannot — WP-107's stated boundary: an archive whose durable
 * ledger state cannot be determined from local files fails closed and
 * waits for the janitor/scheduler). Idempotent per (issueId, attemptId),
 * exactly as ArchiveAttemptOptions.recordLedgerRow requires: a reconciled
 * re-archival replays the same row; different content is refused.
 */
import Database from "better-sqlite3";
import { canonicalJson } from "@camino/shared";
import type { ArchiveLedgerRow } from "../worker/archive.js";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS archive_ledger (
  issue_id    TEXT NOT NULL CHECK (length(issue_id) > 0),
  attempt_id  TEXT NOT NULL CHECK (length(attempt_id) > 0),
  record      TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (issue_id, attempt_id)
);

CREATE TRIGGER IF NOT EXISTS archive_ledger_append_only_update
BEFORE UPDATE ON archive_ledger
BEGIN
  SELECT RAISE(ABORT, 'archive ledger rows are append-only: UPDATE rejected');
END;

CREATE TRIGGER IF NOT EXISTS archive_ledger_append_only_delete
BEFORE DELETE ON archive_ledger
BEGIN
  SELECT RAISE(ABORT, 'archive ledger rows are append-only: DELETE rejected');
END;

CREATE TRIGGER IF NOT EXISTS archive_ledger_no_replace
BEFORE INSERT ON archive_ledger
WHEN EXISTS (SELECT 1 FROM archive_ledger WHERE issue_id = NEW.issue_id AND attempt_id = NEW.attempt_id)
BEGIN
  SELECT RAISE(ABORT, 'archive ledger rows are append-only: replacement rejected');
END;
`;

let expectedLedgerSchema: Map<string, string> | null = null;
function expectedSchemaObjects(): Map<string, string> {
  if (expectedLedgerSchema !== null) return expectedLedgerSchema;
  const mem = new Database(":memory:");
  try {
    mem.exec(SCHEMA);
    const rows = mem
      .prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; sql: string | null }>;
    expectedLedgerSchema = new Map(rows.map((r) => [r.name, r.sql ?? ""]));
    return expectedLedgerSchema;
  } finally {
    mem.close();
  }
}

export interface ArchiveLedgerStoreOptions {
  /** The daemon's held writer lock, or explicitly null for a test context. */
  readonly writerLock: { assertHeld(context: string): void } | null;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

export class ArchiveLedgerStore {
  readonly #db: Database.Database;
  readonly #writerLock: { assertHeld(context: string): void } | undefined;
  readonly #now: () => Date;

  constructor(path: string, options: ArchiveLedgerStoreOptions) {
    if (options === null || typeof options !== "object" || !("writerLock" in options)) {
      throw new TypeError(
        "ArchiveLedgerStore requires a writerLock decision: pass the daemon's held writer lock, or explicitly null for a test context",
      );
    }
    const lock = options.writerLock;
    if (lock !== null && (typeof lock !== "object" || typeof lock.assertHeld !== "function")) {
      throw new TypeError(
        "writerLock must be the daemon's held writer lock ({ assertHeld }) or explicitly null",
      );
    }
    this.#writerLock = lock ?? undefined;
    this.#now = options.now ?? (() => new Date());
    this.#db = new Database(path);
    try {
      this.#db.pragma("journal_mode = WAL");
      const encoding = this.#db.pragma("encoding", { simple: true }) as string;
      if (encoding !== "UTF-8") {
        throw new Error(
          `archive-ledger store ${path} uses encoding ${encoding}; expected UTF-8 — refusing to open`,
        );
      }
      const version = this.#db.pragma("user_version", { simple: true }) as number;
      if (version === 0) {
        this.#db.exec(SCHEMA);
        this.#db.pragma(`user_version = ${SCHEMA_VERSION}`);
      } else if (version !== SCHEMA_VERSION) {
        throw new Error(
          `archive-ledger store ${path} has schema version ${version}; this daemon expects ${SCHEMA_VERSION}`,
        );
      }
      const expected = expectedSchemaObjects();
      const actual = new Map(
        (
          this.#db
            .prepare(
              "SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all() as Array<{ name: string; sql: string | null }>
        ).map((r) => [r.name, r.sql ?? ""]),
      );
      if (actual.size !== expected.size) {
        throw new Error(
          `archive-ledger store ${path} has ${actual.size} schema objects, expected ${expected.size} — ` +
            "refusing to open a tampered or foreign store",
        );
      }
      for (const [name, sql] of expected) {
        if (actual.get(name) !== sql) {
          throw new Error(
            `archive-ledger store ${path} schema object ${name} does not match this daemon's definition — ` +
              "refusing to open a tampered or foreign store",
          );
        }
      }
      const integrity = this.#db.pragma("integrity_check", { simple: true }) as string;
      if (integrity !== "ok") {
        throw new Error(
          `archive-ledger store ${path} fails integrity_check (${integrity}) — refusing to open`,
        );
      }
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  /**
   * The recordLedgerRow implementation archiveAttempt requires: durable
   * before return, idempotent per (issueId, attemptId), conflicting
   * content refused (WP-104 §4.4 posture).
   */
  record(row: ArchiveLedgerRow): ArchiveLedgerRow {
    this.#writerLock?.assertHeld("archive-ledger append");
    const serialized = canonicalJson(row);
    const snapshot = JSON.parse(serialized) as ArchiveLedgerRow;
    if (
      typeof snapshot.issueId !== "string" ||
      snapshot.issueId.length === 0 ||
      typeof snapshot.attemptId !== "string" ||
      snapshot.attemptId.length === 0
    ) {
      throw new Error("archive ledger row requires non-empty issueId and attemptId");
    }
    const existing = this.#db
      .prepare("SELECT record FROM archive_ledger WHERE issue_id = ? AND attempt_id = ?")
      .get(snapshot.issueId, snapshot.attemptId) as { record: string } | undefined;
    if (existing !== undefined) {
      if (existing.record === serialized) return snapshot;
      throw new Error(
        `archive ledger already holds a row for ${snapshot.issueId}/${snapshot.attemptId} with ` +
          "different content — refusing conflicting evidence",
      );
    }
    this.#db
      .prepare(
        "INSERT INTO archive_ledger (issue_id, attempt_id, record, recorded_at) VALUES (?, ?, ?, ?)",
      )
      .run(snapshot.issueId, snapshot.attemptId, serialized, this.#now().toISOString());
    return snapshot;
  }

  get(issueId: string, attemptId: string): ArchiveLedgerRow | undefined {
    const row = this.#db
      .prepare("SELECT record FROM archive_ledger WHERE issue_id = ? AND attempt_id = ?")
      .get(issueId, attemptId) as { record: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.record) as ArchiveLedgerRow);
  }

  forIssue(issueId: string): ArchiveLedgerRow[] {
    const rows = this.#db
      .prepare("SELECT record FROM archive_ledger WHERE issue_id = ? ORDER BY attempt_id")
      .all(issueId) as Array<{ record: string }>;
    return rows.map((r) => JSON.parse(r.record) as ArchiveLedgerRow);
  }
}
