// WP-105: the shared dispatch lifecycle (CAM-EXEC-06) — product promotion of
// the WP-001 spike. One tested lifecycle drives every adapter: spawn (detached
// → own process group), line-by-line stream parsing, cancellation with
// kill-confirm (SIGTERM → grace → SIGKILL → tree-gone), post-exit group
// sweep, centralized outcome classification, and lease release sequenced
// strictly after the tree is confirmed gone (PRD §5 registry item 4).
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  AdapterContext,
  AdapterSpec,
  DispatchRecord,
  KillConfirmRecord,
  LeaseDisposition,
  LeaseHandle,
  DispatchOutcome,
  StreamEvent,
} from "@camino/shared";
import { composeWorkerEnv } from "./env.js";
import { classifyByQuotaSignal } from "./quota.js";

/** Kill-confirm timings. Production defaults (PRD §5 registry item 4): 30s grace. */
export interface KillConfirmTimings {
  graceMs: number;
  sigkillWaitMs: number;
}
export const PRODUCTION_KILL_CONFIRM: KillConfirmTimings = {
  graceMs: 30_000,
  sigkillWaitMs: 5_000,
};

/**
 * Dispatching a disabled adapter is a policy violation, not an outcome
 * (CAM-EXEC-01: a failed sanctioned-path check means installable but never
 * dispatched). The lifecycle refuses with this typed error BEFORE calling
 * plan(), so no caller can forget to check.
 */
export class DisabledAdapterError extends Error {
  readonly adapter: string;
  readonly disabledReason: string;
  constructor(adapter: string, disabledReason: string | undefined) {
    const reason = disabledReason ?? "no reason recorded";
    super(`adapter "${adapter}" is disabled and cannot be dispatched: ${reason}`);
    this.name = "DisabledAdapterError";
    this.adapter = adapter;
    this.disabledReason = reason;
  }
}

export interface DispatchOptions {
  /**
   * External cancellation (the product path): aborting requests the
   * kill-confirm sequence. A signal already aborted at dispatch time means
   * nothing is spawned at all.
   */
  signal?: AbortSignal;
  /**
   * Cancel this long after the first parsed event — a conformance/evidence
   * harness affordance (deterministic mid-run cancel); product callers use
   * `signal`.
   */
  cancelAfterFirstEventMs?: number;
  /** Hard cap so a real dispatch can never run away. Classified `killed`, never `cancelled`. */
  timeoutMs?: number;
  killConfirm?: KillConfirmTimings;
  /** Sink for live transcript lines (raw). */
  onLine?: (channel: "stdout" | "stderr", line: string) => void;
  /**
   * Attempt lease seam (PRD §5 registry item 4). Released at most once, only
   * after the process tree is confirmed gone; deliberately HELD (recorded in
   * the DispatchRecord) when the tree cannot be confirmed gone.
   */
  lease?: LeaseHandle;
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

// Bound how many parsed events are retained so a noisy/misbehaving worker
// cannot grow harness memory (WP-001 review #4): keep the first HEAD + last
// TAIL, plus a total count. The head/tail window preserves both the opening
// context and the trailing result run that finalText needs.
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
 * Kill-confirm sequence (CAM-EXEC-06, PRD §5 registry item 4):
 * SIGTERM to the process GROUP → give the WHOLE GROUP up to `graceMs` to exit
 * → SIGKILL iff any member is still alive → verify the tree is gone.
 * Waiting on the GROUP (not just the leader) means a cooperative descendant
 * gets the full grace window, while a stubborn one still forces SIGKILL — and
 * a leader that exits on SIGTERM while a descendant ignores it cannot orphan
 * (the WP-001 review's finding #1).
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
 * Is the worker process tree confirmed gone, from the dispatch's own records?
 * Pure — exported so the held-lease branch is unit-testable (a genuinely
 * unkillable process cannot be manufactured in CI). The natural-exit path
 * with neither record present is confirmed-by-check: the lifecycle probes the
 * group after the leader exits and populates `postExitCleanup` whenever any
 * member survived, so "no record" means the probe found the group empty.
 */
export function processTreeConfirmedGone(rec: {
  spawned: boolean;
  killConfirm?: KillConfirmRecord;
  postExitCleanup?: KillConfirmRecord;
}): boolean {
  if (!rec.spawned) return true; // no process ever existed
  if (rec.killConfirm && !rec.killConfirm.treeGone) return false;
  if (rec.postExitCleanup && !rec.postExitCleanup.treeGone) return false;
  return true;
}

/** Release the lease iff the tree is confirmed gone; otherwise hold, recorded. */
async function settleLease(
  lease: LeaseHandle,
  treeGone: boolean,
  outcome: DispatchOutcome,
): Promise<LeaseDisposition> {
  if (!treeGone) return { released: false, heldReason: "process-tree-unconfirmed" };
  try {
    await lease.release({ treeGone: true, outcome });
    return { released: true };
  } catch (err) {
    // The release call itself failed — the underlying lease state is unknown,
    // so the dispatch cannot claim it released. Recorded, never thrown: a
    // broken lease store must not corrupt the dispatch record.
    return {
      released: false,
      heldReason: "release-threw",
      releaseError: String(err).slice(0, 400),
    };
  }
}

/**
 * Drive one headless dispatch through an adapter: compose a clean env, spawn
 * the CLI detached (own process group), parse both streams line-by-line into
 * normalized events, and either let it finish or cancel/timeout it with
 * kill-confirm. Outcome is classified centrally; the lease (when provided) is
 * settled last, strictly after the tree-gone determination.
 */
export async function dispatch(
  adapter: AdapterSpec,
  ctx: AdapterContext,
  opts: DispatchOptions = {},
): Promise<DispatchRecord> {
  if (!adapter.enabled) {
    // Refuse BEFORE plan(): a disabled adapter's code never runs (CAM-EXEC-01).
    throw new DisabledAdapterError(adapter.name, adapter.disabledReason);
  }
  const started = Date.now();
  const timings = opts.killConfirm ?? PRODUCTION_KILL_CONFIRM;

  if (opts.signal?.aborted) {
    // Cancelled before anything ran: nothing spawned, nothing to kill; the
    // posture records the composed baseline (no adapter extras — plan() is
    // not consulted for a dispatch that never starts).
    const { posture } = composeWorkerEnv(process.env);
    const record: DispatchRecord = {
      adapter: adapter.name,
      outcome: "cancelled",
      spawned: false,
      streamedEvents: 0,
      finalText: "",
      committedSha: null,
      envPosture: posture,
      exitCode: null,
      durationMs: Date.now() - started,
      events: [],
    };
    if (opts.lease) record.lease = await settleLease(opts.lease, true, record.outcome);
    return record;
  }

  const plan = adapter.plan(ctx);
  const { env, posture } = composeWorkerEnv(process.env, plan.env ?? {});

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
  // noisy/misbehaving worker cannot grow harness memory (WP-001 review #4).
  // Scanned per-line: providers emit a rate-limit signal atomically on one
  // line. Joining adjacent lines manufactures false positives from unrelated
  // text and is deliberately not done (WP-001 review #4-r4).
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
  // Accepted residual (WP-001 review #3): the exit event is asynchronous, so a
  // process that finishes at almost exactly the cancel/timeout instant may be
  // labeled cancelled/killed rather than succeeded. There is no synchronous
  // way to distinguish "still running" from "exited but not yet reaped" (a
  // zombie answers kill(pid,0)), nor a natural exit-0 from a worker that
  // caught SIGTERM and exited 0. The mislabel is (a) confined to a
  // sub-millisecond race that never arises in real dispatches (cancel fires
  // seconds into minutes of work) and (b) in the ledger-safe direction — a
  // cancelled attempt is excluded from model scorecards, not falsely
  // credited. The attempt state machine (Appendix A) records cancel-requested
  // and exited as separate events and reconciles them, rather than forcing a
  // synchronous label.
  const requestKill = (reason: "cancel" | "timeout") => {
    if (exited || killReason) return;
    killReason = reason;
    killPromise = killConfirm(child, timings).then((k) => {
      killRecord = k;
    });
  };
  const onAbort = () => requestKill("cancel");

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
    const record: DispatchRecord = {
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
    if (opts.lease) record.lease = await settleLease(opts.lease, true, record.outcome);
    return record;
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
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      exited = true;
      resolve(code);
    });
  });
  if (cancelTimer) clearTimeout(cancelTimer);
  if (timeoutTimer) clearTimeout(timeoutTimer);
  opts.signal?.removeEventListener("abort", onAbort);
  if (killPromise) await killPromise; // let an in-flight kill finish

  // Post-exit group sweep: the leader exiting does not end the GROUP — a
  // worker may leave background descendants running (same group, detached
  // spawn). A finished dispatch must not leak workers (CAM-EXEC-06
  // process-tree cleanup), and the lease below must not be released over a
  // live group. When no kill-confirm ran, probe the group and sweep any
  // survivors with the same SIGTERM → grace → SIGKILL sequence.
  let postExitCleanup: KillConfirmRecord | undefined;
  const pid = child.pid;
  if (!killRecord && pid != null && groupAlive(pid)) {
    postExitCleanup = await killConfirm(child, timings);
  }

  const events = retainedEvents();

  // Quota classification is centralized: a quota signal on any parsed event OR
  // in the raw stream (so a signal on a dropped/malformed line is not lost) —
  // CAM-EXEC-06. anyEventQuota is tracked over ALL events, not just retained.
  const quotaBlocked = quotaSeenInRaw || anyEventQuota;

  // A cancel/timeout is authoritative from `killReason`, set ONLY by
  // requestKill and ONLY while the child was genuinely still running. A
  // process that had already exited never gets a killReason and is classified
  // on its exit code — no natural completion is mislabeled.
  let outcome: DispatchOutcome;
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

  const record: DispatchRecord = {
    adapter: adapter.name,
    outcome,
    spawned: true,
    streamedEvents: totalEvents,
    finalText: assembleFinalText(events),
    committedSha: null, // filled by the caller after inspecting the workspace
    ...(killRecord ? { killConfirm: killRecord } : {}),
    ...(postExitCleanup ? { postExitCleanup } : {}),
    envPosture: posture,
    exitCode,
    durationMs: Date.now() - started,
    events,
  };

  // Lease settlement is LAST, strictly after the tree-gone determination
  // (PRD §5 registry item 4: … → tree-gone → lease release).
  if (opts.lease) {
    record.lease = await settleLease(opts.lease, processTreeConfirmedGone(record), outcome);
  }
  return record;
}
