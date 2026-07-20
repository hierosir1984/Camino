/**
 * Durable intent ledger (WP-109, CAM-CANON-01): the SQLite shell of the
 * Living Canon's intent ledger. Every lifecycle DECISION — event
 * legality, closed payload schemas, user-actor binding, disposition
 * folding — lives in @camino/core canon-intent; this file is I/O.
 *
 * THE MUTATION SURFACE IS SIX NAMED USER-ACTION METHODS funneling into a
 * runtime-private (#) append: a caller cannot hand this store an event
 * name, and the private method is not reachable at runtime either
 * (review round 1, finding 2). The same refusals exist at the decision
 * layer (decideLedgerAppend) and in the schema itself — event-name CHECK
 * over the six user actions, actor CHECK pinned to 'david', an
 * append-order trigger closing the INSERT OR REPLACE class (REPLACE
 * resolves a key conflict by DELETING the conflicting row without firing
 * DELETE triggers unless the writer enabled recursive triggers — review
 * round 1 finding 1, the WP-103 r1-finding-1 class), and a seq ceiling
 * CHECK keeping every sequence number in JavaScript's safe-integer range
 * (finding 8). What the store cannot verify is CALLER INTENT — see
 * canon-intent.ts for the precise boundary statement.
 *
 * The shell mirrors the WP-101/WP-104 stores deliberately:
 *  - Append-only enforced by BEFORE UPDATE/DELETE triggers plus the
 *    conflicting/out-of-order INSERT guard, not API shape.
 *  - Tamper-evident open verifies schema DEFINITIONS, not just object
 *    names: the file's sqlite_master rows must equal those produced by
 *    executing this module's SCHEMA in a fresh in-memory database
 *    (review round 1, finding 9 — an inert same-named trigger is a
 *    tampered store).
 *  - UTF-8 pin so byte-level NUL CHECKs hold; unsafe-seq refusal at
 *    open (BigInt probe) and at insert (CHECK).
 *  - CAS append inside a transaction (in-process defense-in-depth under
 *    the WP-104 writer lock, asserted per append when wired).
 *  - Single-observation payloads: canonical JSON is the sole authority.
 *  - Fail-closed adoption: opening re-derives the entire log through
 *    core's verifyLedgerLog (which also validates every recordedAt) and
 *    refuses a history the lifecycle disagrees with.
 *  - Every constructor refusal path closes the native handle (WP-104
 *    review round 1 finding 10 / PR #48 pattern).
 *
 * TAMPER-EVIDENT, NOT TAMPER-PROOF — the boundary, named (WP-003/WP-104
 * precedent; review round 2, findings 4/5). These checks detect
 * accidental corruption, truncation, version drift, and inert-schema
 * substitution, and they refuse such a file at open. They do NOT defend
 * against a hostile process that already has WRITE ACCESS to the SQLite
 * file and uses raw SQLite internals — a rootpage/writable_schema swap
 * that leaves the (name, sql) rows intact while redirecting storage, or
 * detaching a trigger from a LIVE store's own connection. A process with
 * that access can rewrite any byte of any store and is the exact
 * single-OS-user adversary the state directory's 0700 mode (WP-102) and
 * the writer lock's stated scope (WP-104) already place OUT of contract;
 * no in-process integrity check can add to that boundary, and chasing
 * byte-level tamper-proofing here would be unwinnable. Restart re-runs
 * adoption verification and refuses a store whose visible schema drifted.
 *
 * Like the intent journal (and unlike the transition recorder), the
 * ledger's writers are inside the daemon — the surfaces that record
 * David's intake confirmations, dispute answers, and descope approvals.
 * An illegal append is a daemon bug and THROWS loudly; GUI surfaces
 * translate refusals for David (later WPs).
 */
import Database from "better-sqlite3";
import { LEDGER_EVENTS } from "@camino/shared";
import type { LedgerEventName, LedgerEventRecord, LedgerReadFilter } from "@camino/shared";
import {
  DAVID_ACTOR,
  applyLedgerRecord,
  decideLedgerAppend,
  foldLedgerView,
  recordedAtProblem,
  verifyLedgerLog,
} from "@camino/core";
import type { LedgerView, LedgerViewEntry } from "@camino/core";
import type { HeldWriterLock } from "./writer-lock.js";

const SCHEMA_VERSION = 1;

/** The largest sequence number JavaScript can represent exactly. */
const MAX_SAFE_SEQ = 9007199254740991;

const EVENT_LIST_SQL = LEDGER_EVENTS.map((event) => `'${event}'`).join(", ");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS canon_ledger (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT CHECK (seq BETWEEN 1 AND ${MAX_SAFE_SEQ}),
  requirement_id TEXT NOT NULL CHECK (typeof(requirement_id) = 'text' AND length(requirement_id) > 0 AND instr(CAST(requirement_id AS BLOB), x'00') = 0),
  event          TEXT NOT NULL CHECK (event IN (${EVENT_LIST_SQL})),
  actor          TEXT NOT NULL CHECK (actor = '${DAVID_ACTOR}'),
  payload        TEXT NOT NULL CHECK (typeof(payload) = 'text'),
  recorded_at    TEXT NOT NULL CHECK (typeof(recorded_at) = 'text' AND instr(CAST(recorded_at AS BLOB), x'00') = 0)
);

CREATE INDEX IF NOT EXISTS idx_canon_ledger_requirement ON canon_ledger (requirement_id, seq);

CREATE TRIGGER IF NOT EXISTS canon_ledger_append_only_update
BEFORE UPDATE ON canon_ledger
BEGIN
  SELECT RAISE(ABORT, 'intent ledger is append-only (CAM-CANON-01): UPDATE rejected');
END;

CREATE TRIGGER IF NOT EXISTS canon_ledger_append_only_delete
BEFORE DELETE ON canon_ledger
BEGIN
  SELECT RAISE(ABORT, 'intent ledger is append-only (CAM-CANON-01): DELETE rejected');
END;

CREATE TRIGGER IF NOT EXISTS canon_ledger_append_order
BEFORE INSERT ON canon_ledger
WHEN NEW.seq > 0 AND NEW.seq <= (SELECT COALESCE(MAX(seq), 0) FROM canon_ledger)
BEGIN
  SELECT RAISE(ABORT, 'intent ledger is append-only (CAM-CANON-01): conflicting or out-of-order INSERT rejected');
END;
`;

interface LedgerRow {
  seq: number;
  requirement_id: string;
  event: string;
  actor: string;
  payload: string;
  recorded_at: string;
}

/**
 * The schema objects a healthy store contains, as (name → creation SQL)
 * produced by executing SCHEMA in a pristine in-memory database. SQLite
 * normalizes the stored text the same way for the file and for memory,
 * so definition tampering — an inert same-named trigger, a dropped
 * CHECK, a removed index — shows up as a text mismatch.
 */
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

export interface CanonLedgerStoreOptions {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  /**
   * The daemon's writer lock; every append asserts it is still held. The
   * production path (recovery.ts) always wires it; unit tests may not.
   */
  readonly writerLock?: HeldWriterLock;
}

/** Payload DTOs for the six user actions (validated again in core). */
export interface ProposeRequirementInput {
  readonly statement: string;
  readonly sourceMissionId: string;
}
export interface DisputeRequirementInput {
  readonly reason: string;
  readonly conflictWith: string | null;
}
export interface ResolveDisputeAcceptedInput {
  readonly resolution: string;
  /** Present when the answer revised the intent text. */
  readonly statement?: string;
}
export interface ResolveDisputeAssumedInput {
  readonly assumption: string;
}
export interface DescopeRequirementInput {
  readonly reason: string;
}

export class CanonLedgerStore {
  readonly #db: Database.Database;
  readonly #now: () => Date;
  readonly #writerLock: HeldWriterLock | undefined;
  readonly #insert: Database.Statement;
  #view: LedgerView;
  #cachedLastSeq: number;

  constructor(path: string, options: CanonLedgerStoreOptions = {}) {
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
          `intent ledger ${path} uses encoding ${encoding}; the byte-level NUL constraints ` +
            "assume UTF-8 — refusing to open (WP-103 precedent)",
        );
      }
      const version = this.#db.pragma("user_version", { simple: true }) as number;
      if (version === 0) {
        this.#db.exec(SCHEMA);
        this.#db.pragma(`user_version = ${SCHEMA_VERSION}`);
      } else if (version !== SCHEMA_VERSION) {
        throw new Error(
          `intent ledger ${path} has schema version ${version}; this daemon expects ${SCHEMA_VERSION}`,
        );
      }
      // Tamper-evident open, DEFINITIONS not names (review round 1,
      // finding 9): the file's schema objects must equal the ones this
      // module's SCHEMA produces — on the fresh-create path too, which
      // is cheap and catches a raced writer.
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
          `intent ledger ${path} has ${actual.size} schema objects, expected ${expected.size} — ` +
            "refusing to open a tampered or foreign store",
        );
      }
      for (const [name, sql] of expected) {
        if (actual.get(name) !== sql) {
          throw new Error(
            `intent ledger ${path} schema object ${name} does not match this daemon's definition — ` +
              "refusing to open a tampered or foreign store",
          );
        }
      }
      // Unsafe-seq refusal (review round 1, finding 8): a file whose
      // highest seq exceeds Number.MAX_SAFE_INTEGER would alias distinct
      // rows once converted to JavaScript numbers.
      const maxSeqStmt = this.#db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM canon_ledger");
      maxSeqStmt.safeIntegers(true);
      const maxSeq = (maxSeqStmt.get() as { m: bigint }).m;
      if (maxSeq > BigInt(MAX_SAFE_SEQ)) {
        throw new Error(
          `intent ledger ${path} contains seq ${maxSeq} beyond JavaScript's safe-integer range — ` +
            "refusing to open (sequence numbers would alias)",
        );
      }
      this.#insert = this.#db.prepare(
        `INSERT INTO canon_ledger (requirement_id, event, actor, payload, recorded_at)
         VALUES (@requirementId, @event, @actor, @payload, @recordedAt)`,
      );
      // Fail-closed adoption: refuse a ledger whose history the intent
      // lifecycle disagrees with (verifyLedgerLog also validates every
      // recordedAt is a real toISOString instant — finding 12).
      const records = this.#readAll();
      const divergences = verifyLedgerLog(records);
      if (divergences.length > 0) {
        const detail = divergences
          .slice(0, 5)
          .map((d) => `seq ${d.seq}: ${d.problem}`)
          .join("; ");
        throw new Error(
          `intent ledger fails lifecycle verification (${divergences.length} divergence(s)) — ` +
            `refusing to adopt it: ${detail}`,
        );
      }
      this.#view = foldLedgerView(records);
      this.#cachedLastSeq = records.at(-1)?.seq ?? 0;
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  get lastSeq(): number {
    return this.#cachedLastSeq;
  }

  /** Intake surfaced a requirement from the user's PRD text (design invariant 6). */
  proposeRequirement(requirementId: string, input: ProposeRequirementInput): LedgerEventRecord {
    return this.#appendEvent(requirementId, "requirement-proposed", {
      statement: input.statement,
      sourceMissionId: input.sourceMissionId,
    });
  }

  /** Intake confirmation: the user confirmed the checklist item (CAM-PLAN-02). */
  acceptRequirement(requirementId: string): LedgerEventRecord {
    return this.#appendEvent(requirementId, "requirement-accepted", {});
  }

  /** Intake surfaced a contradiction; the user's answer is pending. */
  disputeRequirement(requirementId: string, input: DisputeRequirementInput): LedgerEventRecord {
    return this.#appendEvent(requirementId, "requirement-disputed", {
      reason: input.reason,
      conflictWith: input.conflictWith,
    });
  }

  /** Dispute answer: keep the requirement (optionally with revised text). */
  resolveDisputeAccepted(
    requirementId: string,
    input: ResolveDisputeAcceptedInput,
  ): LedgerEventRecord {
    const payload: Record<string, unknown> = { resolution: input.resolution };
    if (input.statement !== undefined) payload["statement"] = input.statement;
    return this.#appendEvent(requirementId, "dispute-resolved-accepted", payload);
  }

  /** Dispute answer: the user signed off a documented assumption (§3.1). */
  resolveDisputeAssumed(
    requirementId: string,
    input: ResolveDisputeAssumedInput,
  ): LedgerEventRecord {
    return this.#appendEvent(requirementId, "dispute-assumed", { assumption: input.assumption });
  }

  /** Descope approval: the user explicitly removed the requirement from intent. */
  descopeRequirement(requirementId: string, input: DescopeRequirementInput): LedgerEventRecord {
    return this.#appendEvent(requirementId, "requirement-descoped", { reason: input.reason });
  }

  /** All matching rows in ascending seq order. */
  read(filter: LedgerReadFilter = {}): LedgerEventRecord[] {
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
      .prepare(`SELECT * FROM canon_ledger${where} ORDER BY seq ASC`)
      .all(params) as LedgerRow[];
    return rows.map((row) => this.#toRecord(row));
  }

  /** A snapshot copy of the folded view (mutating it cannot influence the ledger). */
  currentView(): LedgerView {
    return structuredClone(this.#view);
  }

  /** One requirement's folded entry, snapshot copy. */
  entry(requirementId: string): LedgerViewEntry | undefined {
    const entry = this.#view.get(requirementId);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  close(): void {
    this.#db.close();
  }

  /**
   * The single write path all six methods funnel through — an
   * ECMAScript #private method, unreachable at runtime from outside the
   * class (review round 1, finding 2). The payload is observed exactly
   * once by JSON serialization; the parsed canonical form is validated,
   * persisted, folded, and returned. The CAS is unconditional (WP-104
   * precedent): every append verifies the store's highest seq still
   * equals this instance's view of it, atomically with the insert.
   */
  #appendEvent(
    requirementId: string,
    event: LedgerEventName,
    payload: Record<string, unknown>,
  ): LedgerEventRecord {
    this.#writerLock?.assertHeld("intent ledger append");
    if (this.#db.inTransaction) {
      throw new Error(
        "intent ledger append must not run inside an enclosing transaction: a rollback would " +
          "undo the row while callers already treated it as durable",
      );
    }
    let payloadJson: string;
    let canonicalPayload: Record<string, unknown>;
    try {
      payloadJson = JSON.stringify(payload);
      const parsed: unknown = JSON.parse(payloadJson);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError("payload must serialize to a plain JSON object");
      }
      canonicalPayload = parsed as Record<string, unknown>;
    } catch (error) {
      throw new TypeError(
        `ledger event payload must be representable as a plain JSON object: ${(error as Error).message}`,
      );
    }
    const decision = decideLedgerAppend(this.#view, {
      requirementId,
      event,
      actor: DAVID_ACTOR,
      payload: canonicalPayload,
    });
    if (!decision.ok) {
      throw new Error(`illegal intent ledger append: ${decision.problem}`);
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
        .prepare("SELECT COALESCE(MAX(seq), 0) AS last FROM canon_ledger")
        .get() as { last: number };
      if (lastSeq.last !== expectedLastSeq) {
        throw new Error(
          `intent ledger advanced beyond the writer's view (seq ${lastSeq.last} != ${expectedLastSeq}): ` +
            "a second writer violated the single-writer contract (CAM-STATE-03)",
        );
      }
      const result = this.#insert.run({
        requirementId,
        event,
        actor: DAVID_ACTOR,
        payload: payloadJson,
        recordedAt,
      });
      return Number(result.lastInsertRowid);
    });
    const seq = runAppend.immediate();
    const record: LedgerEventRecord = {
      seq,
      requirementId,
      event,
      actor: DAVID_ACTOR,
      payload: canonicalPayload,
      recordedAt,
    };
    applyLedgerRecord(this.#view, record);
    this.#cachedLastSeq = seq;
    return record;
  }

  #readAll(): LedgerEventRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM canon_ledger ORDER BY seq ASC")
      .all() as LedgerRow[];
    return rows.map((row) => this.#toRecord(row));
  }

  #toRecord(row: LedgerRow): LedgerEventRecord {
    // Canonical-form read (WP-104 precedent): every observer sees the
    // stringify/parse round-trip of the stored text, the same form
    // append produces — canonical JSON is the sole authority.
    const parsed: unknown = JSON.parse(row.payload);
    const canonical: unknown = JSON.parse(JSON.stringify(parsed));
    return {
      seq: row.seq,
      requirementId: row.requirement_id,
      event: row.event as LedgerEventName,
      actor: row.actor,
      payload: canonical as LedgerEventRecord["payload"],
      recordedAt: row.recorded_at,
    };
  }
}
