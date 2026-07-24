/**
 * Per-repo operational knowledge types (WP-113, CAM-CANON-09; design §3.7).
 *
 * `.camino/knowledge.md` names the knowledge BASE; the store in the control
 * plane is authoritative and the repo file is a rendered projection of
 * approved entries (same relationship canon.md has to the intent ledger).
 * Attempts write CANDIDATE entries with provenance and commit/base validity
 * into the control plane immediately — nothing is lost with a failed
 * workspace. Promotion to APPROVED — the only state that enters other
 * missions' context packs — happens through a human curation batch or one of
 * exactly two deterministic rule-classes, never an unattended creative
 * judgment (design invariant 2).
 *
 * Like the intent ledger, the knowledge lifecycle is event-sourced: the
 * store appends events; every state is a fold in @camino/core. Rule-class
 * promotions are RE-VERIFIED at fold time against the store's own
 * observation events, so a promotion row cannot smuggle in evidence the
 * store never saw.
 */

/**
 * Entry classes. The two structured classes carry a machine-comparable
 * (subjectKey, claim) pair — they are what the deterministic rule-classes
 * and contradiction detection are defined over. `note` is free prose.
 *
 * BOUNDARY, stated (same class as the WP-003 git-fsck and WP-102 token-dir
 * boundaries): deterministic contradiction detection is defined ONLY over
 * declared (class, subjectKey, claim) triples. Two prose notes that
 * contradict each other semantically without declaring the same subjectKey
 * are NOT detected — detecting that would be an unattended creative
 * judgment (invariant 2). Prose contradictions surface through human
 * curation, which reviews every candidate batch anyway.
 */
export const KNOWLEDGE_ENTRY_CLASSES = Object.freeze(["command", "flaky-test", "note"] as const);
export type KnowledgeEntryClass = (typeof KNOWLEDGE_ENTRY_CLASSES)[number];

/** Claims a `command` entry may make about its subject command line. */
export const COMMAND_CLAIMS = Object.freeze(["succeeds", "fails"] as const);
export type CommandClaim = (typeof COMMAND_CLAIMS)[number];

/** Claims a `flaky-test` entry may make about its subject test id. */
export const FLAKY_TEST_CLAIMS = Object.freeze(["flaky", "stable"] as const);
export type FlakyTestClaim = (typeof FLAKY_TEST_CLAIMS)[number];

/**
 * Entry states as the fold derives them. Expiry is deliberately NOT a
 * state: an entry past its `expiresAt` keeps its stored state and every
 * read filters it out against the reader's clock — a store never needs a
 * clock-driven background transition (same posture as canon folds).
 */
export const KNOWLEDGE_ENTRY_STATES = Object.freeze([
  "candidate",
  "approved",
  /** Curation resolved against the candidate. */
  "rejected",
  /** A revert removed the entry's validity base (CAM-CANON-09). */
  "invalidated",
  /** Curation retired a previously approved entry (contradiction resolution). */
  "retired",
] as const);
export type KnowledgeEntryState = (typeof KNOWLEDGE_ENTRY_STATES)[number];

/** Scope: a repo area (path-shaped label) or the whole repo (CAM-CANON-09). */
export type KnowledgeScope =
  { readonly kind: "global" } | { readonly kind: "repo-area"; readonly area: string };

/**
 * Where an entry came from: the attempt that wrote it, in full mission
 * context. Rendered wherever the entry is shown — a same-issue repair
 * attempt reading a sibling's candidate must see it is an unvetted sibling
 * observation (design §3.7).
 */
export interface KnowledgeProvenance {
  readonly missionId: string;
  readonly issueId: string;
  readonly attemptId: string;
  /** Short human context: how the knowledge was discovered. */
  readonly context: string;
}

/**
 * Commit/base validity (CAM-CANON-09): the worker head the knowledge was
 * observed at and that head's base on main. A revert of either SHA
 * invalidates the entry — the world the observation was made in is gone.
 */
export interface KnowledgeValidity {
  readonly commitSha: string;
  readonly baseSha: string;
}

/** A knowledge entry as submitted at candidate-recording time. */
export interface KnowledgeEntryInput {
  /** Control-plane-minted durable id (never worker-chosen). */
  readonly entryId: string;
  readonly entryClass: KnowledgeEntryClass;
  /**
   * The machine-comparable subject: the exact command line (`command`),
   * the test id (`flaky-test`), or an optional declared subject (`note`,
   * null when the note names no comparable subject).
   */
  readonly subjectKey: string | null;
  /**
   * The machine-comparable claim about the subject. Constrained per class
   * (COMMAND_CLAIMS / FLAKY_TEST_CLAIMS); free bounded text for notes.
   */
  readonly claim: string;
  /** The statement rendered into packs and the repo projection. */
  readonly text: string;
  readonly scope: KnowledgeScope;
  /** ISO-8601 UTC instant; reads filter entries past this against the reader's clock. */
  readonly expiresAt: string;
  readonly provenance: KnowledgeProvenance;
  readonly validity: KnowledgeValidity;
}

/**
 * The two deterministic promotion rule-classes (CAM-CANON-09, registry
 * item 6) — the ONLY unattended paths to `approved`:
 *
 *  - `rule-command-success`: a `command` candidate claiming `succeeds`
 *    whose command line has ≥ COMMAND_RULE_MIN_SUCCESSES recorded successes
 *    across ≥ COMMAND_RULE_MIN_MISSIONS distinct missions.
 *  - `rule-quarantine-flaky`: a `flaky-test` candidate claiming `flaky`
 *    whose test id has a quarantine confirmation on record (the WP-108
 *    quarantine pipeline is the producing seam).
 *
 * `human-batch` is David's curation act. The fold re-verifies rule
 * authorities against the store's own observation events; a rule promotion
 * without folded evidence is refused at adoption.
 */
export type KnowledgePromotionAuthority =
  | { readonly kind: "human-batch"; readonly batchId: string }
  | { readonly kind: "rule-command-success" }
  | { readonly kind: "rule-quarantine-flaky" };

export const COMMAND_RULE_MIN_SUCCESSES = 3;
export const COMMAND_RULE_MIN_MISSIONS = 2;

/**
 * The knowledge store's CLOSED event vocabulary. Observation events
 * (`command-observation`, `quarantine-confirmation`) are the evidence
 * stream the rule-classes fold over; WP-114's dispatcher and WP-108's
 * quarantine pipeline are their producers — WP-113 defines the seam and
 * stores them durably (same posture as canon facts).
 */
export const KNOWLEDGE_EVENTS = Object.freeze([
  /** An attempt (via the control plane) recorded a candidate entry. */
  "candidate-recorded",
  /** One observed execution of a command line inside an attempt. */
  "command-observation",
  /** WP-108 quarantine confirmed a test flaky (rule-class 2 evidence). */
  "quarantine-confirmation",
  /** A candidate was promoted to approved (human batch or a rule-class). */
  "entry-promoted",
  /** Curation resolved against a candidate. */
  "entry-rejected",
  /** Curation retired an approved entry (contradiction resolution). */
  "entry-retired",
  /** A revert removed a validity base; matching entries invalidate. */
  "validity-base-reverted",
] as const);
export type KnowledgeEventName = (typeof KNOWLEDGE_EVENTS)[number];

/** What a writer submits; the store assigns `seq` and `recordedAt`. */
export interface KnowledgeAppendInput {
  readonly event: KnowledgeEventName;
  /** The acting identity: DAVID_ACTOR for curation acts, a `camino:*` component otherwise. */
  readonly actor: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** A persisted knowledge-event row. `seq` is strictly increasing, append order. */
export interface KnowledgeEventRecord extends KnowledgeAppendInput {
  readonly seq: number;
  /** ISO-8601 UTC timestamp assigned at append time. */
  readonly recordedAt: string;
}

export interface KnowledgeReadFilter {
  readonly afterSeq?: number;
}

// ---------------------------------------------------------------------------
// Entry validation (total; used at append AND at adoption, like contracts)
// ---------------------------------------------------------------------------

/** Bounds shared with the plan vocabulary: entries travel the same surfaces. */
export const KNOWLEDGE_MAX_TEXT_LENGTH = 4000;

const GIT_SHA_RE = /^[0-9a-f]{40}$/;

/** Full 40-hex lowercase git object id (the form validity SHAs use). */
export function isGitSha(value: string): boolean {
  return GIT_SHA_RE.test(value);
}

function boundedText(field: string, value: unknown, problems: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    problems.push(`${field} must be a non-empty string`);
    return;
  }
  if (value.length > KNOWLEDGE_MAX_TEXT_LENGTH) {
    problems.push(`${field} exceeds ${KNOWLEDGE_MAX_TEXT_LENGTH} code units`);
  }
  if (value.includes("\u0000")) problems.push(`${field} contains U+0000`);
}

/**
 * A plain object: a own-enumerable-property bag with Object.prototype or a
 * null prototype (r1 finding 13). A prototype-based object like
 * `Object.create({entryId: …})` reads its required fields through the
 * prototype and would pass a `record[key]` validator, yet JSON.stringify
 * emits `{}` — the store would validate one shape and persist another. This
 * predicate closes that fold-versus-append divergence: only own-property
 * bags validate, exactly the shapes canonical JSON round-trips.
 */
function isPlainObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Strict ISO-8601 UTC instant in Date#toISOString form, round-trip verified. */
function isIsoInstant(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

/**
 * Total validator for a knowledge entry: an empty result means the entry is
 * well-formed. Enforces the per-class (subjectKey, claim) discipline the
 * rule-classes and contradiction detection rely on — a malformed entry is
 * refused at the write, never repaired downstream.
 *
 * TOTAL over `unknown` (r2 findings 7 & 13): the value is first reduced to its
 * canonical JSON form, exactly ONCE, inside a try/catch. This (a) makes the
 * validator total — a throwing accessor becomes a named problem, never a
 * thrown error; and (b) makes what VALIDATES identical to what the store
 * SERIALIZES — a prototype-backed object, a non-enumerable required field, or
 * a prototype-backed NESTED object (scope/provenance/validity) all reduce to
 * `{}`/missing here and are refused, closing the fold-versus-store divergence
 * that a bare `record[key]` read would miss.
 */
export function knowledgeEntryProblems(value: unknown): string[] {
  let canonical: unknown;
  try {
    canonical = JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return ["entry has no canonical JSON form"];
  }
  if (!isPlainObject(canonical)) {
    return ["entry must be a plain object"];
  }
  const record = canonical as Record<string, unknown>;
  const problems: string[] = [];
  boundedText("entryId", record["entryId"], problems);
  const entryClass = record["entryClass"];
  if (
    typeof entryClass !== "string" ||
    !(KNOWLEDGE_ENTRY_CLASSES as readonly string[]).includes(entryClass)
  ) {
    problems.push(`entryClass must be one of ${KNOWLEDGE_ENTRY_CLASSES.join(", ")}`);
  }
  const subjectKey = record["subjectKey"];
  if (subjectKey === null) {
    if (entryClass === "command" || entryClass === "flaky-test") {
      problems.push(`subjectKey is required for class ${entryClass}`);
    }
  } else {
    boundedText("subjectKey", subjectKey, problems);
  }
  const claim = record["claim"];
  if (entryClass === "command") {
    if (typeof claim !== "string" || !(COMMAND_CLAIMS as readonly string[]).includes(claim)) {
      problems.push(`claim must be one of ${COMMAND_CLAIMS.join(", ")} for class command`);
    }
  } else if (entryClass === "flaky-test") {
    if (typeof claim !== "string" || !(FLAKY_TEST_CLAIMS as readonly string[]).includes(claim)) {
      problems.push(`claim must be one of ${FLAKY_TEST_CLAIMS.join(", ")} for class flaky-test`);
    }
  } else {
    boundedText("claim", claim, problems);
  }
  boundedText("text", record["text"], problems);
  const scope = record["scope"];
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
    problems.push("scope must be an object");
  } else {
    const s = scope as Record<string, unknown>;
    if (s["kind"] === "global") {
      for (const key of Object.keys(s)) {
        if (key !== "kind") problems.push(`scope has unknown field ${JSON.stringify(key)}`);
      }
    } else if (s["kind"] === "repo-area") {
      boundedText("scope.area", s["area"], problems);
      for (const key of Object.keys(s)) {
        if (!["kind", "area"].includes(key)) {
          problems.push(`scope has unknown field ${JSON.stringify(key)}`);
        }
      }
    } else {
      problems.push('scope.kind must be "global" or "repo-area"');
    }
  }
  if (!isIsoInstant(record["expiresAt"])) {
    problems.push("expiresAt must be an ISO-8601 UTC instant (toISOString form)");
  }
  const provenance = record["provenance"];
  if (typeof provenance !== "object" || provenance === null || Array.isArray(provenance)) {
    problems.push("provenance must be an object");
  } else {
    const p = provenance as Record<string, unknown>;
    boundedText("provenance.missionId", p["missionId"], problems);
    boundedText("provenance.issueId", p["issueId"], problems);
    boundedText("provenance.attemptId", p["attemptId"], problems);
    boundedText("provenance.context", p["context"], problems);
    // The issueId must be namespaced under the missionId (`<missionId>.…`),
    // exactly as the contract record enforces (r1 finding 3). The
    // cross-mission visibility guarantee rests on a reader's (missionId,
    // issueId) pair being internally consistent — a candidate whose issueId
    // is not under its own missionId could otherwise be matched by a reader
    // of a different mission that happens to share the issueId string.
    if (
      typeof p["missionId"] === "string" &&
      typeof p["issueId"] === "string" &&
      !String(p["issueId"]).startsWith(`${String(p["missionId"])}.`)
    ) {
      problems.push(
        "provenance.issueId must be namespaced under provenance.missionId (`<missionId>.<planIssueId>`)",
      );
    }
    for (const key of Object.keys(p)) {
      if (!["missionId", "issueId", "attemptId", "context"].includes(key)) {
        problems.push(`provenance has unknown field ${JSON.stringify(key)}`);
      }
    }
  }
  const validity = record["validity"];
  if (typeof validity !== "object" || validity === null || Array.isArray(validity)) {
    problems.push("validity must be an object");
  } else {
    const v = validity as Record<string, unknown>;
    for (const field of ["commitSha", "baseSha"] as const) {
      if (typeof v[field] !== "string" || !isGitSha(v[field] as string)) {
        problems.push(`validity.${field} must be a 40-hex lowercase git SHA`);
      }
    }
    for (const key of Object.keys(v)) {
      if (!["commitSha", "baseSha"].includes(key)) {
        problems.push(`validity has unknown field ${JSON.stringify(key)}`);
      }
    }
  }
  const allowed = [
    "entryId",
    "entryClass",
    "subjectKey",
    "claim",
    "text",
    "scope",
    "expiresAt",
    "provenance",
    "validity",
  ];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) problems.push(`unknown field ${JSON.stringify(key)}`);
  }
  return problems;
}
