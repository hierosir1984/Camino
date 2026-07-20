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
 * SIGTERM → grace → SIGKILL iff any group member survives → tree-gone
 * verification. Lease release is sequenced strictly AFTER `treeGone` is
 * confirmed (see LeaseHandle).
 */
export interface KillConfirmRecord {
  requested: boolean;
  /** True if SIGTERM alone did not stop the tree and SIGKILL was needed. */
  escalatedToSigkill: boolean;
  /** True once the whole process group is confirmed gone. */
  treeGone: boolean;
  elapsedMs: number;
}

/** Worker env posture evidence (CAM-SEC-06 / CAM-EXEC-02). Key NAMES only — values are never recorded. */
export interface EnvPostureRecord {
  /** Env keys handed to the worker (values redacted). */
  keys: string[];
  /** GitHub-credential-shaped keys present (empty by construction). */
  githubCredentialKeys: string[];
  /** Whether git's global/system config was neutralized for the worker. */
  gitGlobalNeutralized: boolean;
  /**
   * Key names removed by enforcement (credential-shaped keys, git-config
   * override channels, agent sockets) — observability for the posture the
   * composer enforced. Names only, never values.
   */
  strippedKeys: string[];
}

/**
 * The context passed to a lease release. `treeGone` is always literally true:
 * the lifecycle only ever invokes release AFTER the worker process group is
 * confirmed gone (or was never spawned), never before.
 */
export interface LeaseReleaseContext {
  treeGone: true;
  outcome: DispatchOutcome;
}

/**
 * The attempt-lease seam (PRD §5 registry item 4: kill-confirm ends in "lease
 * release"; CAM-STATE-04: re-grant only after kill-confirm). The dispatch
 * lifecycle guarantees:
 *
 *   - `release` is invoked AT MOST ONCE per dispatch;
 *   - only after the worker process group is confirmed gone (natural exit with
 *     the group swept, kill-confirm with treeGone, or a spawn that never
 *     produced a process);
 *   - NEVER when the tree could not be confirmed gone — the lease is then
 *     deliberately held and the DispatchRecord says so, because releasing a
 *     lease while a worker may still be running would permit two owners of one
 *     environment (the fencing invariant CAM-STATE-04 exists to prevent).
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
  | { released: false; heldReason: "process-tree-unconfirmed" }
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
