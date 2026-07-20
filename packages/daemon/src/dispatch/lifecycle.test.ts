import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LeaseHandle, LeaseReleaseContext } from "@camino/shared";
import {
  dispatch,
  DisabledAdapterError,
  PRODUCTION_KILL_CONFIRM,
  processTreeConfirmedGone,
} from "./lifecycle.js";
import { mockAdapter } from "./adapters/mock.js";
import { classifyByQuotaSignal } from "./quota.js";
import { makeWorkspace, headSha, committedSince } from "./workspace.js";

// Every mechanic of the dispatch lifecycle proven against the fake CLI —
// ZERO subscription quota. This is the WP-001 dispatch suite promoted to run
// against PRODUCT adapter code in CI (WP-105 acceptance), plus the product
// additions: disabled-adapter refusal, AbortSignal cancellation, post-exit
// group sweep, and lease settlement sequenced after tree-gone.

const FAST_KILL = { graceMs: 400, sigkillWaitMs: 2000 };

/** Independent group-liveness probe (same semantics the lifecycle uses). */
function anyGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The mock CLI writes its pid (== the group id under detached spawn) here. */
function mockPid(ws: string): number {
  return Number(readFileSync(join(ws, ".mock-pid"), "utf8"));
}

describe("dispatch lifecycle (mock adapter, no quota)", () => {
  it("pins the production kill-confirm timings (PRD §5 registry item 4: 30s grace)", () => {
    expect(PRODUCTION_KILL_CONFIRM).toEqual({ graceMs: 30_000, sigkillWaitMs: 5_000 });
  });

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
      expect(rec.lease).toBeUndefined(); // no lease supplied → no disposition claimed
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("REFUSES to dispatch a disabled adapter: typed error, plan() never called (CAM-EXEC-01)", async () => {
    const ws = makeWorkspace();
    try {
      const landmine = {
        ...mockAdapter(),
        enabled: false,
        disabledReason: "sanctioned-path check failed",
        plan: () => {
          throw new Error("plan() must not run for a disabled adapter");
        },
      };
      await expect(dispatch(landmine, { workdir: ws, prompt: "x" })).rejects.toThrow(
        DisabledAdapterError,
      );
      await expect(dispatch(landmine, { workdir: ws, prompt: "x" })).rejects.toThrow(
        /sanctioned-path check failed/,
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("mid-run cancel executes kill-confirm and the whole process TREE is gone (leader ignores SIGTERM)", async () => {
    const ws = makeWorkspace();
    try {
      const rec = await dispatch(
        mockAdapter("hang"), // leader ignores SIGTERM, spawns a sleep grandchild
        { workdir: ws, prompt: "run forever" },
        { cancelAfterFirstEventMs: 50, killConfirm: FAST_KILL },
      );
      expect(rec.outcome).toBe("cancelled");
      expect(rec.killConfirm?.escalatedToSigkill).toBe(true); // SIGTERM ignored → SIGKILL
      expect(rec.killConfirm?.treeGone).toBe(true); // group verified gone
      expect(anyGroupAlive(mockPid(ws))).toBe(false); // independent corroboration
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("AbortSignal cancellation (the product cancel path) runs the same kill-confirm", async () => {
    const ws = makeWorkspace();
    try {
      const ac = new AbortController();
      const pending = dispatch(
        mockAdapter("hang"),
        { workdir: ws, prompt: "run forever" },
        { signal: ac.signal, killConfirm: FAST_KILL, timeoutMs: 30_000 },
      );
      setTimeout(() => ac.abort(), 300);
      const rec = await pending;
      expect(rec.outcome).toBe("cancelled"); // not "killed": abort is a cancel
      expect(rec.killConfirm?.treeGone).toBe(true);
      expect(anyGroupAlive(mockPid(ws))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("a signal already aborted at dispatch time spawns NOTHING (plan() not consulted)", async () => {
    const ws = makeWorkspace();
    try {
      const ac = new AbortController();
      ac.abort();
      const landmine = {
        ...mockAdapter(),
        plan: () => {
          throw new Error("plan() must not run for a pre-cancelled dispatch");
        },
      };
      let released = 0;
      const lease: LeaseHandle = { release: () => void released++ };
      const rec = await dispatch(
        landmine,
        { workdir: ws, prompt: "x" },
        { signal: ac.signal, lease },
      );
      expect(rec.spawned).toBe(false);
      expect(rec.outcome).toBe("cancelled");
      expect(rec.streamedEvents).toBe(0);
      expect(released).toBe(1); // nothing ever ran → the lease is releasable
      expect(rec.lease).toEqual({ released: true });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("orphan case: leader exits on SIGTERM but a descendant ignores it — SIGKILL still reaps the tree", async () => {
    // WP-001 review #1: a leader-only wait would skip SIGKILL and orphan the
    // SIGTERM-ignoring descendant. Correct kill-confirm SIGKILLs the whole group.
    const ws = makeWorkspace();
    try {
      const rec = await dispatch(
        mockAdapter("orphan"),
        { workdir: ws, prompt: "spawn a stubborn descendant" },
        { cancelAfterFirstEventMs: 50, killConfirm: FAST_KILL },
      );
      expect(rec.outcome).toBe("cancelled"); // interrupted a live group
      expect(rec.killConfirm?.escalatedToSigkill).toBe(true); // descendant forced SIGKILL
      expect(rec.killConfirm?.treeGone).toBe(true); // no orphan survives
      expect(anyGroupAlive(mockPid(ws))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("a cooperative descendant gets the FULL grace window (no premature SIGKILL)", async () => {
    // WP-001 review #1-new: escalation must wait for the whole GROUP through the
    // grace period, not SIGKILL the instant the leader exits. A descendant that
    // needs ~200ms to shut down, given a 1500ms grace, must not be SIGKILLed.
    const ws = makeWorkspace();
    try {
      const rec = await dispatch(
        mockAdapter("grace-descendant"),
        { workdir: ws, prompt: "cooperative but slow" },
        { cancelAfterFirstEventMs: 50, killConfirm: { graceMs: 1500, sigkillWaitMs: 2000 } },
      );
      expect(rec.outcome).toBe("cancelled");
      expect(rec.killConfirm?.escalatedToSigkill).toBe(false); // exited within grace
      expect(rec.killConfirm?.treeGone).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("post-exit sweep: a leader that exits 0 leaving a live descendant does not leak the group", async () => {
    // WP-105: natural success is not tree-gone. Without the sweep, the
    // descendant outlives the dispatch and a released lease would have two
    // effective owners of one environment.
    const ws = makeWorkspace();
    try {
      let groupGoneAtRelease: boolean | null = null;
      const lease: LeaseHandle = {
        release: () => {
          groupGoneAtRelease = !anyGroupAlive(mockPid(ws));
        },
      };
      const rec = await dispatch(
        mockAdapter("linger-descendant"),
        { workdir: ws, prompt: "finish but linger" },
        { killConfirm: { graceMs: 1500, sigkillWaitMs: 2000 }, lease },
      );
      expect(rec.outcome).toBe("succeeded"); // the worker's own work completed
      expect(rec.killConfirm).toBeUndefined(); // no cancel/timeout ran
      expect(rec.postExitCleanup?.treeGone).toBe(true); // sweep confirmed the group gone
      expect(rec.postExitCleanup?.escalatedToSigkill).toBe(false); // descendant honored SIGTERM
      expect(rec.lease).toEqual({ released: true });
      expect(groupGoneAtRelease).toBe(true); // release fired only after the sweep
      expect(anyGroupAlive(mockPid(ws))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("lease release is sequenced strictly AFTER tree-gone on the cancel path (registry item 4)", async () => {
    const ws = makeWorkspace();
    try {
      let releaseCount = 0;
      let groupGoneAtRelease: boolean | null = null;
      let ctxSeen: LeaseReleaseContext | null = null;
      const lease: LeaseHandle = {
        release: (ctx) => {
          releaseCount++;
          ctxSeen = ctx;
          groupGoneAtRelease = !anyGroupAlive(mockPid(ws));
        },
      };
      const rec = await dispatch(
        mockAdapter("hang"), // SIGTERM-ignoring leader + sleep grandchild
        { workdir: ws, prompt: "run forever" },
        { cancelAfterFirstEventMs: 50, killConfirm: FAST_KILL, lease },
      );
      expect(rec.outcome).toBe("cancelled");
      expect(rec.killConfirm?.treeGone).toBe(true);
      expect(releaseCount).toBe(1); // at most once
      expect(ctxSeen!.treeGone).toBe(true);
      expect(ctxSeen!.outcome).toBe("cancelled");
      expect(groupGoneAtRelease).toBe(true); // the WHOLE group was dead before release
      expect(rec.lease).toEqual({ released: true });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("lease is released on natural success and on timeout-kill", async () => {
    for (const [mode, opts, expected] of [
      ["solve", {}, "succeeded"],
      ["hang", { timeoutMs: 150, killConfirm: FAST_KILL }, "killed"],
    ] as const) {
      const ws = makeWorkspace();
      try {
        let released = 0;
        const lease: LeaseHandle = { release: () => void released++ };
        const rec = await dispatch(
          mockAdapter(mode),
          { workdir: ws, prompt: "x" },
          { ...opts, lease },
        );
        expect(rec.outcome).toBe(expected);
        expect(released).toBe(1);
        expect(rec.lease).toEqual({ released: true });
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    }
  });

  it("a lease release that throws is recorded, never thrown, and never claims released", async () => {
    const ws = makeWorkspace();
    try {
      const lease: LeaseHandle = {
        release: () => {
          throw new Error("lease store unavailable");
        },
      };
      const rec = await dispatch(mockAdapter(), { workdir: ws, prompt: "x" }, { lease });
      expect(rec.outcome).toBe("succeeded"); // dispatch outcome unaffected
      expect(rec.lease).toEqual({
        released: false,
        heldReason: "release-threw",
        releaseError: expect.stringContaining("lease store unavailable") as unknown as string,
      });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("processTreeConfirmedGone: the lease-hold decision is fail-closed on any unconfirmed record", () => {
    const gone = { requested: true, escalatedToSigkill: true, treeGone: true, elapsedMs: 1 };
    const alive = { requested: true, escalatedToSigkill: true, treeGone: false, elapsedMs: 1 };
    // Never spawned → nothing to confirm.
    expect(processTreeConfirmedGone({ spawned: false })).toBe(true);
    // Natural exit with the post-exit probe finding the group empty (no records).
    expect(processTreeConfirmedGone({ spawned: true })).toBe(true);
    // Kill-confirm verified the group gone.
    expect(processTreeConfirmedGone({ spawned: true, killConfirm: gone })).toBe(true);
    // Kill-confirm could NOT verify → hold (a worker may still be running).
    expect(processTreeConfirmedGone({ spawned: true, killConfirm: alive })).toBe(false);
    // Post-exit sweep could not verify → hold.
    expect(processTreeConfirmedGone({ spawned: true, postExitCleanup: alive })).toBe(false);
    expect(processTreeConfirmedGone({ spawned: true, postExitCleanup: gone })).toBe(true);
    // Either record unconfirmed poisons the whole determination.
    expect(
      processTreeConfirmedGone({ spawned: true, killConfirm: gone, postExitCleanup: alive }),
    ).toBe(false);
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

  it("timeout is classified 'killed', distinct from a user cancel", async () => {
    // WP-001 review #4: timeout must not masquerade as a user cancellation.
    const ws = makeWorkspace();
    try {
      const rec = await dispatch(
        mockAdapter("hang"),
        { workdir: ws, prompt: "run forever" },
        { timeoutMs: 150, killConfirm: FAST_KILL },
      );
      expect(rec.outcome).toBe("killed"); // not "cancelled"
      expect(rec.killConfirm?.treeGone).toBe(true);
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

  it("catches a quota signal on a dropped non-JSON raw line", async () => {
    // The raw scan must catch a rate-limit signal even when the parser drops the
    // line. (Cross-line joining is deliberately not done — it false-positives on
    // benign text — so a real single-line signal is the contract; WP-001 #4-r4.)
    const ws = makeWorkspace();
    try {
      const rec = await dispatch(mockAdapter("quota-raw"), { workdir: ws, prompt: "x" });
      expect(rec.exitCode).not.toBe(0);
      expect(rec.outcome).toBe("quota-blocked");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("does NOT false-flag benign multi-line text as quota", () => {
    // The removed rolling window matched "success rate\nLimited…"; per-line
    // scanning must not (WP-001 review #4-r4).
    for (const benign of ["success rate", "Limited evidence remains", "capacity is fine"]) {
      expect(classifyByQuotaSignal(benign), benign).toBe(false);
    }
  });

  it("bounds retained events but reports the true total count", async () => {
    // WP-001 review #4: a flood of events must not grow retention without bound;
    // the true count is still reported and the trailing result is preserved.
    const ws = makeWorkspace();
    try {
      const rec = await dispatch(mockAdapter("flood"), { workdir: ws, prompt: "flood" });
      expect(rec.outcome).toBe("succeeded");
      expect(rec.streamedEvents).toBe(501); // 500 "other" + 1 "result"
      expect(rec.events.length).toBeLessThanOrEqual(400); // head 200 + tail 200
      expect(rec.finalText).toContain("done flooding"); // trailing result retained
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("spawn failure of a missing binary is reported, not thrown — and the lease is releasable", async () => {
    const ws = makeWorkspace();
    try {
      const missing = {
        ...mockAdapter(),
        plan: () => ({ file: "definitely-no-such-bin", args: [] }),
      };
      let released = 0;
      const lease: LeaseHandle = { release: () => void released++ };
      const rec = await dispatch(missing, { workdir: ws, prompt: "x" }, { lease });
      expect(rec.spawned).toBe(false);
      expect(rec.outcome).toBe("requirement-failed");
      expect(released).toBe(1); // no process ever existed → release is safe
      expect(rec.lease).toEqual({ released: true });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("a parser that throws does not crash the dispatch", async () => {
    // The harness must survive a buggy adapter parser (WP-001 review #5).
    const ws = makeWorkspace();
    try {
      const throwing = {
        ...mockAdapter(),
        parseLine: () => {
          throw new Error("boom");
        },
      };
      const rec = await dispatch(throwing, { workdir: ws, prompt: "x" });
      expect(rec.spawned).toBe(true);
      expect(rec.outcome).toBe("succeeded"); // process still exited 0; parser errors swallowed
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
      expect(headSha(a)).toMatch(/^[0-9a-f]{40}$/);
      expect(headSha(b)).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
