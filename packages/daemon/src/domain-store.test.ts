/**
 * Domain-store tests (WP-103): project → repo → mission schema, multi-project
 * from day one (CAM-CORE-06), mission rows immutable at the schema level
 * (CAM-CORE-02), tamper-evident open — the event store's posture applied to
 * the domain side.
 */
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDomainStore, contentSha256 } from "./domain-store.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function newStore(path = ":memory:"): SqliteDomainStore {
  const store = new SqliteDomainStore(path);
  cleanups.push(() => store.close());
  return store;
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-domain-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "domain.db");
}

function seedMission(store: SqliteDomainStore): {
  projectId: string;
  repoId: string;
  missionId: string;
} {
  const project = store.createProject("camino");
  const repo = store.createRepo(project.id, "camino");
  const mission = store.createMission({
    repoId: repo.id,
    route: "integration",
    urgent: false,
    title: "Evidence viewer v0",
    sourceKind: "pasted",
    content: "# PRD\n\nRetained verbatim.",
    contentFormat: "markdown",
  });
  return { projectId: project.id, repoId: repo.id, missionId: mission.id };
}

describe("SqliteDomainStore — schema and hierarchy", () => {
  it("stores projects, repos, and missions and reads them back", () => {
    const store = newStore();
    const { projectId, repoId, missionId } = seedMission(store);

    expect(store.getProject(projectId)?.name).toBe("camino");
    expect(store.getRepo(repoId)?.projectId).toBe(projectId);
    const mission = store.getMission(missionId);
    expect(mission?.repoId).toBe(repoId);
    expect(mission?.content).toBe("# PRD\n\nRetained verbatim.");
    expect(mission?.contentSha256).toBe(contentSha256("# PRD\n\nRetained verbatim."));
    expect(store.listMissions(repoId).map((m) => m.id)).toEqual([missionId]);
  });

  it("adding a second project requires no schema change (CAM-CORE-06)", () => {
    const path = tempDbPath();
    const store = newStore(path);
    seedMission(store);

    const raw = new Database(path, { readonly: true });
    cleanups.push(() => raw.close());
    const schemaBefore = raw
      .prepare("SELECT name, sql FROM sqlite_master ORDER BY name")
      .all() as Array<{ name: string; sql: string }>;
    const versionBefore = raw.pragma("user_version", { simple: true }) as number;

    // A second project with its own repo and mission is plain inserts.
    const second = store.createProject("second-product");
    const repo2 = store.createRepo(second.id, "second-repo", "https://example.invalid/second.git");
    const mission2 = store.createMission({
      repoId: repo2.id,
      route: "quick-task",
      urgent: true,
      title: "Hotfix",
      sourceKind: "quick-task",
      content: "fix the urgent thing",
      contentFormat: "text",
    });

    const schemaAfter = raw
      .prepare("SELECT name, sql FROM sqlite_master ORDER BY name")
      .all() as Array<{ name: string; sql: string }>;
    expect(schemaAfter).toEqual(schemaBefore);
    expect(raw.pragma("user_version", { simple: true }) as number).toBe(versionBefore);

    // The hierarchy is real: each repo lists only its own missions.
    expect(store.listProjects().map((p) => p.name)).toEqual(["camino", "second-product"]);
    expect(store.listRepos(second.id).map((r) => r.id)).toEqual([repo2.id]);
    expect(store.listMissions(repo2.id).map((m) => m.id)).toEqual([mission2.id]);
  });

  it("rejects a repo for a project that does not exist (foreign keys on)", () => {
    const store = newStore();
    expect(() => store.createRepo("no-such-project", "repo")).toThrow(/FOREIGN KEY/i);
  });

  it("rejects a mission for a repo that does not exist", () => {
    const store = newStore();
    expect(() =>
      store.createMission({
        repoId: "no-such-repo",
        route: "integration",
        urgent: false,
        title: "t",
        sourceKind: "pasted",
        content: "c",
        contentFormat: "markdown",
      }),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("enforces project-name and per-project repo-name uniqueness", () => {
    const store = newStore();
    const project = store.createProject("camino");
    store.createRepo(project.id, "repo");
    // The insert-conflict guards fire before the UNIQUE constraint would,
    // with a clearer message — duplicates are rejected either way.
    expect(() => store.createProject("camino")).toThrow(/permanent|UNIQUE/i);
    expect(() => store.createRepo(project.id, "repo")).toThrow(/permanent|UNIQUE/i);
    // The same repo name under a DIFFERENT project is fine (per-project scope).
    const other = store.createProject("other");
    expect(() => store.createRepo(other.id, "repo")).not.toThrow();
  });
});

describe("SqliteDomainStore — mission immutability (CAM-CORE-02)", () => {
  it("rejects UPDATE and DELETE on mission rows on a raw connection (schema triggers)", () => {
    const path = tempDbPath();
    const store = newStore(path);
    const { missionId } = seedMission(store);

    const raw = new Database(path);
    cleanups.push(() => raw.close());
    expect(() =>
      raw.prepare("UPDATE missions SET content = 'rewritten' WHERE id = ?").run(missionId),
    ).toThrow(/immutable/);
    expect(() => raw.prepare("DELETE FROM missions WHERE id = ?").run(missionId)).toThrow(
      /immutable/,
    );

    // The original content survives, byte for byte.
    expect(store.getMission(missionId)?.content).toBe("# PRD\n\nRetained verbatim.");
  });

  it("rejects INSERT OR REPLACE on all three tables on a raw connection (r1 finding 1)", () => {
    const path = tempDbPath();
    const store = newStore(path);
    const { projectId, repoId, missionId } = seedMission(store);

    // REPLACE resolves a key conflict by DELETING the old row without firing
    // DELETE triggers (unless recursive triggers are on) — the BEFORE INSERT
    // conflict guards must abort it on every connection.
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    expect(() =>
      raw
        .prepare(
          `INSERT OR REPLACE INTO missions
             (id, repo_id, route, urgent, title, source_kind, content, content_sha256, content_format, filename, created_at)
           VALUES (?, ?, 'integration', 0, 'REPLACED', 'pasted', 'REPLACED CONTENT', ?, 'markdown', NULL, 'now')`,
        )
        .run(missionId, repoId, "0".repeat(64)),
    ).toThrow(/immutable/);
    expect(() =>
      raw
        .prepare(
          "INSERT OR REPLACE INTO projects (id, name, created_at) VALUES (?, 'camino', 'now')",
        )
        .run(projectId),
    ).toThrow(/permanent/);
    expect(() =>
      raw
        .prepare(
          "INSERT OR REPLACE INTO repos (id, project_id, name, origin_url, created_at) VALUES (?, ?, 'camino', NULL, 'now')",
        )
        .run(repoId, projectId),
    ).toThrow(/permanent/);

    // The original rows survive untouched.
    expect(store.getMission(missionId)?.content).toBe("# PRD\n\nRetained verbatim.");
    expect(store.getProject(projectId)?.name).toBe("camino");
  });

  it("rejects UPDATE OR REPLACE (and plain UPDATE/DELETE) on projects and repos (r2 finding 6)", () => {
    const path = tempDbPath();
    const store = newStore(path);
    const { projectId, repoId } = seedMission(store);
    const second = store.createProject("second");
    const secondRepo = store.createRepo(second.id, "second-repo");

    // UPDATE OR REPLACE resolves a UNIQUE conflict by REPLACE-deleting the
    // other row — before this fold it renamed p1 and silently deleted p2.
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    expect(() =>
      raw.prepare("UPDATE OR REPLACE projects SET name = 'second' WHERE id = ?").run(projectId),
    ).toThrow(/permanent/);
    expect(() =>
      raw
        .prepare("UPDATE OR REPLACE repos SET name = 'second-repo', project_id = ? WHERE id = ?")
        .run(second.id, repoId),
    ).toThrow(/permanent/);
    expect(() =>
      raw.prepare("UPDATE projects SET name = 'renamed' WHERE id = ?").run(projectId),
    ).toThrow(/permanent/);
    expect(() => raw.prepare("DELETE FROM repos WHERE id = ?").run(secondRepo.id)).toThrow(
      /permanent/,
    );
    // Every row survives.
    expect(store.listProjects().map((p) => p.name)).toEqual(["camino", "second"]);
    expect(store.getRepo(secondRepo.id)?.name).toBe("second-repo");
  });

  it("rejects NULL identities on raw inserts (r2 finding 3)", () => {
    const path = tempDbPath();
    newStore(path);
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    // A bare TEXT PRIMARY KEY admits multiple NULLs; NOT NULL closes it.
    expect(() =>
      raw.prepare("INSERT INTO projects (id, name, created_at) VALUES (NULL, 'p', 'now')").run(),
    ).toThrow(/NOT NULL/);
    expect(() =>
      raw
        .prepare(
          "INSERT INTO repos (id, project_id, name, origin_url, created_at) VALUES (NULL, 'x', 'r', NULL, 'now')",
        )
        .run(),
    ).toThrow(/NOT NULL/);
    expect(() =>
      raw
        .prepare(
          `INSERT INTO missions
             (id, repo_id, route, urgent, title, source_kind, content, content_sha256, content_format, filename, created_at)
           VALUES (NULL, 'x', 'integration', 0, 't', 'pasted', 'c', ?, 'markdown', NULL, 'now')`,
        )
        .run("0".repeat(64)),
    ).toThrow(/NOT NULL/);
  });

  it("refuses project/repo metadata that cannot round-trip exactly (r2 finding 8)", () => {
    const store = newStore();
    expect(() => store.createProject("bad \uD800 name")).toThrow(/unpaired surrogate/);
    expect(() => store.createProject("bad \0 name")).toThrow(/embedded NUL/);
    const project = store.createProject("camino");
    expect(() => store.createRepo(project.id, "bad \uDC00 repo")).toThrow(/unpaired surrogate/);
    expect(() => store.createRepo(project.id, "repo", "https://x.invalid/\0")).toThrow(
      /embedded NUL/,
    );
  });

  it("schema CHECKs pin the lane rule: urgent is quick-task-only", () => {
    const store = newStore();
    const { repoId } = seedMission(store);
    expect(() =>
      store.createMission({
        repoId,
        route: "integration",
        urgent: true,
        title: "t",
        sourceKind: "pasted",
        content: "c",
        contentFormat: "markdown",
      }),
    ).toThrow(/CHECK/i);
  });

  it("filename is present exactly for file intake (both directions)", () => {
    const store = newStore();
    const { repoId } = seedMission(store);
    expect(() =>
      store.createMission({
        repoId,
        route: "integration",
        urgent: false,
        title: "t",
        sourceKind: "pasted",
        content: "c",
        contentFormat: "markdown",
        filename: "sneaky.md",
      }),
    ).toThrow(/filename/);
    expect(() =>
      store.createMission({
        repoId,
        route: "integration",
        urgent: false,
        title: "t",
        sourceKind: "file",
        content: "c",
        contentFormat: "markdown",
      }),
    ).toThrow(/filename/);
  });

  it("re-derives the stored content hash itself (a caller cannot supply one)", () => {
    const store = newStore();
    const { repoId } = seedMission(store);
    const mission = store.createMission({
      repoId,
      route: "integration",
      urgent: false,
      title: "t",
      sourceKind: "pasted",
      content: "exact content",
      contentFormat: "markdown",
      // No hash field exists on the input type at all — identity is derived.
    });
    expect(mission.contentSha256).toBe(contentSha256("exact content"));
  });

  it("refuses ill-formed strings that cannot round-trip through SQLite (r1 finding 6)", () => {
    const store = newStore();
    const { repoId } = seedMission(store);
    const base = {
      repoId,
      route: "integration",
      urgent: false,
      sourceKind: "pasted",
      contentFormat: "markdown",
    } as const;
    expect(() => store.createMission({ ...base, title: "t", content: "A\uD800B" })).toThrow(
      /unpaired surrogate/,
    );
    expect(() =>
      store.createMission({ ...base, title: "bad \uDC00 title", content: "fine" }),
    ).toThrow(/unpaired surrogate/);
  });

  it("enforces cross-field coherence at the durable boundary (r1 finding 10)", () => {
    const store = newStore();
    const { repoId } = seedMission(store);
    // Empty content.
    expect(() =>
      store.createMission({
        repoId,
        route: "quick-task",
        urgent: true,
        title: "t",
        sourceKind: "quick-task",
        content: "",
        contentFormat: "text",
      }),
    ).toThrow(/non-empty/);
    // Route ↔ source disagreement (the reviewer's exact shape).
    expect(() =>
      store.createMission({
        repoId,
        route: "quick-task",
        urgent: true,
        title: "t",
        sourceKind: "pasted",
        content: "c",
        contentFormat: "markdown",
      }),
    ).toThrow(/route and source kind/);
    // File format disagreeing with the extension (the reviewer's exact shape).
    expect(() =>
      store.createMission({
        repoId,
        route: "integration",
        urgent: false,
        title: "t",
        sourceKind: "file",
        content: "c",
        contentFormat: "text",
        filename: "spec.md",
      }),
    ).toThrow(/agree with the filename extension/);
    // Quick-task content must be text; pasted must be markdown.
    expect(() =>
      store.createMission({
        repoId,
        route: "quick-task",
        urgent: false,
        title: "t",
        sourceKind: "quick-task",
        content: "c",
        contentFormat: "markdown",
      }),
    ).toThrow(/text/);
    expect(() =>
      store.createMission({
        repoId,
        route: "integration",
        urgent: false,
        title: "t",
        sourceKind: "pasted",
        content: "c",
        contentFormat: "text",
      }),
    ).toThrow(/markdown/);
  });

  it("store and intake agree on filenames: bare dotfiles are rejected at both (r2 finding 11)", () => {
    const store = newStore();
    const { repoId } = seedMission(store);
    for (const filename of [".md", ".txt", ".MD"]) {
      expect(() =>
        store.createMission({
          repoId,
          route: "integration",
          urgent: false,
          title: "t",
          sourceKind: "file",
          content: "c",
          contentFormat: filename.toLowerCase() === ".md" ? "markdown" : "text",
          filename,
        }),
      ).toThrow(/real basename/);
    }
  });

  it("schema rejects dotfile filenames and non-hex hashes on raw inserts (r2 findings 11/3)", () => {
    const path = tempDbPath();
    const store = newStore(path);
    const { repoId } = seedMission(store);
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    const insert = raw.prepare(
      `INSERT INTO missions
         (id, repo_id, route, urgent, title, source_kind, content, content_sha256, content_format, filename, created_at)
       VALUES (?, ?, 'integration', 0, 't', 'file', 'c', ?, ?, ?, 'now')`,
    );
    // Bare dotfiles fail the length floor in the schema CHECK.
    expect(() => insert.run("d1", repoId, "0".repeat(64), "markdown", ".md")).toThrow(/CHECK/i);
    expect(() => insert.run("d2", repoId, "0".repeat(64), "text", ".txt")).toThrow(/CHECK/i);
    // Non-hex and non-text hashes fail the hash CHECK.
    expect(() => insert.run("d3", repoId, "g".repeat(64), "markdown", "x.md")).toThrow(/CHECK/i);
    expect(() => insert.run("d4", repoId, "🚀".repeat(32), "markdown", "x.md")).toThrow(/CHECK/i);
    const blobInsert = raw.prepare(
      `INSERT INTO missions
         (id, repo_id, route, urgent, title, source_kind, content, content_sha256, content_format, filename, created_at)
       VALUES ('d5', ?, 'integration', 0, 't', 'pasted', 'c', zeroblob(64), 'markdown', NULL, 'now')`,
    );
    expect(() => blobInsert.run(repoId)).toThrow(/CHECK/i);
  });

  it("schema CHECKs enforce the same coherence against raw inserts", () => {
    const path = tempDbPath();
    const store = newStore(path);
    const { repoId } = seedMission(store);
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    const insert = raw.prepare(
      `INSERT INTO missions
         (id, repo_id, route, urgent, title, source_kind, content, content_sha256, content_format, filename, created_at)
       VALUES (?, ?, ?, ?, 't', ?, ?, ?, ?, ?, 'now')`,
    );
    const hash = "0".repeat(64);
    // route/source disagreement, wrong quick-task format, wrong file
    // extension pairing, empty content — all rejected by CHECKs.
    expect(() =>
      insert.run("x1", repoId, "quick-task", 1, "pasted", "c", hash, "markdown", null),
    ).toThrow(/CHECK/i);
    expect(() =>
      insert.run("x2", repoId, "quick-task", 0, "quick-task", "c", hash, "markdown", null),
    ).toThrow(/CHECK/i);
    expect(() =>
      insert.run("x3", repoId, "integration", 0, "file", "c", hash, "text", "spec.md"),
    ).toThrow(/CHECK/i);
    expect(() =>
      insert.run("x4", repoId, "integration", 0, "pasted", "", hash, "markdown", null),
    ).toThrow(/CHECK/i);
  });

  it("lists in exact insertion order under equal timestamps and adverse ids (r1 finding 11)", () => {
    // Frozen clock + descending ids: created_at cannot break ties and id
    // order is the REVERSE of insertion — only rowid gives intake order.
    const ids = ["z-project", "y-repo", "x-first", "w-second", "v-third"];
    const store = new SqliteDomainStore(":memory:", {
      now: () => new Date("2026-07-19T00:00:00.000Z"),
      newId: () => ids.shift() ?? "exhausted",
    });
    cleanups.push(() => store.close());
    const project = store.createProject("camino");
    const repo = store.createRepo(project.id, "camino");
    const first = store.createMission({
      repoId: repo.id,
      route: "integration",
      urgent: false,
      title: "first",
      sourceKind: "pasted",
      content: "1",
      contentFormat: "markdown",
    });
    const second = store.createMission({
      repoId: repo.id,
      route: "integration",
      urgent: false,
      title: "second",
      sourceKind: "pasted",
      content: "2",
      contentFormat: "markdown",
    });
    const third = store.createMission({
      repoId: repo.id,
      route: "integration",
      urgent: false,
      title: "third",
      sourceKind: "pasted",
      content: "3",
      contentFormat: "markdown",
    });
    expect(store.listMissions(repo.id).map((m) => m.id)).toEqual([first.id, second.id, third.id]);
  });
});

describe("SqliteDomainStore — tamper-evident open", () => {
  it("refuses a database claiming this schema version but missing the immutability triggers", () => {
    const path = tempDbPath();
    const store = new SqliteDomainStore(path);
    seedMission(store);
    store.close();

    const raw = new Database(path);
    raw.exec("DROP TRIGGER missions_immutable_update");
    raw.close();

    expect(() => new SqliteDomainStore(path)).toThrow(/missing missions_immutable_update/);
  });

  it("refuses a database missing the REPLACE-class insert guard", () => {
    const path = tempDbPath();
    const store = new SqliteDomainStore(path);
    seedMission(store);
    store.close();

    const raw = new Database(path);
    raw.exec("DROP TRIGGER missions_immutable_insert_conflict");
    raw.close();

    expect(() => new SqliteDomainStore(path)).toThrow(/missing missions_immutable_insert_conflict/);
  });

  it("refuses a database with an unknown schema version", () => {
    const path = tempDbPath();
    const raw = new Database(path);
    raw.pragma("user_version = 99");
    raw.close();
    expect(() => new SqliteDomainStore(path)).toThrow(/schema version 99/);
  });
});
