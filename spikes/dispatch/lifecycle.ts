import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { composeWorkerEnv } from "./env.js";
import type {
  AdapterContext,
  AdapterSpec,
  DispatchRecord,
  KillConfirmRecord,
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

/** Is any process in group `pgid` still alive? */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    // ESRCH = gone; EPERM = exists but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), ms);
    child.once("exit", () => finish(true));
  });
}

/**
 * Kill-confirm sequence (CAM-EXEC-06, registry item 4):
 * SIGTERM to the process GROUP → grace → SIGKILL → verify the whole tree is
 * gone. Targeting the group (negative pid) is what makes it a TREE kill: a CLI
 * that spawned children/grandchildren is taken down whole.
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
  let escalated = false;
  const exitedOnTerm = await waitExit(child, timings.graceMs);
  if (!exitedOnTerm && groupAlive(pid)) {
    escalated = true;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* ignore */
    }
    await waitExit(child, timings.sigkillWaitMs);
  }
  return {
    requested: true,
    escalatedToSigkill: escalated,
    treeGone: !groupAlive(pid),
    elapsedMs: Date.now() - started,
  };
}

/**
 * Drive one headless dispatch through an adapter: compose a clean env, spawn
 * the CLI detached (own process group), parse both streams line-by-line into
 * normalized events, and either let it finish or cancel it mid-run with
 * kill-confirm.
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
  let killRecord: KillConfirmRecord | undefined;
  let cancelTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let sawFirstEvent = false;

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
      const ev = adapter.parseLine(line, channel);
      if (!ev) return;
      events.push(ev);
      if (!sawFirstEvent) {
        sawFirstEvent = true;
        if (opts.cancelAfterFirstEventMs != null) {
          cancelTimer = setTimeout(() => {
            void killConfirm(child, timings).then((k) => {
              killRecord = k;
            });
          }, opts.cancelAfterFirstEventMs);
        }
      }
    });
  };
  if (child.stdout) consume("stdout", child.stdout);
  if (child.stderr) consume("stderr", child.stderr);

  if (opts.timeoutMs != null) {
    timeoutTimer = setTimeout(() => {
      void killConfirm(child, timings).then((k) => {
        killRecord = killRecord ?? k;
      });
    }, opts.timeoutMs);
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  if (cancelTimer) clearTimeout(cancelTimer);
  if (timeoutTimer) clearTimeout(timeoutTimer);
  // Let any pending kill-confirm settle.
  if (
    killRecord === undefined &&
    (opts.cancelAfterFirstEventMs != null || opts.timeoutMs != null)
  ) {
    await new Promise((r) => setTimeout(r, 50));
  }

  // finalText: prefer a single complete result message (codex agent_message,
  // claude result). If none carries text — token-streaming CLIs like grok emit
  // the answer as many fragments — reassemble the trailing run of
  // assistant/result fragments in order.
  const lastResult = [...events]
    .reverse()
    .find((e) => e.kind === "result" && e.text.trim().length > 0);
  let finalText: string;
  if (lastResult) {
    finalText = lastResult.text;
  } else {
    const trailing: string[] = [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.kind === "assistant" || e.kind === "result") trailing.push(e.text);
      else if (trailing.length > 0) break;
    }
    finalText = trailing.reverse().join("");
  }
  finalText = finalText.slice(0, 400);

  let outcome: DispatchRecord["outcome"];
  if (killRecord) {
    outcome = "cancelled";
  } else if (exitCode === 0) {
    outcome = "succeeded";
  } else {
    outcome = adapter.classifyFailure(events, exitCode);
  }

  return {
    adapter: adapter.name,
    outcome,
    spawned: true,
    streamedEvents: events.length,
    finalText,
    committedSha: null, // filled by the harness after inspecting the workspace
    ...(killRecord ? { killConfirm: killRecord } : {}),
    envPosture: posture,
    exitCode,
    durationMs: Date.now() - started,
    events,
  };
}
