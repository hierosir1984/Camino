/**
 * Durable canon-fact store (WP-109, CAM-CANON-03): the append-only record
 * of per-requirement OBSERVATIONS — merges, landings, mainline
 * inheritance, reverts, suspicions, verification verdicts — that the
 * status-tuple projection folds. Later WPs write here: the merge
 * machinery records landings and reverts, branch creation/sync records
 * `mainline-inherited` after verifying ancestry, the reconciler records
 * suspicions and rescans (CAM-CANON-06), the validation runner records
 * verdicts (invariant 7 bindings). This WP defines the seam, stores
 * facts durably, and projects them purely.
 *
 * DELIBERATELY A DIFFERENT FILE, SCHEMA, AND CLASS from the intent
 * ledger (canon-ledger.ts): facts carry what happened to code;
 * the ledger carries what the user asked for. The physical separation is
 * one leg of the CAM-CANON-01 construction — fact ingestion holds a
 * handle that cannot name the ledger's table, and the fact vocabulary
 * (CHECK-constrained here, closed in core) contains no intent event.
 * Fact validation is HYGIENE ONLY (closed shapes, SHA/branch/id
 * grammars): facts have no transition machine because they observe a
 * world Camino does not control; the projection is total over any
 * recorded sequence.
 *
 * Store discipline mirrors the hardened ledger shell (review round 1,
 * findings 1/8/9/12): append-only UPDATE/DELETE triggers PLUS the
 * conflicting/out-of-order INSERT guard closing the INSERT OR REPLACE
 * class; a seq ceiling CHECK and open-time BigInt probe keeping
 * sequence numbers in JavaScript's safe-integer range; tamper-evident
 * open comparing schema DEFINITIONS against a pristine in-memory
 * creation; fail-closed shape-verified adoption incl. recordedAt
 * validation; unconditional CAS; constructor cleanup on every refusal
 * path; canonical-form reads; writer-lock assertion per append when
 * wired.
 */
import Database from "better-sqlite3";
import { CANON_FACT_KINDS } from "@camino/shared";
import type {
  CanonFactInput,
  CanonFactKind,
  CanonFactReadFilter,
  CanonFactRecord,
} from "@camino/shared";
import { recordedAtProblem, validateCanonFact, verifyCanonFactLog } from "@camino/core";
import type { HeldWriterLock } from "./writer-lock.js";

const SCHEMA_VERSION = 1;

/** The largest sequence number JavaScript can represent exactly. */
const MAX_SAFE_SEQ = 9007199254740991;

const KIND_LIST_SQL = CANON_FACT_KINDS.map((kind) => `'${kind}'`).join(", ");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS canon_facts (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT CHECK (seq BETWEEN 1 AND ${MAX_SAFE_SEQ}),
  requirement_id TEXT NOT NULL CHECK (typeof(requirement_id) = 'text' AND length(requirement_id) > 0 AND instr(CAST(requirement_id AS BLOB), x'00') = 0),
  kind           TEXT NOT NULL CHECK (kind IN (${KIND_LIST_SQL})),
  actor          TEXT NOT NULL CHECK (typeof(actor) = 'text' AND length(actor) > 0 AND instr(CAST(actor AS BLOB), x'00') = 0),
  payload        TEXT NOT NULL CHECK (typeof(payload) = 'text'),
  recorded_at    TEXT NOT NULL CHECK (typeof(recorded_at) = 'text' AND instr(CAST(recorded_at AS BLOB), x'00') = 0)
);

CREATE INDEX IF NOT EXISTS idx_canon_facts_requirement ON canon_facts (requirement_id, seq);

CREATE TRIGGER IF NOT EXISTS canon_facts_append_only_update
BEFORE UPDATE ON canon_facts
BEGIN
  SELECT RAISE(ABORT, 'canon facts are append-only (CAM-CANON-03): UPDATE rejected');
END;

CREATE TRIGGER IF NOT EXISTS canon_facts_append_only_delete
BEFORE DELETE ON canon_facts
BEGIN
  SELECT RAISE(ABORT, 'canon facts are append-only (CAM-CANON-03): DELETE rejected');
END;

CREATE TRIGGER IF NOT EXISTS canon_facts_append_order
BEFORE INSERT ON canon_facts
WHEN NEW.seq > 0 AND NEW.seq <= (SELECT COALESCE(MAX(seq), 0) FROM canon_facts)
BEGIN
  SELECT RAISE(ABORT, 'canon facts are append-only (CAM-CANON-03): conflicting or out-of-order INSERT rejected');
END;
`;

interface FactRow {
  seq: number;
  requirement_id: string;
  kind: string;
  actor: string;
  payload: string;
  recorded_at: string;
}

/** Expected schema objects, produced by a pristine in-memory creation (see canon-ledger.ts). */
let expectedFactsSchema: Map<string, string> | null = null;
function expectedSchemaObjects(): Map<string, string> {
  if (expectedFactsSchema !== null) return expectedFactsSchema;
  const mem = new Database(":memory:");
  try {
    mem.exec(SCHEMA);
    const rows = mem
      .prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; sql: string | null }>;
    expectedFactsSchema = new Map(rows.map((r) => [r.name, r.sql ?? ""]));
    return expectedFactsSchema;
  } finally {
    mem.close();
  }
}

export interface CanonFactsStoreOptions {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  /** The daemon's writer lock; every append asserts it when wired (production path). */
  readonly writerLock?: HeldWriterLock;
}

export class CanonFactsStore {
  readonly #db: Database.Database;
  readonly #now: () => Date;
  readonly #writerLock: HeldWriterLock | undefined;
  readonly #insert: Database.Statement;
  #cachedLastSeq: number;

  constructor(path: string, options: CanonFactsStoreOptions = {}) {
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
          `canon-fact store ${path} uses encoding ${encoding}; the byte-level NUL constraints ` +
            "assume UTF-8 — refusing to open (WP-103 precedent)",
        );
      }
      const version = this.#db.pragma("user_version", { simple: true }) as number;
      if (version === 0) {
        this.#db.exec(SCHEMA);
        this.#db.pragma(`user_version = ${SCHEMA_VERSION}`);
      } else if (version !== SCHEMA_VERSION) {
        throw new Error(
          `canon-fact store ${path} has schema version ${version}; this daemon expects ${SCHEMA_VERSION}`,
        );
      }
      // Tamper-evident open, DEFINITIONS not names (review round 1, finding 9).
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
          `canon-fact store ${path} has ${actual.size} schema objects, expected ${expected.size} — ` +
            "refusing to open a tampered or foreign store",
        );
      }
      for (const [name, sql] of expected) {
        if (actual.get(name) !== sql) {
          throw new Error(
            `canon-fact store ${path} schema object ${name} does not match this daemon's definition — ` +
              "refusing to open a tampered or foreign store",
          );
        }
      }
      // Unsafe-seq refusal (review round 1, finding 8).
      const maxSeqStmt = this.#db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM canon_facts");
      maxSeqStmt.safeIntegers(true);
      const maxSeq = (maxSeqStmt.get() as { m: bigint }).m;
      if (maxSeq > BigInt(MAX_SAFE_SEQ)) {
        throw new Error(
          `canon-fact store ${path} contains seq ${maxSeq} beyond JavaScript's safe-integer range — ` +
            "refusing to open (sequence numbers would alias)",
        );
      }
      this.#insert = this.#db.prepare(
        `INSERT INTO canon_facts (requirement_id, kind, actor, payload, recorded_at)
         VALUES (@requirementId, @kind, @actor, @payload, @recordedAt)`,
      );
      // Fail-closed adoption: refuse a store whose rows the shape
      // validation refuses (verifyCanonFactLog also validates every
      // recordedAt — finding 12); a malformed fact would poison every
      // future projection fold.
      const records = this.#readAll();
      const divergences = verifyCanonFactLog(records);
      if (divergences.length > 0) {
        const detail = divergences
          .slice(0, 5)
          .map((d) => `seq ${d.seq}: ${d.problem}`)
          .join("; ");
        throw new Error(
          `canon-fact store fails shape verification (${divergences.length} divergence(s)) — ` +
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
   * Record one observation. The payload is observed exactly once by JSON
   * serialization; the canonical form is validated (core
   * validateCanonFact), persisted, and returned. Illegal facts THROW —
   * fact writers are daemon components under the writer lock, so a
   * malformed fact is a daemon bug (the intent-journal asymmetry
   * rationale, WP-104).
   */
  recordFact(input: CanonFactInput): CanonFactRecord {
    this.#writerLock?.assertHeld("canon fact append");
    if (this.#db.inTransaction) {
      throw new Error(
        "canon fact append must not run inside an enclosing transaction: a rollback would " +
          "undo the row while callers already treated it as durable",
      );
    }
    const requirementId = input.requirementId;
    const kind = input.kind;
    const actor = input.actor;
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
        `canon fact payload must be representable as a plain JSON object: ${(error as Error).message}`,
      );
    }
    const validation = validateCanonFact({
      requirementId,
      kind,
      actor,
      payload: canonicalPayload,
    });
    if (!validation.ok) {
      throw new Error(`illegal canon fact append: ${validation.problem}`);
    }
    const expectedLastSeq = this.#cachedLastSeq;
    const recordedAt = this.#now().toISOString();
    // The injectable clock is part of the public surface: validate its
    // output BEFORE persisting, so a misbehaving clock cannot write a row
    // this same store's adoption verification would refuse at restart
    // (review round 4, finding 3 — live-write/reopen agreement).
    const timeIssue = recordedAtProblem(recordedAt);
    if (timeIssue !== null) {
      throw new Error(`clock produced an unusable timestamp: ${timeIssue}`);
    }
    const runAppend = this.#db.transaction((): number => {
      const lastSeq = this.#db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS last FROM canon_facts")
        .get() as { last: number };
      if (lastSeq.last !== expectedLastSeq) {
        throw new Error(
          `canon-fact store advanced beyond the writer's view (seq ${lastSeq.last} != ${expectedLastSeq}): ` +
            "a second writer violated the single-writer contract (CAM-STATE-03)",
        );
      }
      const result = this.#insert.run({
        requirementId,
        kind,
        actor,
        payload: payloadJson,
        recordedAt,
      });
      return Number(result.lastInsertRowid);
    });
    const seq = runAppend.immediate();
    this.#cachedLastSeq = seq;
    return { seq, requirementId, kind, actor, payload: canonicalPayload, recordedAt };
  }

  /** All matching rows in ascending seq order. */
  read(filter: CanonFactReadFilter = {}): CanonFactRecord[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.requirementId !== undefined) {
      clauses.push("requirement_id = @requirementId");
      params["requirementId"] = filter.requirementId;
    }
    if (filter.afterSeq !== undefined) {
      clauses.push("seq > @afterSeq");
      params["afterSeq"] = filter.afterSeq;
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#db
      .prepare(`SELECT * FROM canon_facts${where} ORDER BY seq ASC`)
      .all(params) as FactRow[];
    return rows.map((row) => this.#toRecord(row));
  }

  close(): void {
    this.#db.close();
  }

  #readAll(): CanonFactRecord[] {
    const rows = this.#db.prepare("SELECT * FROM canon_facts ORDER BY seq ASC").all() as FactRow[];
    return rows.map((row) => this.#toRecord(row));
  }

  #toRecord(row: FactRow): CanonFactRecord {
    // Canonical-form read (WP-104 precedent).
    const parsed: unknown = JSON.parse(row.payload);
    const canonical: unknown = JSON.parse(JSON.stringify(parsed));
    return {
      seq: row.seq,
      requirementId: row.requirement_id,
      kind: row.kind as CanonFactKind,
      actor: row.actor,
      payload: canonical as CanonFactRecord["payload"],
      recordedAt: row.recorded_at,
    };
  }
}
