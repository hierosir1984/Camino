import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterSpec, LeaseHandle, LeaseReleaseContext } from "@camino/shared";
import {
  dispatch,
  DisabledAdapterError,
  PRODUCTION_KILL_CONFIRM,
  processGroupConfirmedGone,
} from "./lifecycle.js";
import { mockAdapter } from "./adapters/mock.js";
import { claudeAdapter } from "./adapters/claude.js";
import { codexAdapter } from "./adapters/codex.js";
import { grokAdapter } from "./adapters/grok.js";
import { classifyByQuotaSignal } from "./quota.js";
import { makeWorkspace, headSha, committedSince } from "./workspace.js";

// Every mechanic of the dispatch lifecycle proven against the fake CLI —
// ZERO subscription quota. This is the WP-001 dispatch suite promoted to run
// against PRODUCT adapter code in CI (WP-105 acceptance), plus the product
// additions and round-1 review folds: disabled-adapter refusal, AbortSignal
// cancellation (incl. abort during the plan/spawn window), post-exit group
// sweep, lease settlement sequenced after group-gone, and guaranteed cleanup +
// settlement even when a callback / stdin / plan throws.

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

  it("mid-run cancel executes kill-confirm and the whole process GROUP is gone (leader ignores SIGTERM)", async () => {
    const ws = makeWorkspace();
    try {
      const rec = await dispatch(
        mockAdapter("hang"), // leader ignores SIGTERM, spawns a sleep grandchild
        { workdir: ws, prompt: "run forever" },
        { cancelAfterFirstEventMs: 50, killConfirm: FAST_KILL },
      );
      expect(rec.outcome).toBe("cancelled");
      expect(rec.killConfirm?.escalatedToSigkill).toBe(true); // SIGTERM ignored → SIGKILL
      expect(rec.killConfirm?.groupGone).toBe(true); // group verified gone
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
      expect(rec.killConfirm?.groupGone).toBe(true);
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

  it("an abort during the plan()/spawn window is NOT lost — the worker is cancelled (round-1 finding 3)", async () => {
    const ws = makeWorkspace();
    try {
      const ac = new AbortController();
      // The abort fires INSIDE plan(), before the child exists. A naive
      // implementation that only checks the signal at entry (already past) and
      // attaches its listener after spawn would miss this and run to success.
      const abortingAdapter: AdapterSpec = {
        ...mockAdapter("hang"),
        plan: (ctx) => {
          ac.abort();
          return mockAdapter("hang").plan(ctx);
        },
      };
      const rec = await dispatch(
        abortingAdapter,
        { workdir: ws, prompt: "run forever" },
        { signal: ac.signal, killConfirm: FAST_KILL, timeoutMs: 30_000 },
      );
      // The window-abort was honored: cancelled fast, not a 30s run-to-timeout.
      // (No .mock-pid corroboration here — the kill can beat the mock's first
      // line; outcome + groupGone are the proof that matters.)
      expect(rec.outcome).toBe("cancelled");
      expect(rec.killConfirm?.groupGone).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("orphan case: leader exits on SIGTERM but a descendant ignores it — SIGKILL still reaps the group", async () => {
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
      expect(rec.killConfirm?.groupGone).toBe(true); // no orphan survives
      expect(anyGroupAlive(mockPid(ws))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("a cooperative descendant gets the FULL grace window (no premature SIGKILL)", async () => {
    // WP-001 review #1-new: escalation must wait for the whole GROUP through the
    // grace period, not SIGKILL the instant the leader exits.
    const ws = makeWorkspace();
    try {
      const rec = await dispatch(
        mockAdapter("grace-descendant"),
        { workdir: ws, prompt: "cooperative but slow" },
        { cancelAfterFirstEventMs: 50, killConfirm: { graceMs: 1500, sigkillWaitMs: 2000 } },
      );
      expect(rec.outcome).toBe("cancelled");
      expect(rec.killConfirm?.escalatedToSigkill).toBe(false); // exited within grace
      expect(rec.killConfirm?.groupGone).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("post-exit sweep: a leader that exits 0 leaving a live descendant does not leak the group", async () => {
    // WP-105: natural success is not group-gone. Without the sweep, the
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
      expect(rec.postExitCleanup?.groupGone).toBe(true); // sweep confirmed the group gone
      expect(rec.postExitCleanup?.escalatedToSigkill).toBe(false); // descendant honored SIGTERM
      expect(rec.lease).toEqual({ released: true });
      expect(groupGoneAtRelease).toBe(true); // release fired only after the sweep
      expect(anyGroupAlive(mockPid(ws))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("lease release is sequenced strictly AFTER group-gone on the cancel path (registry item 4)", async () => {
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
      expect(rec.killConfirm?.groupGone).toBe(true);
      expect(releaseCount).toBe(1); // at most once
      expect(ctxSeen!.groupGone).toBe(true);
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

  it("an ASYNC transcript sink that rejects cannot crash the dispatch (round-2 finding 3)", async () => {
    // A void-typed sink that returns a rejecting promise would otherwise become
    // an unhandledRejection (which fails the vitest run). The dispatch must
    // swallow it.
    const ws = makeWorkspace();
    try {
      let released = 0;
      const lease: LeaseHandle = { release: () => void released++ };
      const rec = await dispatch(
        mockAdapter(),
        { workdir: ws, prompt: "x" },
        {
          lease,
          onLine: () => Promise.reject(new Error("async sink rejected")) as unknown as void,
        },
      );
      expect(rec.outcome).toBe("succeeded");
      expect(released).toBe(1);
      // Give any stray rejection a tick to surface (it must not).
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("a throwing plan.env GETTER is handled as a broken adapter, lease settled (round-2 finding 3)", async () => {
    const ws = makeWorkspace();
    try {
      let released = 0;
      const lease: LeaseHandle = { release: () => void released++ };
      const envGetterAdapter: AdapterSpec = {
        ...mockAdapter(),
        plan: () => ({
          file: process.execPath,
          args: [],
          get env(): Record<string, string> {
            throw new Error("plan.env getter threw");
          },
        }),
      };
      const rec = await dispatch(envGetterAdapter, { workdir: ws, prompt: "x" }, { lease });
      expect(rec.spawned).toBe(false);
      expect(rec.outcome).toBe("requirement-failed");
      expect(rec.unexpectedError).toContain("plan.env getter threw");
      expect(released).toBe(1); // nothing spawned → lease released
      expect(rec.lease).toEqual({ released: true });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("a plan() that throws a NON-stringifiable value does not crash error handling (round-2 finding 3)", async () => {
    const ws = makeWorkspace();
    try {
      const toxic = {
        get [Symbol.toPrimitive]() {
          throw new Error("toString threw");
        },
        toString() {
          throw new Error("toString threw");
        },
      };
      const toxicAdapter: AdapterSpec = {
        ...mockAdapter(),
        plan: () => {
          throw toxic;
        },
      };
      const rec = await dispatch(toxicAdapter, { workdir: ws, prompt: "x" });
      expect(rec.spawned).toBe(false);
      expect(rec.outcome).toBe("requirement-failed"); // safeStringify never re-throws
      expect(typeof rec.unexpectedError).toBe("string");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("a lease.release that throws a TOXIC value is recorded, and release is called EXACTLY once (round-2 finding 4)", async () => {
    const ws = makeWorkspace();
    try {
      let releases = 0;
      const toxic = {
        toString() {
          throw new Error("release error conversion threw");
        },
      };
      const lease: LeaseHandle = {
        release: () => {
          releases++;
          throw toxic; // a hostile error that would break String(err)
        },
      };
      const rec = await dispatch(mockAdapter(), { workdir: ws, prompt: "x" }, { lease });
      expect(releases).toBe(1); // NOT twice — no re-entry into settlement
      expect(rec.outcome).toBe("succeeded");
      expect(rec.lease).toMatchObject({ released: false, heldReason: "release-threw" });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("a throwing transcript sink cannot crash the dispatch; cleanup + lease still run (round-1 finding 2)", async () => {
    const ws = makeWorkspace();
    try {
      let released = 0;
      const lease: LeaseHandle = { release: () => void released++ };
      const rec = await dispatch(
        mockAdapter(),
        { workdir: ws, prompt: "x" },
        {
          lease,
          onLine: () => {
            throw new Error("transcript sink failed");
          },
        },
      );
      expect(rec.spawned).toBe(true);
      expect(rec.outcome).toBe("succeeded"); // the worker still exited 0
      expect(released).toBe(1); // settlement ran despite the throwing sink
      expect(rec.lease).toEqual({ released: true });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("a plan() that throws is a requirement-failed record with the lease settled (round-1 finding 2)", async () => {
    const ws = makeWorkspace();
    try {
      let released = 0;
      const lease: LeaseHandle = { release: () => void released++ };
      const throwingPlan: AdapterSpec = {
        ...mockAdapter(),
        plan: () => {
          throw new Error("plan failed");
        },
      };
      const rec = await dispatch(throwingPlan, { workdir: ws, prompt: "x" }, { lease });
      expect(rec.spawned).toBe(false);
      expect(rec.outcome).toBe("requirement-failed"); // broken adapter, not a leaked throw
      expect(rec.unexpectedError).toContain("plan failed"); // the raw adapter error, captured
      expect(released).toBe(1); // nothing spawned → lease releasable
      expect(rec.lease).toEqual({ released: true });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("a worker that closes stdin early does not crash the dispatch (EPIPE handled)", async () => {
    // The shared contract supports stdin delivery; a worker that exits before
    // reading stdin makes the write EPIPE, which must not crash the dispatch.
    const ws = makeWorkspace();
    const script = join(ws, "early-exit.mjs");
    writeFileSync(
      script,
      'process.stdout.write(\'{"type":"result","text":"done"}\\n\');process.exit(0);',
    );
    try {
      const stdinAdapter: AdapterSpec = {
        name: "mock:stdin",
        enabled: true,
        plan: () => ({ file: process.execPath, args: [script], stdin: "x".repeat(2_000_000) }),
        parseLine: (l) => {
          try {
            const o = JSON.parse(l.trim()) as { text?: string };
            return { kind: "result", text: String(o.text ?? "") };
          } catch {
            return null;
          }
        },
      };
      const rec = await dispatch(stdinAdapter, { workdir: ws, prompt: "x" });
      expect(rec.spawned).toBe(true);
      expect(rec.outcome).toBe("succeeded"); // EPIPE swallowed, worker's exit 0 stands
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("processGroupConfirmedGone: the lease-hold decision is fail-closed on any unconfirmed record", () => {
    const gone = { requested: true, escalatedToSigkill: true, groupGone: true, elapsedMs: 1 };
    const alive = { requested: true, escalatedToSigkill: true, groupGone: false, elapsedMs: 1 };
    // Never spawned → nothing to confirm.
    expect(processGroupConfirmedGone({ spawned: false })).toBe(true);
    // Natural exit with the post-exit probe finding the group empty (no records).
    expect(processGroupConfirmedGone({ spawned: true })).toBe(true);
    // Kill-confirm verified the group gone.
    expect(processGroupConfirmedGone({ spawned: true, killConfirm: gone })).toBe(true);
    // Kill-confirm could NOT verify → hold (a worker may still be running).
    expect(processGroupConfirmedGone({ spawned: true, killConfirm: alive })).toBe(false);
    // Post-exit sweep could not verify → hold.
    expect(processGroupConfirmedGone({ spawned: true, postExitCleanup: alive })).toBe(false);
    expect(processGroupConfirmedGone({ spawned: true, postExitCleanup: gone })).toBe(true);
    // Either record unconfirmed poisons the whole determination.
    expect(
      processGroupConfirmedGone({ spawned: true, killConfirm: gone, postExitCleanup: alive }),
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
      expect(rec.killConfirm?.groupGone).toBe(true);
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
      expect(rec.killConfirm?.groupGone).toBe(true);
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
    for (const benign of ["success rate", "Limited evidence remains", "capacity is fine"]) {
      expect(classifyByQuotaSignal(benign), benign).toBe(false);
    }
  });

  it("bounds retained events but reports the true total count", async () => {
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

// Round-1 finding 10 (scope corrected per round-2 finding 8): drive each
// PROVIDER adapter's real parseLine + the real lifecycle's classification in
// CI, zero quota — the provider's own stream schema, emitted by a fake CLI, so
// the product PARSER runs inside the real dispatch. NOTE this substitutes
// plan() (to run the fake CLI) and the workers exit naturally, so it does NOT
// exercise the real provider plan() argv or kill-confirm — those are covered
// by the mock-adapter lifecycle tests above and the real-CLI smoke run. The
// quota assertion below is strengthened to require the PARSER (not the raw-line
// backstop) produced the signal.
describe("provider adapters through the real lifecycle (zero quota)", () => {
  const PROVIDER_LINES: Record<string, { solve: string[]; quota: string }> = {
    "claude-code": {
      solve: [
        '{"type":"system","subtype":"init"}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}',
        '{"type":"result","subtype":"success","result":"done"}',
      ],
      quota:
        '{"type":"result","subtype":"error","is_error":true,"result":"429 rate_limit_error: usage limit reached"}',
    },
    "codex-cli": {
      solve: [
        '{"type":"thread.started"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
        '{"type":"turn.completed"}',
      ],
      quota:
        '{"type":"item.completed","item":{"type":"error","message":"429 Too Many Requests; retry-after 30"}}',
    },
    "grok-build": {
      solve: [
        '{"type":"text","data":"do"}',
        '{"type":"text","data":"ne"}',
        '{"type":"end","data":"done"}',
      ],
      quota: '{"type":"text","data":"error: rate_limit_exceeded — please retry_after 10s"}',
    },
  };

  function schemaEmittingAdapter(name: string, lines: string[], exitCode: number): AdapterSpec {
    // Reuse the PRODUCT parser for `name`, but make plan() run a fake CLI that
    // emits that provider's schema — so parseLine runs inside the real dispatch.
    const real = {
      "claude-code": claudeAdapter,
      "codex-cli": codexAdapter,
      "grok-build": grokAdapter,
    }[name]!();
    const script = `const lines=${JSON.stringify(lines)};for(const l of lines)process.stdout.write(l+"\\n");process.exit(${exitCode});`;
    return { ...real, plan: () => ({ file: process.execPath, args: ["-e", script] }) };
  }

  for (const [name, fixtures] of Object.entries(PROVIDER_LINES)) {
    it(`${name}: solve stream parses through the lifecycle → succeeded`, async () => {
      const ws = mkdtempSync(join(tmpdir(), "wp105-prov-"));
      try {
        const rec = await dispatch(schemaEmittingAdapter(name, fixtures.solve, 0), {
          workdir: ws,
          prompt: "x",
        });
        expect(rec.outcome).toBe("succeeded");
        expect(rec.streamedEvents).toBeGreaterThan(0);
        expect(rec.finalText.length).toBeGreaterThan(0); // the provider parser produced result text
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it(`${name}: a real rate-limit stream classifies quota-blocked via the PARSER`, async () => {
      const ws = mkdtempSync(join(tmpdir(), "wp105-prov-"));
      try {
        const rec = await dispatch(schemaEmittingAdapter(name, [fixtures.quota], 1), {
          workdir: ws,
          prompt: "x",
        });
        expect(rec.outcome).toBe("quota-blocked"); // CAM-EXEC-06, through product parser
        // Prove the PARSER flagged it (not only the lifecycle's raw-line scan):
        // a parsed event carries quotaSignal (round-2 finding 8).
        expect(rec.events.some((e) => e.quotaSignal === true)).toBe(true);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  }
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
