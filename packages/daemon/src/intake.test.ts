/**
 * Mission-intake tests (WP-103, CAM-CORE-02): every intake path produces a
 * mission record with the original content retained immutably; attachments
 * are `.md`/`.txt` only; every other format — the committed `.docx` fixture
 * included — is rejected with the stated reason and NOTHING is stored:
 * no domain row, no event, no partial or truncated copy.
 */
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDomainStore, contentSha256 } from "./domain-store.js";
import { SqliteEventStore } from "./event-store.js";
import { TransitionRecorder } from "./transition-recorder.js";
import { INTAKE_MAX_CONTENT_BYTES, MissionIntake } from "./intake.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Harness {
  domain: SqliteDomainStore;
  events: SqliteEventStore;
  recorder: TransitionRecorder;
  intake: MissionIntake;
  repoId: string;
}

function newHarness(): Harness {
  const domain = new SqliteDomainStore(":memory:");
  const events = new SqliteEventStore(":memory:");
  cleanups.push(() => {
    domain.close();
    events.close();
  });
  const recorder = new TransitionRecorder(events);
  const intake = new MissionIntake(domain, recorder, events);
  const project = domain.createProject("camino");
  const repo = domain.createRepo(project.id, "camino");
  return { domain, events, recorder, intake, repoId: repo.id };
}

/** The healthy-state seam report: everything empty. */
const CLEAN_SEAM = {
  orphanRows: [],
  eventOnlyMissionIds: [],
  routeConflicts: [],
  creationConflicts: [],
  hierarchyGaps: { missionIdsWithoutRepo: [], repoIdsWithoutProject: [] },
};

const DOCX_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "intake",
  "sample-prd.docx",
);

/** Assert an intake refusal stored nothing at all: no rows, no events. */
function expectNothingStored(h: Harness): void {
  expect(h.domain.listMissions(h.repoId)).toEqual([]);
  expect(h.events.read()).toEqual([]);
  expect(h.recorder.currentView.missions.size).toBe(0);
}

describe("MissionIntake — pasted PRD text", () => {
  it("produces a mission record with the exact text retained and records A.1#1", () => {
    const h = newHarness();
    const content = "# Feature\r\n\nLine two with unicode — émojis 🚀 and\ttabs.\n";
    const result = h.intake.createFromText({
      repoId: h.repoId,
      title: "Evidence viewer v0",
      content,
      actor: "david",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Retained verbatim: what was pasted is what is stored.
    const stored = h.domain.getMission(result.mission.id);
    expect(stored?.content).toBe(content);
    expect(stored?.sourceKind).toBe("pasted");
    expect(stored?.contentFormat).toBe("markdown");
    expect(stored?.route).toBe("integration");
    expect(stored?.urgent).toBe(false);

    // The creation event is recorded through the machinery (A.1#1 → draft).
    const records = h.events.read({ entityKind: "mission", entityId: result.mission.id });
    expect(records).toHaveLength(1);
    expect(records[0]?.event).toBe("mission-created");
    expect(records[0]?.actor).toBe("david");
    expect(records[0]?.fromState).toBeNull();
    expect(records[0]?.toState).toBe("draft");
    // The creation event records the retained record's FULL bound identity —
    // the persistent cross-store binding (r2 f9, r3 f2, r4 f2).
    expect(records[0]?.payload).toEqual({
      source: "prd-intake",
      contentSha256: result.mission.contentSha256,
      repoId: h.repoId,
      title: "Evidence viewer v0",
      urgent: false,
      sourceKind: "pasted",
      contentFormat: "markdown",
    });
    expect(h.recorder.currentState("mission", result.mission.id)).toBe("draft");
  });

  it("rejects empty text with the stated reason and stores nothing", () => {
    const h = newHarness();
    const result = h.intake.createFromText({
      repoId: h.repoId,
      title: "t",
      content: "",
      actor: "david",
    });
    expect(result).toMatchObject({ ok: false, code: "empty-content" });
    expectNothingStored(h);
  });

  it("rejects an unknown repo before storing anything", () => {
    const h = newHarness();
    const result = h.intake.createFromText({
      repoId: "no-such-repo",
      title: "t",
      content: "content",
      actor: "david",
    });
    expect(result).toMatchObject({ ok: false, code: "unknown-repo" });
    expectNothingStored(h);
  });

  it("rejects content above the intake bound, stating the bound (never truncating)", () => {
    const h = newHarness();
    const oversize = "x".repeat(INTAKE_MAX_CONTENT_BYTES + 1);
    const result = h.intake.createFromText({
      repoId: h.repoId,
      title: "t",
      content: oversize,
      actor: "david",
    });
    expect(result).toMatchObject({ ok: false, code: "content-too-large" });
    if (result.ok) return;
    expect(result.reason).toContain(String(INTAKE_MAX_CONTENT_BYTES));
    expectNothingStored(h);
  });
});

describe("MissionIntake — uploaded files (.md / .txt only)", () => {
  it("accepts a .md upload, retains it byte-for-byte (BOM and CRLF preserved), markdown first-class", () => {
    const h = newHarness();
    // BOM + CRLF line endings + multibyte text: retention must be exact.
    const original = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("# Über-plan\r\n\r\n- item — ✓\r\n", "utf8"),
    ]);
    const result = h.intake.createFromFile({
      repoId: h.repoId,
      filename: "PRD.md",
      data: new Uint8Array(original),
      actor: "david",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = h.domain.getMission(result.mission.id);
    expect(stored?.sourceKind).toBe("file");
    expect(stored?.filename).toBe("PRD.md");
    expect(stored?.contentFormat).toBe("markdown");
    expect(stored?.title).toBe("PRD.md"); // defaults to the filename
    // Byte-identity: re-encoding the retained text reproduces the upload.
    expect(Buffer.from(stored?.content ?? "", "utf8").equals(original)).toBe(true);
  });

  it("accepts a .txt upload as plain text and honours case-insensitive extensions", () => {
    const h = newHarness();
    const result = h.intake.createFromFile({
      repoId: h.repoId,
      filename: "NOTES.TXT",
      data: new Uint8Array(Buffer.from("plain text notes\n", "utf8")),
      actor: "david",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mission.contentFormat).toBe("text");

    const md = h.intake.createFromFile({
      repoId: h.repoId,
      filename: "SPEC.MD",
      data: new Uint8Array(Buffer.from("# Spec\n", "utf8")),
      actor: "david",
    });
    expect(md.ok).toBe(true);
    if (!md.ok) return;
    expect(md.mission.contentFormat).toBe("markdown");
  });

  it("rejects the committed .docx fixture with the stated reason — never silently truncated (CAM-CORE-02)", () => {
    const h = newHarness();
    const docx = readFileSync(DOCX_FIXTURE);
    const result = h.intake.createFromFile({
      repoId: h.repoId,
      filename: "sample-prd.docx",
      data: new Uint8Array(docx),
      actor: "david",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unsupported-format");
    // The reason is stated and names the rule.
    expect(result.reason).toContain("sample-prd.docx");
    expect(result.reason).toContain(".md and .txt");
    expect(result.reason).toContain("not stored, converted, or truncated");
    // Nothing was stored — no truncated copy anywhere.
    expectNothingStored(h);
  });

  it("rejects other formats, extensionless names, and bare dotfiles with the same stated rule", () => {
    const h = newHarness();
    for (const filename of ["plan.pdf", "notes.markdown", "README", ".md", "archive.tar.gz"]) {
      const result = h.intake.createFromFile({
        repoId: h.repoId,
        filename,
        data: new Uint8Array(Buffer.from("content", "utf8")),
        actor: "david",
      });
      expect(result, filename).toMatchObject({ ok: false, code: "unsupported-format" });
    }
    expectNothingStored(h);
  });

  it("rejects bytes that are not strict UTF-8 rather than storing a lossy copy", () => {
    const h = newHarness();
    // 0xFF can never appear in UTF-8.
    const result = h.intake.createFromFile({
      repoId: h.repoId,
      filename: "binary.md",
      data: new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x00]),
      actor: "david",
    });
    expect(result).toMatchObject({ ok: false, code: "not-utf8" });
    expectNothingStored(h);
  });

  it("rejects filenames carrying path separators (stored verbatim, never resolved)", () => {
    const h = newHarness();
    for (const filename of ["../escape.md", "dir/nested.md", "back\\slash.md"]) {
      const result = h.intake.createFromFile({
        repoId: h.repoId,
        filename,
        data: new Uint8Array(Buffer.from("content", "utf8")),
        actor: "david",
      });
      expect(result, filename).toMatchObject({ ok: false, code: "invalid-request" });
    }
    expectNothingStored(h);
  });

  it("rejects an empty file with the stated reason", () => {
    const h = newHarness();
    const result = h.intake.createFromFile({
      repoId: h.repoId,
      filename: "empty.md",
      data: new Uint8Array(0),
      actor: "david",
    });
    expect(result).toMatchObject({ ok: false, code: "empty-content" });
    expectNothingStored(h);
  });
});

describe("MissionIntake — quick tasks", () => {
  it("produces a quick-task mission and records A.1b#1; the urgent flag persists", () => {
    const h = newHarness();
    const result = h.intake.createQuickTask({
      repoId: h.repoId,
      title: "Hotfix the login redirect",
      description: "The login page redirects to /old — point it at /home.",
      urgent: true,
      actor: "david",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = h.domain.getMission(result.mission.id);
    expect(stored?.route).toBe("quick-task");
    expect(stored?.urgent).toBe(true);
    expect(stored?.sourceKind).toBe("quick-task");
    expect(stored?.contentFormat).toBe("text");

    const records = h.events.read({ entityKind: "mission", entityId: result.mission.id });
    expect(records).toHaveLength(1);
    expect(records[0]?.event).toBe("quick-task-intake");
    expect(records[0]?.toState).toBe("draft");
    expect(records[0]?.cause).toContain("urgent lane");
  });

  it("non-urgent quick tasks record the plain cause", () => {
    const h = newHarness();
    const result = h.intake.createQuickTask({
      repoId: h.repoId,
      title: "Rename a label",
      description: "Rename 'Foo' to 'Bar' in the settings page.",
      urgent: false,
      actor: "david",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(h.domain.getMission(result.mission.id)?.urgent).toBe(false);
  });
});

describe("MissionIntake — ill-formed text is refused, never lossily stored (r1 finding 6)", () => {
  it("rejects pasted PRD text carrying an unpaired surrogate", () => {
    const h = newHarness();
    const result = h.intake.createFromText({
      repoId: h.repoId,
      title: "t",
      content: "A\uD800B",
      actor: "david",
    });
    expect(result).toMatchObject({ ok: false, code: "not-utf8" });
    if (result.ok) return;
    expect(result.reason).toContain("unpaired surrogate");
    expectNothingStored(h);
  });

  it("rejects valid text with an embedded NUL as a typed rejection, never a raw CHECK crash (r2 finding 4)", () => {
    const h = newHarness();
    // "\0hello" is six valid UTF-8 bytes, non-empty and well-formed — but
    // SQLite TEXT length() stops at the NUL, so before this fold the schema
    // CHECK crashed intake with a raw exception.
    const pasted = h.intake.createFromText({
      repoId: h.repoId,
      title: "t",
      content: "\0hello",
      actor: "david",
    });
    expect(pasted).toMatchObject({ ok: false, code: "embedded-nul" });
    const file = h.intake.createFromFile({
      repoId: h.repoId,
      filename: "nul.md",
      data: new Uint8Array(Buffer.from("\0hello", "utf8")),
      actor: "david",
    });
    expect(file).toMatchObject({ ok: false, code: "embedded-nul" });
    const quick = h.intake.createQuickTask({
      repoId: h.repoId,
      title: "t",
      description: "\0hello",
      urgent: false,
      actor: "david",
    });
    expect(quick).toMatchObject({ ok: false, code: "embedded-nul" });
    const title = h.intake.createFromText({
      repoId: h.repoId,
      title: "nul \0 title",
      content: "fine",
      actor: "david",
    });
    expect(title).toMatchObject({ ok: false, code: "invalid-request" });
    expectNothingStored(h);
  });

  it("rejects actors that cannot be recorded exactly (r2 finding 8)", () => {
    const h = newHarness();
    for (const actor of ["david\uD800", "david\0"]) {
      const result = h.intake.createFromText({
        repoId: h.repoId,
        title: "t",
        content: "c",
        actor,
      });
      expect(result, JSON.stringify(actor)).toMatchObject({
        ok: false,
        code: "invalid-request",
      });
    }
    expectNothingStored(h);
  });

  it("rejects quick-task descriptions and titles carrying unpaired surrogates", () => {
    const h = newHarness();
    const badDescription = h.intake.createQuickTask({
      repoId: h.repoId,
      title: "t",
      description: "fix \uDC00 this",
      urgent: false,
      actor: "david",
    });
    expect(badDescription).toMatchObject({ ok: false, code: "not-utf8" });
    const badTitle = h.intake.createFromText({
      repoId: h.repoId,
      title: "broken \uD800 title",
      content: "fine content",
      actor: "david",
    });
    expect(badTitle).toMatchObject({ ok: false, code: "invalid-request" });
    expectNothingStored(h);
  });
});

describe("MissionIntake — title bound counts code points (r1 finding 12)", () => {
  it("accepts 300 astral code points (600 UTF-16 units)", () => {
    const h = newHarness();
    const title = "🚀".repeat(300); // 300 code points, 600 UTF-16 units
    const result = h.intake.createFromText({
      repoId: h.repoId,
      title,
      content: "content",
      actor: "david",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects above the bound with the count stated in code points", () => {
    const h = newHarness();
    const title = "🚀".repeat(501);
    const result = h.intake.createFromText({
      repoId: h.repoId,
      title,
      content: "content",
      actor: "david",
    });
    expect(result).toMatchObject({ ok: false, code: "invalid-request" });
    if (result.ok) return;
    expect(result.reason).toContain("501 code points");
  });
});

describe("MissionIntake — the domain/event seam", () => {
  it("healthy intake leaves no orphans and no divergences", () => {
    const h = newHarness();
    h.intake.createFromText({ repoId: h.repoId, title: "t", content: "c", actor: "david" });
    expect(h.intake.intakeOrphans()).toEqual([]);
    expect(h.intake.seamDivergences()).toEqual(CLEAN_SEAM);
  });

  it("a domain row without a creation event is visible via intakeOrphans()", () => {
    const h = newHarness();
    // Simulate a crash between the two intake writes: the domain row landed,
    // the creation event did not.
    const stranded = h.domain.createMission({
      repoId: h.repoId,
      route: "integration",
      urgent: false,
      title: "stranded",
      sourceKind: "pasted",
      content: "content retained, no state yet",
      contentFormat: "markdown",
    });
    expect(h.intake.intakeOrphans().map((m) => m.id)).toEqual([stranded.id]);
    expect(h.intake.seamDivergences().orphanRows.map((m) => m.id)).toEqual([stranded.id]);
  });

  it("a recorded mission without a domain row is visible via seamDivergences() (r1 finding 8)", () => {
    const h = newHarness();
    // A foreign write records mission state with no retained content.
    h.recorder.record({
      entityKind: "mission",
      entityId: "event-only",
      event: "mission-created",
      actor: "camino:test",
      cause: "intake.test: state without content",
      payload: { source: "prd-intake" },
    });
    expect(h.intake.seamDivergences().eventOnlyMissionIds).toEqual(["event-only"]);
    expect(h.intake.intakeOrphans()).toEqual([]); // one-directional surface, by design
  });

  it("a domain/recorded route disagreement is visible via seamDivergences() (r1 finding 8)", () => {
    const h = newHarness();
    // Construct the split brain directly: a quick-task domain row whose id
    // was recorded with an INTEGRATION creation event.
    const row = h.domain.createMission({
      repoId: h.repoId,
      route: "quick-task",
      urgent: false,
      title: "split brain",
      sourceKind: "quick-task",
      content: "description",
      contentFormat: "text",
    });
    h.recorder.record({
      entityKind: "mission",
      entityId: row.id,
      event: "mission-created",
      actor: "camino:test",
      cause: "intake.test: conflicting creation route",
      payload: { source: "prd-intake" },
    });
    expect(h.intake.seamDivergences().routeConflicts).toEqual([
      { missionId: row.id, domainRoute: "quick-task", recordedRoute: "integration" },
    ]);
  });

  it("an id collision throws AND leaves a persistent creationConflicts signature (r1 f7, r2 f9)", () => {
    // Deterministic ids force the collision the reviewer probed: the event
    // log already holds a mission with the id intake will generate — SAME
    // route, so route conflicts stay silent; the bound fields cannot.
    const domain = new SqliteDomainStore(":memory:", { newId: () => "dup" });
    const events = new SqliteEventStore(":memory:");
    cleanups.push(() => {
      domain.close();
      events.close();
    });
    const recorder = new TransitionRecorder(events);
    const intake = new MissionIntake(domain, recorder, events);
    recorder.record({
      entityKind: "mission",
      entityId: "dup",
      event: "mission-created",
      actor: "prior",
      cause: "intake.test: pre-existing recorded mission",
      payload: { source: "prd-intake" },
    });
    const project = domain.createProject("camino");
    const repo = domain.createRepo(project.id, "camino");
    expect(() =>
      intake.createFromText({ repoId: repo.id, title: "t", content: "c", actor: "david" }),
    ).toThrow(/already-exists.*creationConflicts/s);
    // Not an orphan (the id IS recorded) — but the divergence is PERSISTENT:
    // the recorded creation event carries none of this row's bound fields.
    // (filename is absent on both sides, so it does not conflict.)
    expect(intake.intakeOrphans()).toEqual([]);
    const conflicts = intake.seamDivergences().creationConflicts;
    expect(conflicts.map((c) => c.field).sort()).toEqual([
      "contentFormat",
      "contentSha256",
      "repoId",
      "sourceKind",
      "title",
      "urgent",
    ]);
    expect(conflicts.every((c) => c.missionId === "dup")).toBe(true);
    expect(conflicts.every((c) => c.recordedValue === undefined)).toBe(true);
  });

  it("a SAME-CONTENT collision under a different title/repo still leaves evidence (r3 finding 2)", () => {
    // The reviewer's exact shape: identical content, so the content hash
    // matches — but the recorded repo binding and title cannot.
    const domain = new SqliteDomainStore(":memory:", { newId: () => "dup" });
    const events = new SqliteEventStore(":memory:");
    cleanups.push(() => {
      domain.close();
      events.close();
    });
    const recorder = new TransitionRecorder(events);
    const intake = new MissionIntake(domain, recorder, events);
    const project = domain.createProject("camino");
    const repo = domain.createRepo(project.id, "camino");
    const identical = "# identical";
    // The prior recorded mission carries FULL bindings (as real intake
    // would), for a different repo and title.
    recorder.record({
      entityKind: "mission",
      entityId: "dup",
      event: "mission-created",
      actor: "prior",
      cause: "intake.test: prior recorded mission with bindings",
      payload: {
        source: "prd-intake",
        contentSha256: contentSha256(identical),
        repoId: "some-other-repo",
        title: "original title",
      },
    });
    expect(() =>
      intake.createFromText({
        repoId: repo.id,
        title: "different title",
        content: identical,
        actor: "david",
      }),
    ).toThrow(/already-exists/);
    const conflicts = intake.seamDivergences().creationConflicts;
    // Content hashes match — repo binding and title still diverge, and the
    // prior event carried no urgent/source/format bindings.
    expect(conflicts.map((c) => c.field).sort()).toEqual([
      "contentFormat",
      "repoId",
      "sourceKind",
      "title",
      "urgent",
    ]);
    expect(conflicts.find((c) => c.field === "repoId")?.recordedValue).toBe("some-other-repo");
  });

  it("an urgent-flag divergence between the retained row and its creation event is visible (r4 finding 2)", () => {
    // The reviewer's shape: content, repo, title (and route) all agree —
    // only the urgency differs. Before r4 this was invisible.
    const domain = new SqliteDomainStore(":memory:", { newId: () => "dup" });
    const events = new SqliteEventStore(":memory:");
    cleanups.push(() => {
      domain.close();
      events.close();
    });
    const recorder = new TransitionRecorder(events);
    const intake = new MissionIntake(domain, recorder, events);
    const project = domain.createProject("camino");
    const repo = domain.createRepo(project.id, "camino");
    recorder.record({
      entityKind: "mission",
      entityId: "dup",
      event: "quick-task-intake",
      actor: "prior",
      cause: "intake.test: prior quick-task creation, non-urgent",
      payload: {
        contentSha256: contentSha256("same description"),
        repoId: repo.id,
        title: "same",
        urgent: false,
        sourceKind: "quick-task",
        contentFormat: "text",
      },
    });
    expect(() =>
      intake.createQuickTask({
        repoId: repo.id,
        title: "same",
        description: "same description",
        urgent: true,
        actor: "david",
      }),
    ).toThrow(/already-exists/);
    expect(intake.seamDivergences().creationConflicts).toEqual([
      { missionId: "dup", field: "urgent", domainValue: "true", recordedValue: "false" },
    ]);
  });

  it("a same-id collision where BOTH creations came through intake still shows a content conflict", () => {
    // Two intakes with colliding ids and different content: the recorded
    // creation hash belongs to the FIRST mission's content, the surviving
    // domain row... cannot exist (the insert-conflict guard refuses the
    // second row). Verify the guard fires — the collision cannot even reach
    // the event seam.
    const domain = new SqliteDomainStore(":memory:", { newId: () => "dup" });
    const events = new SqliteEventStore(":memory:");
    cleanups.push(() => {
      domain.close();
      events.close();
    });
    const recorder = new TransitionRecorder(events);
    const intake = new MissionIntake(domain, recorder, events);
    const project = domain.createProject("camino");
    const repo = domain.createRepo(project.id, "camino");
    const first = intake.createFromText({
      repoId: repo.id,
      title: "first",
      content: "first content",
      actor: "david",
    });
    expect(first.ok).toBe(true);
    expect(() =>
      intake.createFromText({
        repoId: repo.id,
        title: "second",
        content: "second content",
        actor: "david",
      }),
    ).toThrow(/immutable/);
    expect(intake.seamDivergences()).toEqual(CLEAN_SEAM);
  });

  it("hierarchy gaps from a foreign writer are visible (r2 finding 9)", () => {
    const h = newHarness();
    // A raw writer with foreign keys off leaves a mission under a missing
    // repo. Reproduce via a raw connection on a shared file database.
    const dir = mkdtempSync(join(tmpdir(), "camino-intake-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "domain.db");
    const domain = new SqliteDomainStore(path);
    const events = new SqliteEventStore(":memory:");
    cleanups.push(() => {
      domain.close();
      events.close();
    });
    const recorder = new TransitionRecorder(events);
    const intake = new MissionIntake(domain, recorder, events);
    const raw = new Database(path);
    // A foreign writer that has switched foreign-key enforcement off.
    raw.pragma("foreign_keys = OFF");
    raw
      .prepare(
        `INSERT INTO missions
           (id, repo_id, route, urgent, title, source_kind, content, content_sha256, content_format, filename, created_at)
         VALUES ('foreign-mission', 'no-such-repo', 'integration', 0, 't', 'pasted', 'c', ?, 'markdown', NULL, 'now')`,
      )
      .run("0".repeat(64));
    raw.close();
    const report = intake.seamDivergences();
    expect(report.hierarchyGaps.missionIdsWithoutRepo).toEqual(["foreign-mission"]);
    // The row is ALSO an orphan (no creation event) — table-scanned, so the
    // broken hierarchy cannot hide it (the r2 receipt showed the old
    // traversal missing it entirely).
    expect(report.orphanRows.map((m) => m.id)).toEqual(["foreign-mission"]);
    expect(h.intake.seamDivergences()).toEqual(CLEAN_SEAM); // unrelated harness unaffected
  });
});
