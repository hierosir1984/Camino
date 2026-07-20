// WP-105: the shared dispatch lifecycle (CAM-EXEC-06) — product promotion of
// the WP-001 spike. One tested lifecycle drives every adapter: spawn (detached
// → own process group), line-by-line stream parsing, cancellation with
// kill-confirm (SIGTERM → grace → SIGKILL → group-gone), post-exit group
// sweep, centralized outcome classification, and lease release sequenced
// strictly after the GROUP is confirmed gone (PRD §5 registry item 4).
//
// Containment boundary (round-1 review finding 1): "gone" is the worker's
// process GROUP. A descendant that detaches into its own session escapes
// group signals; complete process-tree containment is WP-107's container
// (PID namespace). This layer owns the group-scoped ordering guarantee and
// says so.
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
  EnvPostureRecord,
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
   * nothing is spawned at all; an abort during the plan()/spawn window is
   * honored the instant the child exists (round-1 review finding 3).
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
  /** Sink for live transcript lines (raw). Guarded: a throwing sink cannot crash the dispatch. */
  onLine?: (channel: "stdout" | "stderr", line: string) => void;
  /**
   * Attempt lease seam (PRD §5 registry item 4). Released at most once, only
   * after the process GROUP is confirmed gone; deliberately HELD (recorded in
   * the DispatchRecord) when the group cannot be confirmed gone; always
   * settled even if the dispatch body throws.
   */
  lease?: LeaseHandle;
}

/** Is ANY process in group `pgid` still alive? (leader OR any descendant in the group) */
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
 * → SIGKILL iff any member is still alive → verify the group is gone.
 * Waiting on the GROUP (not just the leader) means a cooperative descendant
 * gets the full grace window, while a stubborn one still forces SIGKILL — and
 * a leader that exits on SIGTERM while a descendant ignores it cannot orphan
 * (the WP-001 review's finding #1). Group scope, not full tree: a session
 * escapee is WP-107's container's problem (finding 1).
 */
export async function killConfirm(
  child: ChildProcess,
  timings: KillConfirmTimings,
): Promise<KillConfirmRecord> {
  const started = Date.now();
  const pid = child.pid;
  if (pid == null) {
    return { requested: true, escalatedToSigkill: false, groupGone: true, elapsedMs: 0 };
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
    groupGone: !groupAlive(pid),
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
 * Is the worker process GROUP confirmed gone, from the dispatch's own records?
 * Pure — exported so the held-lease branch is unit-testable (a genuinely
 * unkillable process cannot be manufactured in CI). The natural-exit path
 * with neither record present is confirmed-by-check: the lifecycle probes the
 * group after the leader exits and populates `postExitCleanup` whenever any
 * member survived, so "no record" means the probe found the group empty.
 *
 * Group scope, not full tree (round-1 review finding 1): a descendant that
 * detached into its own session is invisible to the group probe. This function
 * is honest about what it can confirm — the group — and WP-107's container
 * closes the residual.
 */
export function processGroupConfirmedGone(rec: {
  spawned: boolean;
  killConfirm?: KillConfirmRecord;
  postExitCleanup?: KillConfirmRecord;
}): boolean {
  if (!rec.spawned) return true; // no process ever existed
  if (rec.killConfirm && !rec.killConfirm.groupGone) return false;
  if (rec.postExitCleanup && !rec.postExitCleanup.groupGone) return false;
  return true;
}

/** Release the lease iff the group is confirmed gone; otherwise hold, recorded. */
async function settleLease(
  lease: LeaseHandle,
  groupGone: boolean,
  outcome: DispatchOutcome,
): Promise<LeaseDisposition> {
  if (!groupGone) return { released: false, heldReason: "process-group-unconfirmed" };
  try {
    await lease.release({ groupGone: true, outcome });
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

/** Build a terminal record for a dispatch that never produced a running child. */
function noProcessRecord(
  adapter: AdapterSpec,
  outcome: DispatchOutcome,
  posture: EnvPostureRecord,
  startedMs: number,
  extra: Partial<DispatchRecord> = {},
): DispatchRecord {
  return {
    adapter: adapter.name,
    outcome,
    spawned: false,
    streamedEvents: 0,
    finalText: "",
    committedSha: null,
    envPosture: posture,
    exitCode: null,
    durationMs: Date.now() - startedMs,
    events: [],
    ...extra,
  };
}

/**
 * Drive one headless dispatch through an adapter: compose a clean env, spawn
 * the CLI detached (own process group), parse both streams line-by-line into
 * normalized events, and either let it finish or cancel/timeout it with
 * kill-confirm. Outcome is classified centrally; the lease (when provided) is
 * settled LAST — after the group-gone determination — and always settled,
 * even if the dispatch body throws (finally).
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
    const record = noProcessRecord(adapter, "cancelled", posture, started);
    if (opts.lease) record.lease = await settleLease(opts.lease, true, record.outcome);
    return record;
  }

  // plan() is adapter code — a throw here is a broken adapter, handled like a
  // spawn failure (requirement-failed), never a leaked lease (round-1 finding 2).
  let plan;
  try {
    plan = adapter.plan(ctx);
  } catch (err) {
    const { posture } = composeWorkerEnv(process.env);
    const record = noProcessRecord(adapter, "requirement-failed", posture, started, {
      unexpectedError: `plan() threw: ${String(err).slice(0, 400)}`,
    });
    if (opts.lease) record.lease = await settleLease(opts.lease, true, record.outcome);
    return record;
  }
  const { env, posture } = composeWorkerEnv(process.env, plan.env ?? {});

  // State the whole body shares; settled in the finally below.
  let child: ChildProcess | undefined;
  let exited = false;
  let killReason: "cancel" | "timeout" | null = null;
  let killRecord: KillConfirmRecord | undefined;
  let killPromise: Promise<void> | null = null;
  let cancelTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  // Abort may fire during the plan()/spawn window, before a child exists
  // (round-1 review finding 3): remember it and apply it the instant we can.
  let pendingCancel = false;

  const requestKill = (reason: "cancel" | "timeout") => {
    if (killReason) return;
    if (!child || exited) {
      // No live child yet (or already exited): remember a cancel so the
      // post-spawn check applies it; a timeout with no child is moot.
      if (reason === "cancel") pendingCancel = true;
      return;
    }
    killReason = reason;
    const c = child;
    killPromise = killConfirm(c, timings).then((k) => {
      killRecord = k;
    });
  };
  const onAbort = () => requestKill("cancel");
  // Arm the abort listener BEFORE spawn so an abort in the spawn window is not
  // lost (finding 3). An abort that fired DURING plan() — before this listener
  // existed — never re-fires (AbortSignal 'abort' is a one-shot), so also
  // sample the flag directly and remember it as a pending cancel.
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) pendingCancel = true;

  try {
    child = spawn(plan.file, plan.args, {
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
    let sawFirstEvent = false;

    const spawnFailed = await new Promise<boolean>((resolve) => {
      let settled = false;
      child!.once("error", () => {
        if (!settled) {
          settled = true;
          resolve(true);
        }
      });
      child!.once("spawn", () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
    });

    if (spawnFailed) {
      const record = noProcessRecord(adapter, "requirement-failed", posture, started);
      if (opts.lease) record.lease = await settleLease(opts.lease, true, record.outcome);
      return record;
    }

    // The child exists now — apply any cancel that fired during the window.
    if (pendingCancel) requestKill("cancel");

    if (plan.stdin != null && child.stdin) {
      // A worker that closes stdin early makes the write EPIPE; swallow it (an
      // 'error' listener converts the throw into a handled event) so it cannot
      // crash the dispatch (round-1 review finding 2).
      child.stdin.on("error", () => {});
      child.stdin.end(plan.stdin);
    }

    const consume = (channel: "stdout" | "stderr", stream: NodeJS.ReadableStream) => {
      const rl = createInterface({ input: stream });
      rl.on("line", (line) => {
        // The transcript sink is caller code — a throwing sink must not crash
        // the dispatch (round-1 review finding 2).
        try {
          opts.onLine?.(channel, line);
        } catch {
          /* a broken sink is not the worker's fault */
        }
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
      child!.once("exit", (code) => {
        exited = true;
        resolve(code);
      });
    });
    if (killPromise) await killPromise; // let an in-flight kill finish

    // Post-exit group sweep: the leader exiting does not end the GROUP — a
    // worker may leave background descendants running (same group, detached
    // spawn). A finished dispatch must not leak workers (CAM-EXEC-06
    // process-tree cleanup), and the lease below must not be released over a
    // live group. When no kill-confirm ran, probe the group and sweep any
    // survivors with the same SIGTERM → grace → SIGKILL sequence. (A descendant
    // that detached into its OWN session escapes even this — finding 1 — and is
    // WP-107's container's problem.)
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
    //
    // Accepted residual (WP-001 review #3; scope corrected per round-1 review
    // finding 11): the exit event is asynchronous, so a cancel/timeout that
    // fires in the same event-loop window as a natural exit-0 can be recorded
    // as cancelled/killed. The window is bounded by event-loop scheduling (not
    // a hard sub-millisecond claim), and the mislabel is ledger-safe (a
    // cancelled attempt is excluded from scorecards, not falsely credited). The
    // attempt state machine (Appendix A) records cancel-requested and exited as
    // separate events and reconciles them rather than forcing a synchronous
    // label; WP-105 keeps the conservative synchronous label at the seam.
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

    // Lease settlement is LAST, strictly after the group-gone determination
    // (PRD §5 registry item 4: … → group-gone → lease release).
    if (opts.lease) {
      record.lease = await settleLease(opts.lease, processGroupConfirmedGone(record), outcome);
    }
    return record;
  } catch (err) {
    // Anything unexpected in the body (e.g. a stream/API error we didn't
    // anticipate) still cleans up and settles the lease (round-1 finding 2).
    // Best-effort sweep the group so we do not leak a worker, then settle.
    let postExitCleanup: KillConfirmRecord | undefined;
    const pid = child?.pid;
    if (!killRecord && pid != null && groupAlive(pid)) {
      try {
        postExitCleanup = await killConfirm(child!, timings);
      } catch {
        /* best effort */
      }
    }
    const record: DispatchRecord = {
      adapter: adapter.name,
      outcome: "requirement-failed",
      spawned: child != null,
      streamedEvents: 0,
      finalText: "",
      committedSha: null,
      ...(killRecord ? { killConfirm: killRecord } : {}),
      ...(postExitCleanup ? { postExitCleanup } : {}),
      envPosture: posture,
      exitCode: null,
      durationMs: Date.now() - started,
      events: [],
      unexpectedError: String(err).slice(0, 400),
    };
    if (opts.lease) {
      record.lease = await settleLease(
        opts.lease,
        processGroupConfirmedGone(record),
        record.outcome,
      );
    }
    return record;
  } finally {
    if (cancelTimer) clearTimeout(cancelTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
