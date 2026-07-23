/**
 * Real container-input composition (WP-114; the WP-107 handoff's
 * credential-free and provenance obligations, wired together).
 *
 * WP-107's guarantees are COMPOSITIONAL: the composer renders whatever
 * image/network/env/mounts it is handed, and the guarantees hold when the
 * HANDED inputs are clean. WP-114 wires the real inputs, so this module is
 * where the composition is enforced, fail-closed, before any run:
 *
 *   - IMAGE: must be the Camino-built content-addressed ID, re-attested
 *     (image-provenance module) — never a tag;
 *   - NETWORK: RE-attested at composition time by full ID (round-1
 *     finding 14: a one-time attestation object is not a live property) —
 *     driver, ownership label, and non-built-in are all re-checked;
 *   - ENV: zero GitHub-credential-shaped KEYS, zero stripped-class
 *     capability channels (the shared predicates — one source of truth
 *     with the WP-105 composer), and zero credential-token literals in
 *     VALUES (round-1 finding 14: an innocent-named key carrying a PAT
 *     value is still a credential);
 *   - AUTH MOUNTS: provider-auth only; the mounted trees are scanned with
 *     the WP-107 credential scanner AND a bounded content scan for
 *     GitHub-token literals (round-1 finding 14: a PAT inside
 *     provider.json is refused, not only credential-shaped filenames);
 *   - SUPERVISOR: armed by provisionAndArm STRICTLY AFTER `docker create`
 *     succeeds (round-1 finding 2: arming before the container exists let
 *     a slow start outrun a fire-and-forget kill). The protocol is
 *     create → arm → start: the deadline always has a referent.
 *
 * `worker-probes.sh` remains TEST INSTRUMENTATION (WP-107's wording); this
 * module is the production-side composition guard.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AttemptBudget } from "@camino/shared";
import {
  TOKEN_LITERAL_PATTERN_SOURCE,
  isGithubCredentialShapedKey,
  isStrippedWorkerEnvKey,
} from "@camino/shared";
import {
  renderWorkerRunArgs,
  type EgressAllowlistEntry,
  type WorkerContainerRun,
} from "../worker/egress.js";
import { scanForGithubCredentialMaterial } from "../worker/clone.js";
import {
  TRUSTED_TOOL_DIRS,
  assertCaminoBuiltImage,
  type WorkerImageProvenance,
} from "./image-provenance.js";
import { attestWorkerNetwork, type AttestedWorkerNetwork } from "./worker-network.js";
import { armContainerSupervisor, type ArmedSupervisor } from "./supervisor.js";

const execFileP = promisify(execFile);

/** Bounds of the auth-mount content scan (small config trees by design). */
const CONTENT_SCAN_MAX_FILES = 500;
const CONTENT_SCAN_MAX_DEPTH = 6;
const CONTENT_SCAN_MAX_FILE_BYTES = 1024 * 1024;

export class ContainerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerInputError";
  }
}

export interface ComposeContainerRunOptions {
  readonly image: WorkerImageProvenance;
  readonly network: AttestedWorkerNetwork;
  readonly allowlist: EgressAllowlistEntry[];
  readonly workspaceHostPath: string;
  /** Provider subscription-auth trees (mounted read-only by the composer). */
  readonly providerAuthMounts?: { hostPath: string; containerPath: string }[];
  readonly env?: Record<string, string>;
  /** The workload argv the pinned entrypoint hands to the dropped-uid user. */
  readonly cmd?: string[];
  readonly budget: AttemptBudget;
}

export interface ComposedContainerRun {
  readonly containerName: string;
  /** `docker create` argv (execFile-style; never a shell string). */
  readonly createArgs: string[];
  /** `docker start -a` argv: attaches and streams like `run` would. */
  readonly startArgs: string[];
  readonly dockerPath: string;
  readonly budget: AttemptBudget;
  readonly run: WorkerContainerRun;
}

function tokenLiteralRe(): RegExp {
  return new RegExp(TOKEN_LITERAL_PATTERN_SOURCE, "g");
}

/**
 * Bounded content scan of an auth tree for GitHub-token literals. Refusal
 * evidence is the PATH only, never the matched value. Fail-closed on
 * anything unscannable: an unreadable entry or a tree past the bounds is
 * itself a refusal — an auth mount is a SMALL Camino-composed config tree,
 * and one this scan cannot cover is not attestably credential-free.
 */
function contentScanFindings(root: string): string[] {
  const findings: string[] = [];
  let filesSeen = 0;
  const re = tokenLiteralRe();
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > CONTENT_SCAN_MAX_DEPTH) {
      findings.push(`${rel}/ (beyond scan depth — not attestably credential-free)`);
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      findings.push(`${rel}/ (unreadable — not attestably credential-free)`);
      return;
    }
    for (const entry of entries) {
      if (findings.length > 0) return; // first finding refuses; no need to enumerate
      const abs = join(dir, entry);
      const entryRel = rel === "" ? entry : `${rel}/${entry}`;
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        findings.push(`${entryRel} (unreadable — not attestably credential-free)`);
        return;
      }
      if (stat.isDirectory()) {
        walk(abs, entryRel, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      filesSeen++;
      if (filesSeen > CONTENT_SCAN_MAX_FILES) {
        findings.push(`${entryRel} (file cap exceeded — not attestably credential-free)`);
        return;
      }
      if (stat.size > CONTENT_SCAN_MAX_FILE_BYTES) {
        findings.push(`${entryRel} (over the content-scan size bound)`);
        return;
      }
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        findings.push(`${entryRel} (unreadable — not attestably credential-free)`);
        return;
      }
      re.lastIndex = 0;
      if (re.test(text)) {
        findings.push(`${entryRel} (contains a GitHub-token literal)`);
        return;
      }
    }
  };
  walk(root, "", 0);
  return findings;
}

/**
 * Compose one worker container run from ATTESTED inputs and enforce the
 * credential-free composition. PURE with respect to Docker state changes:
 * the network re-attestation reads, nothing runs, nothing is armed —
 * provisionAndArm does that, in the race-free order.
 */
export function composeContainerRun(options: ComposeContainerRunOptions): ComposedContainerRun {
  const { image, network, budget } = options;

  // ENV KEYS: the compositional credential-free guarantee (CAM-EXEC-02
  // "zero GitHub credentials"; CAM-SEC-06 classes) — and ENV VALUES: a
  // token literal under an innocent name is still a credential.
  const env = options.env ?? {};
  const valueRe = tokenLiteralRe();
  for (const [key, value] of Object.entries(env)) {
    if (isGithubCredentialShapedKey(key)) {
      throw new ContainerInputError(
        `worker env key ${JSON.stringify(key)} is GitHub-credential-shaped — workers carry zero ` +
          "GitHub credentials (CAM-EXEC-02; WP-107 compositional guarantee)",
      );
    }
    if (isStrippedWorkerEnvKey(key)) {
      throw new ContainerInputError(
        `worker env key ${JSON.stringify(key)} is a stripped credential/capability channel — ` +
          "the container composition must not reopen what the env composer strips (CAM-SEC-06)",
      );
    }
    valueRe.lastIndex = 0;
    if (valueRe.test(value)) {
      throw new ContainerInputError(
        `worker env key ${JSON.stringify(key)} carries a GitHub-token literal in its VALUE — ` +
          "refused regardless of the key's name (round-1 finding 14)",
      );
    }
  }

  // AUTH MOUNTS: provider subscription auth only — WP-107's scanner for
  // credential-shaped names/known formats, plus the bounded content scan
  // for token literals.
  for (const mount of options.providerAuthMounts ?? []) {
    const findings = [
      ...scanForGithubCredentialMaterial(mount.hostPath),
      ...contentScanFindings(mount.hostPath),
    ];
    if (findings.length > 0) {
      throw new ContainerInputError(
        `provider-auth mount ${mount.hostPath} contains GitHub-credential material ` +
          `(${findings.slice(0, 3).join("; ")}${findings.length > 3 ? "; …" : ""}) — refusing the run`,
      );
    }
  }

  // The ATTESTOR itself must be trusted (round-2 finding 8): a provenance
  // object carrying a docker path outside the trusted directories would
  // let the caller answer its own attestation. This is the cheap
  // accidental-bypass fence (the WP-105 provenance lesson); an in-process
  // caller who can forge the whole object is the named in-process boundary.
  if (!TRUSTED_TOOL_DIRS.some((dir) => image.dockerPath.startsWith(`${dir}/`))) {
    throw new ContainerInputError(
      `provenance docker path ${JSON.stringify(image.dockerPath)} is outside the trusted ` +
        "directories — a composition must not attest through a caller-selected executable",
    );
  }
  // IMAGE + NETWORK: RE-attested at composition time (provenance and
  // ownership are live properties of the local Docker state, not one-time
  // build facts — round-1 finding 14). The run uses the FULL id the
  // re-attestation returned, never the (possibly prefix) input.
  assertCaminoBuiltImage(image.imageId, image);
  const attestedNetwork = attestWorkerNetwork(network.id, { dockerPath: image.dockerPath });

  const containerName = `camino-attempt-${randomUUID().slice(0, 12)}`;
  const run: WorkerContainerRun = {
    image: image.imageId,
    network: attestedNetwork.id,
    allowlist: options.allowlist,
    workspaceHostPath: options.workspaceHostPath,
    ...(options.providerAuthMounts === undefined
      ? {}
      : { providerAuthMounts: options.providerAuthMounts }),
    env,
    name: containerName,
  };
  const runArgs = renderWorkerRunArgs(run, options.cmd ?? []);
  // The composer's argv is `run --rm …`; the race-free protocol splits it
  // into create + start with identical flags (docker create accepts the
  // run flag set; --rm auto-removes on stop for created containers too).
  const createArgs = ["create", ...runArgs.slice(1)];
  const startArgs = ["start", "-a", containerName];
  return { containerName, createArgs, startArgs, dockerPath: image.dockerPath, budget, run };
}

/**
 * The race-free arming protocol (round-1 finding 2): `docker create` the
 * composed container FIRST — it now exists, unstartable past its removal —
 * then arm the out-of-process supervisor for exactly that name. Only after
 * this resolves may the caller `docker start` the workload. A create
 * failure throws with nothing armed and nothing running.
 */
export async function provisionAndArm(
  composed: ComposedContainerRun,
  options: { now?: () => Date } = {},
): Promise<ArmedSupervisor> {
  try {
    await execFileP(composed.dockerPath, composed.createArgs, { maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    throw new ContainerInputError(
      `docker create for ${composed.containerName} failed — nothing armed, nothing running: ` +
        `${(e.stderr ?? e.message ?? "unknown error").slice(0, 500)}`,
    );
  }
  return armContainerSupervisor({
    containerName: composed.containerName,
    wallClockMs: composed.budget.wallClockMs,
    dockerPath: composed.dockerPath,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
