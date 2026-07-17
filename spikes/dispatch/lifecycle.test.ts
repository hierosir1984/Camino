import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dispatch } from "./lifecycle.js";
import { mockAdapter } from "./adapters/mock.js";
import { composeWorkerEnv } from "./env.js";
import { makeWorkspace, headSha, committedSince } from "./workspace.js";

// Every mechanic of the dispatch lifecycle proven against the fake CLI —
// ZERO subscription quota. This is the CI-persistent half of WP-001; the
// real-CLI transcripts are separate, disposable acceptance evidence.

const FAST_KILL = { graceMs: 400, sigkillWaitMs: 2000 };

describe("dispatch lifecycle (mock adapter, no quota)", () => {
  it("spawns, streams events, and the worker produces a local commit", async () => {
    const ws = makeWorkspace();
    const before = headSha(ws);
    try {
      const rec = await dispatch(mockAdapter(), { workdir: ws, prompt: "create GREETING.txt" });
      rec.committedSha = committedSince(ws, before);

      expect(rec.spawned).toBe(true);
      expect(rec.outcome).toBe("succeeded");
      expect(rec.streamedEvents).toBeGreaterThan(0); // live stream parsed
      expect(rec.events.some((e) => e.kind === "assistant")).toBe(true);
      expect(rec.events.some((e) => e.kind === "result")).toBe(true);
      expect(existsSync(`${ws}/GREETING.txt`)).toBe(true);
      expect(rec.committedSha).toMatch(/^[0-9a-f]{40}$/); // worker committed in the clone
      expect(rec.committedSha).not.toBe(before);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("mid-run cancel executes kill-confirm and the whole process TREE is gone", async () => {
    const ws = makeWorkspace();
    try {
      const rec = await dispatch(
        mockAdapter("hang"), // spawns a sleep grandchild, ignores SIGTERM
        { workdir: ws, prompt: "run forever" },
        { cancelAfterFirstEventMs: 50, killConfirm: FAST_KILL },
      );
      expect(rec.outcome).toBe("cancelled");
      expect(rec.killConfirm?.requested).toBe(true);
      expect(rec.killConfirm?.escalatedToSigkill).toBe(true); // SIGTERM ignored → SIGKILL
      expect(rec.killConfirm?.treeGone).toBe(true); // group verified gone
      // No orphaned `sleep 600` grandchild survived this dispatch's group.
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("cancel on a well-behaved worker stops within the grace window (no SIGKILL)", async () => {
    const ws = makeWorkspace();
    try {
      const rec = await dispatch(
        mockAdapter("graceful-cancel"),
        { workdir: ws, prompt: "cancellable" },
        { cancelAfterFirstEventMs: 50, killConfirm: FAST_KILL },
      );
      expect(rec.outcome).toBe("cancelled");
      expect(rec.killConfirm?.treeGone).toBe(true);
      expect(rec.killConfirm?.escalatedToSigkill).toBe(false); // exited on SIGTERM
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("a rate limit is classified quota-blocked, never requirement-failed", async () => {
    const ws = makeWorkspace();
    try {
      const rec = await dispatch(mockAdapter("quota"), { workdir: ws, prompt: "x" });
      expect(rec.exitCode).not.toBe(0);
      expect(rec.outcome).toBe("quota-blocked"); // CAM-EXEC-06
      expect(rec.events.some((e) => e.quotaSignal)).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("worker env carries no GitHub credential and neutralizes git global config", () => {
    // Even if the parent process has GitHub creds, the worker env must not.
    const { env, posture } = composeWorkerEnv({
      PATH: "/usr/bin",
      HOME: "/Users/x",
      GITHUB_TOKEN: "ghp_secret",
      GH_TOKEN: "gho_secret",
      GIT_ASKPASS: "/some/askpass",
    });
    expect(posture.githubCredentialKeys).toEqual([]); // CAM-SEC-06 / CAM-EXEC-02
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
    expect(env["GH_TOKEN"]).toBeUndefined();
    expect(env["GIT_ASKPASS"]).toBeUndefined();
    expect(posture.gitGlobalNeutralized).toBe(true);
    expect(env["HOME"]).toBe("/Users/x"); // provider auth path preserved (sanctioned)
  });

  it("spawn failure of a missing binary is reported, not thrown", async () => {
    const ws = makeWorkspace();
    try {
      const missing = {
        ...mockAdapter(),
        plan: () => ({ file: "definitely-no-such-bin", args: [] }),
      };
      const rec = await dispatch(missing, { workdir: ws, prompt: "x" });
      expect(rec.spawned).toBe(false);
      expect(rec.outcome).toBe("requirement-failed");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("sample-repo isolation", () => {
  it("each workspace is an independent clone", () => {
    const a = makeWorkspace();
    const b = makeWorkspace();
    try {
      expect(a).not.toBe(b);
      execFileSync("git", ["-C", a, "rev-parse", "HEAD"]);
      execFileSync("git", ["-C", b, "rev-parse", "HEAD"]);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
