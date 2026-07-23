// WP-114: the compositional credential-free guarantee + supervisor arming
// (the WP-107 handoff, unit half — a shim stands in for docker so the
// compose path is exercised without a daemon; the real-image path lives in
// container-obligations.test.ts).
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AttemptBudget } from "@camino/shared";
import { ContainerInputError, composeContainerRun } from "./container-inputs.js";
import type { WorkerImageProvenance } from "./image-provenance.js";
import type { AttestedWorkerNetwork } from "./worker-network.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const BUDGET: AttemptBudget = { wallClockMs: 60_000 };

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A docker shim that answers the provenance label inspect with "1". */
function shimWorld(): { provenance: WorkerImageProvenance; network: AttestedWorkerNetwork } {
  const dir = tempDir("camino-shim-");
  const dockerPath = join(dir, "docker");
  writeFileSync(dockerPath, '#!/bin/sh\necho "1"\n');
  chmodSync(dockerPath, 0o755);
  const provenance: WorkerImageProvenance = {
    imageId: `sha256:${"c".repeat(64)}`,
    tag: "camino-worker-profile:test",
    builtAt: "2026-07-23T10:00:00.000Z",
    dockerPath,
  };
  const network: AttestedWorkerNetwork = {
    id: "d".repeat(64),
    name: "camino-worker-test",
    driver: "bridge",
    attestedAt: "2026-07-23T10:00:00.000Z",
    dockerPath,
  };
  return { provenance, network };
}

function baseOptions() {
  const { provenance, network } = shimWorld();
  const workspace = tempDir("camino-ws-");
  return {
    image: provenance,
    network,
    allowlist: [],
    workspaceHostPath: workspace,
    budget: BUDGET,
  };
}

describe("composeContainerRun — credential-free composition (CAM-EXEC-02 / CAM-SEC-06)", () => {
  it("refuses GitHub-credential-shaped env keys", () => {
    for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "MY_GITHUB_PAT", "GIT_ASKPASS"]) {
      expect(() => composeContainerRun({ ...baseOptions(), env: { [key]: "x" } })).toThrow(
        ContainerInputError,
      );
    }
  });

  it("refuses stripped credential/capability channels the env composer strips", () => {
    for (const key of ["OPENAI_API_KEY", "GIT_SSH_COMMAND", "SSH_AUTH_SOCK", "SOME_SECRET"]) {
      expect(() => composeContainerRun({ ...baseOptions(), env: { [key]: "x" } })).toThrow(
        /stripped credential|GitHub-credential/,
      );
    }
  });

  it("refuses a provider-auth mount carrying GitHub credential material", () => {
    const opts = baseOptions();
    const authDir = tempDir("camino-auth-");
    mkdirSync(join(authDir, "provider"), { recursive: true });
    writeFileSync(
      join(authDir, "provider", ".git-credentials"),
      "https://x-access-token:ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX@github.com\n",
    );
    expect(() =>
      composeContainerRun({
        ...opts,
        providerAuthMounts: [{ hostPath: authDir, containerPath: "/auth/provider" }],
      }),
    ).toThrow(/GitHub-credential-shaped material/);
  });

  it("composes a clean run: image by content ID, network by attested ID, supervisor armed", () => {
    const opts = baseOptions();
    const t0 = Date.parse("2026-07-23T10:00:00.000Z");
    const composed = composeContainerRun({ ...opts, now: () => new Date(t0) });
    try {
      expect(composed.runArgs).toContain(opts.image.imageId);
      expect(composed.runArgs).toContain(opts.network.id);
      expect(composed.runArgs).toContain("--name");
      expect(composed.runArgs).toContain(composed.containerName);
      // The authoritative out-of-process bound exists BEFORE anything runs,
      // for exactly this container, at exactly the budget deadline.
      expect(composed.supervisor.containerName).toBe(composed.containerName);
      expect(composed.supervisor.deadlineMs).toBe(t0 + BUDGET.wallClockMs);
    } finally {
      composed.supervisor.disarm();
    }
  });

  it("a render refusal happens before the supervisor is armed (no orphan supervisors)", () => {
    const opts = baseOptions();
    // A reserved env key passes the credential checks but the composer's
    // own fence refuses it at render time — before arming.
    expect(() =>
      composeContainerRun({ ...opts, env: { CAMINO_EGRESS_ALLOWLIST: "spoof" } }),
    ).toThrow(/reserved/);
  });
});
