/**
 * Domain store (WP-103): projects → repos → missions in SQLite.
 *
 * Holds identity and intake content only; mission STATE lives in the
 * append-only event log (WP-101) and is derived by replay. The two join by
 * mission id. Multi-project from day one (CAM-CORE-06): adding a project or
 * repo is an insert — the schema never changes for it.
 *
 * Mission rows are immutable at the schema level (CAM-CORE-02: original
 * content retained immutably): BEFORE UPDATE / BEFORE DELETE triggers abort
 * mutation on every connection, ours or raw — the same posture as the event
 * log. Projects and repos are permanent too in v1 (no update/delete API;
 * missions reference them by foreign key with RESTRICT semantics).
 *
 * Same honesty scope as the event store: SQLite cannot stop a privileged
 * writer issuing DDL; the triggers guard against mutation bugs, and opening
 * a database whose user_version claims this schema but whose tables or
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
  id         TEXT PRIMARY KEY CHECK (length(id) > 0),
  name       TEXT NOT NULL UNIQUE CHECK (length(name) > 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repos (
  id         TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id),
  name       TEXT NOT NULL CHECK (length(name) > 0),
  origin_url TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS missions (
  id             TEXT PRIMARY KEY CHECK (length(id) > 0),
  repo_id        TEXT NOT NULL REFERENCES repos(id),
  route          TEXT NOT NULL CHECK (route IN ('integration', 'quick-task')),
  urgent         INTEGER NOT NULL CHECK (urgent IN (0, 1)),
  title          TEXT NOT NULL CHECK (length(title) > 0),
  source_kind    TEXT NOT NULL CHECK (source_kind IN ('pasted', 'file', 'quick-task')),
  content        TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  content_format TEXT NOT NULL CHECK (content_format IN ('markdown', 'text')),
  filename       TEXT,
  created_at     TEXT NOT NULL,
  -- The urgent lane belongs to quick tasks only (CAM-CORE-08).
  CHECK (urgent = 0 OR route = 'quick-task'),
  -- A filename is present exactly for file intake.
  CHECK ((source_kind = 'file') = (filename IS NOT NULL))
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
`;

const REQUIRED_OBJECTS = [
  "projects",
  "repos",
  "missions",
  "missions_immutable_update",
  "missions_immutable_delete",
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
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE (type = 'table' AND name IN ('projects', 'repos', 'missions'))
              OR (type = 'trigger' AND name IN ('missions_immutable_update', 'missions_immutable_delete'))`,
        )
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
    const project: Project = { id: this.newId(), name, createdAt: this.now().toISOString() };
    this.db
      .prepare("INSERT INTO projects (id, name, created_at) VALUES (@id, @name, @createdAt)")
      .run(project);
    return project;
  }

  createRepo(projectId: string, name: string, originUrl?: string): Repo {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("repo name must be a non-empty string");
    }
    const createdAt = this.now().toISOString();
    const id = this.newId();
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
    if (typeof content !== "string") {
      throw new TypeError("mission content must be a string");
    }
    if ((sourceKind === "file") !== (typeof filename === "string" && filename.length > 0)) {
      throw new TypeError("filename must be present exactly for file intake");
    }
    const record: MissionRecord = {
      id: this.newId(),
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
    const rows = this.db
      .prepare("SELECT * FROM projects ORDER BY created_at, id")
      .all() as ProjectRow[];
    return rows.map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at }));
  }

  getRepo(id: string): Repo | undefined {
    const row = this.db.prepare("SELECT * FROM repos WHERE id = ?").get(id) as RepoRow | undefined;
    return row === undefined ? undefined : toRepo(row);
  }

  listRepos(projectId: string): Repo[] {
    const rows = this.db
      .prepare("SELECT * FROM repos WHERE project_id = ? ORDER BY created_at, id")
      .all(projectId) as RepoRow[];
    return rows.map(toRepo);
  }

  getMission(id: string): MissionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM missions WHERE id = ?").get(id) as
      MissionRow | undefined;
    return row === undefined ? undefined : toMission(row);
  }

  /** All missions of a repo, intake order — the scheduler's join surface. */
  listMissions(repoId: string): MissionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM missions WHERE repo_id = ? ORDER BY created_at, id")
      .all(repoId) as MissionRow[];
    return rows.map(toMission);
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
