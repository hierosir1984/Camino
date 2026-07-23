/**
 * Owned worker-network lifecycle + ownership attestation (WP-114; the
 * WP-107 handoff's network obligation).
 *
 * WP-107's arg composer states its boundary: `--network` resolves by name
 * OR id (any unique prefix), so the composer cannot tell an owned network
 * NAME from a built-in network's ID by shape — the network's driver and
 * ownership are attested by its CREATOR. This module is that creator:
 *
 *   - it CREATES the network (user-defined bridge, Camino label, random
 *     suffix name) and captures the full network ID from its own create;
 *   - it ATTESTS ownership by inspecting THAT ID: driver must be `bridge`,
 *     the name must not be a reserved built-in, and the Camino owner label
 *     must be present;
 *   - dispatch composition receives the attested full ID (unique by
 *     construction — a full 64-hex ID has exactly one referent), never a
 *     name that could collide or a prefix that could alias.
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolveTrustedTool } from "./image-provenance.js";

export const CAMINO_NETWORK_LABEL = "ai.camino.owner";

const RESERVED_NETWORK_NAMES = new Set(["bridge", "host", "none"]);

export class WorkerNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerNetworkError";
  }
}

/** The attestation dispatch composition requires before any run. */
export interface AttestedWorkerNetwork {
  /** Full network ID (the run argument — unique by construction). */
  readonly id: string;
  readonly name: string;
  readonly driver: "bridge";
  /** ISO-8601 instant of the attestation inspect. */
  readonly attestedAt: string;
  readonly dockerPath: string;
}

function runDocker(
  dockerPath: string,
  args: string[],
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(dockerPath, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Inspect a network BY ID and attest it is a Camino-owned isolated bridge.
 * Refuses built-ins, foreign networks, and non-bridge drivers.
 */
export function attestWorkerNetwork(
  networkId: string,
  options: { dockerPath?: string; now?: () => Date } = {},
): AttestedWorkerNetwork {
  if (!/^[0-9a-f]{12,64}$/.test(networkId)) {
    throw new WorkerNetworkError(
      `network id ${JSON.stringify(networkId)} is not a hex network ID — attestation inspects IDs only`,
    );
  }
  const dockerPath = options.dockerPath ?? resolveTrustedTool("docker");
  const inspect = runDocker(dockerPath, [
    "network",
    "inspect",
    "--format",
    `{{.Id}}\t{{.Name}}\t{{.Driver}}\t{{index .Labels "${CAMINO_NETWORK_LABEL}"}}`,
    networkId,
  ]);
  if (inspect.code !== 0) {
    throw new WorkerNetworkError(
      `network ${networkId} cannot be inspected: ${inspect.stderr.trim()}`,
    );
  }
  const [id, name, driver, ownerLabel] = inspect.stdout.trim().split("\t");
  if (id === undefined || name === undefined || driver === undefined) {
    throw new WorkerNetworkError(`network inspect returned an unreadable record for ${networkId}`);
  }
  // The returned id must be a FULL 64-hex network id (round-3 finding 5):
  // everything downstream (the run argument) relies on its uniqueness.
  if (!/^[0-9a-f]{64}$/.test(id)) {
    throw new WorkerNetworkError(
      `network inspect returned a non-canonical id ${JSON.stringify(id)} — refusing`,
    );
  }
  // The record must be ABOUT the requested id (a full id, or the full id
  // the requested unique prefix resolves to) — an answer describing some
  // other network attests nothing about this one.
  if (!id.toLowerCase().startsWith(networkId.toLowerCase())) {
    throw new WorkerNetworkError(
      `network inspect answered for ${id}, not the requested ${networkId} — refusing a record ` +
        "that does not describe the network being attested",
    );
  }
  if (RESERVED_NETWORK_NAMES.has(name)) {
    throw new WorkerNetworkError(
      `network ${networkId} is the built-in "${name}" network — workers run only on Camino-created bridges`,
    );
  }
  if (driver !== "bridge") {
    throw new WorkerNetworkError(
      `network ${networkId} has driver "${driver}" — workers run only on user-defined bridge networks`,
    );
  }
  if (ownerLabel !== "camino") {
    throw new WorkerNetworkError(
      `network ${networkId} does not carry the ${CAMINO_NETWORK_LABEL}=camino label — ` +
        "ownership is attested by the creator, and this daemon did not create it",
    );
  }
  const attestedAt = (options.now ?? (() => new Date()))().toISOString();
  return { id, name, driver: "bridge", attestedAt, dockerPath };
}

/**
 * Create a fresh Camino-owned worker network and return its attestation.
 * The full ID is captured from our own `network create` output and then
 * attested by inspect — creation and attestation are one lifecycle.
 */
export function createAttestedWorkerNetwork(
  options: { dockerPath?: string; now?: () => Date } = {},
): AttestedWorkerNetwork {
  const dockerPath = options.dockerPath ?? resolveTrustedTool("docker");
  const name = `camino-worker-${randomUUID().slice(0, 12)}`;
  const create = runDocker(dockerPath, [
    "network",
    "create",
    "--driver",
    "bridge",
    "--label",
    `${CAMINO_NETWORK_LABEL}=camino`,
    name,
  ]);
  if (create.code !== 0) {
    throw new WorkerNetworkError(`network create failed: ${create.stderr.trim()}`);
  }
  const id = create.stdout.trim();
  if (!/^[0-9a-f]{12,64}$/.test(id)) {
    throw new WorkerNetworkError(`network create returned an unreadable id: ${JSON.stringify(id)}`);
  }
  return attestWorkerNetwork(id, { dockerPath, ...(options.now ? { now: options.now } : {}) });
}

/** Remove an owned network (teardown; refuses to touch unattested ids). */
export function destroyWorkerNetwork(attested: AttestedWorkerNetwork): void {
  const rm = runDocker(attested.dockerPath, ["network", "rm", attested.id]);
  if (rm.code !== 0 && !/not found/i.test(rm.stderr)) {
    throw new WorkerNetworkError(`network rm ${attested.id} failed: ${rm.stderr.trim()}`);
  }
}
