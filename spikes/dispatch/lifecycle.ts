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
  /** Hard cap so a real dispatch can never run away. */
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

/** Wait up to `ms` for the group leader to exit. */
function waitLeaderExit(child: ChildProcess, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Kill-confirm sequence (CAM-EXEC-06, registry item 4):
 * SIGTERM to the process GROUP → grace → SIGKILL **iff any group member is
 * still alive** → verify the whole tree is gone. Escalation is gated on the
 * GROUP, not the leader: a leader that exits on SIGTERM while a descendant
 * ignores it must still trigger SIGKILL, or that descendant orphans.
 */
export async function killConfirm(
  child: ChildProcess,
  timings: KillConfirmTimings,
): Promise<KillConfirmRecord> {
  const started = Date.now();
  const pid = child.pid;
  if (pid == null) {
    return {
      requested: true,
      wasAliveAtSignal: false,
      escalatedToSigkill: false,
      treeGone: true,
      elapsedMs: 0,
    };
  }
  const wasAliveAtSignal = groupAlive(pid);
  if (!wasAliveAtSignal) {
    // The process finished on its own before we signalled — not a real kill.
    return {
      requested: true,
      wasAliveAtSignal: false,
      escalatedToSigkill: false,
      treeGone: true,
      elapsedMs: Date.now() - started,
    };
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* group may already be gone */
  }
  await waitLeaderExit(child, timings.graceMs);
  let escalated = false;
  if (groupAlive(pid)) {
    // Any surviving member (leader or descendant) → SIGKILL the whole group.
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
    wasAliveAtSignal,
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

  const events: StreamEvent[] = [];
  const rawChunks: string[] = [];
  let exited = false;
  let killReason: "cancel" | "timeout" | null = null;
  let killRecord: KillConfirmRecord | undefined;
  let killPromise: Promise<void> | null = null;
  let cancelTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let sawFirstEvent = false;

  // Initiate a kill exactly once, only while the child is still running.
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
      events,
    };
  }

  if (plan.stdin != null && child.stdin) {
    child.stdin.end(plan.stdin);
  }

  const consume = (channel: "stdout" | "stderr", stream: NodeJS.ReadableStream) => {
    const rl = createInterface({ input: stream });
    rl.on("line", (line) => {
      opts.onLine?.(channel, line);
      rawChunks.push(line);
      // A buggy parser must never crash the harness (bypassing cleanup).
      let ev: StreamEvent | null = null;
      try {
        ev = adapter.parseLine(line, channel);
      } catch {
        ev = null;
      }
      if (!ev) return;
      events.push(ev);
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

  // Quota classification is centralized and evidence-wide: any parsed quota
  // signal OR a quota marker in the RAW output (so a signal on a dropped /
  // non-JSON / malformed line is not lost) — CAM-EXEC-06.
  const quotaBlocked =
    events.some((e) => e.quotaSignal) || classifyByQuotaSignal(rawChunks.join("\n"));

  // A cancel/timeout counts only if we genuinely interrupted a LIVE process
  // group (wasAliveAtSignal). A process that finished in the race window before
  // our signal landed is a success/failure on its own terms, not a cancel —
  // this is how a graceful-exit-on-SIGTERM worker is still "cancelled" while a
  // just-completed worker is not (WP-001 review #4).
  const reallyInterrupted = killRecord?.wasAliveAtSignal === true;

  let outcome: Outcome;
  if (killReason === "timeout" && reallyInterrupted) {
    outcome = "killed";
  } else if (killReason === "cancel" && reallyInterrupted) {
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
    streamedEvents: events.length,
    finalText: assembleFinalText(events),
    committedSha: null, // filled by the harness after inspecting the workspace
    ...(killRecord ? { killConfirm: killRecord } : {}),
    envPosture: posture,
    exitCode,
    durationMs: Date.now() - started,
    events,
  };
}
