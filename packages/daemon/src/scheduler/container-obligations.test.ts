/**
 * WP-114 container-layer obligations against a REAL Docker daemon (the
 * WP-107 handoff, integration half). Requires Docker and refuses to skip
 * (the WP-004/WP-107 fail-closed convention — a silent skip would let CI
 * go green while proving nothing):
 *
 *   - IMAGE PROVENANCE: the scheduler's own build yields a
 *     content-addressed ID; runs are attested against THAT ID; tags and
 *     foreign images are refused.
 *   - NETWORK OWNERSHIP: the creator attests driver/label by full ID; a
 *     built-in network's ID fails attestation.
 *   - AUTHORITATIVE OUT-OF-PROCESS BUDGET: the supervisor kills an
 *     over-deadline container WHILE THIS PROCESS'S EVENT LOOP IS BLOCKED —
 *     the daemon-stall immunity WP-107's in-process timer cannot have —
 *     and a killed container is gone with every namespaced pid.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireDockerDaemon } from "../worker/docker.js";
import { composeContainerRun, provisionAndArm } from "./container-inputs.js";
import {
  assertCaminoBuiltImage,
  buildWorkerImage,
  resolveTrustedTool,
  ToolchainError,
  type WorkerImageProvenance,
} from "./image-provenance.js";
import {
  attestWorkerNetwork,
  createAttestedWorkerNetwork,
  destroyWorkerNetwork,
  WorkerNetworkError,
  type AttestedWorkerNetwork,
} from "./worker-network.js";
import { armContainerSupervisor, confirmContainerGone } from "./supervisor.js";

const SETUP_TIMEOUT = 300_000;
const TEST_TIMEOUT = 120_000;
const TAG = "camino-worker-profile:wp114";

let provenance: WorkerImageProvenance;
let network: AttestedWorkerNetwork;
const containers: string[] = [];

function docker(args: string[]): string {
  return execFileSync(provenance.dockerPath, args, { encoding: "utf8" });
}

beforeAll(async () => {
  await requireDockerDaemon();
  provenance = buildWorkerImage({ tag: TAG });
  network = createAttestedWorkerNetwork({ dockerPath: provenance.dockerPath });
}, SETUP_TIMEOUT);

afterAll(() => {
  for (const name of containers) {
    try {
      docker(["rm", "-f", name]);
    } catch {
      /* already gone */
    }
  }
  if (network !== undefined) destroyWorkerNetwork(network);
});

function runSleeper(name: string, seconds: number): void {
  containers.push(name);
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--entrypoint",
    "/bin/sleep",
    provenance.imageId,
    String(seconds),
  ]);
}

describe("image provenance (WP-107 supply-chain handoff)", () => {
  it("the build yields a content-addressed ID and attestation passes on the ID alone", () => {
    expect(provenance.imageId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => assertCaminoBuiltImage(provenance.imageId, provenance)).not.toThrow();
  });

  it("a TAG is refused as the run image — only the recorded ID runs", () => {
    expect(() => assertCaminoBuiltImage(TAG, provenance)).toThrow(ToolchainError);
    expect(() => assertCaminoBuiltImage(TAG, provenance)).toThrow(/content-addressed ID/);
  });

  it(
    "a foreign image's ID fails the label tripwire",
    () => {
      // The profile's own base image (present locally after the build) was
      // not built by Camino: attesting it must refuse.
      docker(["pull", "alpine:3.20"]);
      const foreignId = docker(["image", "inspect", "--format", "{{.Id}}", "alpine:3.20"]).trim();
      const forged: WorkerImageProvenance = { ...provenance, imageId: foreignId };
      expect(() => assertCaminoBuiltImage(foreignId, forged)).toThrow(/Camino build label/);
    },
    TEST_TIMEOUT,
  );

  it("docker itself resolves from the trusted directories, never $PATH", () => {
    expect(provenance.dockerPath).toBe(resolveTrustedTool("docker"));
    expect(provenance.dockerPath.startsWith("/")).toBe(true);
  });
});

describe("network ownership attestation (WP-107 network handoff)", () => {
  it("the created network attests: full ID, bridge driver, Camino owner label", () => {
    expect(network.id).toMatch(/^[0-9a-f]{12,64}$/);
    expect(network.driver).toBe("bridge");
    const again = attestWorkerNetwork(network.id, { dockerPath: provenance.dockerPath });
    expect(again.name).toBe(network.name);
  });

  it("a BUILT-IN network's ID fails attestation (no Camino owner label)", () => {
    const bridgeId = docker(["network", "inspect", "--format", "{{.Id}}", "bridge"]).trim();
    expect(() => attestWorkerNetwork(bridgeId, { dockerPath: provenance.dockerPath })).toThrow(
      WorkerNetworkError,
    );
  });
});

describe("authoritative out-of-process budget bound (CAM-EXEC-03, the load-bearing handoff)", () => {
  it(
    "kills an over-deadline container even while the daemon-side event loop is BLOCKED",
    async () => {
      const name = `camino-sup-${Date.now().toString(36)}`;
      runSleeper(name, 120);
      const armed = armContainerSupervisor({
        containerName: name,
        wallClockMs: 1500,
        dockerPath: provenance.dockerPath,
      });
      try {
        // BLOCK this process's event loop straight through the deadline —
        // an in-process timer could not fire here; the supervisor is a
        // separate process and does (the whole point of the obligation).
        const gate = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(gate, 0, 0, 4000);
        // The container must be gone (kill ⇒ PID namespace collapse ⇒
        // every pid reaped — WP-107's containment guarantee).
        let gone = false;
        for (let i = 0; i < 20 && !gone; i++) {
          gone = await confirmContainerGone(name, provenance.dockerPath);
          if (!gone) await new Promise((r) => setTimeout(r, 500));
        }
        expect(gone).toBe(true);
      } finally {
        armed.disarm();
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "a disarmed supervisor leaves an in-budget container untouched",
    async () => {
      const name = `camino-sup-ok-${Date.now().toString(36)}`;
      runSleeper(name, 120);
      const armed = armContainerSupervisor({
        containerName: name,
        wallClockMs: 60_000,
        dockerPath: provenance.dockerPath,
      });
      armed.disarm();
      await new Promise((r) => setTimeout(r, 1500));
      expect(await confirmContainerGone(name, provenance.dockerPath)).toBe(false);
      docker(["rm", "-f", name]);
    },
    TEST_TIMEOUT,
  );

  it(
    "closes the LATE-START race: a created container cannot start past its deadline (round-1 finding 2)",
    async () => {
      const name = `camino-sup-late-${Date.now().toString(36)}`;
      containers.push(name);
      // The race-free protocol's shape: the container EXISTS (created)
      // before the supervisor arms; a start delayed past the deadline
      // finds it removed — or is promptly killed if it slipped through.
      docker([
        "create",
        "--rm",
        "--name",
        name,
        "--entrypoint",
        "/bin/sleep",
        provenance.imageId,
        "120",
      ]);
      const armed = armContainerSupervisor({
        containerName: name,
        wallClockMs: 1500,
        dockerPath: provenance.dockerPath,
      });
      try {
        await new Promise((r) => setTimeout(r, 5000)); // deadline passes; the child enforces
        let startFailed = false;
        try {
          docker(["start", name]);
        } catch {
          startFailed = true;
        }
        if (!startFailed) {
          // The start slipped into the enforcement loop's window: the next
          // iteration removes the now-running container.
          let gone = false;
          for (let i = 0; i < 20 && !gone; i++) {
            gone = await confirmContainerGone(name, provenance.dockerPath);
            if (!gone) await new Promise((r) => setTimeout(r, 500));
          }
          expect(gone).toBe(true);
        } else {
          expect(startFailed).toBe(true);
        }
      } finally {
        armed.disarm();
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "provisionAndArm over the real daemon: create first, then arm (the composed protocol)",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "camino-obligation-ws-"));
      try {
        const composed = composeContainerRun({
          image: provenance,
          network,
          allowlist: [],
          workspaceHostPath: workspace,
          budget: { wallClockMs: 60_000 },
          cmd: ["true"],
        });
        containers.push(composed.containerName);
        const supervisor = await provisionAndArm(composed);
        try {
          const state = docker([
            "inspect",
            "--format",
            "{{.State.Status}}",
            composed.containerName,
          ]).trim();
          expect(state).toBe("created");
        } finally {
          supervisor.disarm();
          docker(["rm", "-f", composed.containerName]);
        }
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT,
  );
});
