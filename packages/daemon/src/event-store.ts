/**
 * Append-only SQLite event log (WP-101, CAM-STATE-01) implementing the
 * @camino/shared EventStore interface.
 *
 * Append-only is enforced in the schema itself, not just by API shape:
 * BEFORE UPDATE / BEFORE DELETE triggers abort any mutation of recorded
 * rows, so even future daemon code holding the same connection cannot
 * rewrite history. CHECK constraints pin the envelope invariants (applied
 * rows carry a target state, rejected rows carry a rejection code and no
 * target). `seq` is AUTOINCREMENT so append order is total and never
 * reused.
 */
import Database from "better-sqlite3";
import { ENTITY_KINDS } from "@camino/shared";
import type {
  EntityKind,
  EventFilter,
  EventInput,
  EventOutcome,
  EventRecord,
  EventStore,
  RejectionCode,
} from "@camino/shared";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_kind    TEXT    NOT NULL CHECK (entity_kind IN ('mission', 'issue', 'attempt')),
  entity_id      TEXT    NOT NULL CHECK (length(entity_id) > 0),
  event          TEXT    NOT NULL CHECK (length(event) > 0),
  actor          TEXT    NOT NULL CHECK (length(actor) > 0),
  cause          TEXT    NOT NULL CHECK (length(cause) > 0),
  payload        TEXT    NOT NULL,
  from_state     TEXT,
  to_state       TEXT,
  outcome        TEXT    NOT NULL CHECK (outcome IN ('applied', 'rejected')),
  rejection_code TEXT    CHECK (
                   rejection_code IN ('illegal-transition', 'guard-rejected', 'unknown-entity', 'already-exists')
                 ),
  recorded_at    TEXT    NOT NULL,
  -- Envelope invariants: applied rows land somewhere; rejected rows say why
  -- and change nothing.
  CHECK ((outcome = 'applied') = (to_state IS NOT NULL)),
  CHECK ((outcome = 'rejected') = (rejection_code IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_events_entity ON events (entity_kind, entity_id, seq);

CREATE TRIGGER IF NOT EXISTS events_append_only_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events log is append-only (CAM-STATE-01): UPDATE rejected');
END;

CREATE TRIGGER IF NOT EXISTS events_append_only_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events log is append-only (CAM-STATE-01): DELETE rejected');
END;
`;

interface EventRow {
  seq: number;
  entity_kind: string;
  entity_id: string;
  event: string;
  actor: string;
  cause: string;
  payload: string;
  from_state: string | null;
  to_state: string | null;
  outcome: string;
  rejection_code: string | null;
  recorded_at: string;
}

function validateInput(input: EventInput): void {
  if (!ENTITY_KINDS.includes(input.entityKind)) {
    throw new TypeError(`Unknown entityKind: ${JSON.stringify(input.entityKind)}`);
  }
  for (const field of ["entityId", "event", "actor", "cause"] as const) {
    const value = input[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`Event ${field} must be a non-empty string (CAM-STATE-01 envelope)`);
    }
  }
  if (input.payload === null || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw new TypeError("Event payload must be a plain object");
  }
  if ((input.outcome === "rejected") !== (input.rejectionCode !== undefined)) {
    throw new TypeError("rejectionCode must be present exactly when outcome is 'rejected'");
  }
  if ((input.outcome === "applied") !== (input.toState !== null)) {
    throw new TypeError("toState must be present exactly when outcome is 'applied'");
  }
}

export interface SqliteEventStoreOptions {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

export class SqliteEventStore implements EventStore {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly insert: Database.Statement;

  /**
   * @param path SQLite file path, or ":memory:" for tests. Production wiring
   * (`~/.camino/`) lands with the daemon shell (WP-102/103).
   */
  constructor(path: string, options: SqliteEventStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.db = new Database(path);
    // WAL for durable concurrent reads on file databases (PRD §6); SQLite
    // keeps ":memory:" databases on the "memory" journal, which is fine.
    this.db.pragma("journal_mode = WAL");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version === 0) {
      this.db.exec(SCHEMA);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    } else if (version !== SCHEMA_VERSION) {
      throw new Error(
        `events database ${path} has schema version ${version}; this daemon expects ${SCHEMA_VERSION}`,
      );
    } else {
      // Re-assert schema objects (idempotent) so a file with the right
      // version but missing triggers cannot silently accept mutation.
      this.db.exec(SCHEMA);
    }
    this.insert = this.db.prepare(
      `INSERT INTO events
         (entity_kind, entity_id, event, actor, cause, payload, from_state, to_state, outcome, rejection_code, recorded_at)
       VALUES
         (@entityKind, @entityId, @event, @actor, @cause, @payload, @fromState, @toState, @outcome, @rejectionCode, @recordedAt)`,
    );
  }

  append(input: EventInput): EventRecord {
    validateInput(input);
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(input.payload);
    } catch (error) {
      throw new TypeError(`Event payload must be JSON-serializable: ${(error as Error).message}`);
    }
    if (payloadJson === undefined) {
      throw new TypeError("Event payload must be JSON-serializable");
    }
    const recordedAt = this.now().toISOString();
    const result = this.insert.run({
      entityKind: input.entityKind,
      entityId: input.entityId,
      event: input.event,
      actor: input.actor,
      cause: input.cause,
      payload: payloadJson,
      fromState: input.fromState,
      toState: input.toState,
      outcome: input.outcome,
      rejectionCode: input.rejectionCode ?? null,
      recordedAt,
    });
    return {
      ...input,
      payload: JSON.parse(payloadJson) as EventRecord["payload"],
      seq: Number(result.lastInsertRowid),
      recordedAt,
    };
  }

  read(filter: EventFilter = {}): EventRecord[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.entityKind !== undefined) {
      clauses.push("entity_kind = @entityKind");
      params["entityKind"] = filter.entityKind;
    }
    if (filter.entityId !== undefined) {
      clauses.push("entity_id = @entityId");
      params["entityId"] = filter.entityId;
    }
    if (filter.afterSeq !== undefined) {
      clauses.push("seq > @afterSeq");
      params["afterSeq"] = filter.afterSeq;
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM events${where} ORDER BY seq ASC`)
      .all(params) as EventRow[];
    return rows.map((row) => this.toRecord(row));
  }

  close(): void {
    this.db.close();
  }

  private toRecord(row: EventRow): EventRecord {
    return {
      seq: row.seq,
      entityKind: row.entity_kind as EntityKind,
      entityId: row.entity_id,
      event: row.event,
      actor: row.actor,
      cause: row.cause,
      payload: JSON.parse(row.payload) as EventRecord["payload"],
      fromState: row.from_state,
      toState: row.to_state,
      outcome: row.outcome as EventOutcome,
      ...(row.rejection_code === null
        ? {}
        : { rejectionCode: row.rejection_code as RejectionCode }),
      recordedAt: row.recorded_at,
    };
  }
}
