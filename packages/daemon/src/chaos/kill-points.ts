/**
 * Named kill points (WP-104, CAM-STATE-06).
 *
 * The durable protocol exposes a hook at every gap a crash could land in;
 * the chaos child arms this hook from the environment and SIGKILLs ITSELF
 * at the requested point — real `kill -9`, no cleanup handlers, fully
 * deterministic. The PRD's two mandatory sides of the external call map
 * to: BEFORE — `after-intent-recorded`, `after-execution-started`,
 * `in-transport-before-effect`; AFTER — `in-transport-after-effect`,
 * `after-external-call` (the call succeeded, confirmation not yet
 * recorded — the dangerous ambiguity window).
 *
 * Modes (environment-driven, combinable with any script):
 *  - CAMINO_KILL_POINT=<name> [CAMINO_KILL_OCCURRENCE=<n>, default 1]:
 *    die at the n-th time the named point fires (deterministic matrix).
 *  - CAMINO_KILL_NTH=<n>: die at the n-th hook invocation of ANY name —
 *    the exhaustive sweep walks n upward until a run completes, covering
 *    every hook site in a script without naming them.
 */

export const KILL_POINTS = [
  /** Script-side: intent durably recorded, execution not yet begun. */
  "after-intent-recorded",
  /** Executor: barrier durable, transport not yet invoked. */
  "after-execution-started",
  /** Transport: request in flight, effect not yet committed externally. */
  "in-transport-before-effect",
  /** Transport: effect committed externally, response never delivered. */
  "in-transport-after-effect",
  /** Executor: definitive success received, confirmation not yet recorded. */
  "after-external-call",
  /** Recovery: after appending one intent's resolution. */
  "recovery-after-resolution-append",
  /** Recovery: between the ambiguity row and its escalation row. */
  "recovery-between-ambiguity-and-escalation",
] as const;
export type KillPointName = (typeof KILL_POINTS)[number];

function die(): never {
  process.kill(process.pid, "SIGKILL");
  // SIGKILL delivery is not synchronous with the syscall return; spin so
  // no code past the kill point can ever run.
  for (;;) {
    /* waiting to die */
  }
}

/**
 * Build the hook a chaos child installs everywhere (executor, transports,
 * recovery, script). Unarmed (no env vars) it is a no-op.
 */
export function armedKillHook(env: NodeJS.ProcessEnv = process.env): (point: string) => void {
  const targetPoint = env["CAMINO_KILL_POINT"];
  const occurrenceRaw = env["CAMINO_KILL_OCCURRENCE"];
  const targetOccurrence = occurrenceRaw === undefined ? 1 : Number(occurrenceRaw);
  const nthRaw = env["CAMINO_KILL_NTH"];
  const targetNth = nthRaw === undefined ? undefined : Number(nthRaw);
  let totalHits = 0;
  let namedHits = 0;
  return (point: string): void => {
    totalHits += 1;
    if (targetNth !== undefined && totalHits === targetNth) die();
    if (targetPoint !== undefined && point === targetPoint) {
      namedHits += 1;
      if (namedHits === targetOccurrence) die();
    }
  };
}
