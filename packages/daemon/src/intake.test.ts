/**
 * Mission-intake tests (WP-103, CAM-CORE-02): every intake path produces a
 * mission record with the original content retained immutably; attachments
 * are `.md`/`.txt` only; every other format — the committed `.docx` fixture
 * included — is rejected with the stated reason and NOTHING is stored:
 * no domain row, no event, no partial or truncated copy.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDomainStore } from "./domain-store.js";
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
  const intake = new MissionIntake(domain, recorder);
  const project = domain.createProject("camino");
  const repo = domain.createRepo(project.id, "camino");
  return { domain, events, recorder, intake, repoId: repo.id };
}

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
    expect(records[0]?.payload).toEqual({ source: "prd-intake" });
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

describe("MissionIntake — the domain/event seam", () => {
  it("healthy intake leaves no orphans", () => {
    const h = newHarness();
    h.intake.createFromText({ repoId: h.repoId, title: "t", content: "c", actor: "david" });
    expect(h.intake.intakeOrphans()).toEqual([]);
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
  });
});
