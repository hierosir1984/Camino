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
    expect(() => store.createProject("camino")).toThrow(/UNIQUE/i);
    expect(() => store.createRepo(project.id, "repo")).toThrow(/UNIQUE/i);
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

  it("refuses a database with an unknown schema version", () => {
    const path = tempDbPath();
    const raw = new Database(path);
    raw.pragma("user_version = 99");
    raw.close();
    expect(() => new SqliteDomainStore(path)).toThrow(/schema version 99/);
  });
});
