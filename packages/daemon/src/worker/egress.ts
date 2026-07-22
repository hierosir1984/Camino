// WP-107: worker container composition (CAM-EXEC-02/03) — the product
// promotion of the WP-005 validation-egress composer, worker-shaped:
//
//   - egress allowlist comes from PER-REPO CONFIG (repo-config.ts), passed to
//     the container as DATA; the entrypoint installs default-deny INPUT+OUTPUT
//     with one accept per entry, rejects the embedded DNS resolver 127.0.0.11
//     BY ADDRESS (Docker DNAT-redirects resolver traffic off port 53 before
//     the filter chain — the WP-005 shakedown finding), closes IPv6, verifies
//     the deny backstops, then drops to the unprivileged workload user;
//   - capabilities are DROPPED WHOLESALE and only the bootstrap set added
//     back (NET_ADMIN/NET_RAW for rule install, SETUID/SETGID for the
//     privilege drop) — the WP-005 known-limitation "full privilege
//     separation" productization, together with no-new-privileges (the
//     workload can never re-gain what the bootstrap had) and the entrypoint
//     clearing CAMINO_EGRESS_* from the workload env;
//   - the container is the PID namespace that completes process-TREE
//     containment (AMEND-10): a worker that setsid()s out of its process
//     group still dies with the container;
//   - mounts are composed, never caller-shaped: the workspace (rw) and
//     provider auth (ALWAYS read-only — CAM-EXEC-02) with bootstrap paths
//     protected from being mounted over.
//
// BOUNDARY, stated: the profile image here carries the isolation harness
// (entrypoint + tools + git). The real worker TOOLCHAIN image (node, vendor
// CLIs) is layered on top of this profile by the attempt runner (WP-114);
// every guarantee in this module is image-content-independent (caps, mounts,
// env, entrypoint), so the layering cannot weaken it.
import { isAbsolute } from "node:path";

export interface EgressAllowlistEntry {
  host: string;
  port: number;
}

// Conservative host shape (DNS names or IPv4 literals). Anything that could
// corrupt the space-separated host:port env contract — whitespace, colons,
// shell metacharacters — is rejected outright. Kept module-private; exported
// as a PREDICATE only (a live RegExp export is mutable via compile() — the
// barrel-immutability lesson).
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NETWORK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Is `host` a safe allowlist host token (DNS name / IPv4 literal)? */
export function isValidAllowlistHost(host: string): boolean {
  return HOST_RE.test(host);
}

/** Is `port` a valid TCP port? */
export function isValidAllowlistPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

// `host`, `none`, `container:<id>` share ANOTHER namespace the root
// bootstrap's `iptables -F/-P DROP` would rewrite; the default bridge has no
// embedded DNS for setup-time resolution. Only an owned user-defined bridge
// is accepted (fail-closed, from WP-005).
const RESERVED_NETWORKS = new Set(["host", "none", "bridge", "default", "host-gateway"]);
const RESERVED_ENV_PREFIX = "CAMINO_EGRESS_";
const PROTECTED_MOUNT_TARGETS = [
  "/",
  "/usr/local/bin",
  "/sbin",
  "/usr/sbin",
  "/bin",
  "/usr/bin",
  "/etc",
  "/lib",
];

/** Where the workspace clone is mounted (rw) inside the worker container. */
export const WORKER_WORKSPACE_MOUNT = "/workspace";

/**
 * The FULL capability set of the worker container — everything else is
 * dropped (`--cap-drop ALL`). NET_ADMIN + NET_RAW: iptables rule install
 * (bootstrap only); SETUID + SETGID: the su-exec privilege drop to the
 * workload user. The workload itself runs unprivileged with NO effective
 * capabilities, and no-new-privileges makes that irreversible.
 */
export const WORKER_CONTAINER_CAPS = Object.freeze([
  "NET_ADMIN",
  "NET_RAW",
  "SETUID",
  "SETGID",
] as const);

/** Bound on in-container process count (tree containment, AMEND-10). */
export const WORKER_PIDS_LIMIT = 4096;

export class WorkerContainerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerContainerConfigError";
  }
}

export interface WorkerContainerRun {
  image: string;
  /** An owned user-defined docker network (setup-time DNS; fail-closed). */
  network: string;
  /** Per-repo egress allowlist (repo-config.ts). Empty = deny-all baseline. */
  allowlist: EgressAllowlistEntry[];
  /** Host path of the isolated worker clone; mounted rw at WORKER_WORKSPACE_MOUNT. */
  workspaceHostPath?: string;
  /**
   * Provider subscription-auth material, mounted READ-ONLY — composed `:ro`
   * unconditionally, so no caller can produce a writable auth mount
   * (CAM-EXEC-02: "provider auth is made available read-only").
   */
  providerAuthMounts?: { hostPath: string; containerPath: string }[];
  env?: Record<string, string>;
  name?: string;
}

function assertSafeNetwork(network: string): void {
  if (!network) throw new WorkerContainerConfigError("worker run requires a user-defined network");
  if (network.includes(":") || !NETWORK_NAME_RE.test(network) || RESERVED_NETWORKS.has(network)) {
    throw new WorkerContainerConfigError(
      `worker network ${JSON.stringify(network)} rejected — requires an owned, isolated ` +
        "user-defined bridge (not host/none/bridge/container:<id>; fail-closed)",
    );
  }
}

function assertSafeMountPaths(hostPath: string, containerPath: string): void {
  if (!isAbsolute(hostPath) || hostPath.includes(":")) {
    throw new WorkerContainerConfigError(
      `worker mount host path ${JSON.stringify(hostPath)} rejected (want an absolute, colon-free path)`,
    );
  }
  if (!containerPath.startsWith("/") || containerPath.includes(":")) {
    throw new WorkerContainerConfigError(
      `worker mount target ${JSON.stringify(containerPath)} rejected (want an absolute, colon-free path)`,
    );
  }
  const norm = containerPath.replace(/\/+$/u, "") || "/";
  const covers = (p: string): boolean =>
    p === "/" ? norm === "/" : norm === p || norm.startsWith(`${p}/`);
  if (PROTECTED_MOUNT_TARGETS.some(covers)) {
    throw new WorkerContainerConfigError(
      `worker mount target ${JSON.stringify(containerPath)} would cover a bootstrap path — rejected (fail-closed)`,
    );
  }
}

/** Render the CAMINO_EGRESS_ALLOWLIST value; fail-closed on malformed entries. */
export function renderAllowlistEnv(allowlist: EgressAllowlistEntry[]): string {
  return allowlist
    .map((e) => {
      if (!isValidAllowlistHost(e.host)) {
        throw new WorkerContainerConfigError(
          `egress allowlist host ${JSON.stringify(e.host)} rejected — it could corrupt the ` +
            "space-separated host:port contract (fail-closed)",
        );
      }
      if (!isValidAllowlistPort(e.port)) {
        throw new WorkerContainerConfigError(
          `egress allowlist port ${String(e.port)} out of range (1-65535)`,
        );
      }
      return `${e.host}:${e.port}`;
    })
    .join(" ");
}

/**
 * Full `docker run` argument vector (execFile-style, never a shell string).
 * Parameters are Camino-composed — the untrusted workload is the CODE that
 * runs unprivileged after the rules install — and the composer still refuses
 * any parameter shape that could subvert the root bootstrap (unsafe network,
 * bootstrap-path mount, reserved env key), per the WP-005 fail-closed shape.
 */
export function renderWorkerRunArgs(run: WorkerContainerRun, cmd: string[]): string[] {
  assertSafeNetwork(run.network);
  const args = [
    "run",
    "--rm",
    "--init",
    "--cap-drop",
    "ALL",
    ...WORKER_CONTAINER_CAPS.flatMap((cap) => ["--cap-add", cap]),
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    String(WORKER_PIDS_LIMIT),
    "--network",
    run.network,
  ];
  if (run.name) args.push("--name", run.name);
  // Composed FIRST and its key reserved below, so no caller entry can
  // override it (Docker honours the last -e for a key).
  args.push("-e", `CAMINO_EGRESS_ALLOWLIST=${renderAllowlistEnv(run.allowlist)}`);
  for (const [k, v] of Object.entries(run.env ?? {})) {
    if (!ENV_KEY_RE.test(k)) {
      throw new WorkerContainerConfigError(`worker env key ${JSON.stringify(k)} rejected`);
    }
    if (k.startsWith(RESERVED_ENV_PREFIX)) {
      throw new WorkerContainerConfigError(
        `worker env key ${JSON.stringify(k)} is reserved (composed, not caller-set)`,
      );
    }
    args.push("-e", `${k}=${v}`);
  }
  if (run.workspaceHostPath !== undefined) {
    assertSafeMountPaths(run.workspaceHostPath, WORKER_WORKSPACE_MOUNT);
    args.push("-v", `${run.workspaceHostPath}:${WORKER_WORKSPACE_MOUNT}`);
    args.push("-w", WORKER_WORKSPACE_MOUNT);
  }
  for (const m of run.providerAuthMounts ?? []) {
    assertSafeMountPaths(m.hostPath, m.containerPath);
    if (m.containerPath === WORKER_WORKSPACE_MOUNT) {
      throw new WorkerContainerConfigError(
        "provider auth may not be mounted over the workspace (fail-closed)",
      );
    }
    // `:ro` is COMPOSED — there is no writable-auth-mount code path.
    args.push("-v", `${m.hostPath}:${m.containerPath}:ro`);
  }
  args.push(run.image, ...cmd);
  return args;
}
