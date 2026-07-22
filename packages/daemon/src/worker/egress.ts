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
// BOUNDARY, stated (round-3 finding 13): the profile image carries the
// isolation harness (entrypoint + tools + git). The real worker TOOLCHAIN
// image (node, vendor CLIs) is layered ON TOP of this profile by the attempt
// runner (WP-114). This module's run-time guarantees — cap-drop, no-new-privs,
// pids-limit, the pinned entrypoint, and the refusal of mounts over any
// bootstrap PATH — hold for a CAMINO-BUILT image (the profile or a
// `FROM camino-worker-profile` derivative). They do NOT make the harness
// independent of a MALICIOUSLY-BUILT image: pinning the entrypoint PATH cannot
// pin its CONTENTS, so an attacker-built image that replaced the entrypoint
// binary would skip the bootstrap. Image PROVENANCE — that the run uses a
// Camino-built image — is WP-114's image-build boundary; `image` is a
// Camino-composed run parameter, not untrusted worker input. See
// WORKER_PROFILE_ENTRYPOINT below.
//
// BOUNDARY, stated (round-1 finding 8): this is an IP:port allowlist enforced
// at L3/L4 (iptables). Per-repo hosts are RESOLVED to IPs at container setup
// and permitted by address — there is NO L7 host-identity check (HTTP Host,
// TLS SNI). Consequences, named honestly: (a) a non-allowlisted virtual host
// that shares an allowed host's IP AND port (a shared CDN/hosting IP) is
// reachable; (b) IPs are pinned at setup, so a long run does not see DNS
// re-resolution/drift. An L7 filtering proxy (Host/SNI-aware) is the way to
// close (a) and is a deliberate DEFERRAL, not part of WP-107 — recorded for
// David so the deferral is visible, not buried. For a per-repo registry/docs
// allowlist on a personal tool this L3/L4 posture is the accepted v1, matching
// the WP-005 spike it productizes.
import { realpathSync } from "node:fs";
import { isAbsolute, posix as posixPath } from "node:path";
import {
  isGithubCredentialShapedKey,
  isStrippedWorkerEnvKey,
  isWorkerEnvAllowlistKey,
} from "@camino/shared";

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
// A Docker network ID (short 12 or full 64 hex). `docker run --network` resolves
// a value by NAME *or* ID, so a bare ID for the `host`/`none`/`bridge` network
// slips past the reserved-NAME check (round-10 finding 1). Requiring a name makes
// that check authoritative; the network's DRIVER/ownership is attested where the
// network is CREATED (WP-005/WP-114), which this composer does not run.
const DOCKER_NETWORK_ID_RE = /^[0-9a-f]{12}([0-9a-f]{52})?$/i;

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
// Where the workspace clone is mounted (rw) inside the worker container.
export const WORKER_WORKSPACE_MOUNT = "/workspace";

// The single subtree under which provider-auth is mounted (read-only). A
// Camino-invented location, disjoint from every system path.
export const WORKER_AUTH_MOUNT_ROOT = "/auth";

// BOUNDARY, structural (rounds 3/9 chased a DENYLIST of root-loaded paths and it
// kept regenerating — /usr/local/sbin, then /usr/lib/xtables, then /usr/local/lib
// under musl's loader path…). Round 10 replaces it with an ALLOWLIST, which is
// closed by construction: a mount target must sit at or under one of Camino's
// OWN mount roots (the workspace and the auth subtree). EVERYTHING else — every
// PATH dir, every dynamic-linker/plugin search path (musl OR glibc), /etc, and
// any future one — is refused without having to be enumerated, so no root-phase
// code/config path can be shadowed by a mount. The profile bakes its tools+libs
// into the image; nothing the root phase loads lives under an allowed root.
const SAFE_MOUNT_ROOTS = [WORKER_WORKSPACE_MOUNT, WORKER_AUTH_MOUNT_ROOT];

/**
 * The isolation entrypoint, PINNED at run time (`--entrypoint`) rather than
 * trusting the image's own ENTRYPOINT (round-1 finding 1). The worker toolchain
 * image (WP-114) layers on top of the profile, but an image whose ENTRYPOINT was
 * overridden must still run through the bootstrap: pinning defeats that.
 *
 * BOUNDARY, stated (round-2 finding 1): pinning the PATH does not pin its
 * CONTENTS. The guarantee holds for a CAMINO-BUILT image (the profile, or a
 * `FROM camino-worker-profile` toolchain image WP-114 builds) — the entrypoint
 * binary and its tools are baked in by Camino. Image PROVENANCE (that the run
 * uses a Camino-built image, not an attacker-supplied one) is WP-114's image-
 * build boundary, not this composer's: the `image` argument is Camino-composed
 * like every other run parameter, not untrusted worker input. What this module
 * additionally guarantees is that no MOUNT can shadow the entrypoint or its
 * tools at run time (assertSafeMountPaths rejects a mount over a bootstrap path
 * OR any ancestor of one).
 */
export const WORKER_PROFILE_ENTRYPOINT = "/usr/local/bin/worker-profile-entrypoint";

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
  if (DOCKER_NETWORK_ID_RE.test(network)) {
    throw new WorkerContainerConfigError(
      `worker network ${JSON.stringify(network)} looks like a Docker network ID — a network must be ` +
        "referenced by its owned NAME, never an ID (an ID can resolve to host/none/bridge, bypassing " +
        "the reserved-name check; round-10 finding 1)",
    );
  }
  if (network.includes(":") || !NETWORK_NAME_RE.test(network) || RESERVED_NETWORKS.has(network)) {
    throw new WorkerContainerConfigError(
      `worker network ${JSON.stringify(network)} rejected — requires an owned, isolated ` +
        "user-defined bridge (not host/none/bridge/container:<id>; fail-closed)",
    );
  }
}

/** Lexically canonicalize an absolute path (resolve `.`/`..`//), trailing-slash-free. */
function canonicalAbsolute(p: string): string {
  const norm = posixPath.normalize(p);
  return norm.length > 1 ? norm.replace(/\/+$/u, "") : norm;
}

/**
 * Resolve a HOST path to its real location (following symlinks) so overlap
 * checks compare inodes, not spellings — a symlink auth source into the
 * workspace shares the workspace inode despite a distinct path (round-2
 * finding 2). Falls back to lexical canonicalization when the path (or a
 * prefix) does not yet exist, resolving the longest existing prefix so a
 * symlinked PARENT is still followed.
 */
function realHostPath(p: string): string {
  const lexical = canonicalAbsolute(p);
  try {
    return realpathSync(lexical);
  } catch {
    // Resolve the deepest existing ancestor, then re-append the rest.
    const parts = lexical.split("/").filter((s) => s.length > 0);
    for (let i = parts.length - 1; i >= 1; i--) {
      const prefix = "/" + parts.slice(0, i).join("/");
      try {
        const realPrefix = realpathSync(prefix);
        return canonicalAbsolute(realPrefix + "/" + parts.slice(i).join("/"));
      } catch {
        /* keep shrinking */
      }
    }
    return lexical;
  }
}

/** Does `a` equal, contain, or sit inside `b` (path-segment prefix, either way)? */
function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Validate a mount and return the CANONICAL container target. Canonicalizing
 * BEFORE the covers-check closes the `/tmp/../usr/local/bin` bypass
 * (round-1 finding 1): Docker normalizes `..` in a mount target onto the
 * protected path, so the composer must too.
 */
function assertSafeMountPaths(hostPath: string, containerPath: string): string {
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
  const norm = canonicalAbsolute(containerPath);
  if (norm === "/") {
    throw new WorkerContainerConfigError(
      `worker mount target ${JSON.stringify(containerPath)} is the container root — rejected (fail-closed)`,
    );
  }
  // ALLOWLIST (round-10 findings 2/4): the canonical target must sit at or under
  // one of Camino's OWN mount roots. Canonicalization already collapsed any `..`,
  // so `/tmp/../usr/local/lib` cannot masquerade as an allowed root. Anything
  // outside — a system binary/library/plugin/config path, whether or not it is in
  // any hand-kept denylist — is refused. This is closed by construction; there is
  // no path left to enumerate.
  const underAllowedRoot = SAFE_MOUNT_ROOTS.some(
    (root) => norm === root || norm.startsWith(`${root}/`),
  );
  if (!underAllowedRoot) {
    throw new WorkerContainerConfigError(
      `worker mount target ${JSON.stringify(containerPath)} (canonically ${norm}) is outside ` +
        `Camino's mount roots ${JSON.stringify(SAFE_MOUNT_ROOTS)} — refused (fail-closed): a mount ` +
        "may only target the workspace or the auth subtree, never a system path the root bootstrap loads",
    );
  }
  return norm;
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
 * runs unprivileged after the rules install — and the composer refuses any
 * parameter shape that could subvert the root bootstrap or the isolation:
 * an unsafe network, a bootstrap-path mount (canonicalized), a reserved or
 * credential-shaped env key, an overlapping mount source that would alias a
 * read-only mount through the rw workspace, or an image whose ENTRYPOINT could
 * skip the profile bootstrap (the entrypoint is PINNED). Round-1 findings
 * 1/2/3 closed here.
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
    // PIN the isolation entrypoint so ANY image runs the rule-install bootstrap
    // (round-1 finding 1): the image's own ENTRYPOINT can never skip it.
    "--entrypoint",
    WORKER_PROFILE_ENTRYPOINT,
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
    // Zero GitHub credentials, enforced at the container boundary too
    // (round-1 finding 2): a credential-shaped key, or any key the WP-105 env
    // layer strips (git config/redirect, SSH agent, ambient provider key),
    // must not be handed to the worker container as `-e`. The daemon env layer
    // strips the dispatch env; this closes the same channel for the container.
    if (
      isGithubCredentialShapedKey(k) ||
      (isStrippedWorkerEnvKey(k) && !isWorkerEnvAllowlistKey(k))
    ) {
      throw new WorkerContainerConfigError(
        `worker env key ${JSON.stringify(k)} is credential-shaped and refused — workers hold zero credentials (CAM-EXEC-02)`,
      );
    }
    args.push("-e", `${k}=${v}`);
  }
  // Resolve the workspace host path to its REAL location once so overlap checks
  // compare inodes, not spellings — an auth source that is a symlink into the
  // workspace tree would be writable through the workspace alias despite its
  // own :ro mount (round-1 finding 3; round-2 finding 2 widened this from
  // lexical to realpath).
  const workspaceHost =
    run.workspaceHostPath !== undefined ? realHostPath(run.workspaceHostPath) : undefined;
  if (run.workspaceHostPath !== undefined) {
    assertSafeMountPaths(run.workspaceHostPath, WORKER_WORKSPACE_MOUNT);
    args.push("-v", `${run.workspaceHostPath}:${WORKER_WORKSPACE_MOUNT}`);
    args.push("-w", WORKER_WORKSPACE_MOUNT);
  }
  // BOUNDARY, stated (round-3 finding 3): the workspace and provider-auth
  // mount SOURCES are both Camino-composed from disjoint, Camino-OWNED host
  // trees (a fresh clone; the vault's provider-auth dir). The realpath overlap
  // check below closes the reachable MISCONFIGURATION — a symlinked source that
  // resolves into the workspace. It does NOT chase two adversarial aliases that
  // presuppose daemon-level write access: a HARDLINK of an auth file into the
  // workspace, or a symlink SWAP racing between this check and docker's mount,
  // both require writing into Camino's own owned trees, which is outside the
  // worker threat model (the worker gets the composed container; it does not
  // compose it). Camino never hardlinks auth into a workspace, so no such alias
  // exists for this check to detect.
  const seenTargets = new Set<string>([WORKER_WORKSPACE_MOUNT]);
  for (const m of run.providerAuthMounts ?? []) {
    const target = assertSafeMountPaths(m.hostPath, m.containerPath);
    // The read-only guarantee is only real if the same bytes are not also
    // mounted rw elsewhere: reject an auth container target inside the
    // workspace mount, AND an auth HOST source overlapping the workspace host
    // tree (round-1 finding 3).
    if (target === WORKER_WORKSPACE_MOUNT || target.startsWith(`${WORKER_WORKSPACE_MOUNT}/`)) {
      throw new WorkerContainerConfigError(
        `provider auth target ${JSON.stringify(m.containerPath)} is inside the rw workspace mount — rejected (fail-closed)`,
      );
    }
    if (seenTargets.has(target)) {
      throw new WorkerContainerConfigError(
        `duplicate mount target ${JSON.stringify(target)} — rejected (fail-closed)`,
      );
    }
    seenTargets.add(target);
    if (workspaceHost !== undefined && pathsOverlap(realHostPath(m.hostPath), workspaceHost)) {
      throw new WorkerContainerConfigError(
        `provider auth host source ${JSON.stringify(m.hostPath)} resolves into the rw workspace source ` +
          `${JSON.stringify(run.workspaceHostPath)} — the :ro mount would be writable through the ` +
          "workspace alias (fail-closed)",
      );
    }
    // `:ro` is COMPOSED — there is no writable-auth-mount code path.
    args.push("-v", `${m.hostPath}:${m.containerPath}:ro`);
  }
  args.push(run.image, ...cmd);
  return args;
}
