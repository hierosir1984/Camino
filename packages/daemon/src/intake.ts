/**
 * Mission intake (WP-103, CAM-CORE-02): every mission enters through one of
 * three paths — pasted/typed PRD text, an uploaded `.md`/`.txt` file
 * (markdown first-class), or a quick task — and every path produces a
 * mission record with the original content retained immutably, plus the
 * mission's creation event through the transition recorder (A.1#1 for PRD
 * missions, A.1b#1 for quick tasks).
 *
 * Rejections are stated, never silent, and never partial: an unsupported
 * format (`.docx`, everything outside the v1 allowlist), bytes that are not
 * strict UTF-8, oversize or empty content, or an unknown repo each return a
 * typed reason and store NOTHING — content is never truncated, converted,
 * or lossily decoded on the way in. Format converters are a recorded future
 * item, not a silent fallback.
 *
 * Write ordering at the two-store seam (domain row, then creation event):
 * the content is durably retained before any state exists for it. A crash
 * between the two leaves a domain row with no creation event — visible via
 * `intakeOrphans()`, never a half-retained mission with state. The durable
 * recovery/idempotency contract that sweeps such seams is WP-104
 * (CAM-STATE-02/03); this module states the seam rather than hiding it.
 */
import type {
  FileIntakeRequest,
  IntakeRejectionCode,
  IntakeResult,
  MissionContentFormat,
  MissionRecord,
  PastedIntakeRequest,
  QuickTaskIntakeRequest,
} from "@camino/shared";
import type { SqliteDomainStore } from "./domain-store.js";
import type { TransitionRecorder } from "./transition-recorder.js";

/**
 * v1 attachment allowlist (CAM-CORE-02): markdown first-class, plain text
 * second. Everything else — `.docx` included — is rejected with the reason
 * below; converters are future work, not a fallback.
 */
export const INTAKE_ACCEPTED_EXTENSIONS: Readonly<Record<string, MissionContentFormat>> = {
  ".md": "markdown",
  ".txt": "text",
};

/** Upper bound on retained intake content (bytes of UTF-8). Stated in every oversize rejection. */
export const INTAKE_MAX_CONTENT_BYTES = 10 * 1024 * 1024;

/** Upper bound on title length (characters). */
export const INTAKE_MAX_TITLE_CHARS = 500;

interface IntakeRejection {
  readonly ok: false;
  readonly code: IntakeRejectionCode;
  readonly reason: string;
}

function reject(code: IntakeRejectionCode, reason: string): IntakeRejection {
  return { ok: false, code, reason };
}

export class MissionIntake {
  private readonly domain: SqliteDomainStore;
  private readonly recorder: TransitionRecorder;

  constructor(domain: SqliteDomainStore, recorder: TransitionRecorder) {
    this.domain = domain;
    this.recorder = recorder;
  }

  /** Pasted/typed PRD text. PRD text is markdown first-class. */
  createFromText(request: PastedIntakeRequest): IntakeResult {
    const { repoId, title, content, actor } = request;
    const common = this.validateCommon(repoId, title, actor);
    if (common) return common;
    if (typeof content !== "string" || content.length === 0) {
      return reject("empty-content", "PRD text is empty — there is nothing to retain.");
    }
    const size = Buffer.byteLength(content, "utf8");
    if (size > INTAKE_MAX_CONTENT_BYTES) {
      return reject(
        "content-too-large",
        `PRD text is ${size} bytes; the intake bound is ${INTAKE_MAX_CONTENT_BYTES} bytes ` +
          "(nothing was stored — split the document or raise the bound deliberately).",
      );
    }
    return this.persist({
      repoId,
      route: "integration",
      urgent: false,
      title,
      sourceKind: "pasted",
      content,
      contentFormat: "markdown",
      actor,
      cause: "mission intake: pasted PRD text",
      creationEvent: "mission-created",
      creationPayload: { source: "prd-intake" },
    });
  }

  /**
   * Uploaded/attached file. Accepts `.md` and `.txt` only (case-insensitive);
   * every other format is rejected with the stated reason (CAM-CORE-02) —
   * a `.docx` is refused outright, never converted or truncated. Bytes must
   * decode as strict UTF-8; the decoded text re-encodes byte-for-byte (BOM
   * and line endings preserved), so retention is exact.
   */
  createFromFile(request: FileIntakeRequest): IntakeResult {
    const { repoId, filename, data, actor } = request;
    const title = request.title ?? filename;
    const common = this.validateCommon(repoId, title, actor);
    if (common) return common;
    if (typeof filename !== "string" || filename.length === 0) {
      return reject("invalid-request", "filename is required for file intake.");
    }
    if (/[/\\]/.test(filename)) {
      return reject(
        "invalid-request",
        "filename must be a bare name without path separators; it is stored verbatim, never resolved as a path.",
      );
    }
    const format = extensionFormat(filename);
    if (format === undefined) {
      return reject(
        "unsupported-format",
        `"${filename}" is not an accepted attachment format: v1 accepts .md and .txt only ` +
          "(CAM-CORE-02); the file was not stored, converted, or truncated. " +
          "Format converters are a recorded future item.",
      );
    }
    if (!(data instanceof Uint8Array)) {
      return reject("invalid-request", "file data must be the raw uploaded bytes (Uint8Array).");
    }
    if (data.byteLength === 0) {
      return reject("empty-content", `"${filename}" is empty — there is nothing to retain.`);
    }
    if (data.byteLength > INTAKE_MAX_CONTENT_BYTES) {
      return reject(
        "content-too-large",
        `"${filename}" is ${data.byteLength} bytes; the intake bound is ${INTAKE_MAX_CONTENT_BYTES} bytes ` +
          "(nothing was stored — the file was not truncated).",
      );
    }
    let content: string;
    try {
      // fatal: refuse rather than substitute replacement characters;
      // ignoreBOM: keep the BOM in the decoded text so re-encoding
      // reproduces the uploaded bytes exactly.
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
    } catch {
      return reject(
        "not-utf8",
        `"${filename}" does not decode as UTF-8 text; refusing to store a lossy copy ` +
          "(binary or differently-encoded files are outside the v1 .md/.txt intake).",
      );
    }
    return this.persist({
      repoId,
      route: "integration",
      urgent: false,
      title,
      sourceKind: "file",
      content,
      contentFormat: format,
      filename,
      actor,
      cause: `mission intake: uploaded file ${filename}`,
      creationEvent: "mission-created",
      creationPayload: { source: "prd-intake" },
    });
  }

  /** A single quick task (A.1b route); `urgent: true` schedules it on the urgent lane. */
  createQuickTask(request: QuickTaskIntakeRequest): IntakeResult {
    const { repoId, title, description, urgent, actor } = request;
    const common = this.validateCommon(repoId, title, actor);
    if (common) return common;
    if (typeof urgent !== "boolean") {
      return reject("invalid-request", "urgent must be true or false.");
    }
    if (typeof description !== "string" || description.length === 0) {
      return reject(
        "empty-content",
        "quick-task description is empty — there is nothing to retain.",
      );
    }
    const size = Buffer.byteLength(description, "utf8");
    if (size > INTAKE_MAX_CONTENT_BYTES) {
      return reject(
        "content-too-large",
        `quick-task description is ${size} bytes; the intake bound is ${INTAKE_MAX_CONTENT_BYTES} bytes.`,
      );
    }
    return this.persist({
      repoId,
      route: "quick-task",
      urgent,
      title,
      sourceKind: "quick-task",
      content: description,
      contentFormat: "text",
      actor,
      cause: urgent ? "quick-task intake (urgent lane)" : "quick-task intake",
      creationEvent: "quick-task-intake",
      creationPayload: {},
    });
  }

  /**
   * Domain rows whose mission has no creation event in the recorded view —
   * the visible residue of a crash between the two intake writes. Empty in
   * healthy operation; WP-104's recovery contract owns sweeping it.
   */
  intakeOrphans(): MissionRecord[] {
    const view = this.recorder.currentView;
    const orphans: MissionRecord[] = [];
    for (const project of this.domain.listProjects()) {
      for (const repo of this.domain.listRepos(project.id)) {
        for (const mission of this.domain.listMissions(repo.id)) {
          if (!view.missions.has(mission.id)) orphans.push(mission);
        }
      }
    }
    return orphans;
  }

  private validateCommon(repoId: string, title: string, actor: string): IntakeRejection | null {
    if (typeof actor !== "string" || actor.length === 0) {
      return reject(
        "invalid-request",
        "actor is required (every intake is recorded with its actor).",
      );
    }
    if (typeof title !== "string" || title.length === 0) {
      return reject("invalid-request", "title is required.");
    }
    if (title.length > INTAKE_MAX_TITLE_CHARS) {
      return reject(
        "invalid-request",
        `title is ${title.length} characters; the bound is ${INTAKE_MAX_TITLE_CHARS}.`,
      );
    }
    if (typeof repoId !== "string" || repoId.length === 0) {
      return reject("invalid-request", "repoId is required.");
    }
    if (this.domain.getRepo(repoId) === undefined) {
      return reject("unknown-repo", `repo ${repoId} does not exist.`);
    }
    return null;
  }

  private persist(args: {
    repoId: string;
    route: "integration" | "quick-task";
    urgent: boolean;
    title: string;
    sourceKind: "pasted" | "file" | "quick-task";
    content: string;
    contentFormat: MissionContentFormat;
    filename?: string;
    actor: string;
    cause: string;
    creationEvent: "mission-created" | "quick-task-intake";
    creationPayload: Record<string, unknown>;
  }): IntakeResult {
    const mission = this.domain.createMission({
      repoId: args.repoId,
      route: args.route,
      urgent: args.urgent,
      title: args.title,
      sourceKind: args.sourceKind,
      content: args.content,
      contentFormat: args.contentFormat,
      ...(args.filename === undefined ? {} : { filename: args.filename }),
    });
    const outcome = this.recorder.record({
      entityKind: "mission",
      entityId: mission.id,
      event: args.creationEvent,
      actor: args.actor,
      cause: args.cause,
      payload: args.creationPayload,
    });
    if (!outcome.ok) {
      // Intake constructs the creation payload itself, so a refusal here is
      // an internal invariant breach (e.g. an id collision), not a user
      // rejection: fail loudly; the retained row is visible via intakeOrphans.
      throw new Error(
        `mission ${mission.id} was retained but its creation event was refused (${outcome.code}) — ` +
          "intake stopped at the domain/event seam; see intakeOrphans()",
      );
    }
    return { ok: true, mission };
  }
}

/** Map a filename to its accepted content format, or undefined when outside the allowlist. */
function extensionFormat(filename: string): MissionContentFormat | undefined {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return undefined; // no extension, or a bare dotfile like ".md"
  const extension = filename.slice(dot).toLowerCase();
  return INTAKE_ACCEPTED_EXTENSIONS[extension];
}
