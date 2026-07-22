import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterSpec, LeaseHandle, LeaseReleaseContext, StreamEvent } from "@camino/shared";
import {
  dispatch,
  DisabledAdapterError,
  PRODUCTION_KILL_CONFIRM,
  processGroupConfirmedGone,
} from "./lifecycle.js";
import { mockAdapter } from "./adapters/mock.js";
import { claudeAdapter } from "./adapters/claude.js";
import { buildRegistryForTest, hasRegistryProvenance } from "./registry.js";
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

/**
 * The mock CLI writes its pid (== the group id under detached spawn) here at
 * startup. A dispatch that cancels/times out in the spawn window can return
 * BEFORE the mock's synchronous write lands under heavy machine load (observed
 * as an ENOENT flake when many suites run in parallel). Poll briefly; if the
 * file never appears, the mock never established a group, so return NaN —
 * anyGroupAlive(NaN) is false, i.e. "group gone", the correct semantics.
 */
function mockPid(ws: string): number {
  const path = join(ws, ".mock-pid");
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const raw = readFileSync(path, "utf8").trim();
      if (raw.length > 0) return Number(raw);
    } catch {
      /* not written yet */
    }
    Atomics.wait(sleeper, 0, 0, 25); // 25ms, up to ~2s total
  }
  return Number.NaN;
}

describe("dispatch lifecycle (mock adapter, no quota)", () => {
  it("pins the production kill-confirm timings (PRD §5 registry item 4: 30s grace)", () => {
    expect(PRODUCTION_KILL_CONFIRM).toEqual({ graceMs: 30_000, sigkillWaitMs: 5_000 });
  });

  it("PRODUCTION_KILL_CONFIRM is FROZEN — a package-root importer can't zero/NaN the timings (round-9 finding 2)", () => {
    expect(Object.isFrozen(PRODUCTION_KILL_CONFIRM)).toBe(true);
    expect(() => {
      (PRODUCTION_KILL_CONFIRM as { graceMs: number }).graceMs = 0;
    }).toThrow(TypeError);
    expect(() => {
      (PRODUCTION_KILL_CONFIRM as { sigkillWaitMs: number }).sigkillWaitMs = NaN;
    }).toThrow(TypeError);
    expect(PRODUCTION_KILL_CONFIRM.graceMs).toBe(30_000); // unchanged
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

  it("a disabled dispatch with a lease SETTLES it before throwing (round-5 finding 1)", async () => {
    const ws = makeWorkspace();
    try {
      let released = 0;
      const lease: LeaseHandle = { release: () => void released++ };
      const disabled = { ...mockAdapter(), enabled: false, disabledReason: "off" };
      await expect(dispatch(disabled, { workdir: ws, prompt: "x" }, { lease })).rejects.toThrow(
        DisabledAdapterError,
      );
      expect(released).toBe(1); // nothing ran → lease released, never stranded
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("a hostile disabledReason getter still yields DisabledAdapterError (round-5 finding 1)", async () => {
    const ws = makeWorkspace();
    try {
      const hostile = {
        ...mockAdapter(),
        enabled: false,
        get disabledReason(): string {
          return {
            toString: () => {
              throw new Error("reason toString threw");
            },
          } as unknown as string;
        },
      };
      await expect(dispatch(hostile, { workdir: ws, prompt: "x" })).rejects.toThrow(
        DisabledAdapterError,
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("cancelAfterFirstEventMs is read EXACTLY ONCE, so a value-then-toxic getter cannot crash (round-5 finding 1)", async () => {
    const ws = makeWorkspace();
    try {
      let reads = 0;
      const opts = {
        get cancelAfterFirstEventMs(): number {
          reads++;
          if (reads === 1) return 50;
          throw new Error("second read of cancelAfterFirstEventMs");
        },
      };
      const rec = await dispatch(mockAdapter(), { workdir: ws, prompt: "x" }, opts as never);
      expect(reads).toBe(1); // read once → no toxic second read reaches setTimeout
      expect(typeof rec.outcome).toBe("string");
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

  it("a group-escaped descendant holding stdout cannot HANG dispatch — the drain is bounded (round-8 finding 3)", async () => {
    // The round-8 drain awaits stream EOF before classifying. A descendant that
    // escaped the group (own session) and inherited stdout holds the pipe open
    // forever; the group-scoped sweep can't reap it (the WP-107 boundary), so
    // the drain MUST be bounded. FAST_KILL → drain cap ~2s; the descendant
    // sleeps 30s, so a return well under that proves the cap bounded it.
    const ws = makeWorkspace();
    const pidFile = join(ws, ".escaped-holder-pid");
    try {
      const started = Date.now();
      const rec = await dispatch(
        mockAdapter("escaped-stdout-holder"),
        { workdir: ws, prompt: "leak stdout" },
        { killConfirm: FAST_KILL },
      );
      const elapsedMs = Date.now() - started;
      expect(rec.outcome).toBe("succeeded"); // leader exited 0; the holder is the WP-107 boundary
      expect(rec.streamedEvents).toBeGreaterThanOrEqual(2); // the leader's own lines were drained
      expect(elapsedMs).toBeLessThan(8000); // bounded by the ~2s cap, NOT the descendant's 30s sleep
    } finally {
      if (existsSync(pidFile)) {
        try {
          process.kill(Number(readFileSync(pidFile, "utf8").trim()));
        } catch {
          /* already gone */
        }
      }
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("when the drain cap wins, stream consumers are torn down — no line is parsed after the record (round-9 finding 3)", async () => {
    // Without teardown, the readline keeps delivering lines after dispatch has
    // returned (and the inherited pipe pins the process). The escaped holder
    // writes LATE_MARKER at ~2s, past the ~1s cap; a torn-down reader never
    // sees it.
    const ws = makeWorkspace();
    const pidFile = join(ws, ".escaped-holder-pid");
    const seen: string[] = [];
    try {
      const rec = await dispatch(
        mockAdapter("escaped-late-writer"),
        { workdir: ws, prompt: "x" },
        {
          killConfirm: { graceMs: 400, sigkillWaitMs: 1000 }, // drain cap → 1000ms
          onLine: (_c, l) => {
            seen.push(l);
          },
        },
      );
      expect(rec.outcome).toBe("succeeded");
      const countAtReturn = seen.length;
      // Wait well past the holder's 2s marker write.
      await new Promise((r) => setTimeout(r, 2500));
      expect(seen.some((l) => l.includes("LATE_MARKER"))).toBe(false); // reader torn down
      expect(seen.length).toBe(countAtReturn); // no late lines parsed at all
    } finally {
      if (existsSync(pidFile)) {
        try {
          process.kill(Number(readFileSync(pidFile, "utf8").trim()));
        } catch {
          /* already gone */
        }
      }
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

  it("TOTAL exception safety: a hostile first-party input returns a record, never throws to the daemon (round-3 finding 1)", async () => {
    // dispatch's object inputs are trusted first-party code, but a bug (a
    // throwing getter on a config field) must never terminate the daemon or
    // strand a lease. Each hostile input below is caught → requirement-failed
    // record + lease settled, no throw escapes.
    const ws = makeWorkspace();
    try {
      // (a) a hostile signal.aborted getter
      let released = 0;
      const lease: LeaseHandle = { release: () => void released++ };
      const hostileSignal = {
        get aborted(): boolean {
          throw new Error("aborted getter threw");
        },
        addEventListener() {},
        removeEventListener() {},
      } as unknown as AbortSignal;
      const rA = await dispatch(
        mockAdapter(),
        { workdir: ws, prompt: "x" },
        {
          signal: hostileSignal,
          lease,
        },
      );
      expect(rA.outcome).toBe("requirement-failed");
      expect(released).toBe(1);
      expect(rA.lease).toEqual({ released: true });

      // (b) a hostile adapter.name getter — safeAdapterName snapshots it once
      // in a try, so a throw yields a fallback name and the dispatch proceeds.
      const hostileName = {
        ...mockAdapter(),
        get name(): string {
          throw new Error("name getter threw");
        },
      } as AdapterSpec;
      const rB = await dispatch(hostileName, { workdir: ws, prompt: "x" });
      expect(rB.adapter).toBe("unknown-adapter"); // snapshotted safely, no throw escaped

      // (b2) hostile opts.signal / opts.killConfirm getters (read inside the
      // try now, round-4 finding 1) → caught, record returned, lease settled.
      // Each opts object carries `lease` as a data property + one throwing
      // getter; the getter must fire only INSIDE dispatch, never when the test
      // builds the object (so no spread).
      {
        let rel1 = 0;
        const opts1 = {
          lease: { release: () => void rel1++ } as LeaseHandle,
          get signal(): AbortSignal {
            throw new Error("signal getter threw");
          },
        };
        const r1 = await dispatch(mockAdapter(), { workdir: ws, prompt: "x" }, opts1);
        expect(typeof r1.outcome).toBe("string"); // returned a record, no throw
        expect(rel1).toBe(1); // lease read first → settled

        let rel2 = 0;
        const opts2 = {
          lease: { release: () => void rel2++ } as LeaseHandle,
          get killConfirm(): { graceMs: number; sigkillWaitMs: number } {
            throw new Error("killConfirm getter threw");
          },
        };
        const r2 = await dispatch(mockAdapter(), { workdir: ws, prompt: "x" }, opts2);
        expect(typeof r2.outcome).toBe("string");
        expect(rel2).toBe(1);
      }

      // (b3) a hostile cancelAfterFirstEventMs getter is read once (snapshot),
      // NOT inside the async readline callback — so it cannot crash the process.
      const rB3 = await dispatch(mockAdapter(), { workdir: ws, prompt: "x" }, {
        get cancelAfterFirstEventMs(): number {
          throw new Error("cancelAfterFirstEventMs getter threw");
        },
      } as never);
      expect(typeof rB3.outcome).toBe("string"); // record returned, no async crash

      // (c) a hostile killConfirm.graceMs getter, on the cancel path — the
      // cooperative worker dies on the SIGTERM killConfirm sends before the
      // getter throws, so no process leaks; the dispatch returns a record.
      const hostileTimings = {
        get graceMs(): number {
          throw new Error("graceMs getter threw");
        },
        sigkillWaitMs: 100,
      } as unknown as import("./lifecycle.js").KillConfirmTimings;
      const rC = await dispatch(
        mockAdapter("graceful-cancel"),
        { workdir: ws, prompt: "x" },
        { cancelAfterFirstEventMs: 50, killConfirm: hostileTimings, timeoutMs: 5_000 },
      );
      expect(typeof rC.outcome).toBe("string"); // returned a record, did not throw
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("a hostile terminalSuccess getter cannot ERASE a valid quota signal (round-12 finding 2)", async () => {
    // quotaSignal and terminalSuccess are read in SEPARATE try blocks, so a
    // throwing terminalSuccess getter cannot reset an already-read quota
    // signal — a rate-limit must never be misclassified requirement-failed
    // (CAM-EXEC-06).
    const ws = makeWorkspace();
    try {
      const hostile: AdapterSpec = {
        ...mockAdapter("quota"), // the fake CLI emits a line then exits nonzero
        parseLine: (): StreamEvent =>
          ({
            kind: "error",
            text: "429 rate limit reached",
            quotaSignal: true,
            get terminalSuccess(): boolean {
              throw new Error("toxic terminalSuccess getter");
            },
          }) as StreamEvent,
      };
      const rec = await dispatch(hostile, { workdir: ws, prompt: "x" });
      expect(rec.exitCode).not.toBe(0);
      expect(rec.outcome).toBe("quota-blocked"); // quota preserved despite the throwing getter
      expect(rec.quotaSignalSeen).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("a throwing getter on ANY parsed-event field (kind) cannot drop the quota classification — events are normalized on entry (round-12 hostile-getter class)", async () => {
    // The event snapshot at recordEvent reads every field in its own guard, so
    // a hostile kind getter cannot make assembleFinalText throw and let the
    // outer catch override quota-blocked with requirement-failed.
    const ws = makeWorkspace();
    try {
      const hostile: AdapterSpec = {
        ...mockAdapter("quota"),
        parseLine: (): StreamEvent =>
          ({
            text: "429 rate limit reached",
            quotaSignal: true,
            get kind(): StreamEvent["kind"] {
              throw new Error("toxic kind getter");
            },
          }) as unknown as StreamEvent,
      };
      const rec = await dispatch(hostile, { workdir: ws, prompt: "x" });
      expect(rec.exitCode).not.toBe(0);
      expect(rec.outcome).toBe("quota-blocked"); // preserved despite the throwing kind getter
      expect(rec.quotaSignalSeen).toBe(true);
      expect(rec.unexpectedError).toBeUndefined(); // no throw escaped into the catch
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

  it("the PARSER catches a quota signal on a non-JSON diagnostic line (no raw scan)", async () => {
    // round-3 finding 2 removed the lifecycle raw-line scan; the mock adapter's
    // own non-JSON branch (an error channel) now catches the signal.
    const ws = makeWorkspace();
    try {
      const rec = await dispatch(mockAdapter("quota-raw"), { workdir: ws, prompt: "x" });
      expect(rec.exitCode).not.toBe(0);
      expect(rec.outcome).toBe("quota-blocked");
      expect(rec.events.some((e) => e.quotaSignal === true)).toBe(true); // via the parser
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

  it("bounds a single ENORMOUS line pre-parser — no unbounded buffer (WP-107 round-4 finding 1)", async () => {
    const ws = makeWorkspace();
    try {
      // The mock emits one 8 MiB line (no newline) then a normal result. The
      // dispatch must succeed WITHOUT any retained event carrying the whole
      // 8 MiB — the bounded reader truncates the line before the parser.
      const rec = await dispatch(mockAdapter("bigline"), { workdir: ws, prompt: "bigline" });
      expect(rec.outcome).toBe("succeeded");
      expect(rec.finalText).toContain("done after a giant line");
      // No retained event text approaches the emitted size; each is bounded.
      const maxEventText = Math.max(0, ...rec.events.map((e) => e.text.length));
      expect(maxEventText).toBeLessThan(1_100_000); // << the 8 MiB emitted
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

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
      // A rate limit is an ERROR event (round-3 finding 2 — a "text" event is
      // the assistant answer, never a quota signal).
      quota: '{"type":"error","message":"rate_limit_exceeded — please retry_after 10s"}',
    },
  };

  function schemaEmittingAdapter(name: string, lines: string[], exitCode: number): AdapterSpec {
    // Obtain the REAL gated spec through buildRegistry (registry provenance,
    // round-6 finding 1 — dispatch refuses an official-name spec that skipped
    // the sanctioned-path gate), then substitute plan() IN PLACE so a fake CLI
    // emits the provider's schema while the spec keeps its provenance: the
    // PRODUCT parser runs inside the real dispatch. (The default attestations
    // path is the genuine repo record, accepted 2026-07-17.)
    const spec = buildRegistryForTest({ cliPresent: () => true }).find((s) => s.name === name)!;
    const script = `const lines=${JSON.stringify(lines)};for(const l of lines)process.stdout.write(l+"\\n");process.exit(${exitCode});`;
    (spec as { plan: AdapterSpec["plan"] }).plan = () => ({
      file: process.execPath,
      args: ["-e", script],
    });
    return spec;
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
        // Scoped credential roots (round-6 finding 2): an official CLI gets
        // HOME + its OWN config root only — never a sibling CLI's root.
        const ownRoot = {
          "claude-code": "CLAUDE_CONFIG_DIR",
          "codex-cli": "CODEX_HOME",
          "grok-build": "GROK_HOME",
        }[name]!;
        expect(rec.envPosture.credentialRootKeys).toContain("HOME");
        for (const other of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"]) {
          if (other !== ownRoot) expect(rec.envPosture.credentialRootKeys).not.toContain(other);
        }
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
        // Prove the PARSER produced the signal — the lifecycle has had NO
        // raw-line scan since round 3; a parsed event carries quotaSignal
        // (round-2 finding 8, round-3 finding 2).
        expect(rec.events.some((e) => e.quotaSignal === true)).toBe(true);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it(`${name}: a TERMINAL quota error with exit 0 still classifies quota-blocked (round-7 finding 2)`, async () => {
      // CLIs report error results with zero exit codes; a stream that ENDS on
      // a quota-signaling error event is a refusal regardless of exit code.
      const ws = mkdtempSync(join(tmpdir(), "wp105-prov-"));
      try {
        const rec = await dispatch(schemaEmittingAdapter(name, [fixtures.quota], 0), {
          workdir: ws,
          prompt: "x",
        });
        expect(rec.exitCode).toBe(0);
        expect(rec.outcome).toBe("quota-blocked");
        expect(rec.quotaSignalSeen).toBe(true);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  }

  it("a terminal quota event at the TAIL of a large burst is drained before classification (round-8 finding 3)", async () => {
    // 'exit' can fire while stdout still holds buffered lines; a big burst
    // ending in the quota event exercises the post-exit drain. Without it the
    // tail is lost and the record freezes as "succeeded" before the final
    // event is parsed. The parser tracks quota over ALL events, so the last
    // (quota) line decides the outcome once drained.
    const ws = mkdtempSync(join(tmpdir(), "wp105-prov-"));
    try {
      const claude = PROVIDER_LINES["claude-code"]!;
      // Generate the burst INSIDE the script (a loop), never as a giant `-e`
      // argument: 3000 lines serialized into one argv string exceeds Linux's
      // per-arg limit (MAX_ARG_STRLEN, 128KB) → E2BIG spawn failure on CI even
      // though macOS allows it. Registry-gated spec, plan() substituted in place.
      const N = 3000;
      const spec = buildRegistryForTest({ cliPresent: () => true }).find(
        (s) => s.name === "claude-code",
      )!;
      // ONE synchronous write (writeFileSync to fd 1), NOT async process.stdout
      // + process.exit: process.exit does not drain async stdout, so on Linux
      // the tail — the quota line, written last — is truncated before it
      // reaches the pipe and the run misclassifies as "succeeded" (green on
      // macOS, red on CI). A synchronous write lands every byte in the pipe
      // before exit; the parent-side DRAIN is what this test exercises (reading
      // the pipe-buffered tail past 'exit'). Same proven pattern as the flood
      // mock's emitSync.
      const script =
        `const s='{"type":"system","subtype":"init"}\\n'.repeat(${N})+${JSON.stringify(claude.quota)}+'\\n';` +
        `require('fs').writeFileSync(1,s);process.exit(0);`;
      (spec as { plan: AdapterSpec["plan"] }).plan = () => ({
        file: process.execPath,
        args: ["-e", script],
      });
      const rec = await dispatch(spec, { workdir: ws, prompt: "x" });
      expect(rec.exitCode).toBe(0);
      expect(rec.outcome).toBe("quota-blocked"); // final event drained + classified
      expect(rec.quotaSignalSeen).toBe(true);
      expect(rec.streamedEvents).toBe(N + 1); // every line drained, none truncated
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("a quota failure followed by a generic error/footer stays quota-blocked, not succeeded (round-10 finding 1)", async () => {
    // codex: item.completed(error, 429) then a generic turn.failed, exit 0. A
    // terminal turn.failed is NOT recovery — only a success result clears a
    // pending quota failure. Was mislabeled "succeeded" by the last-event test.
    const ws = mkdtempSync(join(tmpdir(), "wp105-prov-"));
    try {
      const codexQuota = PROVIDER_LINES["codex-cli"]!.quota;
      const turnFailed = '{"type":"turn.failed","error":{"message":"request failed"}}';
      const rec = await dispatch(schemaEmittingAdapter("codex-cli", [codexQuota, turnFailed], 0), {
        workdir: ws,
        prompt: "x",
      });
      expect(rec.exitCode).toBe(0);
      expect(rec.outcome).toBe("quota-blocked"); // the quota failure is not cleared by a generic error
      expect(rec.quotaSignalSeen).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("codex: quota → agent_message → turn.FAILED (exit 0) stays quota-blocked — agent_message is not a terminal (round-11 finding 1)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "wp105-prov-"));
    try {
      const rec = await dispatch(
        schemaEmittingAdapter(
          "codex-cli",
          [
            PROVIDER_LINES["codex-cli"]!.quota,
            '{"type":"item.completed","item":{"type":"agent_message","text":"partial answer"}}',
            '{"type":"turn.failed","error":{"message":"request failed"}}',
          ],
          0,
        ),
        { workdir: ws, prompt: "x" },
      );
      expect(rec.outcome).toBe("quota-blocked"); // the turn did NOT complete
      expect(rec.quotaSignalSeen).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("grok: a non-terminal event containing 'result'/'done' does NOT clear pending quota — only `end` is terminal (round-12 finding 1)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "wp105-prov-"));
    try {
      const rec = await dispatch(
        schemaEmittingAdapter(
          "grok-build",
          [
            PROVIDER_LINES["grok-build"]!.quota,
            '{"type":"tool_result","data":"ran a tool"}', // includes "result" but is NOT a terminal
            '{"type":"error","message":"something failed"}',
          ],
          0,
        ),
        { workdir: ws, prompt: "x" },
      );
      expect(rec.outcome).toBe("quota-blocked"); // tool_result must not clear the quota failure
      expect(rec.quotaSignalSeen).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("codex: quota → agent_message → turn.COMPLETED (exit 0) is a genuine recovery → succeeded (round-11 finding 1)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "wp105-prov-"));
    try {
      const rec = await dispatch(
        schemaEmittingAdapter(
          "codex-cli",
          [
            PROVIDER_LINES["codex-cli"]!.quota,
            '{"type":"item.completed","item":{"type":"agent_message","text":"done after retry"}}',
            '{"type":"turn.completed"}',
          ],
          0,
        ),
        { workdir: ws, prompt: "x" },
      );
      expect(rec.outcome).toBe("succeeded"); // turn.completed IS the success terminal
      expect(rec.quotaSignalSeen).toBe(true); // pressure still exposed for WP-106
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("a RECOVERED quota signal (later events, clean exit) stays succeeded, with the pressure exposed (round-7 finding 2)", async () => {
    // An early rate-limit the worker moved past must not be misread as
    // blocked; the transient signal stays visible to the WP-106 quota-aware
    // scheduler via quotaSignalSeen.
    const ws = mkdtempSync(join(tmpdir(), "wp105-prov-"));
    try {
      const claude = PROVIDER_LINES["claude-code"]!;
      const rec = await dispatch(
        schemaEmittingAdapter("claude-code", [claude.quota, ...claude.solve], 0),
        { workdir: ws, prompt: "x" },
      );
      expect(rec.outcome).toBe("succeeded"); // final event is the success result, not the quota error
      expect(rec.quotaSignalSeen).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

// Round-6 finding 1: CAM-EXEC-01's sanctioned-path gate is enforced AT THE
// DISPATCH BOUNDARY, not only inside buildRegistry — an enabled spec bearing
// an official adapter name must be the exact object the registry gated.
describe("registry provenance at the dispatch boundary (round-6 finding 1)", () => {
  it("an enabled official-name spec that skipped buildRegistry is refused, lease settled", async () => {
    const ws = makeWorkspace();
    try {
      let released = 0;
      const lease: LeaseHandle = { release: () => void released++ };
      // The raw factory default-enables — exactly the accidental bypass the
      // provenance check refuses (typed, before plan()).
      await expect(
        dispatch(claudeAdapter(), { workdir: ws, prompt: "x" }, { lease }),
      ).rejects.toThrow(/registry provenance/);
      expect(released).toBe(1); // nothing ran → released, never stranded
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("flipping `enabled` on a DISABLED registry spec does not confer provenance — still refused", async () => {
    const ws = makeWorkspace();
    try {
      const disabled = buildRegistryForTest({ cliPresent: () => false }).find(
        (s) => s.name === "claude-code",
      )!;
      (disabled as { enabled: boolean }).enabled = true; // forge the decision…
      await expect(dispatch(disabled, { workdir: ws, prompt: "x" })).rejects.toThrow(
        /registry provenance/, // …the gate never enabled this object
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("a spread COPY of a gated spec loses provenance and is refused (membership is not copyable)", async () => {
    const ws = makeWorkspace();
    try {
      const gated = buildRegistryForTest({ cliPresent: () => true }).find(
        (s) => s.name === "codex-cli",
      )!;
      expect(hasRegistryProvenance(gated)).toBe(true);
      const copy = { ...gated };
      expect(hasRegistryProvenance(copy)).toBe(false);
      await expect(dispatch(copy, { workdir: ws, prompt: "x" })).rejects.toThrow(
        DisabledAdapterError,
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("non-official adapters (the mock) need no provenance and get NO credential roots (round-6 finding 2)", async () => {
    const ws = makeWorkspace();
    try {
      const rec = await dispatch(mockAdapter(), { workdir: ws, prompt: "x" });
      expect(rec.outcome).toBe("succeeded");
      expect(rec.envPosture.credentialRootKeys).toEqual([]);
      for (const root of ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME"]) {
        expect(rec.envPosture.keys).not.toContain(root);
      }
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
