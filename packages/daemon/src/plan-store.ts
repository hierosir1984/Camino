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
 * hash; insertContract verifies the full shared validator INCLUDING hash
 * recomputation before writing, re-verifies on open (a tampered or foreign
 * store is refused, never adopted), and treats an identical re-insert as
 * the idempotent no-op the crash-resume path relies on.
 */
import Database from "better-sqlite3";
import { DAVID_ACTOR } from "@camino/core";
import {
  contractProblems,
  clarificationResponseProblems,
  planConstructionRecordProblems,
} from "@camino/shared";
import type {
  ClarificationResponse,
  IssueContract,
  MissionTemplateName,
  PlanConstructionRecord,
} from "@camino/shared";
import { MISSION_TEMPLATE_NAMES } from "@camino/shared";
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
  session_id    TEXT NOT NULL CHECK (${NUL_FREE("session_id")}),
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
    for (const row of streamRows) {
      const payload = this.#parseObject(
        row.payload,
        `plan store ${path} stream row ${row.session_id}#${row.seq}`,
      );
      if (row.kind === "review-attached") {
        const problems = reviewArtifactProblems(payload);
        if (problems.length > 0) {
          throw new Error(
            `plan store ${path} stream row ${row.session_id}#${row.seq} fails validation — ` +
              `refusing to adopt: ${problems.join("; ")}`,
          );
        }
      } else {
        const problems = planConstructionRecordProblems(payload);
        if (problems.length > 0) {
          throw new Error(
            `plan store ${path} stream row ${row.session_id}#${row.seq} fails validation — ` +
              `refusing to adopt: ${problems.join("; ")}`,
          );
        }
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
    const contractRows = this.#db
      .prepare("SELECT issue_id, version, contract_hash, record FROM contracts")
      .all() as Array<{ issue_id: string; version: number; contract_hash: string; record: string }>;
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
        contract.version !== row.version
      ) {
        throw new Error(
          `plan store ${path} contract ${row.issue_id} v${row.version} disagrees with its ` +
            "indexed columns — refusing to adopt a tampered store",
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

  appendStream(
    sessionId: string,
    kind: PlanStreamKind,
    payload: PlanConstructionRecord | Record<string, unknown>,
  ): PlanStreamRecord {
    this.#assertWritable("plan store appendStream");
    const recordedAt = this.#now().toISOString();
    const serialized = JSON.stringify(payload);
    const insert = this.#db.transaction((): number => {
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
    return {
      seq,
      kind,
      payload: JSON.parse(serialized) as Record<string, unknown>,
      recordedAt,
    };
  }

  streamRecords(sessionId: string): PlanStreamRecord[] {
    const rows = this.#db
      .prepare(
        "SELECT seq, kind, payload, recorded_at FROM plan_stream WHERE session_id = ? ORDER BY seq",
      )
      .all(sessionId) as Array<{ seq: number; kind: string; payload: string; recorded_at: string }>;
    return rows.map((row) => ({
      seq: row.seq,
      kind: row.kind as PlanStreamKind,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      recordedAt: row.recorded_at,
    }));
  }

  // -------------------------------------------------------------------------
  // David's acts
  // -------------------------------------------------------------------------

  recordAcknowledgment(
    sessionId: string,
    clarificationId: string,
    response: ClarificationResponse,
    actor: string,
  ): void {
    this.#assertWritable("plan store recordAcknowledgment");
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
      rows.map((row) => [row.clarification_id, JSON.parse(row.response) as ClarificationResponse]),
    );
  }

  recordConfirmation(
    sessionId: string,
    confirmation: { segmentId: string; requirementId: string; statement: string },
    actor: string,
  ): void {
    this.#assertWritable("plan store recordConfirmation");
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
    this.#db
      .prepare(
        `INSERT INTO plan_flag_acknowledgments (session_id, flagged_segment_ids, actor, recorded_at)
         VALUES (@sessionId, @flaggedSegmentIds, @actor, @recordedAt)`,
      )
      .run({
        sessionId,
        flaggedSegmentIds: JSON.stringify([...flaggedSegmentIds].sort()),
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

  recordRejection(sessionId: string, actor: string): void {
    this.#assertWritable("plan store recordRejection");
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

  recordApproval(sessionId: string, actor: string): void {
    this.#assertWritable("plan store recordApproval");
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

  recordApprovalCompletion(sessionId: string): void {
    this.#assertWritable("plan store recordApprovalCompletion");
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
    const problems = contractProblems(contract);
    if (problems.length > 0) {
      throw new Error(`refusing to store an invalid contract: ${problems.join("; ")}`);
    }
    const existing = this.contract(contract.issueId, contract.version);
    if (existing !== undefined) {
      if (existing.contractHash === contract.contractHash) return existing;
      throw new Error(
        `contract ${contract.issueId} v${contract.version} already exists with hash ` +
          `${existing.contractHash}; refusing to overwrite it with ${contract.contractHash} ` +
          "(contract versions are immutable — edits create v(n+1), CAM-PLAN-05/WP-112)",
      );
    }
    this.#db
      .prepare(
        `INSERT INTO contracts (issue_id, version, contract_hash, mission_id, session_id, record, recorded_at)
         VALUES (@issueId, @version, @contractHash, @missionId, @sessionId, @record, @recordedAt)`,
      )
      .run({
        issueId: contract.issueId,
        version: contract.version,
        contractHash: contract.contractHash,
        missionId: contract.missionId,
        sessionId,
        record: JSON.stringify(contract),
        recordedAt: this.#now().toISOString(),
      });
    return contract;
  }

  contract(issueId: string, version: number): IssueContract | undefined {
    const row = this.#db
      .prepare("SELECT record FROM contracts WHERE issue_id = ? AND version = ?")
      .get(issueId, version) as { record: string } | undefined;
    return row === undefined ? undefined : this.#toContract(row.record);
  }

  /** The highest contract version for an issue, or undefined. */
  latestContract(issueId: string): IssueContract | undefined {
    const row = this.#db
      .prepare("SELECT record FROM contracts WHERE issue_id = ? ORDER BY version DESC LIMIT 1")
      .get(issueId) as { record: string } | undefined;
    return row === undefined ? undefined : this.#toContract(row.record);
  }

  contractByHash(contractHash: string): IssueContract | undefined {
    const row = this.#db
      .prepare("SELECT record FROM contracts WHERE contract_hash = ?")
      .get(contractHash) as { record: string } | undefined;
    return row === undefined ? undefined : this.#toContract(row.record);
  }

  contractsForMission(missionId: string): IssueContract[] {
    const rows = this.#db
      .prepare("SELECT record FROM contracts WHERE mission_id = ? ORDER BY issue_id, version")
      .all(missionId) as Array<{ record: string }>;
    return rows.map((row) => this.#toContract(row.record));
  }

  /**
   * Re-validate on every read (hash recomputation): a row edited behind the
   * store's back — even with triggers dropped by a raw writer — is refused
   * at the read seam, never served.
   */
  #toContract(record: string): IssueContract {
    const parsed = JSON.parse(record) as unknown;
    const problems = contractProblems(parsed);
    if (problems.length > 0) {
      throw new Error(`stored contract fails validation on read: ${problems.join("; ")}`);
    }
    const contract = parsed as IssueContract;
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
