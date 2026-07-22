import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { composeWorkerEnv } from "./env.js";
import { classifyByQuotaSignal } from "./quota.js";
import type {
  AdapterContext,
  AdapterSpec,
  DispatchRecord,
  KillConfirmRecord,
  Outcome,
  StreamEvent,
} from "./types.js";

/** Kill-confirm timings. Production defaults (registry item 4): 30s grace. */
export interface KillConfirmTimings {
  graceMs: number;
  sigkillWaitMs: number;
}
export const PRODUCTION_KILL_CONFIRM: KillConfirmTimings = {
  graceMs: 30_000,
  sigkillWaitMs: 5_000,
};

export interface DispatchOptions {
  /** Cancel the dispatch this long after the first streamed event (for the cancel test). */
  cancelAfterFirstEventMs?: number;
  /** In-process cap (best-effort; the authoritative runaway bound is out-of-process). */
  timeoutMs?: number;
  killConfirm?: KillConfirmTimings;
  /** Sink for live transcript lines (raw). */
  onLine?: (channel: "stdout" | "stderr", line: string) => void;
}

/** Is ANY process in group `pgid` still alive? (leader OR any descendant) */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    // ESRCH = gone; EPERM = exists but not ours (still alive, conservative).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Bound how many parsed events are retained so a noisy/misbehaving worker cannot
// grow harness memory (review #4): keep the first HEAD + last TAIL, plus a
// total count. The head/tail window preserves both the opening context and the
// trailing result run that finalText needs.
const EVENT_HEAD_CAP = 200;
const EVENT_TAIL_CAP = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait up to `ms` for the whole group to disappear, polling. */
async function waitGroupGone(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return true;
    await sleep(20);
  }
  return !groupAlive(pgid);
}

/**
 * Kill-confirm sequence (CAM-EXEC-06, registry item 4):
 * SIGTERM to the process GROUP → give the WHOLE GROUP up to `graceMs` to exit
 * → SIGKILL iff any member is still alive → verify the tree is gone.
 * Waiting on the GROUP (not just the leader) means a cooperative descendant
 * gets the full grace window, while a stubborn one still forces SIGKILL — and
 * a leader that exits on SIGTERM while a descendant ignores it cannot orphan.
 */
export async function killConfirm(
  child: ChildProcess,
  timings: KillConfirmTimings,
): Promise<KillConfirmRecord> {
  const started = Date.now();
  const pid = child.pid;
  if (pid == null) {
    return { requested: true, escalatedToSigkill: false, treeGone: true, elapsedMs: 0 };
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* group may already be gone */
  }
  await waitGroupGone(pid, timings.graceMs); // full grace for the whole group
  let escalated = false;
  if (groupAlive(pid)) {
    escalated = true;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* ignore */
    }
    await waitGroupGone(pid, timings.sigkillWaitMs);
  }
  return {
    requested: true,
    escalatedToSigkill: escalated,
    treeGone: !groupAlive(pid),
    elapsedMs: Date.now() - started,
  };
}

function assembleFinalText(events: readonly StreamEvent[]): string {
  // Prefer a single complete result message (codex agent_message, claude
  // result). Otherwise reassemble the trailing run of assistant/result
  // fragments in order (token-streaming CLIs like grok).
  const lastResult = [...events]
    .reverse()
    .find((e) => e.kind === "result" && e.text.trim().length > 0);
  if (lastResult) return lastResult.text.slice(0, 400);
  const trailing: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "assistant" || e.kind === "result") trailing.push(e.text);
    else if (trailing.length > 0) break;
  }
  return trailing.reverse().join("").slice(0, 400);
}

/**
 * Drive one headless dispatch through an adapter: compose a clean env, spawn
 * the CLI detached (own process group), parse both streams line-by-line into
 * normalized events, and either let it finish or cancel/timeout it with
 * kill-confirm. Outcome is classified centrally.
 */
export async function dispatch(
  adapter: AdapterSpec,
  ctx: AdapterContext,
  opts: DispatchOptions = {},
): Promise<DispatchRecord> {
  const started = Date.now();
  const plan = adapter.plan(ctx);
  const { env, posture } = composeWorkerEnv(process.env, plan.env ?? {});
  const timings = opts.killConfirm ?? PRODUCTION_KILL_CONFIRM;

  const child = spawn(plan.file, plan.args, {
    cwd: ctx.workdir,
    env,
    detached: true,
    stdio: [plan.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
  });

  // Bounded event retention (head + tail ring) with a true total count.
  const headEvents: StreamEvent[] = [];
  const tailRing: StreamEvent[] = [];
  let totalEvents = 0;
  let anyEventQuota = false;
  const recordEvent = (ev: StreamEvent) => {
    totalEvents++;
    if (ev.quotaSignal) anyEventQuota = true;
    if (headEvents.length < EVENT_HEAD_CAP) headEvents.push(ev);
    else {
      tailRing.push(ev);
      if (tailRing.length > EVENT_TAIL_CAP) tailRing.shift();
    }
  };
  const retainedEvents = (): StreamEvent[] => [...headEvents, ...tailRing];

  // Incremental quota detection: a single flag, not an unbounded buffer, so a
  // noisy/misbehaving worker cannot grow harness memory (review #4). Scanned
  // per-line: providers emit a rate-limit signal atomically on one line (a 429
  // status, a `rate_limit_exceeded` token). Joining adjacent lines to catch a
  // signal "split" across them manufactures false positives from unrelated text
  // ("success rate\nLimited…") and is deliberately not done (review #4-r4).
  let quotaSeenInRaw = false;
  let exited = false;
  let killReason: "cancel" | "timeout" | null = null;
  let killRecord: KillConfirmRecord | undefined;
  let killPromise: Promise<void> | null = null;
  let cancelTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let sawFirstEvent = false;

  // Initiate a kill exactly once, only while the child has not yet exited (per
  // the exit event, our authoritative exit signal).
  //
  // Accepted residual (review #3): the exit event is asynchronous, so a process
  // that finishes at almost exactly the cancel/timeout instant may be labeled
  // cancelled/killed rather than succeeded. There is no synchronous way to
  // distinguish "still running" from "exited but not yet reaped" (a zombie
  // answers kill(pid,0)), nor a natural exit-0 from a worker that caught SIGTERM
  // and exited 0. The mislabel is (a) confined to a sub-millisecond race that
  // never arises in real dispatches (cancel fires 1.5s into 30s+ of work) and
  // (b) in the ledger-safe direction — a cancelled attempt is excluded from
  // model scorecards, not falsely credited. The production attempt state
  // machine (Appendix A, WP-101/105) records cancel-requested and exited as
  // separate events and reconciles them, rather than forcing a synchronous label.
  const requestKill = (reason: "cancel" | "timeout") => {
    if (exited || killReason) return;
    killReason = reason;
    killPromise = killConfirm(child, timings).then((k) => {
      killRecord = k;
    });
  };

  const spawnFailed = await new Promise<boolean>((resolve) => {
    let settled = false;
    child.once("error", () => {
      if (!settled) {
        settled = true;
        resolve(true);
      }
    });
    child.once("spawn", () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
  });

  if (spawnFailed) {
    return {
      adapter: adapter.name,
      outcome: "requirement-failed",
      spawned: false,
      streamedEvents: 0,
      finalText: "",
      committedSha: null,
      envPosture: posture,
      exitCode: null,
      durationMs: Date.now() - started,
      events: [],
    };
  }

  if (plan.stdin != null && child.stdin) {
    child.stdin.end(plan.stdin);
  }

  const consume = (channel: "stdout" | "stderr", stream: NodeJS.ReadableStream) => {
    const rl = createInterface({ input: stream });
    rl.on("line", (line) => {
      opts.onLine?.(channel, line);
      if (!quotaSeenInRaw && classifyByQuotaSignal(line)) quotaSeenInRaw = true;
      // A buggy parser must never crash the harness (bypassing cleanup).
      let ev: StreamEvent | null = null;
      try {
        ev = adapter.parseLine(line, channel);
      } catch {
        ev = null;
      }
      if (!ev) return;
      recordEvent(ev);
      if (!sawFirstEvent) {
        sawFirstEvent = true;
        if (opts.cancelAfterFirstEventMs != null) {
          cancelTimer = setTimeout(() => requestKill("cancel"), opts.cancelAfterFirstEventMs);
        }
      }
    });
  };
  if (child.stdout) consume("stdout", child.stdout);
  if (child.stderr) consume("stderr", child.stderr);

  if (opts.timeoutMs != null) {
    timeoutTimer = setTimeout(() => requestKill("timeout"), opts.timeoutMs);
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      exited = true;
      resolve(code);
    });
  });
  if (cancelTimer) clearTimeout(cancelTimer);
  if (timeoutTimer) clearTimeout(timeoutTimer);
  if (killPromise) await killPromise; // let an in-flight kill finish

  const events = retainedEvents();

  // Quota classification is centralized: a quota signal on any parsed event OR
  // in the raw stream (so a signal on a dropped/malformed line is not lost) —
  // CAM-EXEC-06. anyEventQuota is tracked over ALL events, not just retained.
  const quotaBlocked = quotaSeenInRaw || anyEventQuota;

  // A cancel/timeout is authoritative from `killReason`, set ONLY by requestKill
  // and ONLY while the child was genuinely still running (its exited + pidAlive
  // guards). A process that had already exited never gets a killReason and is
  // classified on its exit code — no natural completion is mislabeled.
  let outcome: Outcome;
  if (killReason === "timeout") {
    outcome = "killed";
  } else if (killReason === "cancel") {
    outcome = "cancelled";
  } else if (exitCode === 0) {
    outcome = "succeeded";
  } else if (quotaBlocked) {
    outcome = "quota-blocked";
  } else {
    outcome = "requirement-failed";
  }

  return {
    adapter: adapter.name,
    outcome,
    spawned: true,
    streamedEvents: totalEvents,
    finalText: assembleFinalText(events),
    committedSha: null, // filled by the harness after inspecting the workspace
    ...(killRecord ? { killConfirm: killRecord } : {}),
    envPosture: posture,
    exitCode,
    durationMs: Date.now() - started,
    events,
  };
}
