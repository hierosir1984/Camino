// Docker CLI helpers for the WP-005 egress suite. Always execFile with an
// argument vector (never a shell), mirroring the git helper convention from
// the quarantine spike.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;

export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run docker; non-zero exit is returned, not thrown (probe-style callers). */
export async function docker(args: string[]): Promise<DockerResult> {
  try {
    const { stdout, stderr } = await execFileP("docker", args, { maxBuffer: MAX_BUFFER });
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

/** Run docker; non-zero exit throws with the captured output (setup-style callers). */
export async function dockerOrThrow(args: string[]): Promise<DockerResult> {
  const r = await docker(args);
  if (r.code !== 0) {
    throw new Error(`docker ${args.join(" ")} failed (exit ${r.code}): ${r.stderr || r.stdout}`);
  }
  return r;
}

/**
 * The egress suite REQUIRES the Docker daemon (a WP-000 gate prerequisite) and
 * refuses to skip: a silent skip would let CI go green while proving nothing
 * (fail-closed posture, WP-004 convention).
 */
export async function requireDockerDaemon(): Promise<void> {
  const r = await docker(["info", "--format", "{{.ServerVersion}}"]);
  if (r.code !== 0) {
    throw new Error(
      "Docker daemon unavailable — the WP-005 egress suite requires it and refuses to skip " +
        `(fail-closed): ${(r.stderr || r.stdout).trim()}`,
    );
  }
}
