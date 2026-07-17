// Phase-0 dispatch spike (WP-001) — the minimal adapter interface.
//
// This is a SPIKE: it de-risks the mechanics of driving each vendor CLI
// headless (spawn / stream / cancel / cleanup / quota-classify). The durable
// machinery here promotes into packages/daemon's real adapter layer at WP-105;
// the transcripts it records are disposable acceptance evidence.

/** A normalized event parsed from an adapter's headless output stream. */
export interface StreamEvent {
  /** Coarse kind so the harness can reason without knowing each vendor's schema. */
  kind: "assistant" | "tool" | "result" | "error" | "other";
  /** Short human text for the transcript (already truncated by the parser). */
  text: string;
  /** Provider rate-limit / quota signal detected on this line, if any. */
  quotaSignal?: boolean;
}

/** How a dispatch ended, classified per CAM-EXEC-06 (quota is never a failure). */
export type Outcome = "succeeded" | "requirement-failed" | "quota-blocked" | "cancelled" | "killed";

export interface SpawnPlan {
  /** Executable to run (resolved on PATH). */
  file: string;
  /** Argv, excluding the executable. */
  args: string[];
  /** Extra env keys to add on top of the composed clean env (values only). */
  env?: Record<string, string>;
  /** If the prompt is delivered on stdin rather than argv, its text. */
  stdin?: string;
}

export interface AdapterContext {
  /** Absolute path to the isolated worker clone. */
  workdir: string;
  /** The trivial issue prompt to resolve. */
  prompt: string;
  /** Optional model override. */
  model?: string;
}

/**
 * An adapter is pure configuration + pure parsing. All process handling,
 * env composition, kill-confirm, AND outcome classification live in the shared
 * lifecycle so every adapter gets identical, tested semantics — in particular,
 * quota-vs-failure classification is centralized (over parsed events *and* raw
 * output) so no adapter can independently misclassify (CAM-EXEC-06).
 */
export interface AdapterSpec {
  readonly name: string;
  readonly enabled: boolean;
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

export interface DispatchRecord {
  adapter: string;
  outcome: Outcome;
  spawned: boolean;
  streamedEvents: number;
  finalText: string;
  committedSha: string | null;
  killConfirm?: KillConfirmRecord;
  envPosture: EnvPostureRecord;
  exitCode: number | null;
  durationMs: number;
  events: StreamEvent[];
}

export interface KillConfirmRecord {
  requested: boolean;
  /**
   * True if the process group was still alive when the kill signal was sent —
   * i.e. we genuinely interrupted running work, rather than racing a process
   * that had already finished. This is what distinguishes a real cancel/kill
   * from a late no-op (used to classify the dispatch outcome).
   */
  wasAliveAtSignal: boolean;
  /** True if SIGTERM alone did not stop the tree and SIGKILL was needed. */
  escalatedToSigkill: boolean;
  /** True once the whole process group is confirmed gone. */
  treeGone: boolean;
  elapsedMs: number;
}

export interface EnvPostureRecord {
  /** Env keys handed to the worker (values redacted). */
  keys: string[];
  /** GitHub-credential-shaped keys present (must be empty — CAM-SEC-06/EXEC-02). */
  githubCredentialKeys: string[];
  /** Whether git's global/system config was neutralized for the worker. */
  gitGlobalNeutralized: boolean;
}
