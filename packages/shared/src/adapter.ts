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
// This file is types + pure constants only: packages/shared compiles with no
// Node types and must stay importable from any package, including pure core.

/** A normalized event parsed from an adapter's headless output stream. */
export interface StreamEvent {
  /** Coarse kind so the harness can reason without knowing each vendor's schema. */
  kind: "assistant" | "tool" | "result" | "error" | "other";
  /** Short human text for the transcript (already truncated by the parser). */
  text: string;
  /** Provider rate-limit / quota signal detected on this line, if any. */
  quotaSignal?: boolean;
}

/**
 * How a dispatch ended, classified per CAM-EXEC-06: a provider rate limit is
 * `quota-blocked`, NEVER `requirement-failed` — blaming the worker for the
 * provider's throttle would corrupt the outcome ledger. `cancelled` (external
 * cancel) and `killed` (harness timeout) are distinct so a timeout can never
 * masquerade as a user decision.
 */
export type DispatchOutcome =
  "succeeded" | "requirement-failed" | "quota-blocked" | "cancelled" | "killed";

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
 * Containment boundary (round-1 review finding 1): "gone" here means the
 * worker's process GROUP is gone. A descendant that deliberately detaches
 * into its OWN session/group (setsid / double-fork, reparented to init)
 * escapes both the group signal and the group-liveness probe — no
 * signal-based mechanism on this layer can contain that. Complete
 * process-tree containment is the container's job: WP-107 runs each worker
 * in a PID namespace where killing the container reaps every pid regardless
 * of session. At THIS layer the fencing guarantee is scoped to the process
 * group, and that scope is stated, not overclaimed.
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
}

/**
 * The context passed to a lease release. `groupGone` is always literally true:
 * the lifecycle only ever invokes release AFTER the worker process group is
 * confirmed gone (or was never spawned), never before. (See the containment
 * boundary on KillConfirmRecord: "gone" is scoped to the process group; a
 * deliberate session escapee is contained by WP-107's container.)
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
 *   - even when the dispatch body throws unexpectedly: settlement runs in a
 *     finally, so a thrown dispatch never silently strands a lease.
 *
 * Group scope, not full-tree (round-1 review finding 1): a descendant that
 * detaches into its own session escapes group containment; the environment's
 * true single-owner guarantee is completed by WP-107's container (kill the
 * container → every namespaced pid dies). WP-105 owns the ordering guarantee
 * at the group boundary.
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
export const GITHUB_CREDENTIAL_MARKERS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_PAT",
  "GIT_ASKPASS",
  "GIT_TOKEN",
] as const;

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
 */
export const CREDENTIAL_SHAPED_PATTERN =
  /API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SECRET|TOKEN|CREDENTIAL|PASSWORD|PASSPHRASE/i;

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
 *   - git repo/exec redirect: GIT_DIR / GIT_WORK_TREE / GIT_OBJECT_DIRECTORY /
 *     GIT_ALTERNATE_OBJECT_DIRECTORIES / GIT_INDEX_FILE / GIT_NAMESPACE /
 *     GIT_COMMON_DIR / GIT_EXEC_PATH point git at attacker-chosen state or
 *     helper binaries (round-1 review finding 4);
 *   - transport / agent: GIT_SSH / GIT_SSH_COMMAND / GIT_PROXY_COMMAND /
 *     SSH_AUTH_SOCK / SSH_ASKPASS hand out arbitrary transport commands and
 *     the user's SSH agent.
 */
export const STRIPPED_ENV_EXACT = [
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_COMMON_DIR",
  "GIT_EXEC_PATH",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  "SSH_AUTH_SOCK",
  "SSH_ASKPASS",
] as const;

export const STRIPPED_ENV_PREFIXES = ["GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"] as const;

/**
 * The host-inherited allowlist: the ONLY host env keys a worker inherits. HOME
 * is included on purpose — the official vendor CLIs read their OWN
 * subscription auth from under it (the sanctioned path, CAM-SEC-06). Shared so
 * the composer inherits exactly these and the API-key contract refuses to let
 * an adapter alias a credential onto one of them.
 */
export const WORKER_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
] as const;

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
    CREDENTIAL_SHAPED_PATTERN.test(upper) ||
    isGitOrSshChannelEnvKey(upper)
  );
}

/** Is this key one of the host-inherited allowlist names? */
export function isWorkerEnvAllowlistKey(key: string): boolean {
  return (WORKER_ENV_ALLOWLIST as readonly string[]).includes(key.toUpperCase());
}
