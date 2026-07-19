/**
 * Domain model types (WP-103): project → repo → mission.
 *
 * The data model is multi-project from day one (CAM-CORE-06) even though v1
 * executes on one repo: missions belong to repos, repos belong to projects,
 * and every serialization rule is scoped per repo — adding a second project
 * or repo is a plain insert, never a schema change.
 *
 * A mission's STATE lives in the append-only event log (WP-101) and is
 * derived by replay; the mission RECORD here carries identity and the
 * immutably retained intake content (CAM-CORE-02). The two are joined by
 * mission id.
 */

/** Where a mission's content came from (CAM-CORE-02's three intake paths). */
export const MISSION_SOURCE_KINDS = ["pasted", "file", "quick-task"] as const;
export type MissionSourceKind = (typeof MISSION_SOURCE_KINDS)[number];

/**
 * How the retained content renders in the mission view. Markdown is
 * first-class; plain text renders preformatted. The format is fixed at
 * intake from the path (pasted PRD text and `.md` files are markdown,
 * `.txt` files and quick-task descriptions are text).
 */
export const MISSION_CONTENT_FORMATS = ["markdown", "text"] as const;
export type MissionContentFormat = (typeof MISSION_CONTENT_FORMATS)[number];

export interface Project {
  readonly id: string;
  readonly name: string;
  /** ISO-8601 UTC timestamp assigned at creation. */
  readonly createdAt: string;
}

export interface Repo {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  /** Optional git remote URL; onboarding records it, v1 does not require it. */
  readonly originUrl?: string;
  readonly createdAt: string;
}

/**
 * The mission's route through Appendix A: `integration` (A.1) for PRD
 * missions, `quick-task` (A.1b) for quick tasks. Mirrors @camino/core's
 * MissionRoute; declared here so the domain schema does not depend on core.
 */
export const MISSION_ROUTES = ["integration", "quick-task"] as const;
export type MissionRouteName = (typeof MISSION_ROUTES)[number];

export interface MissionRecord {
  readonly id: string;
  readonly repoId: string;
  readonly route: MissionRouteName;
  /**
   * True only for an urgent quick task: it schedules on the repo's urgent
   * lane instead of the primary execution slot (CAM-CORE-08 "one active
   * mission, plus the urgent lane"). Always false on the integration route.
   */
  readonly urgent: boolean;
  readonly title: string;
  readonly sourceKind: MissionSourceKind;
  /**
   * The original intake content, retained verbatim and immutably
   * (CAM-CORE-02): the exact pasted text, the uploaded file's exact decoded
   * text (byte-for-byte re-encodable, BOM and line endings preserved), or
   * the quick-task description.
   */
  readonly content: string;
  /** SHA-256 (hex) of the UTF-8 encoding of `content` — content identity. */
  readonly contentSha256: string;
  readonly contentFormat: MissionContentFormat;
  /** Present exactly when sourceKind is "file": the uploaded file's name. */
  readonly filename?: string;
  readonly createdAt: string;
}

/** Intake request DTOs (module-level today; the HTTP shell mounts them later). */

export interface PastedIntakeRequest {
  readonly repoId: string;
  readonly title: string;
  /** The PRD text exactly as typed or pasted. */
  readonly content: string;
  /** Who initiated intake (event-log actor). */
  readonly actor: string;
}

export interface FileIntakeRequest {
  readonly repoId: string;
  /** Defaults to the filename when omitted. */
  readonly title?: string;
  readonly filename: string;
  /** Raw uploaded bytes; decoded as strict UTF-8, never lossily. */
  readonly data: Uint8Array;
  readonly actor: string;
}

export interface QuickTaskIntakeRequest {
  readonly repoId: string;
  readonly title: string;
  /** The task description (renders as plain text). */
  readonly description: string;
  /** Claim the urgent lane instead of the primary slot (CAM-CORE-08). */
  readonly urgent: boolean;
  readonly actor: string;
}

/** Why an intake request was refused (CAM-CORE-02: stated reason, never a silent truncation). */
export type IntakeRejectionCode =
  | "unsupported-format" // extension outside the v1 allowlist (.md / .txt)
  | "not-utf8" // bytes do not decode as strict UTF-8
  | "content-too-large" // above the intake size bound
  | "empty-content" // nothing to retain
  | "unknown-repo" // repoId matches no repo
  | "invalid-request"; // malformed fields (missing title, empty filename, …)

export type IntakeResult =
  | { readonly ok: true; readonly mission: MissionRecord }
  | { readonly ok: false; readonly code: IntakeRejectionCode; readonly reason: string };
