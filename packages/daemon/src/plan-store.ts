/**
 * Plan store (WP-110): durable planning state — the construction stream,
 * David's acknowledgment/confirmation acts, approval acts, and the frozen
 * contract records (CAM-PLAN-01/-02/-04/-11).
 *
 * Every table is APPEND-ONLY (UPDATE/DELETE triggers abort), because each
 * row is either part of the planner's recorded construction stream or one
 * of David's recorded acts — neither is ever edited in place. Session
 * status is DERIVED from which rows exist (construction-complete record,
 * rejection, approval, completion), never stored as a mutable column, so
 * there is no second truth to drift.
 *
 * User-action tables CHECK-pin actor to 'david' (the canon-ledger
 * precedent): acknowledgments, confirmations, flag acknowledgments,
 * approvals, and rejections are user acts by definition.
 *
 * Contracts are immutable rows keyed (issue_id, version) with a UNIQUE
 * hash; insertContract persists a canonical snapshot (one observation — a
 * caller-side accessor or toJSON cannot make the validated value and the
 * persisted bytes differ, r1 finding 8), verifies the full shared
 * validator INCLUDING hash recomputation before writing, re-verifies with
 * index binding on every read and at adoption, and treats an identical
 * re-insert as the idempotent no-op the crash-resume path relies on.
 *
 * TAMPER-EVIDENCE BOUNDARY, stated plainly (r1 finding 13): the open
 * check proves the schema DEFINITIONS are this build's and every present
 * row validates — it is not a completeness proof. A raw writer that drops
 * a trigger, deletes history, and restores the identical trigger leaves
 * no schema evidence; row completeness is cross-checked against the event
 * log at resume (an approval-completion without its contracts, or a
 * recorded approval the gate refuses, fails loudly there), and the
 * durable single-writer guarantee is the WP-104 writer lock the
 * production composition holds — the same posture as every store in this
 * family.
 */
import Database from "better-sqlite3";
import {
  DAVID_ACTOR,
  dependencyGraphProblems,
  findDependencyCycle,
  formatCycle,
  templateProblems,
} from "@camino/core";
import {
  CanonicalJsonError,
  canonicalJson,
  contractProblems,
  clarificationResponseProblems,
  isRequirementId,
  planConstructionRecordProblems,
} from "@camino/shared";
import type {
  ChecklistRowDraft,
  ClarificationResponse,
  ClarifyingItemDraft,
  IssueContract,
  MissionTemplateName,
  PlanConstructionRecord,
  PlannedIssueDraft,
} from "@camino/shared";
import { MISSION_TEMPLATES, MISSION_TEMPLATE_NAMES } from "@camino/shared";
import type { HeldWriterLock } from "./writer-lock.js";

const SCHEMA_VERSION = 1;
const MAX_SAFE_SEQ = 9007199254740991;

const TEMPLATE_LIST_SQL = MISSION_TEMPLATE_NAMES.map((name) => `'${name}'`).join(", ");

/** Stream record kinds: the four shared construction kinds plus the review slot. */
export const PLAN_STREAM_KINDS = Object.freeze([
  "issue",
  "clarification",
  "checklist-row",
  "construction-complete",
  "review-attached",
] as const);
export type PlanStreamKind = (typeof PLAN_STREAM_KINDS)[number];

const STREAM_KIND_LIST_SQL = PLAN_STREAM_KINDS.map((kind) => `'${kind}'`).join(", ");

const NUL_FREE = (column: string): string =>
  `typeof(${column}) = 'text' AND length(${column}) > 0 AND instr(CAST(${column} AS BLOB), x'00') = 0`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plan_sessions (
  session_id  TEXT PRIMARY KEY CHECK (${NUL_FREE("session_id")}),
  mission_id  TEXT NOT NULL CHECK (${NUL_FREE("mission_id")}),
  template    TEXT NOT NULL CHECK (template IN (${TEMPLATE_LIST_SQL})),
  prd_sha256  TEXT NOT NULL CHECK (typeof(prd_sha256) = 'text' AND length(prd_sha256) = 64),
  created_at  TEXT NOT NULL CHECK (${NUL_FREE("created_at")})
);

CREATE INDEX IF NOT EXISTS idx_plan_sessions_mission ON plan_sessions (mission_id);

CREATE TABLE IF NOT EXISTS plan_stream (
  session_id  TEXT NOT NULL REFERENCES plan_sessions(session_id),
  seq         INTEGER NOT NULL CHECK (seq BETWEEN 1 AND ${MAX_SAFE_SEQ}),
  kind        TEXT NOT NULL CHECK (kind IN (${STREAM_KIND_LIST_SQL})),
  payload     TEXT NOT NULL CHECK (typeof(payload) = 'text'),
  recorded_at TEXT NOT NULL CHECK (${NUL_FREE("recorded_at")}),
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS plan_acknowledgments (
  session_id       TEXT NOT NULL REFERENCES plan_sessions(session_id),
  clarification_id TEXT NOT NULL CHECK (${NUL_FREE("clarification_id")}),
  response         TEXT NOT NULL CHECK (typeof(response) = 'text'),
  actor            TEXT NOT NULL CHECK (actor = '${DAVID_ACTOR}'),
  recorded_at      TEXT NOT NULL CHECK (${NUL_FREE("recorded_at")}),
  PRIMARY KEY (session_id, clarification_id)
);

CREATE TABLE IF NOT EXISTS plan_confirmations (
  session_id     TEXT NOT NULL REFERENCES plan_sessions(session_id),
  segment_id     TEXT NOT NULL CHECK (${NUL_FREE("segment_id")}),
  requirement_id TEXT NOT NULL CHECK (${NUL_FREE("requirement_id")}),
  statement      TEXT NOT NULL CHECK (${NUL_FREE("statement")}),
  actor          TEXT NOT NULL CHECK (actor = '${DAVID_ACTOR}'),
  recorded_at    TEXT NOT NULL CHECK (${NUL_FREE("recorded_at")}),
  PRIMARY KEY (session_id, segment_id),
  UNIQUE (session_id, requirement_id)
);

CREATE TABLE IF NOT EXISTS plan_flag_acknowledgments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id BETWEEN 1 AND ${MAX_SAFE_SEQ}),
  session_id          TEXT NOT NULL REFERENCES plan_sessions(session_id),
  flagged_segment_ids TEXT NOT NULL CHECK (typeof(flagged_segment_ids) = 'text'),
  actor               TEXT NOT NULL CHECK (actor = '${DAVID_ACTOR}'),
  recorded_at         TEXT NOT NULL CHECK (${NUL_FREE("recorded_at")})
);

CREATE TABLE IF NOT EXISTS plan_rejections (
  session_id  TEXT PRIMARY KEY REFERENCES plan_sessions(session_id),
  actor       TEXT NOT NULL CHECK (actor = '${DAVID_ACTOR}'),
  recorded_at TEXT NOT NULL CHECK (${NUL_FREE("recorded_at")})
);

CREATE TABLE IF NOT EXISTS plan_approvals (
  session_id  TEXT PRIMARY KEY REFERENCES plan_sessions(session_id),
  actor       TEXT NOT NULL CHECK (actor = '${DAVID_ACTOR}'),
  recorded_at TEXT NOT NULL CHECK (${NUL_FREE("recorded_at")})
);

CREATE TABLE IF NOT EXISTS plan_approval_completions (
  session_id  TEXT PRIMARY KEY REFERENCES plan_approvals(session_id),
  recorded_at TEXT NOT NULL CHECK (${NUL_FREE("recorded_at")})
);

CREATE TABLE IF NOT EXISTS contracts (
  issue_id      TEXT NOT NULL CHECK (${NUL_FREE("issue_id")}),
  version       INTEGER NOT NULL CHECK (version >= 1),
  contract_hash TEXT NOT NULL UNIQUE CHECK (typeof(contract_hash) = 'text' AND length(contract_hash) = 64),
  mission_id    TEXT NOT NULL CHECK (${NUL_FREE("mission_id")}),
  session_id    TEXT NOT NULL REFERENCES plan_sessions(session_id) CHECK (${NUL_FREE("session_id")}),
  record        TEXT NOT NULL CHECK (typeof(record) = 'text'),
  recorded_at   TEXT NOT NULL CHECK (${NUL_FREE("recorded_at")}),
  PRIMARY KEY (issue_id, version)
);

CREATE INDEX IF NOT EXISTS idx_contracts_mission ON contracts (mission_id);
`;

const APPEND_ONLY_TABLES = [
  "plan_sessions",
  "plan_stream",
  "plan_acknowledgments",
  "plan_confirmations",
  "plan_flag_acknowledgments",
  "plan_rejections",
  "plan_approvals",
  "plan_approval_completions",
  "contracts",
] as const;

const TRIGGERS = APPEND_ONLY_TABLES.map(
  (table) => `
CREATE TRIGGER IF NOT EXISTS ${table}_append_only_update
BEFORE UPDATE ON ${table}
BEGIN
  SELECT RAISE(ABORT, 'plan store table ${table} is append-only: UPDATE rejected');
END;

CREATE TRIGGER IF NOT EXISTS ${table}_append_only_delete
BEFORE DELETE ON ${table}
BEGIN
  SELECT RAISE(ABORT, 'plan store table ${table} is append-only: DELETE rejected');
END;
`,
).join("\n");

const FULL_SCHEMA = SCHEMA + TRIGGERS;

let expectedPlanSchema: Map<string, string> | null = null;
function expectedSchemaObjects(): Map<string, string> {
  if (expectedPlanSchema !== null) return expectedPlanSchema;
  const mem = new Database(":memory:");
  try {
    mem.exec(FULL_SCHEMA);
    const rows = mem
      .prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; sql: string | null }>;
    expectedPlanSchema = new Map(rows.map((r) => [r.name, r.sql ?? ""]));
    return expectedPlanSchema;
  } finally {
    mem.close();
  }
}

export interface PlanSessionRow {
  readonly sessionId: string;
  readonly missionId: string;
  readonly template: MissionTemplateName;
  readonly prdSha256: string;
  readonly createdAt: string;
}

export interface PlanStreamRecord {
  readonly seq: number;
  readonly kind: PlanStreamKind;
  /** Parsed payload: a PlanConstructionRecord for the four plan kinds, the artifact for review-attached. */
  readonly payload: Record<string, unknown>;
  readonly recordedAt: string;
}

interface ContractRowShape {
  issue_id: string;
  version: number;
  contract_hash: string;
  mission_id: string;
  record: string;
}

export interface ConfirmationRow {
  readonly segmentId: string;
  readonly requirementId: string;
  readonly statement: string;
  readonly recordedAt: string;
}

export interface UserActRow {
  readonly actor: string;
  readonly recordedAt: string;
}

export interface PlanStoreOptions {
  readonly now?: () => Date;
  readonly writerLock?: HeldWriterLock;
}

/**
 * Review artifact slot (CAM-PLAN-03 seam): WP-111's reviewer fills this
 * with the real cross-family critique; WP-110 requires its PRESENCE and,
 * on the quick-task route, the two reviewer facts A.1b's guards consume.
 * The full artifact schema is WP-111's to pin; this validator bounds shape
 * without inventing that schema.
 */
export function reviewArtifactProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["review artifact must be a plain object"];
  }
  const record = value as Record<string, unknown>;
  const problems: string[] = [];
  const reviewClass = record["reviewClass"];
  if (reviewClass !== "full-falsification" && reviewClass !== "mini-falsification") {
    problems.push(
      'review artifact reviewClass must be "full-falsification" or "mini-falsification"',
    );
  }
  if (typeof record["reviewer"] !== "string" || (record["reviewer"] as string).length === 0) {
    problems.push("review artifact must name its reviewer");
  }
  for (const flag of ["observabilityAdjudicated", "riskTierLow", "neutralConcurred"]) {
    if (flag in record && typeof record[flag] !== "boolean") {
      problems.push(`review artifact ${flag} must be a boolean when present`);
    }
  }
  try {
    if (JSON.stringify(record).length > 256 * 1024) {
      problems.push("review artifact exceeds the 256 KiB bound");
    }
  } catch {
    problems.push("review artifact must be JSON-serializable");
  }
  return problems;
}

export class PlanStore {
  readonly #db: Database.Database;
  readonly #now: () => Date;
  readonly #writerLock: HeldWriterLock | undefined;

  constructor(path: string, options: PlanStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#writerLock = options.writerLock;
    this.#db = new Database(path);
    // Every refusal path must close the native handle (WP-104 finding 10).
    try {
      this.#db.pragma("journal_mode = WAL");
      // SQLite leaves declared REFERENCES unenforced unless the pragma is
      // set per connection — without it an act row for a nonexistent
      // session would insert silently.
      this.#db.pragma("foreign_keys = ON");
      const encoding = this.#db.pragma("encoding", { simple: true }) as string;
      if (encoding !== "UTF-8") {
        throw new Error(
          `plan store ${path} uses encoding ${encoding}; refusing to open (WP-103 precedent)`,
        );
      }
      const version = this.#db.pragma("user_version", { simple: true }) as number;
      if (version === 0) {
        this.#db.exec(FULL_SCHEMA);
        this.#db.pragma(`user_version = ${SCHEMA_VERSION}`);
      } else if (version !== SCHEMA_VERSION) {
        throw new Error(
          `plan store ${path} has schema version ${version}; this daemon expects ${SCHEMA_VERSION}`,
        );
      }
      // Tamper-evident open by schema DEFINITIONS, not names (the canon-ledger
      // pattern) — on the fresh-create path too.
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
          `plan store ${path} has ${actual.size} schema objects, expected ${expected.size} — ` +
            "refusing to open a tampered or foreign store",
        );
      }
      for (const [name, sql] of expected) {
        if (actual.get(name) !== sql) {
          throw new Error(
            `plan store ${path} schema object ${name} does not match this daemon's definition — ` +
              "refusing to open a tampered or foreign store",
          );
        }
      }
      this.#verifyContents(path);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  /** Fail-closed adoption: refuse a store whose rows this build's validators reject. */
  #verifyContents(path: string): void {
    const streamRows = this.#db
      .prepare("SELECT session_id, seq, kind, payload FROM plan_stream ORDER BY session_id, seq")
      .all() as Array<{ session_id: string; seq: number; kind: string; payload: string }>;
    const perSession = new Map<
      string,
      {
        issueIds: Set<string>;
        clarificationIds: Set<string>;
        segments: Set<string>;
        complete: boolean;
      }
    >();
    for (const row of streamRows) {
      const context = `plan store ${path} stream row ${row.session_id}#${row.seq}`;
      const payload = this.#parseObject(row.payload, context);
      if (row.kind === "review-attached") {
        const problems = reviewArtifactProblems(payload);
        if (problems.length > 0) {
          throw new Error(
            `${context} fails validation — refusing to adopt: ${problems.join("; ")}`,
          );
        }
        continue;
      }
      const problems = planConstructionRecordProblems(payload);
      if (problems.length > 0) {
        throw new Error(`${context} fails validation — refusing to adopt: ${problems.join("; ")}`);
      }
      if (payload["kind"] !== row.kind) {
        throw new Error(`${context} kind column disagrees with its payload — refusing to adopt`);
      }
      // Cross-record coherence per session (the r1 finding-1 ingest-bypass
      // class): duplicates and post-completion records are refused at
      // adoption exactly as appendStream refuses them at write time.
      const session = perSession.get(row.session_id) ?? {
        issueIds: new Set<string>(),
        clarificationIds: new Set<string>(),
        segments: new Set<string>(),
        complete: false,
      };
      perSession.set(row.session_id, session);
      if (session.complete) {
        throw new Error(`${context} follows construction-complete — refusing to adopt`);
      }
      if (row.kind === "issue") {
        const id = (payload["issue"] as { planIssueId: string }).planIssueId;
        if (session.issueIds.has(id)) {
          throw new Error(`${context} duplicates issue ${id} — refusing to adopt`);
        }
        session.issueIds.add(id);
      } else if (row.kind === "clarification") {
        const id = (payload["clarification"] as { clarificationId: string }).clarificationId;
        if (session.clarificationIds.has(id)) {
          throw new Error(`${context} duplicates clarification ${id} — refusing to adopt`);
        }
        session.clarificationIds.add(id);
      } else if (row.kind === "checklist-row") {
        const id = (payload["row"] as { segmentId: string }).segmentId;
        if (session.segments.has(id)) {
          throw new Error(`${context} duplicates checklist segment ${id} — refusing to adopt`);
        }
        session.segments.add(id);
      } else if (row.kind === "construction-complete") {
        session.complete = true;
      }
    }
    const ackRows = this.#db
      .prepare("SELECT session_id, clarification_id, response FROM plan_acknowledgments")
      .all() as Array<{ session_id: string; clarification_id: string; response: string }>;
    for (const row of ackRows) {
      const response = this.#parseObject(
        row.response,
        `plan store ${path} acknowledgment ${row.session_id}/${row.clarification_id}`,
      );
      const problems = clarificationResponseProblems(response);
      if (problems.length > 0) {
        throw new Error(
          `plan store ${path} acknowledgment ${row.session_id}/${row.clarification_id} fails ` +
            `validation — refusing to adopt: ${problems.join("; ")}`,
        );
      }
    }
    // Confirmation and flag-acknowledgment rows validate at adoption too
    // (r2 finding 10): malformed ids or non-array flag payloads written by
    // a raw writer are refused, not adopted.
    const confirmationRows = this.#db
      .prepare("SELECT session_id, segment_id, requirement_id FROM plan_confirmations")
      .all() as Array<{ session_id: string; segment_id: string; requirement_id: string }>;
    for (const row of confirmationRows) {
      if (!isRequirementId(row.requirement_id)) {
        throw new Error(
          `plan store ${path} confirmation ${row.session_id}/${row.segment_id} holds a ` +
            `malformed requirement id — refusing to adopt`,
        );
      }
    }
    const flagRows = this.#db
      .prepare("SELECT session_id, id, flagged_segment_ids FROM plan_flag_acknowledgments")
      .all() as Array<{ session_id: string; id: number; flagged_segment_ids: string }>;
    for (const row of flagRows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.flagged_segment_ids);
      } catch {
        parsed = null;
      }
      if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== "string")) {
        throw new Error(
          `plan store ${path} flag acknowledgment ${row.session_id}#${row.id} is not a ` +
            `string array — refusing to adopt`,
        );
      }
    }
    const contractRows = this.#db
      .prepare(
        "SELECT issue_id, version, contract_hash, mission_id, session_id, record FROM contracts",
      )
      .all() as Array<{
      issue_id: string;
      version: number;
      contract_hash: string;
      mission_id: string;
      session_id: string;
      record: string;
    }>;
    for (const row of contractRows) {
      const record = this.#parseObject(
        row.record,
        `plan store ${path} contract ${row.issue_id} v${row.version}`,
      );
      const problems = contractProblems(record);
      if (problems.length > 0) {
        throw new Error(
          `plan store ${path} contract ${row.issue_id} v${row.version} fails validation — ` +
            `refusing to adopt: ${problems.join("; ")}`,
        );
      }
      const contract = record as unknown as IssueContract;
      if (
        contract.contractHash !== row.contract_hash ||
        contract.issueId !== row.issue_id ||
        contract.version !== row.version ||
        contract.missionId !== row.mission_id
      ) {
        throw new Error(
          `plan store ${path} contract ${row.issue_id} v${row.version} disagrees with its ` +
            "indexed columns — refusing to adopt a tampered store",
        );
      }
      // Session custody (r2 finding 10): the contract's session must exist
      // and belong to the contract's mission — a ghost or re-routed
      // session_id is refused (new writes are FK-enforced; this closes the
      // raw-writer path at adoption).
      const custodySession = this.#db
        .prepare("SELECT mission_id FROM plan_sessions WHERE session_id = ?")
        .get(row.session_id) as { mission_id: string } | undefined;
      if (custodySession === undefined || custodySession.mission_id !== row.mission_id) {
        throw new Error(
          `plan store ${path} contract ${row.issue_id} v${row.version} names session ` +
            `${row.session_id}, which does not exist under mission ${row.mission_id} — ` +
            "refusing to adopt",
        );
      }
    }
  }

  #parseObject(text: string, context: string): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${context} holds non-JSON payload — refusing to adopt`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${context} payload is not a plain object — refusing to adopt`);
    }
    return parsed as Record<string, unknown>;
  }

  #assertWritable(context: string): void {
    this.#writerLock?.assertHeld(context);
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  createSession(input: {
    sessionId: string;
    missionId: string;
    template: MissionTemplateName;
    prdSha256: string;
  }): PlanSessionRow {
    this.#assertWritable("plan store createSession");
    const createdAt = this.#now().toISOString();
    this.#db
      .prepare(
        `INSERT INTO plan_sessions (session_id, mission_id, template, prd_sha256, created_at)
         VALUES (@sessionId, @missionId, @template, @prdSha256, @createdAt)`,
      )
      .run({ ...input, createdAt });
    return { ...input, createdAt };
  }

  session(sessionId: string): PlanSessionRow | undefined {
    const row = this.#db
      .prepare("SELECT * FROM plan_sessions WHERE session_id = ?")
      .get(sessionId) as
      | {
          session_id: string;
          mission_id: string;
          template: string;
          prd_sha256: string;
          created_at: string;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      sessionId: row.session_id,
      missionId: row.mission_id,
      template: row.template as MissionTemplateName,
      prdSha256: row.prd_sha256,
      createdAt: row.created_at,
    };
  }

  sessionsForMission(missionId: string): PlanSessionRow[] {
    const rows = this.#db
      .prepare(
        "SELECT session_id FROM plan_sessions WHERE mission_id = ? ORDER BY created_at, session_id",
      )
      .all(missionId) as Array<{ session_id: string }>;
    return rows.map((r) => this.session(r.session_id) as PlanSessionRow);
  }

  /** Sessions that are neither rejected nor approval-completed. */
  openSessionsForMission(missionId: string): PlanSessionRow[] {
    return this.sessionsForMission(missionId).filter(
      (s) =>
        this.rejection(s.sessionId) === undefined &&
        this.approvalCompletion(s.sessionId) === undefined,
    );
  }

  // -------------------------------------------------------------------------
  // The construction stream
  // -------------------------------------------------------------------------

  /**
   * Append one stream record. The store enforces its OWN invariants
   * (r1 finding 1 — a first-party caller reaching past the service must
   * not be able to persist rows the service would refuse): the payload is
   * canonically snapshotted and validated against its kind, the session
   * must exist and be open (no rejection, no approval), and after
   * construction-complete only review-attached records may follow.
   * Cross-record semantics (duplicate ids, reference checks, template
   * bounds) remain the planning service's; both layers verify on open.
   */
  appendStream(
    sessionId: string,
    kind: PlanStreamKind,
    payload: PlanConstructionRecord | Record<string, unknown>,
  ): PlanStreamRecord {
    this.#assertWritable("plan store appendStream");
    if (this.session(sessionId) === undefined) {
      throw new Error(`plan session ${sessionId} does not exist`);
    }
    if (this.rejection(sessionId) !== undefined || this.approval(sessionId) !== undefined) {
      throw new Error(`plan session ${sessionId} is closed to stream appends`);
    }
    let serialized: string;
    try {
      serialized = canonicalJson(payload);
    } catch (error) {
      if (error instanceof CanonicalJsonError) {
        throw new Error(`stream payload has no canonical JSON form: ${error.message}`);
      }
      throw error;
    }
    // Single observation: validate the parsed snapshot, persist its bytes.
    const snapshot = JSON.parse(serialized) as Record<string, unknown>;
    if (kind === "review-attached") {
      const problems = reviewArtifactProblems(snapshot);
      if (problems.length > 0) {
        throw new Error(`review artifact refused: ${problems.join("; ")}`);
      }
      // Class binding (r2 finding 2): a full-route plan cannot carry a mini
      // review and vice versa — the template decides.
      const session = this.session(sessionId) as PlanSessionRow;
      const expected = MISSION_TEMPLATES[session.template].reviewClass;
      if (snapshot["reviewClass"] !== expected) {
        throw new Error(
          `review artifact class ${JSON.stringify(snapshot["reviewClass"])} does not match the ` +
            `${session.template} template's ${expected}`,
        );
      }
    } else {
      const problems = planConstructionRecordProblems(snapshot);
      if (problems.length > 0) {
        throw new Error(`construction record refused: ${problems.join("; ")}`);
      }
      if (snapshot["kind"] !== kind) {
        throw new Error(
          `stream kind ${kind} does not match the record's kind ${JSON.stringify(snapshot["kind"])}`,
        );
      }
    }
    const recordedAt = this.#now().toISOString();
    const insert = this.#db.transaction((): number => {
      if (kind !== "review-attached") {
        const complete = this.#db
          .prepare(
            "SELECT 1 FROM plan_stream WHERE session_id = ? AND kind = 'construction-complete' LIMIT 1",
          )
          .get(sessionId);
        if (complete !== undefined) {
          throw new Error(
            `plan session ${sessionId} construction is complete; only review-attached records may follow`,
          );
        }
      }
      const last = this.#db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS last FROM plan_stream WHERE session_id = ?")
        .get(sessionId) as { last: number };
      const seq = last.last + 1;
      this.#db
        .prepare(
          `INSERT INTO plan_stream (session_id, seq, kind, payload, recorded_at)
           VALUES (@sessionId, @seq, @kind, @payload, @recordedAt)`,
        )
        .run({ sessionId, seq, kind, payload: serialized, recordedAt });
      return seq;
    });
    const seq = insert.immediate();
    return { seq, kind, payload: snapshot, recordedAt };
  }

  /**
   * Read the stream, RE-VALIDATING every row (r2 finding 10): a row a raw
   * writer slipped past the triggers is refused at the read seam with its
   * position named, never served downstream.
   */
  streamRecords(sessionId: string): PlanStreamRecord[] {
    const rows = this.#db
      .prepare(
        "SELECT seq, kind, payload, recorded_at FROM plan_stream WHERE session_id = ? ORDER BY seq",
      )
      .all(sessionId) as Array<{ seq: number; kind: string; payload: string; recorded_at: string }>;
    return rows.map((row) => {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const problems =
        row.kind === "review-attached"
          ? reviewArtifactProblems(payload)
          : planConstructionRecordProblems(payload);
      if (problems.length > 0) {
        throw new Error(
          `stored stream row ${sessionId}#${row.seq} fails validation on read: ${problems.join("; ")}`,
        );
      }
      if (row.kind !== "review-attached" && payload["kind"] !== row.kind) {
        throw new Error(
          `stored stream row ${sessionId}#${row.seq} kind column disagrees with its payload`,
        );
      }
      return {
        seq: row.seq,
        kind: row.kind as PlanStreamKind,
        payload,
        recordedAt: row.recorded_at,
      };
    });
  }

  // -------------------------------------------------------------------------
  // David's acts
  //
  // The store enforces its OWN act invariants (r2 findings 1–2): acts bind
  // to stream entities that exist, statements bind to their checklist rows,
  // nothing lands after an approval or rejection act (so the state the
  // approval gate re-derives at resume is EXACTLY the state David approved
  // over), and the approval/completion markers require the derivable gate
  // conditions. The service performs the same checks with richer typed
  // refusals; both layers verify so a first-party caller reaching past the
  // service cannot persist rows the service would refuse.
  // -------------------------------------------------------------------------

  /** The stream-derived plan shape the act guards check against. */
  #streamStateFor(sessionId: string): {
    issues: PlannedIssueDraft[];
    clarifications: ClarifyingItemDraft[];
    checklist: ChecklistRowDraft[];
    constructionComplete: boolean;
    reviewArtifacts: Array<Record<string, unknown>>;
  } {
    const issues: PlannedIssueDraft[] = [];
    const clarifications: ClarifyingItemDraft[] = [];
    const checklist: ChecklistRowDraft[] = [];
    const reviewArtifacts: Array<Record<string, unknown>> = [];
    let constructionComplete = false;
    for (const record of this.streamRecords(sessionId)) {
      switch (record.kind) {
        case "issue":
          issues.push((record.payload as unknown as { issue: PlannedIssueDraft }).issue);
          break;
        case "clarification":
          clarifications.push(
            (record.payload as unknown as { clarification: ClarifyingItemDraft }).clarification,
          );
          break;
        case "checklist-row":
          checklist.push((record.payload as unknown as { row: ChecklistRowDraft }).row);
          break;
        case "construction-complete":
          constructionComplete = true;
          break;
        case "review-attached":
          reviewArtifacts.push(record.payload);
          break;
      }
    }
    return { issues, clarifications, checklist, constructionComplete, reviewArtifacts };
  }

  /** Acts are refused once an approval or rejection act closed the session. */
  #assertActsOpen(sessionId: string, act: string): void {
    if (this.session(sessionId) === undefined) {
      throw new Error(`plan session ${sessionId} does not exist`);
    }
    if (this.rejection(sessionId) !== undefined) {
      throw new Error(`plan session ${sessionId} is rejected; ${act} refused`);
    }
    if (this.approval(sessionId) !== undefined) {
      throw new Error(
        `plan session ${sessionId} has a recorded approval; ${act} refused — acts after ` +
          "approval would change the state the approval was granted over",
      );
    }
  }

  recordAcknowledgment(
    sessionId: string,
    clarificationId: string,
    response: ClarificationResponse,
    actor: string,
  ): void {
    this.#assertWritable("plan store recordAcknowledgment");
    this.#assertActsOpen(sessionId, "acknowledgment");
    const problems = clarificationResponseProblems(response);
    if (problems.length > 0) {
      throw new Error(`acknowledgment response refused: ${problems.join("; ")}`);
    }
    const state = this.#streamStateFor(sessionId);
    if (!state.clarifications.some((c) => c.clarificationId === clarificationId)) {
      throw new Error(`clarification ${clarificationId} does not exist in ${sessionId}`);
    }
    this.#db
      .prepare(
        `INSERT INTO plan_acknowledgments (session_id, clarification_id, response, actor, recorded_at)
         VALUES (@sessionId, @clarificationId, @response, @actor, @recordedAt)`,
      )
      .run({
        sessionId,
        clarificationId,
        response: JSON.stringify(response),
        actor,
        recordedAt: this.#now().toISOString(),
      });
  }

  acknowledgments(sessionId: string): Map<string, ClarificationResponse> {
    const rows = this.#db
      .prepare("SELECT clarification_id, response FROM plan_acknowledgments WHERE session_id = ?")
      .all(sessionId) as Array<{ clarification_id: string; response: string }>;
    return new Map(
      rows.map((row) => {
        const response = JSON.parse(row.response) as ClarificationResponse;
        const problems = clarificationResponseProblems(response);
        if (problems.length > 0) {
          throw new Error(
            `stored acknowledgment ${sessionId}/${row.clarification_id} fails validation on ` +
              `read: ${problems.join("; ")}`,
          );
        }
        return [row.clarification_id, response];
      }),
    );
  }

  recordConfirmation(
    sessionId: string,
    confirmation: { segmentId: string; requirementId: string; statement: string },
    actor: string,
  ): void {
    this.#assertWritable("plan store recordConfirmation");
    this.#assertActsOpen(sessionId, "confirmation");
    if (!isRequirementId(confirmation.requirementId)) {
      throw new Error(
        `confirmation requirement id ${JSON.stringify(confirmation.requirementId)} is not CAM-AREA-NN`,
      );
    }
    // Statement binding (r2 finding 2): a confirmation confirms EXACTLY the
    // proposed statement of its mapped checklist row — a forged statement
    // never becomes accepted intent through this seam.
    const state = this.#streamStateFor(sessionId);
    const row = state.checklist.find((r) => r.segmentId === confirmation.segmentId);
    if (row === undefined) {
      throw new Error(`segment ${confirmation.segmentId} has no checklist row in ${sessionId}`);
    }
    if (row.disposition !== "mapped") {
      throw new Error(
        `segment ${confirmation.segmentId} is flagged unmapped; confirmation refused`,
      );
    }
    if (row.proposedStatement !== confirmation.statement) {
      throw new Error(
        `confirmation statement does not match the checklist row's proposed statement for ` +
          `${confirmation.segmentId} — refusing to bind foreign text to accepted intent`,
      );
    }
    this.#db
      .prepare(
        `INSERT INTO plan_confirmations (session_id, segment_id, requirement_id, statement, actor, recorded_at)
         VALUES (@sessionId, @segmentId, @requirementId, @statement, @actor, @recordedAt)`,
      )
      .run({
        sessionId,
        ...confirmation,
        actor,
        recordedAt: this.#now().toISOString(),
      });
  }

  confirmations(sessionId: string): ConfirmationRow[] {
    const rows = this.#db
      .prepare(
        "SELECT segment_id, requirement_id, statement, recorded_at FROM plan_confirmations WHERE session_id = ? ORDER BY recorded_at, segment_id",
      )
      .all(sessionId) as Array<{
      segment_id: string;
      requirement_id: string;
      statement: string;
      recorded_at: string;
    }>;
    return rows.map((row) => ({
      segmentId: row.segment_id,
      requirementId: row.requirement_id,
      statement: row.statement,
      recordedAt: row.recorded_at,
    }));
  }

  allConfirmations(): Array<ConfirmationRow & { sessionId: string }> {
    const rows = this.#db
      .prepare(
        "SELECT session_id, segment_id, requirement_id, statement, recorded_at FROM plan_confirmations ORDER BY recorded_at, session_id, segment_id",
      )
      .all() as Array<{
      session_id: string;
      segment_id: string;
      requirement_id: string;
      statement: string;
      recorded_at: string;
    }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      segmentId: row.segment_id,
      requirementId: row.requirement_id,
      statement: row.statement,
      recordedAt: row.recorded_at,
    }));
  }

  recordFlagAcknowledgment(
    sessionId: string,
    flaggedSegmentIds: readonly string[],
    actor: string,
  ): void {
    this.#assertWritable("plan store recordFlagAcknowledgment");
    this.#assertActsOpen(sessionId, "flag acknowledgment");
    const state = this.#streamStateFor(sessionId);
    const flagged = state.checklist
      .filter((r) => r.disposition === "unmapped")
      .map((r) => r.segmentId)
      .sort();
    const named = [...flaggedSegmentIds].sort();
    if (JSON.stringify(named) !== JSON.stringify(flagged)) {
      throw new Error(
        `flag acknowledgment must name the current unmapped set exactly [${flagged.join(", ")}]`,
      );
    }
    this.#db
      .prepare(
        `INSERT INTO plan_flag_acknowledgments (session_id, flagged_segment_ids, actor, recorded_at)
         VALUES (@sessionId, @flaggedSegmentIds, @actor, @recordedAt)`,
      )
      .run({
        sessionId,
        flaggedSegmentIds: JSON.stringify(named),
        actor,
        recordedAt: this.#now().toISOString(),
      });
  }

  /** The most recent flagged-rows acknowledgment, or null. */
  latestFlagAcknowledgment(sessionId: string): { segmentIds: string[]; recordedAt: string } | null {
    const row = this.#db
      .prepare(
        "SELECT flagged_segment_ids, recorded_at FROM plan_flag_acknowledgments WHERE session_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(sessionId) as { flagged_segment_ids: string; recorded_at: string } | undefined;
    if (row === undefined) return null;
    return {
      segmentIds: JSON.parse(row.flagged_segment_ids) as string[],
      recordedAt: row.recorded_at,
    };
  }

  /**
   * Deterministic conflict resolution (r2 finding 5): a rejection cannot
   * land once an approval act exists — a granted approval completes (or is
   * refused loudly at resume); it is never raced by a rejection into
   * irreconcilable state.
   */
  recordRejection(sessionId: string, actor: string): void {
    this.#assertWritable("plan store recordRejection");
    this.#assertActsOpen(sessionId, "rejection");
    this.#db
      .prepare("INSERT INTO plan_rejections (session_id, actor, recorded_at) VALUES (?, ?, ?)")
      .run(sessionId, actor, this.#now().toISOString());
  }

  rejection(sessionId: string): UserActRow | undefined {
    const row = this.#db
      .prepare("SELECT actor, recorded_at FROM plan_rejections WHERE session_id = ?")
      .get(sessionId) as { actor: string; recorded_at: string } | undefined;
    return row === undefined ? undefined : { actor: row.actor, recordedAt: row.recorded_at };
  }

  /**
   * The approval act requires every gate condition DERIVABLE from this
   * store's own rows (r2 finding 1): construction complete, a review
   * artifact of the template's class (with true reviewer facts on the
   * quick-task route), every clarification acknowledged, every mapped row
   * confirmed, the flagged set acknowledged, the dependency graph sound
   * and acyclic, and the template bounds met. Checklist TOTALITY is the
   * one gate condition this store cannot derive (segments come from the
   * mission's PRD content, which lives in the domain store) — the
   * service's pure gate covers it, and the resume path re-runs that gate
   * before completing any approval.
   */
  recordApproval(sessionId: string, actor: string): void {
    this.#assertWritable("plan store recordApproval");
    this.#assertActsOpen(sessionId, "approval");
    const session = this.session(sessionId) as PlanSessionRow;
    const state = this.#streamStateFor(sessionId);
    const problems: string[] = [];
    if (!state.constructionComplete) problems.push("construction is not complete");
    const template = MISSION_TEMPLATES[session.template];
    const artifact = state.reviewArtifacts.at(-1);
    if (artifact === undefined) {
      problems.push("no review artifact is attached");
    } else if (session.template === "quick-task") {
      for (const fact of ["riskTierLow", "neutralConcurred", "observabilityAdjudicated"]) {
        if (artifact[fact] !== true) problems.push(`quick-task review fact ${fact} is not true`);
      }
    }
    problems.push(...templateProblems(template, state.issues));
    problems.push(...dependencyGraphProblems(state.issues));
    const cycle = findDependencyCycle(state.issues);
    if (cycle !== null) problems.push(`dependency cycle ${formatCycle(cycle)}`);
    const acknowledged = this.acknowledgments(sessionId);
    for (const clarification of state.clarifications) {
      if (!acknowledged.has(clarification.clarificationId)) {
        problems.push(`clarification ${clarification.clarificationId} is unacknowledged`);
      }
    }
    const confirmed = new Set(this.confirmations(sessionId).map((c) => c.segmentId));
    const flagged: string[] = [];
    for (const row of state.checklist) {
      if (row.disposition === "mapped") {
        if (!confirmed.has(row.segmentId))
          problems.push(`mapped row ${row.segmentId} is unconfirmed`);
      } else {
        flagged.push(row.segmentId);
      }
    }
    if (flagged.length > 0) {
      const latest = this.latestFlagAcknowledgment(sessionId);
      if (
        latest === null ||
        JSON.stringify([...latest.segmentIds].sort()) !== JSON.stringify(flagged.sort())
      ) {
        problems.push(`flagged rows [${flagged.join(", ")}] are unacknowledged`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`approval act refused: ${problems.join("; ")}`);
    }
    this.#db
      .prepare("INSERT INTO plan_approvals (session_id, actor, recorded_at) VALUES (?, ?, ?)")
      .run(sessionId, actor, this.#now().toISOString());
  }

  approval(sessionId: string): UserActRow | undefined {
    const row = this.#db
      .prepare("SELECT actor, recorded_at FROM plan_approvals WHERE session_id = ?")
      .get(sessionId) as { actor: string; recorded_at: string } | undefined;
    return row === undefined ? undefined : { actor: row.actor, recordedAt: row.recorded_at };
  }

  /**
   * The completion marker requires its substance (r2 findings 1 and 3): an
   * approval act (also FK-enforced) and one stored contract per streamed
   * issue, under the session's mission. A bare marker cannot make a plan
   * read as approved.
   */
  recordApprovalCompletion(sessionId: string): void {
    this.#assertWritable("plan store recordApprovalCompletion");
    if (this.approval(sessionId) === undefined) {
      throw new Error(`plan session ${sessionId} has no approval act; completion refused`);
    }
    const session = this.session(sessionId) as PlanSessionRow;
    const state = this.#streamStateFor(sessionId);
    const missing = state.issues
      .map((issue) => `${session.missionId}.${issue.planIssueId}`)
      .filter((issueId) => this.latestContract(issueId) === undefined);
    if (missing.length > 0) {
      throw new Error(
        `plan session ${sessionId} completion refused: no contract stored for ` +
          `[${missing.join(", ")}]`,
      );
    }
    this.#db
      .prepare("INSERT INTO plan_approval_completions (session_id, recorded_at) VALUES (?, ?)")
      .run(sessionId, this.#now().toISOString());
  }

  approvalCompletion(sessionId: string): { recordedAt: string } | undefined {
    const row = this.#db
      .prepare("SELECT recorded_at FROM plan_approval_completions WHERE session_id = ?")
      .get(sessionId) as { recorded_at: string } | undefined;
    return row === undefined ? undefined : { recordedAt: row.recorded_at };
  }

  /** Completed approvals — the resume reconciliation sweep's worklist (r2 finding 3). */
  completedApprovalSessions(): PlanSessionRow[] {
    const rows = this.#db
      .prepare("SELECT session_id FROM plan_approval_completions ORDER BY recorded_at, session_id")
      .all() as Array<{ session_id: string }>;
    return rows.map((r) => this.session(r.session_id) as PlanSessionRow);
  }

  /** Approval acts whose freeze never completed — the crash-resume worklist. */
  pendingApprovalSessions(): PlanSessionRow[] {
    const rows = this.#db
      .prepare(
        `SELECT a.session_id FROM plan_approvals a
         LEFT JOIN plan_approval_completions c ON c.session_id = a.session_id
         WHERE c.session_id IS NULL ORDER BY a.recorded_at, a.session_id`,
      )
      .all() as Array<{ session_id: string }>;
    return rows.map((r) => this.session(r.session_id) as PlanSessionRow);
  }

  // -------------------------------------------------------------------------
  // Contracts (CAM-PLAN-04)
  // -------------------------------------------------------------------------

  /**
   * Insert one frozen contract. Full-validator check (hash recomputation
   * included) before the write. If the (issueId, version) row already
   * exists: an identical hash is the idempotent resume no-op; a different
   * hash is refused loudly — a contract version is never rewritten.
   */
  insertContract(contract: IssueContract, sessionId: string): IssueContract {
    this.#assertWritable("plan store insertContract");
    // ONE observation (r1 finding 8): canonically serialize FIRST, then
    // validate the parsed snapshot, then persist those exact bytes — a
    // caller object whose accessors or toJSON produce different values per
    // read cannot make the validated value and the stored record differ
    // (functions, exotica, and holes are refused by the canonicalizer).
    let serialized: string;
    try {
      serialized = canonicalJson(contract);
    } catch (error) {
      if (error instanceof CanonicalJsonError) {
        throw new Error(`refusing to store a contract with no canonical form: ${error.message}`);
      }
      throw error;
    }
    const snapshot = JSON.parse(serialized) as IssueContract;
    const problems = contractProblems(snapshot);
    if (problems.length > 0) {
      throw new Error(`refusing to store an invalid contract: ${problems.join("; ")}`);
    }
    const existing = this.contract(snapshot.issueId, snapshot.version);
    if (existing !== undefined) {
      if (existing.contractHash === snapshot.contractHash) return existing;
      throw new Error(
        `contract ${snapshot.issueId} v${snapshot.version} already exists with hash ` +
          `${existing.contractHash}; refusing to overwrite it with ${snapshot.contractHash} ` +
          "(contract versions are immutable — edits create v(n+1), CAM-PLAN-05/WP-112)",
      );
    }
    this.#db
      .prepare(
        `INSERT INTO contracts (issue_id, version, contract_hash, mission_id, session_id, record, recorded_at)
         VALUES (@issueId, @version, @contractHash, @missionId, @sessionId, @record, @recordedAt)`,
      )
      .run({
        issueId: snapshot.issueId,
        version: snapshot.version,
        contractHash: snapshot.contractHash,
        missionId: snapshot.missionId,
        sessionId,
        record: serialized,
        recordedAt: this.#now().toISOString(),
      });
    return snapshot;
  }

  contract(issueId: string, version: number): IssueContract | undefined {
    const row = this.#db
      .prepare(
        "SELECT issue_id, version, contract_hash, mission_id, record FROM contracts WHERE issue_id = ? AND version = ?",
      )
      .get(issueId, version) as ContractRowShape | undefined;
    return row === undefined ? undefined : this.#toContract(row);
  }

  /** The highest contract version for an issue, or undefined. */
  latestContract(issueId: string): IssueContract | undefined {
    const row = this.#db
      .prepare(
        "SELECT issue_id, version, contract_hash, mission_id, record FROM contracts WHERE issue_id = ? ORDER BY version DESC LIMIT 1",
      )
      .get(issueId) as ContractRowShape | undefined;
    return row === undefined ? undefined : this.#toContract(row);
  }

  contractByHash(contractHash: string): IssueContract | undefined {
    const row = this.#db
      .prepare(
        "SELECT issue_id, version, contract_hash, mission_id, record FROM contracts WHERE contract_hash = ?",
      )
      .get(contractHash) as ContractRowShape | undefined;
    return row === undefined ? undefined : this.#toContract(row);
  }

  contractsForMission(missionId: string): IssueContract[] {
    const rows = this.#db
      .prepare(
        "SELECT issue_id, version, contract_hash, mission_id, record FROM contracts WHERE mission_id = ? ORDER BY issue_id, version",
      )
      .all(missionId) as ContractRowShape[];
    return rows.map((row) => this.#toContract(row));
  }

  /**
   * Re-validate on every read: hash recomputation via contractProblems PLUS
   * index binding — the record's own issueId/version/hash/missionId must
   * equal the row columns it was found by (r1 finding 8: a raw writer that
   * swaps a valid record under a different index key is refused, so a
   * lookup can never return a contract other than the one its key names).
   */
  #toContract(row: ContractRowShape): IssueContract {
    const parsed = JSON.parse(row.record) as unknown;
    const problems = contractProblems(parsed);
    if (problems.length > 0) {
      throw new Error(`stored contract fails validation on read: ${problems.join("; ")}`);
    }
    const contract = parsed as IssueContract;
    if (
      contract.issueId !== row.issue_id ||
      contract.version !== row.version ||
      contract.contractHash !== row.contract_hash ||
      contract.missionId !== row.mission_id
    ) {
      throw new Error(
        `stored contract ${row.issue_id} v${row.version} disagrees with its index columns — ` +
          "refusing to serve a re-keyed record",
      );
    }
    // Belt over braces: contractProblems already recomputed the hash; keep
    // the deep-frozen copy from escaping mutation by callers.
    return Object.freeze({
      ...contract,
      acceptanceCriteria: Object.freeze([...contract.acceptanceCriteria]),
      requirementIds: Object.freeze([...contract.requirementIds]),
      dependsOn: Object.freeze([...contract.dependsOn]),
      interfaces: Object.freeze(contract.interfaces.map((i) => Object.freeze({ ...i }))),
    }) as IssueContract;
  }

  close(): void {
    this.#db.close();
  }
}
