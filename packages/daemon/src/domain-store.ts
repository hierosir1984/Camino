/**
 * Domain store (WP-103): projects → repos → missions in SQLite.
 *
 * Holds identity and intake content only; mission STATE lives in the
 * append-only event log (WP-101) and is derived by replay. The two join by
 * mission id. Multi-project from day one (CAM-CORE-06): adding a project or
 * repo is an insert — the schema never changes for it.
 *
 * ALL rows are immutable/permanent at the schema level: BEFORE UPDATE /
 * BEFORE DELETE triggers on every table abort mutation on every connection,
 * ours or raw (r2 finding 6: projects/repos were mutable via ordinary
 * `UPDATE OR REPLACE`, which REPLACE-deletes the conflicting row), and
 * BEFORE INSERT conflict guards close the REPLACE-insert class (r1 finding
 * 1: `INSERT OR REPLACE` deletes past DELETE triggers unless the writer
 * opted into recursive triggers). Renaming projects/repos becomes a
 * deliberate, schema-versioned capability when a WP needs it — not an
 * UPDATE that happens to work.
 *
 * Identity and shape are pinned in the schema too: ids are NOT NULL (a
 * bare TEXT PRIMARY KEY admits multiple NULLs — r2 finding 3), stored
 * types are CHECKed (`typeof`), the content hash must be 64 lowercase hex
 * characters, and cross-field coherence — route ↔ source kind, source ↔
 * format, file format ↔ extension over a real basename — is enforced at
 * the durable boundary AND validated in TS for clear errors (r1 finding
 * 10, r2 finding 11).
 *
 * Strings must round-trip exactly: every string field is refused if it is
 * ill-formed UTF-16 (unpaired surrogates become replacement characters in
 * SQLite — r1 finding 6, extended to project/repo metadata by r2 finding
 * 8) or contains U+0000 (SQLite TEXT semantics break on embedded NUL:
 * `length()` stops there, so a CHECK can reject valid non-empty text — r2
 * finding 4).
 *
 * Honesty scope: embedded NUL is excluded SCHEMA-WIDE via
 * `instr(CAST(col AS BLOB), x'00') = 0` — a byte-level search that does not
 * stop at the NUL the way text functions do (r4 finding 4 corrected r3's
 * "not expressible" claim; the hash column additionally pins byte length).
 * What a privileged raw writer can still do: issue DDL, supply explicit
 * rowids, store a forged-but-valid-hex hash, or store TEXT that is not
 * valid UTF-8 (encoding validation is not expressible in SQLite SQL) —
 * stated, not defended. The API path re-derives hashes, validates every
 * string it persists (generated ids AND caller-supplied foreign ids
 * included — r3 f4, r4 f3), and assigns rowids monotonically. Opening a
 * database whose user_version claims this schema but whose tables or
 * triggers are missing refuses to start rather than silently recreating an
 * emptied store.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { MISSION_SOURCE_KINDS, MISSION_CONTENT_FORMATS, MISSION_ROUTES } from "@camino/shared";
import type {
  MissionContentFormat,
  MissionRecord,
  MissionRouteName,
  MissionSourceKind,
  Project,
  Repo,
} from "@camino/shared";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY NOT NULL CHECK (typeof(id) = 'text' AND length(id) > 0 AND instr(CAST(id AS BLOB), x'00') = 0),
  name       TEXT NOT NULL UNIQUE CHECK (typeof(name) = 'text' AND length(name) > 0 AND instr(CAST(name AS BLOB), x'00') = 0),
  created_at TEXT NOT NULL CHECK (typeof(created_at) = 'text' AND instr(CAST(created_at AS BLOB), x'00') = 0)
);

CREATE TABLE IF NOT EXISTS repos (
  id         TEXT PRIMARY KEY NOT NULL CHECK (typeof(id) = 'text' AND length(id) > 0 AND instr(CAST(id AS BLOB), x'00') = 0),
  project_id TEXT NOT NULL REFERENCES projects(id) CHECK (typeof(project_id) = 'text' AND instr(CAST(project_id AS BLOB), x'00') = 0),
  name       TEXT NOT NULL CHECK (typeof(name) = 'text' AND length(name) > 0 AND instr(CAST(name AS BLOB), x'00') = 0),
  origin_url TEXT CHECK (origin_url IS NULL OR (typeof(origin_url) = 'text' AND instr(CAST(origin_url AS BLOB), x'00') = 0)),
  created_at TEXT NOT NULL CHECK (typeof(created_at) = 'text' AND instr(CAST(created_at AS BLOB), x'00') = 0),
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS missions (
  id             TEXT PRIMARY KEY NOT NULL CHECK (typeof(id) = 'text' AND length(id) > 0 AND instr(CAST(id AS BLOB), x'00') = 0),
  repo_id        TEXT NOT NULL REFERENCES repos(id) CHECK (typeof(repo_id) = 'text' AND instr(CAST(repo_id AS BLOB), x'00') = 0),
  route          TEXT NOT NULL CHECK (route IN ('integration', 'quick-task')),
  urgent         INTEGER NOT NULL CHECK (urgent IN (0, 1)),
  title          TEXT NOT NULL CHECK (typeof(title) = 'text' AND length(title) > 0 AND instr(CAST(title AS BLOB), x'00') = 0),
  source_kind    TEXT NOT NULL CHECK (source_kind IN ('pasted', 'file', 'quick-task')),
  content        TEXT NOT NULL CHECK (typeof(content) = 'text' AND length(content) > 0 AND instr(CAST(content AS BLOB), x'00') = 0),
  content_sha256 TEXT NOT NULL CHECK (
                   typeof(content_sha256) = 'text'
                   AND length(content_sha256) = 64
                   -- Byte length must equal character length: SQLite text
                   -- functions stop at an embedded NUL, so a NUL-suffixed
                   -- value passes length/GLOB on its prefix alone (r3
                   -- finding 3). 64 hex characters are 64 bytes exactly.
                   AND length(CAST(content_sha256 AS BLOB)) = 64
                   AND content_sha256 NOT GLOB '*[^0-9a-f]*'
                 ),
  content_format TEXT NOT NULL CHECK (content_format IN ('markdown', 'text')),
  filename       TEXT CHECK (filename IS NULL OR (typeof(filename) = 'text' AND instr(CAST(filename AS BLOB), x'00') = 0)),
  created_at     TEXT NOT NULL CHECK (typeof(created_at) = 'text' AND instr(CAST(created_at AS BLOB), x'00') = 0),
  -- The urgent lane belongs to quick tasks only (CAM-CORE-08).
  CHECK (urgent = 0 OR route = 'quick-task'),
  -- A filename is present exactly for file intake.
  CHECK ((source_kind = 'file') = (filename IS NOT NULL)),
  -- Route ↔ source coherence: quick tasks come only from quick-task intake,
  -- integration missions only from pasted text or files (r1 finding 10).
  CHECK ((route = 'quick-task') = (source_kind = 'quick-task')),
  -- Source ↔ format coherence: quick tasks are text, pasted PRD text is
  -- markdown, and a file's format must agree with its extension over a real
  -- basename (a bare dotfile like ".md" is not a name — r2 finding 11) with
  -- no path separators.
  CHECK (source_kind != 'quick-task' OR content_format = 'text'),
  CHECK (source_kind != 'pasted' OR content_format = 'markdown'),
  CHECK (
    source_kind != 'file'
    OR (
      instr(filename, '/') = 0
      AND instr(filename, '\\') = 0
      AND (
        (lower(substr(filename, -3)) = '.md' AND length(filename) >= 4 AND content_format = 'markdown')
        OR (lower(substr(filename, -4)) = '.txt' AND length(filename) >= 5 AND content_format = 'text')
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_missions_repo ON missions (repo_id, created_at);

CREATE TRIGGER IF NOT EXISTS missions_immutable_update
BEFORE UPDATE ON missions
BEGIN
  SELECT RAISE(ABORT, 'mission records are immutable (CAM-CORE-02): UPDATE rejected');
END;

CREATE TRIGGER IF NOT EXISTS missions_immutable_delete
BEFORE DELETE ON missions
BEGIN
  SELECT RAISE(ABORT, 'mission records are immutable (CAM-CORE-02): DELETE rejected');
END;

-- Projects and repos are permanent in v1 (r2 finding 6: without these, an
-- ordinary UPDATE OR REPLACE could REPLACE-delete a conflicting row).
-- Renaming becomes a deliberate schema-versioned capability when needed.
CREATE TRIGGER IF NOT EXISTS projects_permanent_update
BEFORE UPDATE ON projects
BEGIN
  SELECT RAISE(ABORT, 'project rows are permanent in v1: UPDATE rejected');
END;

CREATE TRIGGER IF NOT EXISTS projects_permanent_delete
BEFORE DELETE ON projects
BEGIN
  SELECT RAISE(ABORT, 'project rows are permanent in v1: DELETE rejected');
END;

CREATE TRIGGER IF NOT EXISTS repos_permanent_update
BEFORE UPDATE ON repos
BEGIN
  SELECT RAISE(ABORT, 'repo rows are permanent in v1: UPDATE rejected');
END;

CREATE TRIGGER IF NOT EXISTS repos_permanent_delete
BEFORE DELETE ON repos
BEGIN
  SELECT RAISE(ABORT, 'repo rows are permanent in v1: DELETE rejected');
END;

-- REPLACE-class guard (r1 finding 1): INSERT OR REPLACE resolves a key
-- conflict by DELETING the conflicting row without firing DELETE triggers
-- (unless the writer enabled recursive triggers). Aborting the INSERT while
-- a conflicting row exists closes that path on every connection.
CREATE TRIGGER IF NOT EXISTS missions_immutable_insert_conflict
BEFORE INSERT ON missions
WHEN EXISTS (SELECT 1 FROM missions WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'mission records are immutable (CAM-CORE-02): conflicting INSERT rejected');
END;

CREATE TRIGGER IF NOT EXISTS projects_permanent_insert_conflict
BEFORE INSERT ON projects
WHEN EXISTS (SELECT 1 FROM projects WHERE id = NEW.id OR name = NEW.name)
BEGIN
  SELECT RAISE(ABORT, 'project rows are permanent: conflicting INSERT rejected');
END;

CREATE TRIGGER IF NOT EXISTS repos_permanent_insert_conflict
BEFORE INSERT ON repos
WHEN EXISTS (
  SELECT 1 FROM repos WHERE id = NEW.id OR (project_id = NEW.project_id AND name = NEW.name)
)
BEGIN
  SELECT RAISE(ABORT, 'repo rows are permanent: conflicting INSERT rejected');
END;
`;

const REQUIRED_OBJECTS = [
  "projects",
  "repos",
  "missions",
  "missions_immutable_update",
  "missions_immutable_delete",
  "missions_immutable_insert_conflict",
  "projects_permanent_update",
  "projects_permanent_delete",
  "projects_permanent_insert_conflict",
  "repos_permanent_update",
  "repos_permanent_delete",
  "repos_permanent_insert_conflict",
] as const;

interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
}

interface RepoRow {
  id: string;
  project_id: string;
  name: string;
  origin_url: string | null;
  created_at: string;
}

interface MissionRow {
  id: string;
  repo_id: string;
  route: string;
  urgent: number;
  title: string;
  source_kind: string;
  content: string;
  content_sha256: string;
  content_format: string;
  filename: string | null;
  created_at: string;
}

/** SHA-256 (hex) of the UTF-8 encoding of `content` — the content identity stored per mission. */
export function contentSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Refuse strings SQLite cannot hold faithfully: ill-formed UTF-16 becomes
 * replacement characters (r1 finding 6, r2 finding 8), and embedded U+0000
 * breaks SQLite TEXT semantics — length()/LIKE stop at the NUL, so CHECKs
 * misjudge valid text (r2 finding 4). Applied to EVERY string this store
 * persists.
 */
function assertRoundTripExact(field: string, value: string): void {
  if (!value.isWellFormed()) {
    throw new TypeError(
      `${field} contains unpaired surrogate code units and cannot be retained exactly`,
    );
  }
  if (value.includes("\0")) {
    throw new TypeError(`${field} contains an embedded NUL, which SQLite TEXT cannot hold`);
  }
}

/**
 * The id source is injectable (tests) and its output is persisted, so it is
 * validated like any other input: a numeric or NUL-carrying id would be
 * stored converted (42 → "42.0") or truncated by text functions, breaking
 * the identity join silently (r3 finding 4).
 */
function validatedId(field: string, value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} generator must return a non-empty string`);
  }
  assertRoundTripExact(field, value);
  return value;
}

export interface SqliteDomainStoreOptions {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  /** Injectable id source for deterministic tests; defaults to crypto.randomUUID. */
  readonly newId?: () => string;
}

export interface CreateMissionInput {
  readonly repoId: string;
  readonly route: MissionRouteName;
  readonly urgent: boolean;
  readonly title: string;
  readonly sourceKind: MissionSourceKind;
  readonly content: string;
  readonly contentFormat: MissionContentFormat;
  readonly filename?: string;
}

export class SqliteDomainStore {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly newId: () => string;

  /**
   * @param path SQLite file path, or ":memory:" for tests. Production wiring
   * places this beside the event log under `~/.camino/` (daemon shell WPs).
   */
  constructor(path: string, options: SqliteDomainStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version === 0) {
      this.db.exec(SCHEMA);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    } else if (version !== SCHEMA_VERSION) {
      throw new Error(
        `domain database ${path} has schema version ${version}; this daemon expects ${SCHEMA_VERSION}`,
      );
    } else {
      // Tamper evidence: a database claiming this schema version must still
      // carry the tables and the mission-immutability triggers. Recreating a
      // missing object here would silently accept a rewritten store — refuse.
      const objects = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')")
        .all() as Array<{ name: string }>;
      const names = new Set(objects.map((o) => o.name));
      for (const required of REQUIRED_OBJECTS) {
        if (!names.has(required)) {
          throw new Error(
            `domain database ${path} claims schema version ${version} but is missing ${required} — ` +
              "refusing to open a possibly tampered or truncated store",
          );
        }
      }
    }
  }

  createProject(name: string): Project {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("project name must be a non-empty string");
    }
    assertRoundTripExact("project name", name);
    const project: Project = {
      id: validatedId("project id", this.newId()),
      name,
      createdAt: this.now().toISOString(),
    };
    this.db
      .prepare("INSERT INTO projects (id, name, created_at) VALUES (@id, @name, @createdAt)")
      .run(project);
    return project;
  }

  createRepo(projectId: string, name: string, originUrl?: string): Repo {
    // Caller-supplied foreign ids are validated like every other string: a
    // numeric value would be affinity-converted on storage ("42" → "42.0")
    // while the returned object kept the number — silently divergent
    // identities (r4 finding 3).
    if (typeof projectId !== "string" || projectId.length === 0) {
      throw new TypeError("projectId must be a non-empty string");
    }
    assertRoundTripExact("projectId", projectId);
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("repo name must be a non-empty string");
    }
    assertRoundTripExact("repo name", name);
    if (originUrl !== undefined) {
      if (typeof originUrl !== "string" || originUrl.length === 0) {
        throw new TypeError("originUrl, when present, must be a non-empty string");
      }
      assertRoundTripExact("repo originUrl", originUrl);
    }
    const createdAt = this.now().toISOString();
    const id = validatedId("repo id", this.newId());
    this.db
      .prepare(
        `INSERT INTO repos (id, project_id, name, origin_url, created_at)
         VALUES (@id, @projectId, @name, @originUrl, @createdAt)`,
      )
      .run({ id, projectId, name, originUrl: originUrl ?? null, createdAt });
    return { id, projectId, name, ...(originUrl === undefined ? {} : { originUrl }), createdAt };
  }

  /**
   * Insert a mission record. Intake (intake.ts) is the only intended caller:
   * it validates content and format BEFORE this point; the store re-derives
   * the content hash itself so a stored hash can never disagree with the
   * stored content.
   */
  createMission(input: CreateMissionInput): MissionRecord {
    // Snapshot every field exactly once (exotic caller objects must not let
    // validation and insertion read different values — WP-101 posture).
    const { repoId, route, urgent, title, sourceKind, content, contentFormat, filename } = input;
    if (typeof repoId !== "string" || repoId.length === 0) {
      throw new TypeError("repoId must be a non-empty string");
    }
    assertRoundTripExact("repoId", repoId);
    if (!MISSION_ROUTES.includes(route)) {
      throw new TypeError(`unknown mission route: ${JSON.stringify(route)}`);
    }
    if (!MISSION_SOURCE_KINDS.includes(sourceKind)) {
      throw new TypeError(`unknown mission source kind: ${JSON.stringify(sourceKind)}`);
    }
    if (!MISSION_CONTENT_FORMATS.includes(contentFormat)) {
      throw new TypeError(`unknown mission content format: ${JSON.stringify(contentFormat)}`);
    }
    if (typeof urgent !== "boolean") {
      throw new TypeError("urgent must be a boolean");
    }
    if (typeof title !== "string" || title.length === 0) {
      throw new TypeError("mission title must be a non-empty string");
    }
    if (typeof content !== "string" || content.length === 0) {
      throw new TypeError("mission content must be a non-empty string");
    }
    // Every string must round-trip exactly (r1 finding 6, r2 findings 4/8).
    assertRoundTripExact("mission content", content);
    assertRoundTripExact("mission title", title);
    if (filename !== undefined) assertRoundTripExact("mission filename", filename);
    if ((sourceKind === "file") !== (typeof filename === "string" && filename.length > 0)) {
      throw new TypeError("filename must be present exactly for file intake");
    }
    // Cross-field coherence at the durable boundary (r1 finding 10) —
    // mirrored by schema CHECKs; validated here for clear errors.
    if ((route === "quick-task") !== (sourceKind === "quick-task")) {
      throw new TypeError("route and source kind must agree (quick-task ⇔ quick-task intake)");
    }
    if (sourceKind === "quick-task" && contentFormat !== "text") {
      throw new TypeError("quick-task content is text");
    }
    if (sourceKind === "pasted" && contentFormat !== "markdown") {
      throw new TypeError("pasted PRD text is markdown");
    }
    if (sourceKind === "file" && filename !== undefined) {
      // Same rule as intake (r2 finding 11): a real basename before the
      // extension (bare dotfiles are not names), no path separators.
      if (/[/\\]/.test(filename)) {
        throw new TypeError("filename must be a bare name without path separators");
      }
      const dot = filename.lastIndexOf(".");
      const extension = dot > 0 ? filename.slice(dot).toLowerCase() : undefined;
      const expected = extension === ".md" ? "markdown" : extension === ".txt" ? "text" : undefined;
      if (expected === undefined || expected !== contentFormat) {
        throw new TypeError(
          `file content format must agree with the filename extension over a real basename ` +
            `(${JSON.stringify(filename)} vs ${contentFormat})`,
        );
      }
    }
    const record: MissionRecord = {
      id: validatedId("mission id", this.newId()),
      repoId,
      route,
      urgent,
      title,
      sourceKind,
      content,
      contentSha256: contentSha256(content),
      contentFormat,
      ...(filename === undefined ? {} : { filename }),
      createdAt: this.now().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO missions
           (id, repo_id, route, urgent, title, source_kind, content, content_sha256, content_format, filename, created_at)
         VALUES
           (@id, @repoId, @route, @urgent, @title, @sourceKind, @content, @contentSha256, @contentFormat, @filename, @createdAt)`,
      )
      .run({
        id: record.id,
        repoId: record.repoId,
        route: record.route,
        urgent: record.urgent ? 1 : 0,
        title: record.title,
        sourceKind: record.sourceKind,
        content: record.content,
        contentSha256: record.contentSha256,
        contentFormat: record.contentFormat,
        filename: record.filename ?? null,
        createdAt: record.createdAt,
      });
    return record;
  }

  getProject(id: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      ProjectRow | undefined;
    return row === undefined
      ? undefined
      : { id: row.id, name: row.name, createdAt: row.created_at };
  }

  listProjects(): Project[] {
    // rowid is assigned monotonically for THIS API's inserts: exact insertion
    // order, deterministic under equal timestamps (r1 finding 11). A raw
    // writer supplying explicit rowids is outside the claim (privileged
    // class, like DDL — r2 finding 12).
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY rowid").all() as ProjectRow[];
    return rows.map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at }));
  }

  getRepo(id: string): Repo | undefined {
    const row = this.db.prepare("SELECT * FROM repos WHERE id = ?").get(id) as RepoRow | undefined;
    return row === undefined ? undefined : toRepo(row);
  }

  listRepos(projectId: string): Repo[] {
    const rows = this.db
      .prepare("SELECT * FROM repos WHERE project_id = ? ORDER BY rowid")
      .all(projectId) as RepoRow[];
    return rows.map(toRepo);
  }

  getMission(id: string): MissionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM missions WHERE id = ?").get(id) as
      MissionRow | undefined;
    return row === undefined ? undefined : toMission(row);
  }

  /** All missions of a repo in API insertion order (rowid) — the scheduler's join surface. */
  listMissions(repoId: string): MissionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM missions WHERE repo_id = ? ORDER BY rowid")
      .all(repoId) as MissionRow[];
    return rows.map(toMission);
  }

  /**
   * EVERY mission row, scanned from the table itself — not by walking
   * projects → repos (r2 finding 9: a hierarchy-traversal misses rows whose
   * parent is absent). Reconciliation surfaces build on this.
   */
  listAllMissions(): MissionRecord[] {
    const rows = this.db.prepare("SELECT * FROM missions ORDER BY rowid").all() as MissionRow[];
    return rows.map(toMission);
  }

  /**
   * Referential gaps a foreign writer (foreign keys off) can leave behind:
   * missions whose repo row is missing, repos whose project row is missing.
   * Both empty on every API-written store (FKs are enforced here).
   */
  hierarchyGaps(): { missionIdsWithoutRepo: string[]; repoIdsWithoutProject: string[] } {
    const missionRows = this.db
      .prepare(
        `SELECT m.id AS id FROM missions m LEFT JOIN repos r ON m.repo_id = r.id
         WHERE r.id IS NULL ORDER BY m.rowid`,
      )
      .all() as Array<{ id: string }>;
    const repoRows = this.db
      .prepare(
        `SELECT r.id AS id FROM repos r LEFT JOIN projects p ON r.project_id = p.id
         WHERE p.id IS NULL ORDER BY r.rowid`,
      )
      .all() as Array<{ id: string }>;
    return {
      missionIdsWithoutRepo: missionRows.map((row) => row.id),
      repoIdsWithoutProject: repoRows.map((row) => row.id),
    };
  }

  close(): void {
    this.db.close();
  }
}

function toRepo(row: RepoRow): Repo {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    ...(row.origin_url === null ? {} : { originUrl: row.origin_url }),
    createdAt: row.created_at,
  };
}

function toMission(row: MissionRow): MissionRecord {
  return {
    id: row.id,
    repoId: row.repo_id,
    route: row.route as MissionRouteName,
    urgent: row.urgent === 1,
    title: row.title,
    sourceKind: row.source_kind as MissionSourceKind,
    content: row.content,
    contentSha256: row.content_sha256,
    contentFormat: row.content_format as MissionContentFormat,
    ...(row.filename === null ? {} : { filename: row.filename }),
    createdAt: row.created_at,
  };
}
