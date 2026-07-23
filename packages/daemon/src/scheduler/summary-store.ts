/**
 * Durable attempt-summary store (WP-114, CAM-PLAN-09): the structured
 * failure-handoff records the scheduler writes at every attempt terminal.
 * The NEXT attempt (and the WP-113 context pack briefing it) reads these —
 * never the worker transcript; the schema itself has no field a transcript
 * could ride in (@camino/shared attempt-summary).
 *
 * Append-only with idempotent replay per attempt (the WP-104 §4.4 posture,
 * same as the WP-106 window tracker): a crash between recording the
 * attempt terminal and downstream processing must not duplicate or rewrite
 * a summary — replaying the same attemptId with identical content returns
 * the existing row; different content is refused as conflicting evidence.
 */
import Database from "better-sqlite3";
import type { AttemptSummary } from "@camino/shared";
import { attemptSummaryProblems, canonicalJson } from "@camino/shared";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS attempt_summaries (
  attempt_id  TEXT PRIMARY KEY CHECK (length(attempt_id) > 0),
  issue_id    TEXT NOT NULL CHECK (length(issue_id) > 0),
  mission_id  TEXT NOT NULL CHECK (length(mission_id) > 0),
  record      TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempt_summaries_issue ON attempt_summaries (issue_id, recorded_at);

CREATE TRIGGER IF NOT EXISTS attempt_summaries_append_only_update
BEFORE UPDATE ON attempt_summaries
BEGIN
  SELECT RAISE(ABORT, 'attempt summaries are append-only: UPDATE rejected');
END;

CREATE TRIGGER IF NOT EXISTS attempt_summaries_append_only_delete
BEFORE DELETE ON attempt_summaries
BEGIN
  SELECT RAISE(ABORT, 'attempt summaries are append-only: DELETE rejected');
END;

CREATE TRIGGER IF NOT EXISTS attempt_summaries_no_replace
BEFORE INSERT ON attempt_summaries
WHEN EXISTS (SELECT 1 FROM attempt_summaries WHERE attempt_id = NEW.attempt_id)
BEGIN
  SELECT RAISE(ABORT, 'attempt summaries are append-only: replacement rejected');
END;
`;

let expectedSummarySchema: Map<string, string> | null = null;
function expectedSchemaObjects(): Map<string, string> {
  if (expectedSummarySchema !== null) return expectedSummarySchema;
  const mem = new Database(":memory:");
  try {
    mem.exec(SCHEMA);
    const rows = mem
      .prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; sql: string | null }>;
    expectedSummarySchema = new Map(rows.map((r) => [r.name, r.sql ?? ""]));
    return expectedSummarySchema;
  } finally {
    mem.close();
  }
}

interface SummaryRow {
  attempt_id: string;
  issue_id: string;
  mission_id: string;
  record: string;
  recorded_at: string;
}

export interface AttemptSummaryStoreOptions {
  /** The daemon's held writer lock, or explicitly null for a test context. */
  readonly writerLock: { assertHeld(context: string): void } | null;
}

export class AttemptSummaryStore {
  readonly #db: Database.Database;
  readonly #writerLock: { assertHeld(context: string): void } | undefined;

  constructor(path: string, options: AttemptSummaryStoreOptions) {
    if (options === null || typeof options !== "object" || !("writerLock" in options)) {
      throw new TypeError(
        "AttemptSummaryStore requires a writerLock decision: pass the daemon's held writer lock, or explicitly null for a test context",
      );
    }
    const lock = options.writerLock;
    if (lock !== null && (typeof lock !== "object" || typeof lock.assertHeld !== "function")) {
      throw new TypeError(
        "writerLock must be the daemon's held writer lock ({ assertHeld }) or explicitly null",
      );
    }
    this.#writerLock = lock ?? undefined;
    this.#db = new Database(path);
    try {
      this.#db.pragma("journal_mode = WAL");
      const encoding = this.#db.pragma("encoding", { simple: true }) as string;
      if (encoding !== "UTF-8") {
        throw new Error(
          `attempt-summary store ${path} uses encoding ${encoding}; expected UTF-8 — refusing to open`,
        );
      }
      const version = this.#db.pragma("user_version", { simple: true }) as number;
      if (version === 0) {
        this.#db.exec(SCHEMA);
        this.#db.pragma(`user_version = ${SCHEMA_VERSION}`);
      } else if (version !== SCHEMA_VERSION) {
        throw new Error(
          `attempt-summary store ${path} has schema version ${version}; this daemon expects ${SCHEMA_VERSION}`,
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
          `attempt-summary store ${path} has ${actual.size} schema objects, expected ${expected.size} — ` +
            "refusing to open a tampered or foreign store",
        );
      }
      for (const [name, sql] of expected) {
        if (actual.get(name) !== sql) {
          throw new Error(
            `attempt-summary store ${path} schema object ${name} does not match this daemon's definition — ` +
              "refusing to open a tampered or foreign store",
          );
        }
      }
      const integrity = this.#db.pragma("integrity_check", { simple: true }) as string;
      if (integrity !== "ok") {
        throw new Error(
          `attempt-summary store ${path} fails integrity_check (${integrity}) — refusing to open`,
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
   * Record one summary. ONE observation discipline (the WP-110 insertContract
   * lesson): canonically serialize FIRST, validate the parsed snapshot, then
   * persist those exact bytes. Idempotent replay per attemptId; conflicting
   * content is refused.
   */
  record(summary: AttemptSummary): AttemptSummary {
    this.#writerLock?.assertHeld("attempt-summary append");
    const serialized = canonicalJson(summary);
    const snapshot = JSON.parse(serialized) as AttemptSummary;
    const problems = attemptSummaryProblems(snapshot);
    if (problems.length > 0) {
      throw new Error(`refusing to store an invalid attempt summary: ${problems.join("; ")}`);
    }
    const existing = this.#db
      .prepare("SELECT * FROM attempt_summaries WHERE attempt_id = ?")
      .get(snapshot.attemptId) as SummaryRow | undefined;
    if (existing !== undefined) {
      if (existing.record === serialized) {
        return JSON.parse(existing.record) as AttemptSummary;
      }
      throw new Error(
        `attempt ${snapshot.attemptId} already has a recorded summary with different content — ` +
          "refusing conflicting evidence",
      );
    }
    this.#db
      .prepare(
        `INSERT INTO attempt_summaries (attempt_id, issue_id, mission_id, record, recorded_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.attemptId,
        snapshot.issueId,
        snapshot.missionId,
        serialized,
        snapshot.recordedAt,
      );
    return snapshot;
  }

  /** Summaries for one issue, oldest first (validated on read). */
  forIssue(issueId: string): AttemptSummary[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM attempt_summaries WHERE issue_id = ? ORDER BY recorded_at, attempt_id",
      )
      .all(issueId) as SummaryRow[];
    return rows.map((row) => this.#validated(row));
  }

  /** The newest summary for an issue, or undefined. */
  latestForIssue(issueId: string): AttemptSummary | undefined {
    const rows = this.forIssue(issueId);
    return rows.at(-1);
  }

  get(attemptId: string): AttemptSummary | undefined {
    const row = this.#db
      .prepare("SELECT * FROM attempt_summaries WHERE attempt_id = ?")
      .get(attemptId) as SummaryRow | undefined;
    return row === undefined ? undefined : this.#validated(row);
  }

  /** Re-validate on every read (the WP-110 read posture): a store row that no longer validates is refused, not returned. */
  #validated(row: SummaryRow): AttemptSummary {
    const parsed = JSON.parse(row.record) as unknown;
    const problems = attemptSummaryProblems(parsed);
    if (problems.length > 0) {
      throw new Error(
        `attempt summary ${row.attempt_id} fails validation on read (${problems.join("; ")}) — ` +
          "refusing to serve corrupted evidence",
      );
    }
    return parsed as AttemptSummary;
  }
}
