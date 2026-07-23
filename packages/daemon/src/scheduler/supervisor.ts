/**
 * Out-of-process attempt-budget supervision (WP-114; the WP-107 handoff's
 * load-bearing obligation — CAM-EXEC-03 authoritative half).
 *
 * WP-107's in-process wall-clock timer is BEST-EFFORT: a worker can delay
 * it by inducing daemon-side CPU (its stated boundary). THIS module is the
 * authoritative bound: a DETACHED supervisor process armed per container
 * run, sharing no event loop with the daemon, that kills the container at
 * the deadline — and killing the container reaps every pid in its PID
 * namespace (WP-107, CAM-EXEC-02). Properties:
 *
 *   - immune to daemon-loop stalls (separate process, own timer);
 *   - survives a daemon crash (detached + unref: an orphan still fires at
 *     the deadline, then exits — bounded and self-terminating);
 *   - covers the "tokens where reportable" residual: usage hidden in an
 *     over-cap output line is unreportable, and is bounded by THIS kill,
 *     not by the token budget (the WP-107 review record's wording).
 *
 * The daemon-side kill-confirm for containers lives here too: a container
 * confirmed gone IS full process-tree confirmation (the namespace
 * collapsed), which licenses the lease settlement (`container` source).
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

const CHILD_PATH = fileURLToPath(new URL("./supervisor-child.mjs", import.meta.url));

export class SupervisorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorError";
  }
}

export interface ArmedSupervisor {
  readonly pid: number;
  readonly containerName: string;
  /** Epoch ms the supervisor fires at. */
  readonly deadlineMs: number;
  /**
   * Stand the supervisor down after a CLEAN finish (worker exited within
   * budget, outcome recorded). Best-effort: a supervisor that already
   * fired or exited is fine — its kill of an already-gone container is a
   * no-op by design.
   */
  disarm(): void;
}

export interface ArmSupervisorOptions {
  readonly containerName: string;
  /** The attempt's wall-clock budget in ms (validated finite positive). */
  readonly wallClockMs: number;
  /**
   * Absolute docker path from the trusted-tool resolution (image-provenance
   * module). Required: the supervisor must not resolve `docker` through an
   * ambient PATH (the WP-107 trusted-PATH handoff).
   */
  readonly dockerPath: string;
  /** Injectable clock (tests). */
  readonly now?: () => Date;
}

/**
 * Arm one supervisor for one container run. Call BEFORE spawning the
 * worker dispatch, so the bound exists before anything it bounds.
 */
export function armContainerSupervisor(options: ArmSupervisorOptions): ArmedSupervisor {
  const { containerName, wallClockMs, dockerPath } = options;
  if (typeof containerName !== "string" || containerName.length === 0) {
    throw new SupervisorError("containerName must be a non-empty string");
  }
  if (!Number.isFinite(wallClockMs) || wallClockMs <= 0) {
    throw new SupervisorError(
      `wallClockMs must be a finite positive number (got ${String(wallClockMs)}) — ` +
        "an unbounded supervisor is no supervisor",
    );
  }
  if (typeof dockerPath !== "string" || !dockerPath.startsWith("/")) {
    throw new SupervisorError(
      "dockerPath must be an absolute trusted path (resolveTrustedTool); ambient-PATH resolution is refused",
    );
  }
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const deadlineMs = nowMs + Math.ceil(wallClockMs);
  const child = spawn(
    process.execPath,
    [CHILD_PATH, containerName, String(deadlineMs), dockerPath],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  if (child.pid === undefined) {
    throw new SupervisorError("failed to spawn the budget supervisor — refusing to run unbounded");
  }
  // Detach fully: the supervisor must not die with the daemon, and must not
  // hold the daemon's loop open.
  child.unref();
  const pid = child.pid;
  return {
    pid,
    containerName,
    deadlineMs,
    disarm(): void {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already exited or fired — both are settled states */
      }
    },
  };
}

/** Run docker at an EXPLICIT absolute path; non-zero exit returned, not thrown. */
async function runDocker(
  dockerPath: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (typeof dockerPath !== "string" || !dockerPath.startsWith("/")) {
    throw new SupervisorError(
      "dockerPath must be an absolute trusted path (resolveTrustedTool); ambient-PATH resolution is refused",
    );
  }
  try {
    const { stdout, stderr } = await execFileP(dockerPath, args, { maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

/**
 * Container kill-confirm: is the container GONE (no such container, or
 * present but not running)? A gone container is FULL process-tree
 * confirmation — the PID namespace collapsed and the kernel reaped every
 * pid (WP-107). Indeterminate docker errors return false (fail-closed:
 * an unconfirmed kill never licenses a lease settlement).
 */
export async function confirmContainerGone(
  containerName: string,
  dockerPath: string,
): Promise<boolean> {
  const r = await runDocker(dockerPath, [
    "inspect",
    "--format",
    "{{.State.Running}}",
    containerName,
  ]);
  if (r.code !== 0) {
    // "No such object" = gone. Any OTHER failure (daemon unreachable,
    // permission) is indeterminate → NOT confirmed.
    return /no such (object|container)/i.test(r.stderr);
  }
  return r.stdout.trim() === "false";
}

/**
 * Kill a container and confirm it gone (the container-scope kill-confirm
 * sequence): SIGKILL via docker, then the gone check. Used by the budget
 * path (breach → kill-and-escalate) and by recovery's settlement of
 * interrupted attempts.
 */
export async function killContainerAndConfirm(
  containerName: string,
  dockerPath: string,
): Promise<boolean> {
  await runDocker(dockerPath, ["kill", "--signal=KILL", containerName]);
  return confirmContainerGone(containerName, dockerPath);
}
