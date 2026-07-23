/**
 * Worker-image provenance + trusted daemon toolchain (WP-114; the WP-107
 * handoff's supply-chain obligation).
 *
 * WP-107's entrypoint pinning defeats an ENTRYPOINT override — it does NOT
 * defeat a maliciously-built image or a substituted daemon-side tool. This
 * module is the image-build boundary WP-107 names:
 *
 *   IMAGE PROVENANCE. The scheduler builds the worker image ITSELF from
 *   the in-repo profile (packages/daemon/src/worker/worker-profile — the
 *   reviewed Dockerfile), captures the CONTENT-ADDRESSED image ID from its
 *   own build, and dispatch runs by THAT ID, never by tag. An image ID is
 *   a digest of the image's config+layers, so the run is byte-identical to
 *   what Camino built: a tag repointed at a hostile image cannot be
 *   selected, because tags are never what dispatch passes to `docker run`.
 *   NAMED BOUNDARY: the local Docker store is trusted — an actor who can
 *   rewrite Docker's content store (root on the host) is outside every
 *   in-process guarantee, the same perimeter every daemon store names.
 *
 *   TRUSTED TOOLCHAIN. Daemon-side subprocess tools (docker, git, tar) are
 *   resolved ONCE against a FIXED system-directory list — never the
 *   ambient PATH, which a hostile environment variable could point at a
 *   writable directory. The resolved path must be a regular executable
 *   file; resolution failure is a refusal, not a fallback to PATH.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKER_PROFILE_DIR = fileURLToPath(
  new URL("../worker/worker-profile", import.meta.url),
);

/** The label the Camino build stamps (informational; the ID is the guarantee). */
export const CAMINO_IMAGE_LABEL = "ai.camino.built";

/**
 * Fixed trusted directories for daemon-side tools, in resolution order.
 * System paths first; the Homebrew prefixes admit the macOS dev host.
 * NAMED BOUNDARY (round-2 finding 10): on a default macOS host the
 * Homebrew prefix is owned by the daemon USER — "trusted" here means the
 * daemon user's own administrative surface, and a hostile writer running
 * AS that user is outside every in-process guarantee (it could patch this
 * daemon's node_modules directly). What resolution additionally refuses,
 * fail-closed, is the accident class: a WORLD-writable directory or tool
 * file, and any $PATH consultation at all.
 */
export const TRUSTED_TOOL_DIRS = Object.freeze([
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
] as const);

export class ToolchainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolchainError";
  }
}

/**
 * Resolve a tool to an absolute path inside the trusted directory list.
 * Refuses (never falls back to PATH) when absent everywhere.
 */
export function resolveTrustedTool(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new ToolchainError(`tool name ${JSON.stringify(name)} is not a plain executable name`);
  }
  for (const dir of TRUSTED_TOOL_DIRS) {
    const candidate = join(dir, name);
    try {
      const dirStat = statSync(dir);
      if ((dirStat.mode & 0o002) !== 0) continue; // world-writable dir: never trusted
      const stat = statSync(candidate);
      if (!stat.isFile()) continue;
      if ((stat.mode & 0o002) !== 0) continue; // world-writable tool: never trusted
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new ToolchainError(
    `tool ${name} not found in the trusted directories (${TRUSTED_TOOL_DIRS.join(", ")}) — ` +
      "refusing ambient-PATH resolution (WP-107 trusted-toolchain handoff)",
  );
}

/** The provenance record dispatch composition consumes. */
export interface WorkerImageProvenance {
  /** Content-addressed image ID (sha256:…): what `docker run` receives. */
  readonly imageId: string;
  /** The tag the build stamped (human handle only; never the run argument). */
  readonly tag: string;
  readonly builtAt: string;
  readonly dockerPath: string;
}

export interface BuildWorkerImageOptions {
  /** Human tag for the build (the run always uses the ID). */
  readonly tag?: string;
  /** Injectable clock (tests). */
  readonly now?: () => Date;
}

function runDocker(
  dockerPath: string,
  args: string[],
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(dockerPath, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Build the worker image from the in-repo profile and return its
 * provenance. Synchronous and long (docker build); call at daemon startup
 * or in test setup, not per dispatch.
 *
 * The build context is PINNED to the in-repo profile (round-1 finding 14:
 * a caller-supplied context would let this function stamp the Camino label
 * onto foreign bytes — the label would then attest something the build
 * boundary never inspected). A derivative toolchain image (`FROM
 * camino-worker-profile`) is WP-119's runner glue and gets its own
 * reviewed context there.
 */
export function buildWorkerImage(options: BuildWorkerImageOptions = {}): WorkerImageProvenance {
  const dockerPath = resolveTrustedTool("docker");
  const tag = options.tag ?? "camino-worker-profile:local";
  const contextDir = WORKER_PROFILE_DIR;
  const build = runDocker(dockerPath, [
    "build",
    "--label",
    `${CAMINO_IMAGE_LABEL}=1`,
    "-t",
    tag,
    contextDir,
  ]);
  if (build.code !== 0) {
    throw new ToolchainError(
      `worker image build failed (exit ${build.code}): ${build.stderr.slice(-2000) || build.stdout.slice(-2000)}`,
    );
  }
  // The ID from OUR OWN build invocation, read back immediately by the tag
  // we just stamped. From here on, only the ID is used.
  const inspect = runDocker(dockerPath, ["image", "inspect", "--format", "{{.Id}}", tag]);
  if (inspect.code !== 0 || !/^sha256:[0-9a-f]{64}\s*$/.test(inspect.stdout)) {
    throw new ToolchainError(
      `could not read back the built image's content-addressed ID for ${tag}: ${inspect.stderr}`,
    );
  }
  const nowIso = (options.now ?? (() => new Date()))().toISOString();
  return { imageId: inspect.stdout.trim(), tag, builtAt: nowIso, dockerPath };
}

/**
 * Assert a run is about to use EXACTLY the Camino-built image: the run
 * argument must be the recorded content-addressed ID, and the local store
 * must resolve that ID to an image carrying the Camino build label. The ID
 * equality is the guarantee; the label check is a cheap tamper tripwire.
 */
export function assertCaminoBuiltImage(runImage: string, provenance: WorkerImageProvenance): void {
  if (runImage !== provenance.imageId) {
    throw new ToolchainError(
      `worker run image ${JSON.stringify(runImage)} is not the Camino-built image ID ` +
        `${provenance.imageId} — dispatch runs by content-addressed ID, never by tag ` +
        "(WP-107 image-provenance handoff)",
    );
  }
  const inspect = runDocker(provenance.dockerPath, [
    "image",
    "inspect",
    "--format",
    `{{index .Config.Labels "${CAMINO_IMAGE_LABEL}"}}`,
    provenance.imageId,
  ]);
  if (inspect.code !== 0) {
    throw new ToolchainError(
      `the Camino-built image ${provenance.imageId} is no longer in the local store — refusing to run`,
    );
  }
  if (inspect.stdout.trim() !== "1") {
    throw new ToolchainError(
      `image ${provenance.imageId} does not carry the Camino build label — the local store ` +
        "disagrees with this daemon's build record; refusing to run",
    );
  }
}
