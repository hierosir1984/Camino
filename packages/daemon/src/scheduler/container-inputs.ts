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
 *   - NETWORK: must be a creator-attested Camino-owned bridge ID
 *     (worker-network module) — never a bare name;
 *   - ENV: zero GitHub-credential-shaped keys and zero stripped-class
 *     capability channels (the shared predicates are the single source of
 *     truth — the same ones the WP-105 env composer enforces);
 *   - AUTH MOUNTS: provider-auth only, and the mounted trees are scanned
 *     for GitHub credential material (the WP-107 clone scanner) — the
 *     SUBSCRIPTION provider's token belongs there; a GitHub token never;
 *   - SUPERVISOR: the run is named, and the authoritative out-of-process
 *     wall-clock supervisor is armed for that name BEFORE the caller may
 *     spawn (the compose result carries the armed supervisor).
 *
 * `worker-probes.sh` remains TEST INSTRUMENTATION (WP-107's wording); this
 * module is the production-side composition guard.
 */
import { randomUUID } from "node:crypto";
import type { AttemptBudget } from "@camino/shared";
import { isGithubCredentialShapedKey, isStrippedWorkerEnvKey } from "@camino/shared";
import {
  renderWorkerRunArgs,
  type EgressAllowlistEntry,
  type WorkerContainerRun,
} from "../worker/egress.js";
import { scanForGithubCredentialMaterial } from "../worker/clone.js";
import { assertCaminoBuiltImage, type WorkerImageProvenance } from "./image-provenance.js";
import type { AttestedWorkerNetwork } from "./worker-network.js";
import { armContainerSupervisor, type ArmedSupervisor } from "./supervisor.js";

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
  /** Injectable clock for the supervisor deadline (tests). */
  readonly now?: () => Date;
}

export interface ComposedContainerRun {
  readonly containerName: string;
  /** Full `docker run` argv (execFile-style; never a shell string). */
  readonly runArgs: string[];
  /** The armed authoritative wall-clock bound for this exact container. */
  readonly supervisor: ArmedSupervisor;
  readonly run: WorkerContainerRun;
}

/**
 * Compose one worker container run from ATTESTED inputs, enforce the
 * credential-free composition, and arm the out-of-process supervisor.
 * Every refusal happens before anything runs.
 */
export function composeContainerRun(options: ComposeContainerRunOptions): ComposedContainerRun {
  const { image, network, budget } = options;

  // ENV: the compositional credential-free guarantee (CAM-EXEC-02 "zero
  // GitHub credentials"; CAM-SEC-06 classes). The WP-105 composer strips
  // these for the ADAPTER path; the container path enforces the same
  // predicates on what WP-114 composes — one source of truth, two doors.
  const env = options.env ?? {};
  for (const key of Object.keys(env)) {
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
  }

  // AUTH MOUNTS: provider subscription auth only. The mounted host trees
  // are scanned with the WP-107 credential scanner: findings refuse the
  // run (a GitHub token placed in the auth mount would otherwise ride into
  // the container read-only — still a credential the worker must not see).
  for (const mount of options.providerAuthMounts ?? []) {
    const findings = scanForGithubCredentialMaterial(mount.hostPath);
    if (findings.length > 0) {
      throw new ContainerInputError(
        `provider-auth mount ${mount.hostPath} contains GitHub-credential-shaped material ` +
          `(${findings.slice(0, 3).join("; ")}${findings.length > 3 ? "; …" : ""}) — refusing the run`,
      );
    }
  }

  // IMAGE + NETWORK: re-attest at composition time (provenance is a live
  // property of the local store, not a one-time build fact).
  assertCaminoBuiltImage(image.imageId, image);

  const containerName = `camino-attempt-${randomUUID().slice(0, 12)}`;
  const run: WorkerContainerRun = {
    image: image.imageId,
    network: network.id,
    allowlist: options.allowlist,
    workspaceHostPath: options.workspaceHostPath,
    ...(options.providerAuthMounts === undefined
      ? {}
      : { providerAuthMounts: options.providerAuthMounts }),
    env,
    name: containerName,
  };
  // Render FIRST (the composer's own fences run — image shape, network
  // shape, mount roots), then arm the supervisor for the exact name the
  // args carry. Order matters: a render refusal must not leave an armed
  // supervisor behind.
  const runArgs = renderWorkerRunArgs(run, options.cmd ?? []);
  const supervisor = armContainerSupervisor({
    containerName,
    wallClockMs: budget.wallClockMs,
    dockerPath: image.dockerPath,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { containerName, runArgs, supervisor, run };
}
