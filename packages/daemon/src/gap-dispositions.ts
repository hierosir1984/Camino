/**
 * Gap-disposition log, SQLite shell (WP-122, CAM-CANON-05 / CAM-CORE-04):
 * the durable, append-only record of David's register actions —
 * fix-queued / disputed / false-positive-waived / reopened — one row per
 * action, actor-bound to the user, with the same tamper-evident open and
 * append-only construction as the intent ledger (canon-ledger.ts).
 *
 * TAMPER-EVIDENT, NOT TAMPER-PROOF (round 1, finding 14; the WP-109
 * canon-ledger boundary, restated): "tamper-evident open" here means the
 * schema-object DEFINITIONS are pinned (a weakened CHECK or dropped trigger
 * is caught) and every row is re-run through shape verification at adoption,
 * and the append-only triggers reject UPDATE/DELETE. It does NOT mean the
 * row DATA is authenticated: an actor with direct write access to the SQLite
 * file who drops the triggers, edits a row that still passes shape
 * verification, and recreates identical triggers leaves no evidence — there
 * is no row hash-chain. That actor already owns the OS account the state
 * directory's 0700 permissions rest on (the WP-102 token-dir boundary); the
 * store defends against the accidental and the schema-level, not against the
 * account owner tampering with their own file.
 *
 * DECISION ASYMMETRY, stated (the WP-104 intent-journal rationale): the
 * store validates what the log ALONE can prove — shapes, actor binding,
 * closed vocabularies, monotone seqs — via `verifyGapDispositionLog` at
 * open and on every append. Whether a disposition is APPLICABLE (does a
 * live register row exist? is the row waivable?) is a cross-store
 * question over the intent ledger and canon facts; the composition layer
 * (register-service.ts) decides it with `decideGapDisposition` BEFORE
 * appending, and the projection re-judges applicability on every read
 * (basis binding), so a row whose basis no longer holds governs nothing.
 *
 * PROTOTYPE-POLLUTION BOUNDARY, named (round 3, findings 1/3/6). The
 * envelope and read filter here read OWN properties only, so a caller's
 * object cannot borrow fields from a polluted `Object.prototype`. But
 * `Object.prototype.toJSON` pollution (which `JSON.stringify` honors) and
 * every deeper nested read cannot ALL be closed by own-property checks —
 * and chasing them is unbounded. This is deliberate: polluting the
 * daemon's own global `Object.prototype` requires executing code INSIDE
 * the daemon process. That is not reachable from the remote surface —
 * `JSON.parse` of a request body does not mutate a prototype (a
 * `"__proto__"` key becomes an own property, not a prototype change) — so
 * it is the same single-OS-user in-process boundary the token dir
 * (WP-102) and the intent ledger's in-process-liar (CAM-CANON-01) rest
 * on: a party that can pollute the daemon's globals can equally call this
 * store directly, read the token, or replace the code. The own-property
 * reads are defense-in-depth against the accidental, not a security
 * boundary against an in-process attacker who has already won.
 */
import Database from "better-sqlite3";
import { GAP_DISPOSITION_EVENTS } from "@camino/shared";
import type {
  GapDispositionEventName,
  GapDispositionReadFilter,
  GapDispositionRecord,
} from "@camino/shared";
import { DAVID_ACTOR, recordedAtProblem, verifyGapDispositionLog } from "@camino/core";
import type { HeldWriterLock } from "./writer-lock.js";

const SCHEMA_VERSION = 1;

/** The largest sequence number JavaScript can represent exactly. */
const MAX_SAFE_SEQ = 9007199254740991;

const EVENT_LIST_SQL = GAP_DISPOSITION_EVENTS.map((event) => `'${event}'`).join(", ");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gap_dispositions (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT CHECK (seq BETWEEN 1 AND ${MAX_SAFE_SEQ}),
  requirement_id TEXT NOT NULL CHECK (typeof(requirement_id) = 'text' AND length(requirement_id) > 0 AND instr(CAST(requirement_id AS BLOB), x'00') = 0),
  event          TEXT NOT NULL CHECK (event IN (${EVENT_LIST_SQL})),
  actor          TEXT NOT NULL CHECK (actor = '${DAVID_ACTOR}'),
  payload        TEXT NOT NULL CHECK (typeof(payload) = 'text'),
  recorded_at    TEXT NOT NULL CHECK (typeof(recorded_at) = 'text' AND instr(CAST(recorded_at AS BLOB), x'00') = 0)
);

CREATE INDEX IF NOT EXISTS idx_gap_dispositions_requirement ON gap_dispositions (requirement_id, seq);

CREATE TRIGGER IF NOT EXISTS gap_dispositions_append_only_update
BEFORE UPDATE ON gap_dispositions
BEGIN
  SELECT RAISE(ABORT, 'gap-disposition log is append-only (CAM-CORE-04): UPDATE rejected');
END;

CREATE TRIGGER IF NOT EXISTS gap_dispositions_append_only_delete
BEFORE DELETE ON gap_dispositions
BEGIN
  SELECT RAISE(ABORT, 'gap-disposition log is append-only (CAM-CORE-04): DELETE rejected');
END;

CREATE TRIGGER IF NOT EXISTS gap_dispositions_append_order
BEFORE INSERT ON gap_dispositions
WHEN NEW.seq > 0 AND NEW.seq <= (SELECT COALESCE(MAX(seq), 0) FROM gap_dispositions)
BEGIN
  SELECT RAISE(ABORT, 'gap-disposition log is append-only (CAM-CORE-04): conflicting or out-of-order INSERT rejected');
END;
`;

interface DispositionRow {
  seq: number;
  requirement_id: string;
  event: string;
  actor: string;
  payload: string;
  recorded_at: string;
}

/**
 * Expected schema objects, computed once from SCHEMA in a throwaway
 * in-memory database: tamper-evident open compares DEFINITIONS, not names
 * (the canon-ledger precedent — a weakened CHECK or removed trigger shows
 * up as a text mismatch).
 */
let expectedDispositionSchema: Map<string, string> | null = null;
function expectedSchemaObjects(): Map<string, string> {
  if (expectedDispositionSchema !== null) return expectedDispositionSchema;
  const mem = new Database(":memory:");
  try {
    mem.exec(SCHEMA);
    const rows = mem
      .prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; sql: string | null }>;
    expectedDispositionSchema = new Map(rows.map((r) => [r.name, r.sql ?? ""]));
    return expectedDispositionSchema;
  } finally {
    mem.close();
  }
}

export interface GapDispositionsStoreOptions {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  /**
   * The daemon's writer lock; every append asserts it is still held. The
   * production path (recovery.ts) always wires it; unit tests may not.
   */
  readonly writerLock?: HeldWriterLock;
}

/** What the register service submits (actor is always the user, bound here). */
export interface GapDispositionWriteInput {
  readonly requirementId: string;
  readonly event: GapDispositionEventName;
  readonly payload: Readonly<Record<string, unknown>>;
}

export class GapDispositionsStore {
  readonly #db: Database.Database;
  readonly #now: () => Date;
  readonly #writerLock: HeldWriterLock | undefined;
  readonly #insert: Database.Statement;
  #cachedLastSeq: number;

  constructor(path: string, options: GapDispositionsStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#writerLock = options.writerLock;
    this.#db = new Database(path);
    // EVERY refusal path below must close the native handle (WP-104
    // round-1 finding 10; the PR #48 domain-store pattern).
    try {
      this.#db.pragma("journal_mode = WAL");
      const encoding = this.#db.pragma("encoding", { simple: true }) as string;
      if (encoding !== "UTF-8") {
        throw new Error(
          `gap-disposition log ${path} uses encoding ${encoding}; the byte-level NUL constraints ` +
            "assume UTF-8 — refusing to open (WP-103 precedent)",
        );
      }
      const version = this.#db.pragma("user_version", { simple: true }) as number;
      if (version === 0) {
        this.#db.exec(SCHEMA);
        this.#db.pragma(`user_version = ${SCHEMA_VERSION}`);
      } else if (version !== SCHEMA_VERSION) {
        throw new Error(
          `gap-disposition log ${path} has schema version ${version}; this daemon expects ${SCHEMA_VERSION}`,
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
          `gap-disposition log ${path} has ${actual.size} schema objects, expected ${expected.size} — ` +
            "refusing to open a tampered or foreign store",
        );
      }
      for (const [name, sql] of expected) {
        if (actual.get(name) !== sql) {
          throw new Error(
            `gap-disposition log ${path} schema object ${name} does not match this daemon's definition — ` +
              "refusing to open a tampered or foreign store",
          );
        }
      }
      // Unsafe-seq refusal (canon-ledger precedent): a file whose highest
      // seq exceeds Number.MAX_SAFE_INTEGER would alias distinct rows once
      // converted to JavaScript numbers.
      const maxSeqStmt = this.#db.prepare(
        "SELECT COALESCE(MAX(seq), 0) AS m FROM gap_dispositions",
      );
      maxSeqStmt.safeIntegers(true);
      const maxSeq = (maxSeqStmt.get() as { m: bigint }).m;
      if (maxSeq > BigInt(MAX_SAFE_SEQ)) {
        throw new Error(
          `gap-disposition log ${path} contains seq ${maxSeq} beyond JavaScript's safe-integer range — ` +
            "refusing to open (sequence numbers would alias)",
        );
      }
      this.#insert = this.#db.prepare(
        `INSERT INTO gap_dispositions (requirement_id, event, actor, payload, recorded_at)
         VALUES (@requirementId, @event, @actor, @payload, @recordedAt)`,
      );
      // Fail-closed adoption: refuse a log whose rows the shape hygiene
      // refuses (see the module header for what re-open can and cannot
      // re-verify).
      const records = this.#readAll();
      const divergences = verifyGapDispositionLog(records);
      if (divergences.length > 0) {
        const detail = divergences
          .slice(0, 5)
          .map((d) => `seq ${d.seq}: ${d.problem}`)
          .join("; ");
        throw new Error(
          `gap-disposition log fails shape verification (${divergences.length} divergence(s)) — ` +
            `refusing to adopt it: ${detail}`,
        );
      }
      this.#cachedLastSeq = records.at(-1)?.seq ?? 0;
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  get lastSeq(): number {
    return this.#cachedLastSeq;
  }

  /**
   * Append one already-decided disposition event. Callers must have run
   * `decideGapDisposition` against the current projection first
   * (register-service.ts is the production path); this method re-checks
   * shape hygiene and refuses anything the log verifier would refuse at
   * the next open — live writes and re-opens always agree.
   */
  append(input: GapDispositionWriteInput): GapDispositionRecord {
    this.#writerLock?.assertHeld("gap-disposition append");
    if (this.#db.inTransaction) {
      throw new Error(
        "gap-disposition append must not run inside an enclosing transaction: a rollback would " +
          "undo the row while callers already treated it as durable",
      );
    }
    // OWN-property reads only (round 2, finding 4): the envelope's fields must
    // be the caller's own, never inherited from a polluted Object.prototype —
    // an input that owns nothing must not borrow a requirementId/event/payload.
    if (input === null || typeof input !== "object") {
      throw new TypeError("gap-disposition input must be an object");
    }
    const requirementId = Object.hasOwn(input, "requirementId") ? input.requirementId : undefined;
    const event = Object.hasOwn(input, "event") ? input.event : undefined;
    const rawPayload = Object.hasOwn(input, "payload") ? input.payload : undefined;
    let payloadJson: string;
    let canonicalPayload: Record<string, unknown>;
    try {
      payloadJson = JSON.stringify(rawPayload);
      const parsed: unknown = JSON.parse(payloadJson);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError("payload must serialize to a plain JSON object");
      }
      canonicalPayload = parsed as Record<string, unknown>;
    } catch (error) {
      throw new TypeError(
        `gap-disposition payload must be representable as a plain JSON object: ${(error as Error).message}`,
      );
    }
    const expectedLastSeq = this.#cachedLastSeq;
    const recordedAt = this.#now().toISOString();
    // Validate the clock's output BEFORE persisting (canon-ledger
    // precedent: live-write/reopen agreement).
    const timeIssue = recordedAtProblem(recordedAt);
    if (timeIssue !== null) {
      throw new Error(`clock produced an unusable timestamp: ${timeIssue}`);
    }
    // One shape-hygiene path for writes and re-opens: verify the would-be
    // record exactly as the adoption pass would.
    const candidate: GapDispositionRecord = {
      seq: expectedLastSeq + 1,
      requirementId: requirementId as string,
      event: event as GapDispositionEventName,
      actor: DAVID_ACTOR,
      payload: canonicalPayload,
      recordedAt,
    };
    const divergences = verifyGapDispositionLog([candidate]);
    if (divergences.length > 0) {
      throw new Error(`illegal gap-disposition append: ${divergences[0]!.problem}`);
    }
    const runAppend = this.#db.transaction((): number => {
      const lastSeq = this.#db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS last FROM gap_dispositions")
        .get() as { last: number };
      if (lastSeq.last !== expectedLastSeq) {
        throw new Error(
          `gap-disposition log advanced beyond the writer's view (seq ${lastSeq.last} != ${expectedLastSeq}): ` +
            "a second writer violated the single-writer contract (CAM-STATE-03)",
        );
      }
      const result = this.#insert.run({
        requirementId: candidate.requirementId,
        event: candidate.event,
        actor: DAVID_ACTOR,
        payload: payloadJson,
        recordedAt,
      });
      return Number(result.lastInsertRowid);
    });
    const seq = runAppend.immediate();
    this.#cachedLastSeq = seq;
    return { ...candidate, seq };
  }

  /** All matching rows in ascending seq order. */
  read(filter: GapDispositionReadFilter = {}): GapDispositionRecord[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    // Own-property reads (round 3, finding 6): a polluted Object.prototype must
    // not smuggle a `requirementId`/`afterSeq` onto the default `{}` filter and
    // silently narrow a full-log read (which snapshot() relies on).
    const requirementId = Object.hasOwn(filter, "requirementId") ? filter.requirementId : undefined;
    const afterSeq = Object.hasOwn(filter, "afterSeq") ? filter.afterSeq : undefined;
    if (requirementId !== undefined) {
      clauses.push("requirement_id = @requirementId");
      params["requirementId"] = requirementId;
    }
    if (afterSeq !== undefined) {
      clauses.push("seq > @afterSeq");
      params["afterSeq"] = afterSeq;
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#db
      .prepare(`SELECT * FROM gap_dispositions${where} ORDER BY seq ASC`)
      .all(params) as DispositionRow[];
    return rows.map((row) => this.#toRecord(row));
  }

  close(): void {
    this.#db.close();
  }

  #readAll(): GapDispositionRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM gap_dispositions ORDER BY seq ASC")
      .all() as DispositionRow[];
    return rows.map((row) => this.#toRecord(row));
  }

  #toRecord(row: DispositionRow): GapDispositionRecord {
    // Canonical-form read (WP-104 precedent): every observer sees the
    // stringify/parse round-trip of the stored text.
    const parsed: unknown = JSON.parse(row.payload);
    const canonical: unknown = JSON.parse(JSON.stringify(parsed));
    return {
      seq: row.seq,
      requirementId: row.requirement_id,
      event: row.event as GapDispositionEventName,
      actor: row.actor,
      payload: canonical as GapDispositionRecord["payload"],
      recordedAt: row.recorded_at,
    };
  }
}
