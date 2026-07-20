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
  EventStore,
  FileIntakeRequest,
  IntakeRejectionCode,
  IntakeResult,
  MissionContentFormat,
  MissionRecord,
  MissionRouteName,
  PastedIntakeRequest,
  QuickTaskIntakeRequest,
} from "@camino/shared";
import type { SqliteDomainStore } from "./domain-store.js";
import type { TransitionRecorder } from "./transition-recorder.js";

/**
 * v1 attachment allowlist (CAM-CORE-02): markdown first-class, plain text
 * second. Everything else — `.docx` included — is rejected with the reason
 * below; converters are future work, not a fallback.
 *
 * FROZEN: `Readonly<...>` is a compile-time annotation, not a runtime one. On
 * the unfrozen record a package-root importer could add `".exe": "text"` and
 * widen the accepted-extension allowlist through the public barrel alone — no
 * deep import, no gated-object mutation (the named WP-107 boundary). Freezing
 * makes the allowlist non-extensible; lookups are unaffected.
 */
export const INTAKE_ACCEPTED_EXTENSIONS: Readonly<Record<string, MissionContentFormat>> =
  Object.freeze({
    ".md": "markdown",
    ".txt": "text",
  });

/**
 * Upper bound on retained intake content (bytes of UTF-8), stated in every
 * oversize rejection. 1 MiB ≈ 500 pages of text — far above any real PRD,
 * and small enough that even the worst-expansion HTML-escape fallback stays
 * a few-MB, tens-of-ms operation (r2 finding 2's measurements).
 */
export const INTAKE_MAX_CONTENT_BYTES = 1024 * 1024;

/** Upper bound on title length (Unicode code points, stated in the rejection — r1 finding 12). */
export const INTAKE_MAX_TITLE_CODE_POINTS = 500;

interface IntakeRejection {
  readonly ok: false;
  readonly code: IntakeRejectionCode;
  readonly reason: string;
}

/** A mission id whose domain route disagrees with the recorded creation route. */
export interface RouteConflict {
  readonly missionId: string;
  readonly domainRoute: MissionRouteName;
  readonly recordedRoute: string;
}

/**
 * A mission id whose retained record disagrees with its recorded creation
 * event on one of the BOUND fields — every observable creation-time fact:
 * content hash, repo binding, title, urgent flag, source kind, content
 * format, filename (r2 f9; widened by r3 f2 and again by r4 f2 — content/
 * repo/title alone let an urgent-flag or source divergence hide). The
 * persistent signature of an id-collision or a foreign creation write. A
 * collision identical in ALL bound fields (plus route, which the creation
 * event type itself encodes) is observationally identical to the recorded
 * mission apart from its timestamps; the intake error thrown at the seam
 * remains its only signal, stated plainly. Values are reported as strings
 * (`urgent` as "true"/"false").
 */
export interface CreationConflict {
  readonly missionId: string;
  readonly field:
    "contentSha256" | "repoId" | "title" | "urgent" | "sourceKind" | "contentFormat" | "filename";
  /** Absent when the domain side has no value (e.g. filename on non-file intake). */
  readonly domainValue?: string;
  /** The creation event's recorded value; undefined when the event carries none. */
  readonly recordedValue?: string;
  /**
   * True when the field is PRESENT on the creation event but not the
   * expected primitive type. Carried OUT OF BAND (r6 finding 2): an
   * in-band sentinel string could equal a legitimate domain value and
   * vanish from the report.
   */
  readonly recordedMalformed?: true;
}

/** Bidirectional domain/event seam report — see `MissionIntake.seamDivergences`. */
export interface SeamDivergences {
  readonly orphanRows: readonly MissionRecord[];
  readonly eventOnlyMissionIds: readonly string[];
  readonly routeConflicts: readonly RouteConflict[];
  readonly creationConflicts: readonly CreationConflict[];
  /** Referential gaps a foreign writer can leave (missions without a repo, repos without a project). */
  readonly hierarchyGaps: {
    readonly missionIdsWithoutRepo: readonly string[];
    readonly repoIdsWithoutProject: readonly string[];
  };
}

/** A creation-payload binding as recorded: a string value, or present-but-malformed. */
type RecordedBinding = { kind: "value"; value: string } | { kind: "malformed" };

function reject(code: IntakeRejectionCode, reason: string): IntakeRejection {
  return { ok: false, code, reason };
}

export class MissionIntake {
  private readonly domain: SqliteDomainStore;
  private readonly recorder: TransitionRecorder;
  private readonly store: EventStore;

  constructor(domain: SqliteDomainStore, recorder: TransitionRecorder, store: EventStore) {
    this.domain = domain;
    this.recorder = recorder;
    this.store = store;
  }

  /** Pasted/typed PRD text. PRD text is markdown first-class. */
  createFromText(request: PastedIntakeRequest): IntakeResult {
    const { repoId, title, content, actor } = request;
    const common = this.validateCommon(repoId, title, actor);
    if (common) return common;
    if (typeof content !== "string") {
      return reject("invalid-request", "PRD text must be a string.");
    }
    if (content.length === 0) {
      return reject("empty-content", "PRD text is empty — there is nothing to retain.");
    }
    if (!content.isWellFormed()) {
      return reject(
        "not-utf8",
        "PRD text contains unpaired surrogate code units, which have no UTF-8 encoding; " +
          "storing it would substitute replacement characters instead of retaining the exact text.",
      );
    }
    if (content.includes("\0")) {
      return reject(
        "embedded-nul",
        "PRD text contains an embedded NUL (U+0000), which SQLite TEXT cannot hold faithfully; " +
          "nothing was stored.",
      );
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
    if (!filename.isWellFormed() || filename.includes("\0")) {
      return reject(
        "invalid-request",
        "filename contains unpaired surrogate code units or an embedded NUL and cannot be " +
          "retained exactly.",
      );
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
    if (content.includes("\0")) {
      return reject(
        "embedded-nul",
        `"${filename}" contains an embedded NUL byte (U+0000), which SQLite TEXT cannot hold ` +
          "faithfully; nothing was stored.",
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
    if (typeof description !== "string") {
      return reject("invalid-request", "quick-task description must be a string.");
    }
    if (description.length === 0) {
      return reject(
        "empty-content",
        "quick-task description is empty — there is nothing to retain.",
      );
    }
    if (!description.isWellFormed()) {
      return reject(
        "not-utf8",
        "quick-task description contains unpaired surrogate code units, which have no UTF-8 " +
          "encoding; storing it would substitute replacement characters instead of the exact text.",
      );
    }
    if (description.includes("\0")) {
      return reject(
        "embedded-nul",
        "quick-task description contains an embedded NUL (U+0000), which SQLite TEXT cannot " +
          "hold faithfully; nothing was stored.",
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
   * Domain rows whose mission id has no recorded mission in the view — the
   * visible residue of a crash between the two intake writes. Empty in
   * healthy operation; WP-104's recovery contract owns sweeping it.
   * Scans the missions TABLE itself, so rows under a broken hierarchy are
   * still seen (r2 finding 9).
   *
   * Membership is by id, so a retained row whose creation event was refused
   * BECAUSE an unrelated recorded mission already holds the same id is NOT
   * listed here — that case has a PERSISTENT signature in
   * `seamDivergences().creationConflicts` unless the two missions agree on
   * EVERY bound creation field (content hash, repo, title, urgent, source
   * kind, format, filename — r5 finding 5 updated this from the older
   * three-field condition), in which case they are observationally
   * identical apart from timestamps and the intake error thrown at the
   * seam is the only signal, stated plainly.
   */
  intakeOrphans(): MissionRecord[] {
    const view = this.recorder.currentView;
    const orphans: MissionRecord[] = [];
    for (const mission of this.domain.listAllMissions()) {
      if (!view.missions.has(mission.id)) orphans.push(mission);
    }
    return orphans;
  }

  /**
   * Bidirectional domain/event reconciliation (r1 finding 8, r2 finding 9):
   * the seam is honest only if BOTH directions — and the table itself, not
   * just the reachable hierarchy — are visible. Reports
   * - `orphanRows`: domain rows with no recorded mission (crash residue);
   * - `eventOnlyMissionIds`: recorded missions with no domain row — state
   *   without retained content (foreign write or partial restore);
   * - `routeConflicts`: domain route vs recorded creation route;
   * - `creationConflicts`: the retained record's SEVEN bound fields
   *   (content hash, repo binding, title, urgent flag, source kind,
   *   content format, filename) vs what the creation event recorded.
   *   Intake stamps the first six into every creation payload it authors;
   *   `filename` is stamped exactly when the mission has one — absence is
   *   represented by OMISSION, and the comparison treats both-absent as
   *   agreement (r6 f5, precision per r7 f5). The persistent signature of
   *   an id collision or a foreign creation, even when routes agree and
   *   content matches (r3 f2, r4 f2);
   * - `hierarchyGaps`: missions without a repo row, repos without a project
   *   row (foreign writers with foreign keys off).
   * Empty across the board in healthy operation; WP-104's recovery contract
   * owns repair.
   */
  seamDivergences(): SeamDivergences {
    const view = this.recorder.currentView;
    const orphanRows: MissionRecord[] = [];
    const routeConflicts: RouteConflict[] = [];
    const creationConflicts: CreationConflict[] = [];
    const domainIds = new Set<string>();
    const creationBindings = this.recordedCreationBindings();
    for (const mission of this.domain.listAllMissions()) {
      domainIds.add(mission.id);
      const snapshot = view.missions.get(mission.id);
      if (snapshot === undefined) {
        orphanRows.push(mission);
        continue;
      }
      if (snapshot.route !== mission.route) {
        routeConflicts.push({
          missionId: mission.id,
          domainRoute: mission.route,
          recordedRoute: snapshot.route,
        });
      }
      const binding = creationBindings.get(mission.id) ?? {};
      const comparisons: ReadonlyArray<
        [CreationConflict["field"], string | undefined, RecordedBinding | undefined]
      > = [
        ["contentSha256", mission.contentSha256, binding["contentSha256"]],
        ["repoId", mission.repoId, binding["repoId"]],
        ["title", mission.title, binding["title"]],
        ["urgent", String(mission.urgent), binding["urgent"]],
        ["sourceKind", mission.sourceKind, binding["sourceKind"]],
        ["contentFormat", mission.contentFormat, binding["contentFormat"]],
        ["filename", mission.filename, binding["filename"]],
      ];
      for (const [field, domainValue, recorded] of comparisons) {
        // Tagged comparison (r6 finding 2): a malformed-present binding is a
        // conflict REGARDLESS of the domain value; absence and value carry
        // their own rules. No in-band sentinel exists to collide with.
        const agrees =
          recorded === undefined
            ? domainValue === undefined
            : recorded.kind === "value" && recorded.value === domainValue;
        if (!agrees) {
          creationConflicts.push({
            missionId: mission.id,
            field,
            ...(domainValue === undefined ? {} : { domainValue }),
            ...(recorded !== undefined && recorded.kind === "value"
              ? { recordedValue: recorded.value }
              : {}),
            ...(recorded !== undefined && recorded.kind === "malformed"
              ? { recordedMalformed: true as const }
              : {}),
          });
        }
      }
    }
    const eventOnlyMissionIds: string[] = [];
    for (const missionId of view.missions.keys()) {
      if (!domainIds.has(missionId)) eventOnlyMissionIds.push(missionId);
    }
    return {
      orphanRows,
      eventOnlyMissionIds,
      routeConflicts,
      creationConflicts,
      hierarchyGaps: this.domain.hierarchyGaps(),
    };
  }

  /**
   * The bound fields each recorded mission's APPLIED creation event carries
   * (if any), normalized to strings for comparison. Only creations authored
   * by THIS module are guaranteed to carry them (r4 finding 5) — a foreign
   * creation without bindings shows every field as a conflict once a domain
   * row exists for the id.
   */
  private recordedCreationBindings(): Map<string, Record<string, RecordedBinding | undefined>> {
    const bindings = new Map<string, Record<string, RecordedBinding | undefined>>();
    for (const record of this.store.read({ entityKind: "mission" })) {
      if (record.outcome !== "applied" || record.fromState !== null) continue;
      const normalized: Record<string, RecordedBinding | undefined> = {};
      // Absence and malformed presence are DIFFERENT facts (r5 finding 2),
      // and malformed-ness is carried as a TAG, not an in-band sentinel a
      // legitimate value could equal (r6 finding 2).
      const normalize = (
        field: string,
        expect: "string" | "boolean",
      ): RecordedBinding | undefined => {
        if (!Object.prototype.hasOwnProperty.call(record.payload, field)) return undefined;
        const value = record.payload[field];
        if (expect === "boolean") {
          return typeof value === "boolean"
            ? { kind: "value", value: String(value) }
            : { kind: "malformed" };
        }
        return typeof value === "string" ? { kind: "value", value } : { kind: "malformed" };
      };
      for (const field of [
        "contentSha256",
        "repoId",
        "title",
        "sourceKind",
        "contentFormat",
        "filename",
      ]) {
        normalized[field] = normalize(field, "string");
      }
      normalized["urgent"] = normalize("urgent", "boolean");
      bindings.set(record.entityId, normalized);
    }
    return bindings;
  }

  private validateCommon(repoId: string, title: string, actor: string): IntakeRejection | null {
    if (typeof actor !== "string" || actor.length === 0) {
      return reject(
        "invalid-request",
        "actor is required (every intake is recorded with its actor).",
      );
    }
    // The actor is persisted in the event log; it must round-trip exactly
    // there too (r2 finding 8 — validated at THIS boundary; the recorder
    // envelope itself is WP-101 machinery, consumed as-is).
    if (!actor.isWellFormed() || actor.includes("\0")) {
      return reject(
        "invalid-request",
        "actor contains unpaired surrogate code units or an embedded NUL and cannot be " +
          "recorded exactly.",
      );
    }
    if (typeof title !== "string" || title.length === 0) {
      return reject("invalid-request", "title is required.");
    }
    if (!title.isWellFormed() || title.includes("\0")) {
      return reject(
        "invalid-request",
        "title contains unpaired surrogate code units or an embedded NUL and cannot be " +
          "retained exactly.",
      );
    }
    const titleCodePoints = [...title].length;
    if (titleCodePoints > INTAKE_MAX_TITLE_CODE_POINTS) {
      return reject(
        "invalid-request",
        `title is ${titleCodePoints} code points; the bound is ${INTAKE_MAX_TITLE_CODE_POINTS}.`,
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
      // The creation event records the retained record's FULL bound
      // identity — every observable creation-time fact — the persistent
      // cross-store binding seamDivergences() audits (r2 f9, r3 f2, r4 f2).
      payload: {
        ...args.creationPayload,
        contentSha256: mission.contentSha256,
        repoId: mission.repoId,
        title: mission.title,
        urgent: mission.urgent,
        sourceKind: mission.sourceKind,
        contentFormat: mission.contentFormat,
        ...(mission.filename === undefined ? {} : { filename: mission.filename }),
      },
    });
    if (!outcome.ok) {
      // Intake constructs the creation payload itself, so a refusal here is
      // an internal invariant breach, not a user rejection: fail loudly and
      // say which surface holds the residue (r1 finding 7). On
      // `already-exists` an unrelated recorded mission holds this id, so the
      // retained row is NOT an intakeOrphans() entry — seamDivergences()
      // reports the disagreement instead.
      const surface =
        outcome.code === "already-exists"
          ? "an unrelated recorded mission already holds this id (id-generation defect); the " +
            "retained row is NOT an intakeOrphans() entry — seamDivergences().creationConflicts " +
            "carries its persistent signature unless EVERY bound creation field coincides, in " +
            "which case this error is the only signal"
          : "see intakeOrphans()";
      throw new Error(
        `mission ${mission.id} was retained but its creation event was refused (${outcome.code}) — ` +
          `intake stopped at the domain/event seam; ${surface}`,
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
