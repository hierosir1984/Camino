/**
 * Knowledge event store (WP-113, CAM-CANON-09): the durable, append-only
 * home of `.camino/knowledge.md`'s lifecycle — candidate entries with
 * provenance and commit/base validity land here IMMEDIATELY (nothing is
 * lost with a failed workspace), observation events accumulate the
 * rule-class evidence, and every promotion is validated against
 * @camino/core's fold BEFORE it is written and RE-VERIFIED at adoption.
 *
 * Mirrors the intent-ledger store's hardening posture exactly (WP-109
 * precedent): WAL, UTF-8 assertion, schema verification by DEFINITION not
 * name, append-only triggers, safe-seq refusal, unconditional CAS append
 * under the daemon writer lock, canonical-JSON payload observation, and
 * fail-closed adoption (a store whose history the fold refuses is never
 * silently repaired).
 *
 * Tamper-evident, not tamper-proof — the stated WP-109 boundary applies
 * unchanged: an attacker with write access to the SQLite file can rewrite
 * history; what they cannot do is have this daemon ADOPT a history the
 * lifecycle rules refuse.
 *
 * AUTHORITY BOUNDARY, stated (r1 finding 7): like the intent ledger's
 * DAVID_ACTOR, "david" here is a control-plane actor STRING, not a
 * cryptographic proof of a human act. The store enforces the RULES —
 * human-batch promotion and curation (reject/retire) require the david
 * actor, the two rule-classes require re-verified store evidence, and a
 * contradiction blocks promotion under every authority — but the
 * authenticity of a "david" append rests on the single-writer control plane
 * that holds this store, exactly as it does for every ledger. Binding a
 * human-batch to a verified approval receipt is the curation SURFACE's job
 * (the GUI approval flow, a later WP), not this store's, and is not claimed
 * here. Any code holding the store instance is already inside the trust
 * boundary; the guarantee is against a corrupted FILE, not against a
 * misbehaving in-process holder.
 */
import Database from "better-sqlite3";
import type {
  KnowledgeAppendInput,
  KnowledgeEntryInput,
  KnowledgeEventName,
  KnowledgeEventRecord,
  KnowledgePromotionAuthority,
  KnowledgeReadFilter,
} from "@camino/shared";
import {
  COMMAND_RULE_MIN_MISSIONS,
  COMMAND_RULE_MIN_SUCCESSES,
  KNOWLEDGE_EVENTS,
} from "@camino/shared";
import type {
  CommandObservationPayload,
  KnowledgeContradiction,
  KnowledgeReader,
  KnowledgeView,
  QuarantineConfirmationPayload,
  VisibleKnowledgeEntry,
} from "@camino/core";
import {
  DAVID_ACTOR,
  foldKnowledge,
  knowledgeAppendProblems,
  knowledgeCurationQueue,
  standingApprovedConflicts,
  visibleKnowledgeFor,
} from "@camino/core";
import type { HeldWriterLock } from "./writer-lock.js";

const SCHEMA_VERSION = 1;

/** The largest sequence number JavaScript can represent exactly. */
const MAX_SAFE_SEQ = 9007199254740991;

const EVENT_LIST_SQL = KNOWLEDGE_EVENTS.map((event) => `'${event}'`).join(", ");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT CHECK (seq BETWEEN 1 AND ${MAX_SAFE_SEQ}),
  event       TEXT NOT NULL CHECK (event IN (${EVENT_LIST_SQL})),
  actor       TEXT NOT NULL CHECK (typeof(actor) = 'text' AND length(actor) > 0 AND instr(CAST(actor AS BLOB), x'00') = 0),
  payload     TEXT NOT NULL CHECK (typeof(payload) = 'text'),
  recorded_at TEXT NOT NULL CHECK (typeof(recorded_at) = 'text' AND instr(CAST(recorded_at AS BLOB), x'00') = 0)
);

CREATE TRIGGER IF NOT EXISTS knowledge_events_append_only_update
BEFORE UPDATE ON knowledge_events
BEGIN
  SELECT RAISE(ABORT, 'knowledge store is append-only (CAM-CANON-09): UPDATE rejected');
END;

CREATE TRIGGER IF NOT EXISTS knowledge_events_append_only_delete
BEFORE DELETE ON knowledge_events
BEGIN
  SELECT RAISE(ABORT, 'knowledge store is append-only (CAM-CANON-09): DELETE rejected');
END;

CREATE TRIGGER IF NOT EXISTS knowledge_events_append_order
BEFORE INSERT ON knowledge_events
WHEN NEW.seq > 0 AND NEW.seq <= (SELECT COALESCE(MAX(seq), 0) FROM knowledge_events)
BEGIN
  SELECT RAISE(ABORT, 'knowledge store is append-only (CAM-CANON-09): conflicting or out-of-order INSERT rejected');
END;
`;

interface KnowledgeRow {
  seq: number;
  event: string;
  actor: string;
  payload: string;
  recorded_at: string;
}

/**
 * Expected schema objects, computed once from SCHEMA itself so drift —
 * an edited trigger, a loosened CHECK — shows up as a text mismatch.
 */
let expectedKnowledgeSchema: Map<string, string> | null = null;
function expectedSchemaObjects(): Map<string, string> {
  if (expectedKnowledgeSchema !== null) return expectedKnowledgeSchema;
  const mem = new Database(":memory:");
  try {
    mem.exec(SCHEMA);
    const rows = mem
      .prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; sql: string | null }>;
    expectedKnowledgeSchema = new Map(rows.map((r) => [r.name, r.sql ?? ""]));
    return expectedKnowledgeSchema;
  } finally {
    mem.close();
  }
}

export interface KnowledgeStoreOptions {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  /**
   * The daemon's writer lock; every append asserts it is still held. The
   * production path (recovery.ts) always wires it; unit tests may not.
   */
  readonly writerLock?: HeldWriterLock;
}

/** Recursively freeze a plain data value (r1 finding 2 — no shared mutable state). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export class KnowledgeStore {
  readonly #db: Database.Database;
  readonly #now: () => Date;
  readonly #writerLock: HeldWriterLock | undefined;
  readonly #insert: Database.Statement;
  #records: KnowledgeEventRecord[];
  #view: KnowledgeView;

  constructor(path: string, options: KnowledgeStoreOptions = {}) {
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
          `knowledge store ${path} uses encoding ${encoding}; the byte-level NUL constraints ` +
            "assume UTF-8 — refusing to open (WP-103 precedent)",
        );
      }
      const version = this.#db.pragma("user_version", { simple: true }) as number;
      if (version === 0) {
        this.#db.exec(SCHEMA);
        this.#db.pragma(`user_version = ${SCHEMA_VERSION}`);
      } else if (version !== SCHEMA_VERSION) {
        throw new Error(
          `knowledge store ${path} has schema version ${version}; this daemon expects ${SCHEMA_VERSION}`,
        );
      }
      // Tamper-evident open, DEFINITIONS not names (WP-109 precedent).
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
          `knowledge store ${path} has ${actual.size} schema objects, expected ${expected.size} — ` +
            "refusing to open a tampered or foreign store",
        );
      }
      for (const [name, sql] of expected) {
        if (actual.get(name) !== sql) {
          throw new Error(
            `knowledge store ${path} schema object ${name} does not match this daemon's definition — ` +
              "refusing to open a tampered or foreign store",
          );
        }
      }
      // Unsafe-seq refusal (WP-109 precedent): a seq beyond the safe range
      // would alias distinct rows once converted to JavaScript numbers.
      const maxSeqStmt = this.#db.prepare(
        "SELECT COALESCE(MAX(seq), 0) AS m FROM knowledge_events",
      );
      maxSeqStmt.safeIntegers(true);
      const maxSeq = (maxSeqStmt.get() as { m: bigint }).m;
      if (maxSeq > BigInt(MAX_SAFE_SEQ)) {
        throw new Error(
          `knowledge store ${path} contains seq ${maxSeq} beyond JavaScript's safe-integer range — ` +
            "refusing to open (sequence numbers would alias)",
        );
      }
      this.#insert = this.#db.prepare(
        `INSERT INTO knowledge_events (event, actor, payload, recorded_at)
         VALUES (@event, @actor, @payload, @recordedAt)`,
      );
      // Fail-closed adoption: the fold re-runs every row through the same
      // append gate live writes use; a history it refuses is never adopted.
      const records = this.#readAll();
      try {
        this.#view = foldKnowledge(records);
      } catch (error) {
        throw new Error(
          `knowledge store fails lifecycle verification — refusing to adopt it: ` +
            (error as Error).message,
        );
      }
      this.#records = records;
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  get lastSeq(): number {
    return this.#view.lastSeq;
  }

  /**
   * Record a candidate entry — the immediate write that survives a failed
   * workspace (CAM-CANON-09 "candidates immediate"). `actor` is the
   * recording control-plane component (the attempt identity lives in the
   * entry's provenance).
   */
  recordCandidate(entry: KnowledgeEntryInput, actor: string): KnowledgeEventRecord {
    return this.#append({ event: "candidate-recorded", actor, payload: { entry } });
  }

  /** One observed command execution (rule-class 1 evidence; WP-114 emits). */
  recordCommandObservation(
    observation: CommandObservationPayload,
    actor: string,
  ): KnowledgeEventRecord {
    return this.#append({
      event: "command-observation",
      actor,
      payload: { ...observation },
    });
  }

  /** A quarantine flakiness confirmation (rule-class 2 evidence; WP-108 emits). */
  recordQuarantineConfirmation(
    confirmation: QuarantineConfirmationPayload,
    actor: string,
  ): KnowledgeEventRecord {
    return this.#append({
      event: "quarantine-confirmation",
      actor,
      payload: { ...confirmation },
    });
  }

  /**
   * Promote a candidate. Eligibility (authority evidence, contradiction
   * guard, expiry) is enforced by the shared append gate; a human batch
   * must carry DAVID_ACTOR.
   */
  promoteEntry(
    entryId: string,
    authority: KnowledgePromotionAuthority,
    actor: string,
  ): KnowledgeEventRecord {
    return this.#append({ event: "entry-promoted", actor, payload: { entryId, authority } });
  }

  /** Curation resolves against a candidate (David's act). */
  rejectEntry(entryId: string, reason: string): KnowledgeEventRecord {
    return this.#append({
      event: "entry-rejected",
      actor: DAVID_ACTOR,
      payload: { entryId, reason },
    });
  }

  /** Curation retires an approved entry (contradiction resolution; David's act). */
  retireEntry(entryId: string, reason: string): KnowledgeEventRecord {
    return this.#append({
      event: "entry-retired",
      actor: DAVID_ACTOR,
      payload: { entryId, reason },
    });
  }

  /** A revert removed a validity base; matching entries invalidate at fold. */
  recordValidityBaseRevert(revertedSha: string, actor: string): KnowledgeEventRecord {
    return this.#append({
      event: "validity-base-reverted",
      actor,
      payload: { revertedSha },
    });
  }

  /**
   * The deterministic promotion sweep: promote every candidate whose
   * rule-class evidence is complete (CAM-CANON-09 registry item 6). Safe
   * to run unattended BECAUSE it is exactly the two rule-classes — a
   * contradiction-blocked, expired, or evidence-short candidate is
   * skipped, never judged. Returns the promotions performed, in order.
   */
  promoteEligibleByRules(actor: string): KnowledgeEventRecord[] {
    const promoted: KnowledgeEventRecord[] = [];
    const nowIso = this.#now().toISOString();
    // Snapshot the candidate list up front; each append refolds the view.
    const candidates = [...this.#view.entries.values()].filter(
      (snapshot) => snapshot.state === "candidate",
    );
    for (const snapshot of candidates) {
      const entry = snapshot.entry;
      if (standingApprovedConflicts(this.#view, entry, nowIso).length > 0) continue;
      if (entry.expiresAt <= nowIso) continue;
      let authority: KnowledgePromotionAuthority | null = null;
      if (entry.entryClass === "command" && entry.claim === "succeeds") {
        const tally = this.#view.commandTallies.get(entry.subjectKey as string);
        if (
          tally !== undefined &&
          tally.successes >= COMMAND_RULE_MIN_SUCCESSES &&
          tally.missionsWithSuccess.length >= COMMAND_RULE_MIN_MISSIONS
        ) {
          authority = { kind: "rule-command-success" };
        }
      } else if (entry.entryClass === "flaky-test" && entry.claim === "flaky") {
        if (this.#view.quarantineConfirmed.has(entry.subjectKey as string)) {
          authority = { kind: "rule-quarantine-flaky" };
        }
      }
      if (authority !== null) {
        promoted.push(this.promoteEntry(entry.entryId, authority, actor));
      }
    }
    return promoted;
  }

  /** All matching rows in ascending seq order. */
  read(filter: KnowledgeReadFilter = {}): KnowledgeEventRecord[] {
    if (filter.afterSeq === undefined) return this.#records.map((r) => structuredClone(r));
    return this.#records
      .filter((record) => record.seq > (filter.afterSeq as number))
      .map((r) => structuredClone(r));
  }

  /** A snapshot copy of the folded view (mutating it cannot influence the store). */
  currentView(): KnowledgeView {
    return structuredClone(this.#view);
  }

  /** The CAM-CANON-09 escalation surface: candidates contradicting approved entries. */
  curationQueue(): KnowledgeContradiction[] {
    return knowledgeCurationQueue(this.#view, this.#now().toISOString());
  }

  /** The entries one reading attempt may see (pack assembly's knowledge source). */
  visibleFor(reader: KnowledgeReader, nowIso: string): VisibleKnowledgeEntry[] {
    return structuredClone(visibleKnowledgeFor(this.#view, reader, nowIso));
  }

  close(): void {
    this.#db.close();
  }

  /**
   * The single write path — validation via the SAME core gate the fold
   * re-runs at adoption, canonical-JSON payload observation, unconditional
   * CAS append (WP-104 precedent), then a full refold so the live view and
   * a restart's view cannot diverge by construction.
   */
  #append(input: {
    event: KnowledgeEventName;
    actor: string;
    payload: Record<string, unknown>;
  }): KnowledgeEventRecord {
    this.#writerLock?.assertHeld("knowledge store append");
    if (this.#db.inTransaction) {
      throw new Error(
        "knowledge store append must not run inside an enclosing transaction: a rollback would " +
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
        `knowledge event payload must be representable as a plain JSON object: ${(error as Error).message}`,
      );
    }
    const recordedAt = this.#now().toISOString();
    const appendInput: KnowledgeAppendInput = {
      event: input.event,
      actor: input.actor,
      payload: canonicalPayload,
    };
    const problems = knowledgeAppendProblems(this.#view, appendInput, recordedAt);
    if (problems.length > 0) {
      throw new Error(`illegal knowledge append (${input.event}): ${problems.join("; ")}`);
    }
    const expectedLastSeq = this.#view.lastSeq;
    const runAppend = this.#db.transaction((): number => {
      const lastSeq = this.#db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS last FROM knowledge_events")
        .get() as { last: number };
      if (lastSeq.last !== expectedLastSeq) {
        throw new Error(
          `knowledge store advanced beyond the writer's view (seq ${lastSeq.last} != ${expectedLastSeq}): ` +
            "a second writer violated the single-writer contract (CAM-STATE-03)",
        );
      }
      const result = this.#insert.run({
        event: input.event,
        actor: input.actor,
        payload: payloadJson,
        recordedAt,
      });
      return Number(result.lastInsertRowid);
    });
    const seq = runAppend.immediate();
    // Deep-freeze before it is shared three ways (r1 finding 2): the returned
    // value, the retained `#records` row, and the folded view's entry are the
    // SAME object. Unfrozen, a caller mutating `record.payload.entry.text`
    // would silently change the live view while SQLite (and any restart)
    // still holds the original — breaking the live/restart equivalence the
    // fold-on-every-append is meant to guarantee. Frozen, the in-memory
    // record can never diverge from the persisted bytes.
    const record: KnowledgeEventRecord = deepFreeze({
      seq,
      event: input.event,
      actor: input.actor,
      payload: canonicalPayload,
      recordedAt,
    });
    this.#records.push(record);
    this.#view = foldKnowledge(this.#records);
    return record;
  }

  #readAll(): KnowledgeEventRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM knowledge_events ORDER BY seq ASC")
      .all() as KnowledgeRow[];
    return rows.map((row) => {
      // Canonical-form read (WP-104 precedent): every observer sees the
      // stringify/parse round-trip of the stored text.
      const parsed: unknown = JSON.parse(row.payload);
      const canonical: unknown = JSON.parse(JSON.stringify(parsed));
      return {
        seq: row.seq,
        event: row.event as KnowledgeEventName,
        actor: row.actor,
        payload: canonical as KnowledgeEventRecord["payload"],
        recordedAt: row.recorded_at,
      };
    });
  }
}
