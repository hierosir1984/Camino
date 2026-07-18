// Egress-profile composer — WP-005 (CAM-VAL-03 egress half).
//
// Renders `docker run` arguments for the validation-environment egress
// profile: default-deny egress with a per-run allowlist, taken as DATA. The
// container image (see Dockerfile/entrypoint.sh next to this file) installs
// the rules as root and drops to an unprivileged workload user, so the
// workload cannot alter the rules it runs under. NET_ADMIN is granted to the
// container for the root-owned setup step only — the unprivileged workload
// process cannot exercise it.
//
// Reuse shape: WP-107 (worker egress — allowlist from per-repo config) and
// WP-115 (validation runner — allowlisted test endpoints) productize exactly
// this composer + entrypoint pair.

export interface EgressAllowlistEntry {
  host: string;
  port: number;
}

export interface EgressProfileRun {
  image: string;
  /**
   * A user-defined docker network: the entrypoint resolves allowlist names via
   * the network's embedded DNS at setup time (the default bridge has none).
   */
  network: string;
  /** Empty list = deny-all (the baseline posture). */
  allowlist: EgressAllowlistEntry[];
  name?: string;
  env?: Record<string, string>;
  readonlyMounts?: { hostPath: string; containerPath: string }[];
}

// Conservative host shape (DNS names or IPv4 literals). Anything that could
// corrupt the space-separated host:port env contract — whitespace, colons,
// shell metacharacters — is rejected outright.
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Render the CAMINO_EGRESS_ALLOWLIST value; fail-closed on malformed entries. */
export function renderAllowlistEnv(allowlist: EgressAllowlistEntry[]): string {
  return allowlist
    .map((e) => {
      if (!HOST_RE.test(e.host)) {
        throw new Error(
          `egress allowlist host ${JSON.stringify(e.host)} rejected — it could corrupt the ` +
            "space-separated host:port contract (fail-closed)",
        );
      }
      if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) {
        throw new Error(`egress allowlist port ${String(e.port)} out of range (1-65535)`);
      }
      return `${e.host}:${e.port}`;
    })
    .join(" ");
}

/** Full `docker run` argument vector (execFile-style, never a shell string). */
export function renderEgressRunArgs(run: EgressProfileRun, cmd: string[]): string[] {
  if (!run.network) throw new Error("egress profile requires a user-defined network");
  const args = ["run", "--rm", "--cap-add", "NET_ADMIN", "--network", run.network];
  if (run.name) args.push("--name", run.name);
  args.push("-e", `CAMINO_EGRESS_ALLOWLIST=${renderAllowlistEnv(run.allowlist)}`);
  for (const [k, v] of Object.entries(run.env ?? {})) {
    if (!ENV_KEY_RE.test(k))
      throw new Error(`egress profile env key ${JSON.stringify(k)} rejected`);
    args.push("-e", `${k}=${v}`);
  }
  for (const m of run.readonlyMounts ?? []) {
    args.push("-v", `${m.hostPath}:${m.containerPath}:ro`);
  }
  args.push(run.image, ...cmd);
  return args;
}
