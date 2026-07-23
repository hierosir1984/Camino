// WP-114: the compositional credential-free guarantee + the race-free
// create → arm → start protocol (the WP-107 handoff, unit half — a shim
// stands in for docker so the compose path is exercised without a daemon;
// the real-image path lives in container-obligations.test.ts).
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AttemptBudget } from "@camino/shared";
import { ContainerInputError, composeContainerRun, provisionAndArm } from "./container-inputs.js";
import type { WorkerImageProvenance } from "./image-provenance.js";
import type { AttestedWorkerNetwork } from "./worker-network.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const BUDGET: AttemptBudget = { wallClockMs: 60_000 };
const NETWORK_ID = "d".repeat(64);

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A docker shim answering exactly the calls composition makes: the image
 * label inspect ("1"), the network attestation inspect (well-formed TSV
 * for the test network id), and `create` (success). Everything else exits
 * 0 silently.
 */
function shimWorld(): { provenance: WorkerImageProvenance; network: AttestedWorkerNetwork } {
  const dir = tempDir("camino-shim-");
  const dockerPath = join(dir, "docker");
  writeFileSync(
    dockerPath,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  image) echo "1";;',
      `  network) printf '${NETWORK_ID}\\tcamino-worker-test\\tbridge\\tcamino\\n';;`,
      "  create) echo shim-container-id;;",
      "  *) exit 0;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(dockerPath, 0o755);
  const provenance: WorkerImageProvenance = {
    imageId: `sha256:${"c".repeat(64)}`,
    tag: "camino-worker-profile:test",
    builtAt: "2026-07-23T10:00:00.000Z",
    dockerPath,
  };
  const network: AttestedWorkerNetwork = {
    id: NETWORK_ID,
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

  it("refuses a token literal in an env VALUE under an innocent key name (round-1 finding 14)", () => {
    expect(() =>
      composeContainerRun({
        ...baseOptions(),
        env: { INNOCENT_NAME: `ghp_${"A".repeat(36)}` },
      }),
    ).toThrow(/token literal in its VALUE/);
  });

  it("refuses a provider-auth mount carrying credential-shaped files", () => {
    const opts = baseOptions();
    const authDir = tempDir("camino-auth-");
    mkdirSync(join(authDir, "provider"), { recursive: true });
    writeFileSync(
      join(authDir, "provider", ".git-credentials"),
      `https://x-access-token:ghp_${"X".repeat(36)}@github.com\n`,
    );
    expect(() =>
      composeContainerRun({
        ...opts,
        providerAuthMounts: [{ hostPath: authDir, containerPath: "/auth/provider" }],
      }),
    ).toThrow(/GitHub-credential material/);
  });

  it("refuses a token LITERAL inside an innocuously named auth file (round-1 finding 14)", () => {
    const opts = baseOptions();
    const authDir = tempDir("camino-auth-");
    writeFileSync(
      join(authDir, "provider.json"),
      JSON.stringify({ auth: `github_pat_${"a".repeat(30)}` }),
    );
    expect(() =>
      composeContainerRun({
        ...opts,
        providerAuthMounts: [{ hostPath: authDir, containerPath: "/auth/provider" }],
      }),
    ).toThrow(/token literal|GitHub-credential material/);
  });

  it("composes a clean create/start pair: image by content ID, network re-attested by ID", () => {
    const opts = baseOptions();
    const composed = composeContainerRun(opts);
    expect(composed.createArgs[0]).toBe("create");
    expect(composed.createArgs).toContain(opts.image.imageId);
    expect(composed.createArgs).toContain(opts.network.id);
    expect(composed.createArgs).toContain(composed.containerName);
    expect(composed.startArgs).toEqual(["start", "-a", composed.containerName]);
    expect(composed.dockerPath).toBe(opts.image.dockerPath);
  });

  it("re-attests the network at composition: a record describing ANOTHER network refuses", () => {
    const opts = baseOptions();
    // The shim answers every network inspect with NETWORK_ID's record;
    // composing against a DIFFERENT id must refuse — an answer about some
    // other network attests nothing about this one (round-1 finding 14).
    const evil = { ...opts.network, id: "e".repeat(64) };
    expect(() => composeContainerRun({ ...opts, network: evil })).toThrow(
      /not the requested|refusing a record/,
    );
  });
});

describe("provisionAndArm — the race-free arming protocol (round-1 finding 2)", () => {
  it("creates the container FIRST, then arms the supervisor for that exact name", async () => {
    const opts = baseOptions();
    const composed = composeContainerRun(opts);
    const supervisor = await provisionAndArm(composed);
    try {
      expect(supervisor.containerName).toBe(composed.containerName);
      expect(supervisor.deadlineMs).toBeGreaterThan(Date.now());
      expect(supervisor.deadlineMs).toBeLessThanOrEqual(Date.now() + BUDGET.wallClockMs + 1000);
    } finally {
      supervisor.disarm();
    }
  });

  it("a create failure throws with NOTHING armed and nothing running", async () => {
    const opts = baseOptions();
    const composed = composeContainerRun(opts);
    // A dockerPath whose create fails: /usr/bin/false exits 1 for any argv.
    const failing = { ...composed, dockerPath: "/usr/bin/false" };
    await expect(provisionAndArm(failing)).rejects.toThrow(/nothing armed, nothing running/);
  });
});
