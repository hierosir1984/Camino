// WP-105: the worker-adapter dispatch contract (CAM-EXEC-01, CAM-EXEC-06,
// CAM-SEC-06) — the product promotion of the WP-001 dispatch spike's interface.
//
// An adapter is pure configuration + pure parsing. All process handling, env
// composition, kill-confirm, and outcome classification live in the shared
// dispatch lifecycle (packages/daemon/src/dispatch/lifecycle.ts) so every
// adapter gets identical, tested semantics — in particular, quota-vs-failure
// classification is centralized so no adapter can independently misclassify
// (CAM-EXEC-06), and credential posture is enforced by the one env composer
// rather than re-implemented per adapter (CAM-SEC-06).
//
// This file is types + pure constants only, importable from any package,
// including pure core. (Shared as a whole gained Node ambient types in WP-110
// for content hashing — node:crypto in canonical-json.ts — but this module
// stays platform-neutral.)

/** A normalized event parsed from an adapter's headless output stream. */
export interface StreamEvent {
  /** Coarse kind so the harness can reason without knowing each vendor's schema. */
  kind: "assistant" | "tool" | "result" | "error" | "other";
  /** Short human text for the transcript (already truncated by the parser). */
  text: string;
  /** Provider rate-limit / quota signal detected on this line, if any. */
  quotaSignal?: boolean;
  /**
   * True ONLY on the genuine success TERMINAL of a turn (claude success
   * `result`, codex `turn.completed`, grok `end`) — distinct from an
   * intermediate answer that the parser also maps to kind "result" (codex
   * `agent_message` carries the answer TEXT for finalText but is mid-turn).
   * The lifecycle clears a pending quota failure only on this, so a quota
   * error followed by an intermediate answer and then a `turn.failed` stays
   * quota-blocked (round-11 finding 1).
   */
  terminalSuccess?: boolean;
  /**
   * CUMULATIVE tokens consumed by the dispatch so far, when the vendor stream
   * reports usage (CAM-EXEC-03 "tokens where reportable" — WP-107). Parsers
   * set this ONLY on events carrying a run-cumulative figure (claude `result`
   * usage, codex `turn.completed` usage), never by summing per-message
   * numbers (double-counting would breach budgets that were not breached).
   * The lifecycle's budget monitor takes the max across events.
   */
  tokensTotal?: number;
}

/**
 * How a dispatch ended, classified per CAM-EXEC-06: a provider rate limit is
 * `quota-blocked`, NEVER `requirement-failed` — blaming the worker for the
 * provider's throttle would corrupt the outcome ledger. `cancelled` (external
 * cancel), `killed` (harness runaway cap), and `killed-budget` (per-attempt
 * budget breach — CAM-EXEC-03, WP-107) are distinct so neither a timeout nor
 * a budget breach can masquerade as a user decision, and a budget breach maps
 * 1:1 to the Appendix A.3 `killed-budget` terminal (kill-and-escalate, never
 * an automatic retry).
 */
export type DispatchOutcome =
  "succeeded" | "requirement-failed" | "quota-blocked" | "cancelled" | "killed" | "killed-budget";

/**
 * Per-attempt budget (CAM-EXEC-03, WP-107): wall-clock ALWAYS; tokens only
 * where the vendor stream reports usage (StreamEvent.tokensTotal). A breach
 * runs the kill-confirm sequence and classifies `killed-budget`.
 */
export interface AttemptBudget {
  /** Wall-clock ceiling for the dispatch, in milliseconds. Required. */
  wallClockMs: number;
  /** Cumulative-token ceiling; enforced only when the stream reports usage. */
  tokens?: number;
}

/** Which budget tripped, with the limit and the observed value (evidence). */
export interface BudgetBreachRecord {
  kind: "wall-clock" | "tokens";
  limit: number;
  observed: number;
  /**
   * Optional human-readable cause when the numeric fields do not tell the whole
   * story — e.g. a token breach declared because a worker's usage report could
   * NOT be parsed (an oversized line past the reader cap), so it fails closed
   * rather than being silently accepted as under-budget (WP-107, round-15 finding 1).
   */
  reason?: string;
}

/** The headless spawn plan an adapter builds for one dispatch. */
export interface SpawnPlan {
  /** Executable to run (resolved on PATH). */
  file: string;
  /** Argv, excluding the executable. */
  args: string[];
  /**
   * Extra env keys to add on top of the composed clean env. Enforcement runs
   * AFTER these are applied: credential-shaped keys and git-config override
   * channels supplied here are stripped, never honored (see
   * packages/daemon/src/dispatch/env.ts).
   */
  env?: Record<string, string>;
  /** If the prompt is delivered on stdin rather than argv, its text. */
  stdin?: string;
}

/** Per-dispatch input handed to an adapter's plan(). */
export interface AdapterContext {
  /** Absolute path to the isolated worker clone. */
  workdir: string;
  /** The issue prompt to resolve. */
  prompt: string;
  /** Optional model override. */
  model?: string;
}

/**
 * A worker adapter (CAM-EXEC-01). The v1 set drives official vendor CLIs on
 * the user's subscriptions; enablement is decided by the registry
 * (sanctioned-path verification + CLI presence) and a disabled adapter is
 * installable but never dispatched — the lifecycle refuses it with a typed
 * error rather than trusting callers to skip it.
 */
export interface AdapterSpec {
  readonly name: string;
  /** Enablement decision (made by the registry, not by the adapter itself). */
  readonly enabled: boolean;
  /** Recorded reason whenever `enabled` is false (CAM-EXEC-01 negative path). */
  readonly disabledReason?: string;
  /**
   * STRUCTURED cause of a registry-gate refusal, set by buildRegistry()'s
   * gate alongside the human-readable reason: "cli-absent" (the executable
   * did not resolve) or "sanctioned-path" (the recorded provider
   * disposition is not accepted). Consumers that must branch on the cause
   * — the WP-106 capability registry's rebuild-obligation annotation —
   * read this, never the reason text (round-8 review finding 2).
   */
  readonly disabledCause?: "cli-absent" | "sanctioned-path";
  /** Build the headless spawn plan for one dispatch. */
  plan(ctx: AdapterContext): SpawnPlan;
  /**
   * Parse one line of stdout/stderr into a normalized event (or null to skip).
   * Must be total: a parser that throws is caught by the lifecycle and the line
   * is treated as unparseable, never crashing the dispatch.
   */
  parseLine(line: string, channel: "stdout" | "stderr"): StreamEvent | null;
}

/**
 * Kill-confirm evidence (CAM-EXEC-06; PRD §5 registry item 4):
 * SIGTERM → grace → SIGKILL iff any group member survives → group-gone
 * verification. Lease release is sequenced strictly AFTER `groupGone` is
 * confirmed (see LeaseHandle).
 *
 * Containment boundary (round-1 review finding 1; widened per round-2 finding
 * 2): "gone" here means the worker's process GROUP is gone. A descendant that
 * changes its own process group — setpgid(0,0) (same session) or setsid (new
 * session) — escapes both the group signal and the group-liveness probe; no
 * signal-based mechanism on this layer can contain that. Complete process-tree
 * containment is the container's job: WP-107 runs each worker in a PID
 * namespace / cgroup where killing the container reaps every pid regardless of
 * group. At THIS layer the fencing guarantee is scoped to the process group,
 * and that scope is stated, not overclaimed. The PRD scopes this in two layers
 * per AMEND-10 (approved 2026-07-20, PR #50): group-gone at this layer;
 * process-tree-gone is the post-container end state (WP-107).
 */
export interface KillConfirmRecord {
  requested: boolean;
  /** True if SIGTERM alone did not stop the group and SIGKILL was needed. */
  escalatedToSigkill: boolean;
  /** True once the worker's process GROUP is confirmed gone (see boundary note above). */
  groupGone: boolean;
  elapsedMs: number;
}

/** Worker env posture evidence (CAM-SEC-06 / CAM-EXEC-02). Key NAMES only — the env VALUES bound to them are never recorded. */
export interface EnvPostureRecord {
  /** Env key NAMES handed to the worker (the values bound to them are never recorded). */
  keys: string[];
  /** GitHub-credential-shaped keys present (empty by construction). */
  githubCredentialKeys: string[];
  /** Whether git's global/system config was neutralized for the worker. */
  gitGlobalNeutralized: boolean;
  /**
   * Key NAMES removed by enforcement (credential-shaped keys, git-config
   * override + redirect channels, agent sockets) — observability for the
   * posture the composer enforced. This field records the NAMES of keys, i.e.
   * the same identifying information the `keys` field carries; it never
   * records the env VALUE that was bound to a stripped key. (A caller that
   * hides a secret inside an env-var NAME rather than its value has leaked
   * its own secret to its own process listing; that is not a channel this
   * record opens.)
   */
  strippedKeys: string[];
  /**
   * The credential-root key NAMES granted by adapter-scoped composition and
   * actually present on the host (round-6 finding 2) — e.g.
   * ["CODEX_HOME", "HOME"] for an official codex-cli dispatch; ALWAYS [] for a
   * non-official adapter. Names only, like every posture field.
   */
  credentialRootKeys: string[];
}

/**
 * The context passed to a lease release. `groupGone` is always literally true:
 * the lifecycle only ever invokes release AFTER the worker process group is
 * confirmed gone (or was never spawned), never before. (See the containment
 * boundary on KillConfirmRecord: "gone" is scoped to the process group; a
 * descendant that changes its process group — setpgid/setsid — is contained by
 * WP-107's container.)
 */
export interface LeaseReleaseContext {
  groupGone: true;
  outcome: DispatchOutcome;
}

/**
 * The attempt-lease seam (PRD §5 registry item 4: kill-confirm ends in "lease
 * release"; CAM-STATE-04: re-grant only after kill-confirm). The dispatch
 * lifecycle guarantees:
 *
 *   - `release` is invoked AT MOST ONCE per dispatch;
 *   - only after the worker process GROUP is confirmed gone (natural exit with
 *     the group swept, kill-confirm with groupGone, or a spawn that never
 *     produced a process);
 *   - NEVER when the group could not be confirmed gone — the lease is then
 *     deliberately held and the DispatchRecord says so, because releasing a
 *     lease while a worker may still be running would permit two owners of one
 *     environment (the fencing invariant CAM-STATE-04 exists to prevent);
 *   - even when the dispatch body throws unexpectedly: settlement runs on
 *     EVERY terminal path (the normal return AND the error catch, each exactly
 *     once via an internal guard), so a thrown dispatch never silently strands
 *     a lease.
 *
 * Group scope, not full-tree (round-1 finding 1, widened round-2 finding 2): a
 * descendant that changes its process group — setpgid(0,0) or setsid — escapes
 * group containment; the environment's true single-owner guarantee is
 * completed by WP-107's container (kill the container → every namespaced pid
 * dies). WP-105 owns the ordering guarantee at the group boundary.
 *
 * The handle's owner (the attempt runner, WP-114) decides what release()
 * actually does — it may collect evidence before releasing the underlying
 * lease. WP-105 owns only the ordering guarantee.
 */
export interface LeaseHandle {
  release(ctx: LeaseReleaseContext): void | Promise<void>;
}

/** What happened to the lease handed to a dispatch (present iff one was provided). */
export type LeaseDisposition =
  | { released: true }
  | { released: false; heldReason: "process-group-unconfirmed" }
  | { released: false; heldReason: "release-threw"; releaseError: string };

/** The full evidence record of one dispatch. */
export interface DispatchRecord {
  adapter: string;
  outcome: DispatchOutcome;
  spawned: boolean;
  streamedEvents: number;
  finalText: string;
  committedSha: string | null;
  /** Present when a cancel/timeout ran the kill-confirm sequence. */
  killConfirm?: KillConfirmRecord;
  /**
   * Present when the leader exited on its own but group members survived it and
   * had to be swept (same kill-confirm sequence, run as post-exit cleanup).
   */
  postExitCleanup?: KillConfirmRecord;
  /**
   * Present when the dispatch body threw unexpectedly (e.g. a broken transcript
   * sink). The dispatch still cleans up and settles the lease; this records
   * that the terminal outcome came from an error path, not a normal one.
   */
  unexpectedError?: string;
  envPosture: EnvPostureRecord;
  exitCode: number | null;
  durationMs: number;
  events: StreamEvent[];
  /**
   * True iff ANY parsed event carried a quota signal — including a transient
   * one the worker recovered from (outcome "succeeded"). Lets the quota-aware
   * scheduler (CAM-ROUTE-06, WP-106) observe pressure without misreading a
   * recovered dispatch as blocked (round-7 finding 2).
   */
  quotaSignalSeen: boolean;
  /**
   * Present iff the outcome is `killed-budget`: which budget tripped, the
   * configured limit, and the observed value (CAM-EXEC-03 evidence for the
   * escalation record).
   */
  budgetBreach?: BudgetBreachRecord;
  /** Present iff a LeaseHandle was supplied to the dispatch. */
  lease?: LeaseDisposition;
}

/**
 * GitHub-credential-shaped env key markers a worker must never carry
 * (CAM-SEC-06, CAM-EXEC-02): the control plane holds the sole GitHub
 * credential; workers hold zero. Matched case-insensitively as substrings.
 * Shared so the env composer (daemon) and the API-key contract checks use one
 * source of truth.
 */
// Every exported enforcement-policy constant is Object.freeze'd (round-8
// finding 2). These objects are consumed by the dispatch provenance check and
// the env composer's credential-root scoping; exporting them live let a
// package-root importer mutate policy (drop "claude-code" from the official
// set, or a key from the credential-root set) and thereby bypass enforcement
// WITHOUT a deep import or a gated-object mutation. Freezing closes that
// package-public vector; reads (includes/index/iterate/spread) are unaffected.
export const GITHUB_CREDENTIAL_MARKERS = Object.freeze([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_PAT",
  "GIT_ASKPASS",
  "GIT_TOKEN",
] as const);

/** Is this env key name GitHub-credential-shaped? (case-insensitive substring match) */
export function isGithubCredentialShapedKey(key: string): boolean {
  const upper = key.toUpperCase();
  return GITHUB_CREDENTIAL_MARKERS.some((marker) => upper.includes(marker));
}

/**
 * Credential-shaped key-name fragments (beyond the GitHub markers) a worker
 * must never carry: loose API keys / secrets that would let a subscription
 * dispatch authenticate as something Camino never intended (e.g. a provider
 * API key silently re-billing the dispatch to an API account). Matched
 * case-insensitively as a substring pattern.
 *
 * MODULE-PRIVATE by design (round-9 finding 2): a public RegExp export is
 * mutable through the legacy `RegExp.prototype.compile()` even after
 * Object.freeze, so this enforcement pattern is NOT exported — reach it only
 * through isStrippedWorkerEnvKey(). The immutable SOURCE string is exported
 * for messages/tests.
 */
const CREDENTIAL_SHAPED_RE =
  /API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SECRET|TOKEN|CREDENTIAL|PASSWORD|PASSPHRASE/i;
export const CREDENTIAL_SHAPED_PATTERN_SOURCE: string = CREDENTIAL_SHAPED_RE.source;

/**
 * The env key names / prefixes the worker-env composer STRIPS as a class,
 * because each is an authentication or git-redirect capability a worker must
 * not inherit (CAM-SEC-06 / CAM-EXEC-02). One source of truth: the daemon's
 * composer strips these, AND the API-key adapter contract refuses to let an
 * adapter re-open any of them by declaring it as a "credential env var".
 *
 *   - git config injection: GIT_CONFIG / GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n /
 *     GIT_CONFIG_VALUE_n / GIT_CONFIG_PARAMETERS bypass the /dev/null
 *     global+system neutralization entirely (credential.helper, core.sshCommand);
 *     GIT_CONFIG_GLOBAL/SYSTEM/TERMINAL_PROMPT are the composer's own forced
 *     keys — listed here so the predicate is authoritative (the composer
 *     re-forces them to safe values after stripping);
 *   - git repo/exec redirect: GIT_DIR / GIT_WORK_TREE / GIT_OBJECT_DIRECTORY /
 *     GIT_ALTERNATE_OBJECT_DIRECTORIES / GIT_INDEX_FILE / GIT_NAMESPACE /
 *     GIT_COMMON_DIR / GIT_EXEC_PATH point git at attacker-chosen state or
 *     helper binaries (round-1 review finding 4);
 *   - git command-execution channels: GIT_EXTERNAL_DIFF / GIT_EDITOR /
 *     GIT_SEQUENCE_EDITOR / GIT_PAGER / GIT_TEMPLATE_DIR make an ordinary git
 *     invocation run an attacker-chosen binary (round-2 review finding 7 —
 *     GIT_EXTERNAL_DIFF executes on `git diff`);
 *   - transport / agent: GIT_SSH / GIT_SSH_COMMAND / GIT_PROXY_COMMAND hand out
 *     arbitrary transport commands; the SSH_* family (SSH_AUTH_SOCK,
 *     SSH_ASKPASS, SSH_SK_PROVIDER — a loadable library path, round-3 finding
 *     3, and every other SSH_* directive) is stripped WHOLESALE by prefix
 *     below, since a headless coding worker needs no SSH_* variable.
 *
 * BOUNDARY (round-2 finding 7, round-3 finding 3): the git env surface is
 * large and regenerating — a finder can always name the next capability
 * variable. The SSH_* surface is closed by prefix; the git capability channels
 * are enumerated here; and complete isolation from every remaining git env var
 * is the CONTAINER's job (WP-107, CAM-EXEC-02: isolated full clone, no host
 * filesystem). The env layer closes the SSH surface + the known git channels
 * and NAMES the container as the closer of the rest, rather than chasing an
 * unbounded denylist (the WP-003 git-fsck / WP-102 token-dir precedent).
 */
export const STRIPPED_ENV_EXACT = Object.freeze([
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_TERMINAL_PROMPT",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_COMMON_DIR",
  "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_PAGER",
  "GIT_TEMPLATE_DIR",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
] as const);

// SSH_ closes the whole SSH_* family in one rule (SSH_AUTH_SOCK, SSH_ASKPASS,
// SSH_SK_PROVIDER, …) — a headless worker needs no SSH_* variable, so strip by
// prefix rather than enumerate (round-3 finding 3).
export const STRIPPED_ENV_PREFIXES = Object.freeze([
  "GIT_CONFIG_KEY_",
  "GIT_CONFIG_VALUE_",
  "SSH_",
] as const);

/**
 * The worker env inheritance UNION: every host env key ANY worker may inherit.
 * Composition scopes it further per adapter identity (round-6 finding 2):
 *
 *   - The BASE keys (PATH/USER/LOGNAME/SHELL/LANG/LC_ALL/TMPDIR) go to every
 *     worker.
 *   - The CREDENTIAL-ROOT keys (HOME + the official CLIs' config-root vars
 *     CODEX_HOME / CLAUDE_CONFIG_DIR / GROK_HOME) reference host credential
 *     state, so composeWorkerEnv grants them ONLY to an official-CLI dispatch
 *     — and each official CLI receives HOME plus its OWN root alone
 *     (CAM-SEC-06: "composition references host credential state for official
 *     CLIs only" is ENFORCED at composition, not merely stated). A user who
 *     relocated a CLI's config (a non-default CODEX_HOME / GROK_HOME) still
 *     authenticates (round-5 finding 2). These are config-DIRECTORY pointers,
 *     not credentials: the composer references the host's own value so each
 *     official CLI finds its own credential; Camino never reads, copies, or
 *     proxies the credential itself.
 *
 * The [F] API-key adapter path does NOT broaden this: a non-official adapter's
 * worker env carries NO credential roots at all, and credentials reach it only
 * via explicitly DECLARED env var names (see api-key-adapter.ts).
 *
 * Shared so the composer inherits exactly (a scoped subset of) these and the
 * API-key contract refuses to let an adapter alias a credential onto ANY of
 * them.
 */
export const WORKER_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  // Official-CLI config roots (sanctioned auth locations), round-5 finding 2;
  // granted per adapter identity only (round-6 finding 2).
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "GROK_HOME",
] as const);

/**
 * The v1 official-CLI adapter set (CAM-EXEC-01). dispatch() requires registry
 * provenance for a spec bearing one of these names (round-6 finding 1), and
 * env composition grants credential roots only to them (round-6 finding 2).
 */
export const OFFICIAL_ADAPTER_NAMES = Object.freeze([
  "claude-code",
  "codex-cli",
  "grok-build",
] as const);
export type OfficialAdapterName = (typeof OFFICIAL_ADAPTER_NAMES)[number];

/** Each official CLI's config-root env var — the only root it receives besides HOME. */
export const OFFICIAL_CLI_CONFIG_ROOTS: Readonly<Record<OfficialAdapterName, string>> =
  Object.freeze({
    "claude-code": "CLAUDE_CONFIG_DIR",
    "codex-cli": "CODEX_HOME",
    "grok-build": "GROK_HOME",
  });

/**
 * The allowlist subset that references host credential state (CAM-SEC-06).
 * Granted per adapter identity at composition, never inherited by default.
 */
export const CREDENTIAL_ROOT_ENV_KEYS = Object.freeze([
  "HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "GROK_HOME",
] as const);

export function isCredentialRootEnvKey(key: string): boolean {
  return (CREDENTIAL_ROOT_ENV_KEYS as readonly string[]).includes(key);
}

/**
 * Is this key one of the git config/redirect or SSH-agent CAPABILITY channels
 * the composer strips? Distinct from the credential-shaped pattern: a
 * legitimate API-key credential var IS credential-shaped (e.g. GLM_API_KEY),
 * so the API-key contract check rejects an aliased CAPABILITY channel (this
 * predicate) but not a genuine credential var.
 */
export function isGitOrSshChannelEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    (STRIPPED_ENV_EXACT as readonly string[]).includes(upper) ||
    (STRIPPED_ENV_PREFIXES as readonly string[]).some((p) => upper.startsWith(p))
  );
}

/**
 * Does the worker-env composer strip this key name (credential-shaped, a git
 * config/redirect channel, or an SSH agent reference)? The composer's full
 * strip predicate.
 */
export function isStrippedWorkerEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    isGithubCredentialShapedKey(upper) ||
    CREDENTIAL_SHAPED_RE.test(upper) ||
    isGitOrSshChannelEnvKey(upper)
  );
}

/** Is this key one of the host-inherited allowlist names? */
export function isWorkerEnvAllowlistKey(key: string): boolean {
  return (WORKER_ENV_ALLOWLIST as readonly string[]).includes(key.toUpperCase());
}
