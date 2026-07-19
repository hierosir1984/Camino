/**
 * External-operation contracts (WP-104): the design §4.4 idempotency table
 * as code (CAM-STATE-02).
 *
 * Every side effect Camino performs against an external system belongs to
 * exactly one OPERATION CLASS, and each class carries the reconciliation
 * key the design table assigns it:
 *
 *   branch-create          branch name (natural key); state query
 *   push                   intended SHA recorded in the intent; reconcile
 *                          by comparing the observed ref to it
 *   pr-create              intent UUID embedded in the PR body at creation
 *                          + head-branch natural key (bodies are mutable —
 *                          the branch key is primary, the UUID
 *                          corroborates); closed/reused-branch ambiguity →
 *                          escalation class
 *   merge-by-push          idempotent by ref state: is the target at/past
 *                          the constructed merge commit
 *   label-set              naturally idempotent as (object, label, desired
 *                          state)
 *   comment-post           embedded UUID marker
 *   workflow-dispatch      AT-MOST-ONCE with respect to every AUTOMATIC
 *                          path — `camino_intent_id` surfaced via
 *                          run-name is correlation for observability, not
 *                          an idempotency guarantee; on lost-response
 *                          ambiguity there is no automatic retry. David's
 *                          explicit retry-authorized may knowingly
 *                          duplicate a run whose first dispatch was
 *                          lost-but-landed — the table prices exactly
 *                          this ("duplicates are tolerable because
 *                          GitHub CI on worker refs is advisory-only";
 *                          Camino's own runner gates merges, and the
 *                          duplicate stays visible via correlatedRuns)
 *   test-service-mutation  environment granularity: reset-before-use makes
 *                          the environment the idempotency unit;
 *                          irreversible effects are recorded as ambiguity,
 *                          never auto-retried
 *   catch-all              at-most-once with the ambiguity durably
 *                          recorded before any MANUAL retry, then human
 *                          escalation — stated, not hidden
 *
 * The durable protocol every class runs (intent journal, WP-104):
 *
 *   recorded → execution-started → [the external call] → confirmed
 *
 * `execution-started` is the pre-execution barrier: it is appended durably
 * BEFORE the transport is invoked, so recovery can distinguish "provably
 * never sent" (barrier absent — safe to complete for every class,
 * including at-most-once ones: completing a never-sent intent is the first
 * execution, not a retry) from "may have been sent" (barrier present,
 * confirmation absent — the dangerous ambiguity window; decidable classes
 * reconcile by query, at-most-once classes record ambiguity and escalate).
 *
 * Fake-backed at this WP: the transport INTERFACES here are the product
 * contract; WP-104 ships file-backed fakes and the chaos harness against
 * them, and the WPs that implement real side effects (WP-114/115/119/120)
 * register their integration fixtures into the same matrix (WP-126 asserts
 * it against real backends).
 */

/** The nine operation classes of the design §4.4 table, closed. */
export const OPERATION_CLASSES = [
  "branch-create",
  "push",
  "pr-create",
  "merge-by-push",
  "label-set",
  "comment-post",
  "workflow-dispatch",
  "test-service-mutation",
  "catch-all",
] as const;
export type OperationClass = (typeof OPERATION_CLASSES)[number];

/** Where a label/comment lands (GitHub numbers issues and PRs together). */
export const OPERATION_TARGET_KINDS = ["issue", "pull-request"] as const;
export type OperationTargetKind = (typeof OPERATION_TARGET_KINDS)[number];

/** Desired end state for the naturally idempotent label class. */
export const LABEL_DESIRED_STATES = ["present", "absent"] as const;
export type LabelDesiredState = (typeof LABEL_DESIRED_STATES)[number];

/**
 * The DELIMITED embedded-marker forms (round 1 finding 1; delimiter hole
 * closed by round 2 finding 1). A bare id as a substring is
 * prefix-ambiguous — a search for "intent-1" matches a body carrying
 * "intent-10" — so what gets embedded and matched is always the full
 * bracketed token. The token alone is NOT enough: an id containing "]"
 * (e.g. "intent-A]foreign") would generate a token CONTAINING the shorter
 * id's complete token. Therefore intent ids are grammar-pinned at the
 * journal boundary (INTENT_ID_PATTERN — no "[", "]", or ":" can appear),
 * and under that grammar token containment is impossible for distinct
 * ids: any token's only "[" is its first character, so a contained token
 * must be a prefix, which forces one id to be a prefix of the other
 * followed by "]" — a character the grammar excludes from ids. The
 * marker/correlation FIELDS on the specs are additionally validated to
 * equal the intent id exactly (the design's "intent UUID" is the
 * intent's own id, not a caller-chosen string), so the reconciliation
 * key is bound to the journal identity it reconciles.
 */

/**
 * The closed intent-id grammar (round 2 finding 1): ids are
 * Camino-generated (UUIDs later), never user text, so a conservative
 * alphabet costs nothing and makes the token-containment proof above
 * hold. Enforced by core's decideIntentAppend on every journal write and
 * on every replay (a raw-written id outside the grammar refuses at open).
 */
export const INTENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
export function intentMarkerToken(intentId: string): string {
  return `[camino-intent:${intentId}]`;
}

/** The run-name correlation form for workflow dispatch (`camino_intent_id`). */
export function correlationToken(intentId: string): string {
  return `[camino_intent_id=${intentId}]`;
}

/**
 * Per-class intent payloads. Everything reconciliation will ever need is
 * recorded IN the intent before the call: decisions reconcile from the
 * log, never from re-derivation (CAM-STATE-03). `repo` is the owning repo
 * id throughout; SHAs are full 40-hex.
 */
export interface BranchCreateSpec {
  readonly op: "branch-create";
  readonly repo: string;
  /** The natural key. Camino owns its branch namespace. */
  readonly branch: string;
  readonly targetSha: string;
}

export interface PushSpec {
  readonly op: "push";
  readonly repo: string;
  readonly ref: string;
  /** The SHA the ref must end at — THE reconciliation comparison value. */
  readonly intendedSha: string;
  /**
   * The SHA the ref was at when the intent was formed. An observed ref
   * still here means the push provably did not land; an observed ref at
   * neither SHA means an out-of-band actor moved it (escalation, §4.5 —
   * reconciliation never force-pushes over an unexplained ref).
   */
  readonly expectedBaseSha: string;
}

export interface PrCreateSpec {
  readonly op: "pr-create";
  readonly repo: string;
  /** The primary natural key (bodies are mutable; branch names are ours). */
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly title: string;
  /**
   * The intent UUID embedded in the PR body at creation (corroboration).
   * MUST equal the intent's own id (validated at the journal boundary),
   * and the body must embed `intentMarkerToken(bodyMarker)` — the
   * delimited form is what reconciliation matches.
   */
  readonly bodyMarker: string;
  readonly body: string;
}

export interface MergeByPushSpec {
  readonly op: "merge-by-push";
  readonly repo: string;
  /** The ref being advanced (v1: the default branch). */
  readonly targetRef: string;
  /** The exact constructed merge commit (design §4.2: what is validated is what lands). */
  readonly mergeSha: string;
  /** Where the target ref must be for the fast-forward to apply. */
  readonly expectedBaseSha: string;
}

export interface LabelSetSpec {
  readonly op: "label-set";
  readonly repo: string;
  readonly targetKind: OperationTargetKind;
  readonly targetNumber: number;
  readonly label: string;
  readonly desired: LabelDesiredState;
}

export interface CommentPostSpec {
  readonly op: "comment-post";
  readonly repo: string;
  readonly targetKind: OperationTargetKind;
  readonly targetNumber: number;
  readonly body: string;
  /**
   * The embedded UUID marker (the class's reconciliation key). MUST equal
   * the intent's own id; the body embeds `intentMarkerToken(marker)`.
   */
  readonly marker: string;
}

export interface WorkflowDispatchSpec {
  readonly op: "workflow-dispatch";
  readonly repo: string;
  readonly workflow: string;
  readonly ref: string;
  /**
   * Surfaced in the run-name as `correlationToken(correlationId)` —
   * correlation for observability only, per the table: a run carrying it
   * proves our dispatch happened; its ABSENCE proves nothing (queue
   * lag), which is exactly why this class is at-most-once with no
   * automatic retry. MUST equal the intent's own id.
   */
  readonly correlationId: string;
}

export interface TestServiceMutationSpec {
  readonly op: "test-service-mutation";
  /** The idempotency unit: reset-before-use wipes it, making re-execution safe. */
  readonly environmentId: string;
  /** What is done to the environment (opaque to WP-104; the fake applies it literally). */
  readonly mutation: string;
  /**
   * True for effects reset cannot undo (sent emails/webhooks, consumed
   * quota). Declared AT INTENT TIME — recovery of an unconfirmed
   * irreversible mutation is ambiguity + escalation, never a retry.
   */
  readonly irreversible: boolean;
}

export interface CatchAllSpec {
  readonly op: "catch-all";
  /** Human-readable statement of the one-off effect (escalation text). */
  readonly description: string;
}

export type ExternalOperationSpec =
  | BranchCreateSpec
  | PushSpec
  | PrCreateSpec
  | MergeByPushSpec
  | LabelSetSpec
  | CommentPostSpec
  | WorkflowDispatchSpec
  | TestServiceMutationSpec
  | CatchAllSpec;

/** What a completed external call reports back (recorded on confirmation). */
export type OperationResult = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Intent journal event names (append-only; the journal is the durable
 * record CAM-STATE-02's "ambiguity is durably recorded" points at).
 *
 *   recorded            intent + full class spec durably written (before
 *                       anything else happens)
 *   execution-started   the pre-execution barrier (see module header)
 *   confirmed           effect known-present: transport response, or
 *                       reconciliation concluded from queried facts
 *   failed              effect known-absent and the intent cannot proceed
 *                       (clean transport refusal, superseded merge base) —
 *                       terminal, surfaced to the mission layer
 *   re-armed            recovery concluded the effect is provably absent;
 *                       the intent returns to executable
 *   ambiguity-recorded  the durable ambiguity row (before any retry could
 *                       ever be considered)
 *   escalated           human escalation opened for the ambiguity
 *   retry-authorized    a human explicitly authorized re-execution of an
 *                       escalated intent (the "manual retry" the catch-all
 *                       row permits) — actor-bound to David
 *   abandoned           a human closed an escalated intent without retry —
 *                       terminal, actor-bound to David
 */
export const INTENT_EVENTS = [
  "recorded",
  "execution-started",
  "confirmed",
  "failed",
  "re-armed",
  "ambiguity-recorded",
  "escalated",
  "retry-authorized",
  "abandoned",
] as const;
export type IntentEventName = (typeof INTENT_EVENTS)[number];

/**
 * Folded intent status. `recorded` covers a re-armed or retry-authorized
 * intent too (it is executable again); `execution-started` is the crash
 * window recovery must reconcile; `ambiguity-recorded` exists transiently
 * between the ambiguity row and its escalation row (recovery is idempotent
 * across a crash between the two).
 */
export const INTENT_STATUSES = [
  "recorded",
  "execution-started",
  "confirmed",
  "failed",
  "ambiguity-recorded",
  "escalated",
  "abandoned",
] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

/** A persisted intent journal row. */
export interface IntentEventRecord {
  readonly seq: number;
  readonly intentId: string;
  readonly event: IntentEventName;
  /** Who caused the row (e.g. "camino:executor", "camino:recovery", "david"). */
  readonly actor: string;
  /** JSON payload; the full ExternalOperationSpec on `recorded` rows. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly recordedAt: string;
}

/**
 * The transport outcome contract (hardened by review round 1, finding 3):
 * silence about an error's meaning must never become a claim that the
 * effect is absent, so the two knowable outcomes are EXPLICIT error
 * types and everything else is treated as unknown.
 *
 *  - return value                → definitive success
 *  - DefinitiveRefusalError      → definitive non-application (the
 *    external system refused BEFORE applying anything: a 4xx-class
 *    response, a validation rejection)
 *  - IndeterminateOutcomeError   → outcome unknown (timeout, connection
 *    lost mid-request)
 *  - ANY OTHER throw             → treated as unknown too. A raw socket
 *    reset, a JSON parse error, a bug — none of them prove the effect
 *    absent, and recording `failed` on one would be a durable lie about
 *    external state. Unknown errors leave the intent in its ambiguity
 *    window for reconciliation to settle, exactly like a crash.
 */
export class DefinitiveRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefinitiveRefusalError";
  }
}

/** See the transport outcome contract above: outcome unknown, never a refusal. */
export class IndeterminateOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndeterminateOutcomeError";
  }
}

/**
 * MUTATION transports: the calls that change external state. Implemented
 * by WP-104's file-backed fakes now, by the real integrations in
 * WP-114/115/119/120, all under the transport outcome contract above. A
 * crash AROUND the call is what the intent journal + recovery handle.
 */
export interface GitHubMutationTransport {
  createBranch(spec: BranchCreateSpec): OperationResult;
  push(spec: PushSpec): OperationResult;
  createPullRequest(spec: PrCreateSpec): OperationResult;
  mergeByPush(spec: MergeByPushSpec): OperationResult;
  setLabel(spec: LabelSetSpec): OperationResult;
  postComment(spec: CommentPostSpec): OperationResult;
  /** Dispatch returns no body upstream; the result carries only what we sent. */
  dispatchWorkflow(spec: WorkflowDispatchSpec): OperationResult;
}

export interface TestServiceMutationTransport {
  /** Reset-before-use: wipes the environment (the idempotency unit). */
  resetEnvironment(environmentId: string): void;
  mutate(spec: TestServiceMutationSpec): OperationResult;
}

export interface CatchAllMutationTransport {
  perform(spec: CatchAllSpec): OperationResult;
}

/** Everything the executor needs to act. */
export interface MutationTransports {
  readonly github: GitHubMutationTransport;
  readonly testService: TestServiceMutationTransport;
  readonly catchAll: CatchAllMutationTransport;
}

/** A pull request as reconciliation observes it. */
export interface ObservedPullRequest {
  readonly number: number;
  readonly state: "open" | "closed";
  readonly headBranch: string;
  /** The base is part of the PR's identity (round-1 finding 2): a PR from
   * our head into a DIFFERENT base is not our PR. */
  readonly baseBranch: string;
  readonly body: string;
}

/** One coherent observation of a ref (round-1 finding 4): the SHA and the
 * ancestry answer come from a single query, so they can never contradict
 * each other across a ref move between two calls. */
export interface ObservedRef {
  readonly refSha: string | null;
  readonly atOrPastAncestor: boolean;
}

/** A workflow run as reconciliation observes it. */
export interface ObservedWorkflowRun {
  readonly runId: number;
  readonly runName: string;
}

/**
 * QUERY transports: the read-only surface recovery reconciles from
 * (CAM-STATE-03: external facts from GitHub queries; decisions from the
 * log). This interface deliberately contains NO mutating call — a
 * reconciler written against it cannot change external state, by type.
 * The test-service class needs no query surface at all: resettable
 * mutations reconcile by reset-before-use re-execution, and irreversible
 * ones are ambiguity by definition (that is what irreversible means here —
 * there is nothing to query that would settle them).
 */
export interface GitHubQueryTransport {
  /** The SHA a ref currently points at, or null if the ref does not exist. */
  getRef(repo: string, ref: string): string | null;
  /**
   * ONE observation answering both "where is the ref" and "is
   * `ancestorSha` at-or-behind it" coherently (merge-by-push
   * reconciliation must never act on two mutually contradictory reads).
   */
  observeRef(repo: string, ref: string, ancestorSha: string): ObservedRef;
  /** Every PR (open and closed) whose head is the given branch. */
  findPullRequestsByHead(repo: string, headBranch: string): readonly ObservedPullRequest[];
  /** Whether the label is currently present on the target. */
  isLabelPresent(
    repo: string,
    targetKind: OperationTargetKind,
    targetNumber: number,
    label: string,
  ): boolean;
  /**
   * EVERY comment carrying the marker token. More than one is possible
   * only through an out-of-band actor (Camino validation reserves the
   * namespace) — the verdict treats it as ambiguity, never first-match.
   */
  findCommentsByMarker(
    repo: string,
    targetKind: OperationTargetKind,
    targetNumber: number,
    marker: string,
  ): ReadonlyArray<{ readonly commentId: number }>;
  /** Runs whose run-name carries the correlation id (observability surface). */
  findWorkflowRunsByCorrelation(
    repo: string,
    correlationId: string,
  ): readonly ObservedWorkflowRun[];
}
