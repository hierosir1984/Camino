/**
 * Append-only intent journal (WP-104, CAM-STATE-02/03): the durable record
 * of every external-operation intent, its pre-execution barrier, and its
 * resolution — the store the phrase "ambiguity is durably recorded" points
 * at.
 *
 * The shell mirrors the WP-101 event store deliberately, because the same
 * review pressure applies:
 *
 *  - Append-only enforced in the schema (BEFORE UPDATE / BEFORE DELETE
 *    triggers on every connection), not just by API shape.
 *  - Tamper-evident open: a database claiming this schema version whose
 *    table or triggers are missing refuses to start; the encoding is
 *    pinned to UTF-8 so the byte-level NUL CHECK holds (WP-103 lesson).
 *  - CAS append inside BEGIN IMMEDIATE: the highest-seq check and the
 *    insert are one atomic unit (in-process defense-in-depth; the durable
 *    cross-process guarantee is the writer lock this WP adds, asserted
 *    here before every append when wired).
 *  - Single-observation payloads: the caller's object is observed exactly
 *    once by JSON serialization; validation and persistence share that
 *    canonical form (WP-101 round-4 lesson).
 *  - Fail-closed adoption: opening a journal re-derives the entire log
 *    through core's `decideIntentAppend` (verifyIntentLog) and refuses a
 *    history the lifecycle disagrees with.
 *
 * Every lifecycle DECISION — event legality, closed payload schemas,
 * David-actor binding, status folding — lives in @camino/core
 * intent-lifecycle; this file is I/O. Unlike the transition recorder,
 * whose callers are the outside world and whose refusals are therefore
 * logged as rejected rows (CAM-STATE-05), the journal's writers are the
 * executor, recovery, and the David surface — all inside the daemon,
 * under the writer lock. An illegal journal append is a daemon bug, so it
 * THROWS loudly instead of writing a refusal row; the callers that
 * surface David's actions translate refusals for the GUI (later WPs).
 */
import Database from "better-sqlite3";
import { INTENT_EVENTS } from "@camino/shared";
import type { IntentEventName, IntentEventRecord } from "@camino/shared";
import {
  applyIntentRecord,
  decideIntentAppend,
  foldIntentView,
  verifyIntentLog,
} from "@camino/core";
import type { IntentAppendInput, IntentSnapshot, IntentView, IntentViewEntry } from "@camino/core";
import type { HeldWriterLock } from "./writer-lock.js";

const SCHEMA_VERSION = 1;

const EVENT_LIST_SQL = INTENT_EVENTS.map((event) => `'${event}'`).join(", ");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS intent_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id   TEXT NOT NULL CHECK (typeof(intent_id) = 'text' AND length(intent_id) > 0 AND instr(CAST(intent_id AS BLOB), x'00') = 0),
  event       TEXT NOT NULL CHECK (event IN (${EVENT_LIST_SQL})),
  actor       TEXT NOT NULL CHECK (typeof(actor) = 'text' AND length(actor) > 0 AND instr(CAST(actor AS BLOB), x'00') = 0),
  payload     TEXT NOT NULL CHECK (typeof(payload) = 'text'),
  recorded_at TEXT NOT NULL CHECK (typeof(recorded_at) = 'text' AND instr(CAST(recorded_at AS BLOB), x'00') = 0)
);

CREATE INDEX IF NOT EXISTS idx_intent_events_intent ON intent_events (intent_id, seq);

CREATE TRIGGER IF NOT EXISTS intent_events_append_only_update
BEFORE UPDATE ON intent_events
BEGIN
  SELECT RAISE(ABORT, 'intent journal is append-only (CAM-STATE-02): UPDATE rejected');
END;

CREATE TRIGGER IF NOT EXISTS intent_events_append_only_delete
BEFORE DELETE ON intent_events
BEGIN
  SELECT RAISE(ABORT, 'intent journal is append-only (CAM-STATE-02): DELETE rejected');
END;
`;

interface IntentEventRow {
  seq: number;
  intent_id: string;
  event: string;
  actor: string;
  payload: string;
  recorded_at: string;
}

export interface IntentJournalOptions {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  /**
   * The daemon's writer lock. When present, every append asserts it is
   * still held — in-process defense-in-depth beneath the kernel lock the
   * recovery composition acquires (CAM-STATE-03). Unit tests may open a
   * journal without it; the production path (recovery.ts) always wires it.
   */
  readonly writerLock?: HeldWriterLock;
}

export interface IntentReadFilter {
  readonly intentId?: string;
  readonly afterSeq?: number;
}

export class IntentJournal {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly writerLock: HeldWriterLock | undefined;
  private readonly insert: Database.Statement;
  private view: IntentView;
  private cachedLastSeq: number;

  constructor(path: string, options: IntentJournalOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.writerLock = options.writerLock;
    this.db = new Database(path);
    // EVERY refusal path below must close the native handle — a caller
    // retry-looping on a refused journal must not leak file descriptors
    // until GC gets around to it (review round 1, finding 10).
    try {
      this.db.pragma("journal_mode = WAL");
      const encoding = this.db.pragma("encoding", { simple: true }) as string;
      if (encoding !== "UTF-8") {
        throw new Error(
          `intent journal ${path} uses encoding ${encoding}; the byte-level NUL constraints ` +
            "assume UTF-8 — refusing to open (WP-103 precedent)",
        );
      }
      const version = this.db.pragma("user_version", { simple: true }) as number;
      if (version === 0) {
        this.db.exec(SCHEMA);
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      } else if (version !== SCHEMA_VERSION) {
        throw new Error(
          `intent journal ${path} has schema version ${version}; this daemon expects ${SCHEMA_VERSION}`,
        );
      } else {
        const objects = this.db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE (type = 'table' AND name = 'intent_events')
                OR (type = 'trigger' AND name IN ('intent_events_append_only_update', 'intent_events_append_only_delete'))`,
          )
          .all() as Array<{ name: string }>;
        const names = new Set(objects.map((o) => o.name));
        for (const required of [
          "intent_events",
          "intent_events_append_only_update",
          "intent_events_append_only_delete",
        ]) {
          if (!names.has(required)) {
            throw new Error(
              `intent journal ${path} claims schema version ${version} but is missing ${required} — ` +
                "refusing to open a possibly tampered or truncated journal",
            );
          }
        }
      }
      this.insert = this.db.prepare(
        `INSERT INTO intent_events (intent_id, event, actor, payload, recorded_at)
         VALUES (@intentId, @event, @actor, @payload, @recordedAt)`,
      );
      // Fail-closed adoption: refuse a journal whose history the lifecycle
      // decision path disagrees with (mirrors the recorder's replay-verified
      // recovery).
      const records = this.readAll();
      const divergences = verifyIntentLog(records);
      if (divergences.length > 0) {
        const detail = divergences
          .slice(0, 5)
          .map((d) => `seq ${d.seq}: ${d.problem}`)
          .join("; ");
        throw new Error(
          `intent journal fails lifecycle verification (${divergences.length} divergence(s)) — ` +
            `refusing to adopt it: ${detail}`,
        );
      }
      this.view = foldIntentView(records);
      this.cachedLastSeq = records.at(-1)?.seq ?? 0;
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  get lastSeq(): number {
    return this.cachedLastSeq;
  }

  /**
   * Append one intent event. Legality and payload shape are decided by
   * core's decideIntentAppend over the journal's own folded view; an
   * illegal append throws (daemon bug — see module header). The payload is
   * observed exactly once by JSON serialization; the parsed canonical form
   * is what gets validated, folded, and returned.
   *
   * The CAS is UNCONDITIONAL (review round 1, finding 11): every append
   * verifies the store's highest seq still equals this instance's own
   * view of it, atomically with the insert. There is no opt-out for any
   * caller — a second writer instance (or a raw write behind this one's
   * back) refuses instead of interleaving.
   */
  append(input: IntentAppendInput): IntentEventRecord {
    this.writerLock?.assertHeld("intent journal append");
    const intentId = input.intentId;
    const event = input.event;
    const actor = input.actor;
    if (this.db.inTransaction) {
      throw new Error(
        "intent journal append must not run inside an enclosing transaction: a rollback would " +
          "undo the row while callers already treated it as durable",
      );
    }
    let payloadJson: string;
    let canonicalPayload: Record<string, unknown>;
    try {
      payloadJson = JSON.stringify(input.payload);
      const parsed: unknown = JSON.parse(payloadJson);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError("payload must serialize to a plain JSON object");
      }
      canonicalPayload = parsed as Record<string, unknown>;
    } catch (error) {
      throw new TypeError(
        `intent event payload must be representable as a plain JSON object: ${(error as Error).message}`,
      );
    }
    const decision = decideIntentAppend(this.view, {
      intentId,
      event,
      actor,
      payload: canonicalPayload,
    });
    if (!decision.ok) {
      throw new Error(`illegal intent journal append: ${decision.problem}`);
    }
    const expectedLastSeq = this.cachedLastSeq;
    const recordedAt = this.now().toISOString();
    const runAppend = this.db.transaction((): number => {
      const lastSeq = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS last FROM intent_events")
        .get() as { last: number };
      if (lastSeq.last !== expectedLastSeq) {
        throw new Error(
          `intent journal advanced beyond the writer's view (seq ${lastSeq.last} != ${expectedLastSeq}): ` +
            "a second writer violated the single-writer contract (CAM-STATE-03)",
        );
      }
      const result = this.insert.run({
        intentId,
        event,
        actor,
        payload: payloadJson,
        recordedAt,
      });
      return Number(result.lastInsertRowid);
    });
    const seq = runAppend.immediate();
    const record: IntentEventRecord = {
      seq,
      intentId,
      event,
      actor,
      payload: canonicalPayload,
      recordedAt,
    };
    applyIntentRecord(this.view, record);
    this.cachedLastSeq = seq;
    return record;
  }

  /** All matching rows in ascending seq order. */
  read(filter: IntentReadFilter = {}): IntentEventRecord[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.intentId !== undefined) {
      clauses.push("intent_id = @intentId");
      params["intentId"] = filter.intentId;
    }
    if (filter.afterSeq !== undefined) {
      clauses.push("seq > @afterSeq");
      params["afterSeq"] = filter.afterSeq;
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM intent_events${where} ORDER BY seq ASC`)
      .all(params) as IntentEventRow[];
    return rows.map((row) => this.toRecord(row));
  }

  /** A snapshot copy of the folded view (mutating it cannot influence the journal). */
  currentView(): IntentView {
    return structuredClone(this.view);
  }

  /** The reconcile-facing snapshot of one intent, or undefined. */
  snapshot(intentId: string): IntentSnapshot | undefined {
    const entry = this.view.get(intentId);
    if (entry === undefined) return undefined;
    return { intentId: entry.intentId, status: entry.status, spec: structuredClone(entry.spec) };
  }

  /** Full view entry (status + result + ambiguity), snapshot copy. */
  entry(intentId: string): IntentViewEntry | undefined {
    const entry = this.view.get(intentId);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  /**
   * Every intent that is not terminal — recovery's worklist, in first-
   * recorded order: `recorded` (executable), `execution-started` (the
   * ambiguity window), `ambiguity-recorded` (escalation incomplete),
   * `escalated` (awaiting a human, reported not acted on).
   */
  nonTerminal(): IntentSnapshot[] {
    const out: IntentSnapshot[] = [];
    for (const entry of this.view.values()) {
      if (entry.status === "confirmed" || entry.status === "failed" || entry.status === "abandoned")
        continue;
      out.push({
        intentId: entry.intentId,
        status: entry.status,
        spec: structuredClone(entry.spec),
      });
    }
    return out;
  }

  close(): void {
    this.db.close();
  }

  private readAll(): IntentEventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM intent_events ORDER BY seq ASC")
      .all() as IntentEventRow[];
    return rows.map((row) => this.toRecord(row));
  }

  private toRecord(row: IntentEventRow): IntentEventRecord {
    // Canonical-form read (round 4 on round-3 finding 2): a raw writer
    // can persist JSON text whose parse differs from its re-serialized
    // form (literal -0 parses to -0 but stringifies to "0"). Reading
    // through a stringify/parse round-trip makes every observer — read(),
    // the fold, replay — see ONE canonical value, the same form append
    // produces (single-observation philosophy: canonical JSON is the
    // sole authority).
    const parsed: unknown = JSON.parse(row.payload);
    const canonical: unknown = JSON.parse(JSON.stringify(parsed));
    return {
      seq: row.seq,
      intentId: row.intent_id,
      event: row.event as IntentEventName,
      actor: row.actor,
      payload: canonical as IntentEventRecord["payload"],
      recordedAt: row.recorded_at,
    };
  }
}
