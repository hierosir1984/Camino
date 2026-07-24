#!/usr/bin/env node
// Reusable CPU load-test helper (remediation for the 2026-07-22 orphaned-load
// incident: 40 background `yes` processes escaped an ad-hoc shell cleanup and
// consumed ~12 cores for two days).
//
// Root cause of that incident, proven from the session transcript: the cleanup
// ran `kill $LOADPIDS 2>/dev/null` under zsh, which does not word-split unquoted
// variables — all pids were passed as ONE argument, kill failed with "illegal
// pid", and the redirect suppressed the only evidence. The load processes had
// also been started as `( yes & )` grandchildren, so nothing owned them.
//
// This helper closes both failure classes structurally:
//   * OWNERSHIP  — every load run gets a dedicated process group: a detached
//     leader (new session, pgid == leader pid) spawns the workers as direct
//     children. Cleanup signals the group and verifies each tracked pid; no
//     pids ever round-trip through shell strings, and no global pgrep result
//     is used as the ownership mechanism (a marker-based scan runs only as a
//     final safety net, after the ownership assertions).
//   * LIFECYCLE  — cleanup handlers are registered before the first spawn and
//     run on normal completion, error, timeout, SIGTERM, SIGINT, and SIGHUP.
//     Two independent backstops survive even SIGKILL of this controller: the
//     leader self-terminates the group when its parent changes (orphan
//     watchdog) and when a hard wall-clock deadline passes; workers do the
//     same on their own.
//   * EVIDENCE   — the owned pgid, every owned pid, each lifecycle phase, the
//     cleanup outcome, and the safety-net scan are recorded as JSON.
//
// Usage:
//   node scripts/load-test.mjs --workers 8 --duration 90s
//   node scripts/load-test.mjs --workers 8 -- ./node_modules/.bin/vitest run <suite>
//   node scripts/load-test.mjs --reap-leftovers --workers 1 --duration 1s
//
// Exit codes: 0 success (or the wrapped command's own exit code);
//   1 error; 70 cleanup left survivors; 71 preflight found leftover load
//   processes; 72 hard runtime cap hit; 128+n interrupted by signal n.
//
// One load test at a time per worktree: the preflight treats ANY live process
// carrying this worktree's marker as a leftover and refuses to start.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { availableParallelism, setPriority } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
// Marker string carried in every leader/worker argv. Scan-visible worktree
// attribution (the incident was attributed by worktree), never the primary
// ownership mechanism.
const MARKER_PREFIX = "camino-load-test::";
const repoMarker = `${MARKER_PREFIX}${repoRoot}::`;

const EXIT_ERROR = 1;
const EXIT_CLEANUP_FAILED = 70;
const EXIT_LEFTOVERS = 71;
const EXIT_TIMEOUT = 72;
const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
// Synchronous sleep so the teardown path works inside signal handlers and the
// process 'exit' event, where awaiting is impossible.
function sleepSync(ms) {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

// One `ps` snapshot for the whole process table; zombies (stat Z*) are dead
// for ownership purposes — a blocked event loop can't reap them, and counting
// them as alive would fabricate survivors.
function psSnapshot() {
  const out = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (out.error || out.status !== 0) {
    throw new Error(`ps failed: ${out.error?.message ?? out.stderr}`);
  }
  const rows = [];
  for (const line of out.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (m && !m[4].startsWith("Z")) {
      rows.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], command: m[5] });
    }
  }
  return rows;
}

function markerRows(rows) {
  return rows.filter((r) => r.command.includes(repoMarker));
}

function parseDuration(text, flag) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(text));
  if (!m)
    throw new UsageError(`${flag}: cannot parse duration "${text}" (use e.g. 500ms, 90s, 5m)`);
  const n = Number(m[1]);
  return Math.round(m[2] === "m" ? n * 60_000 : m[2] === "s" ? n * 1000 : n);
}

function parsePositiveInt(text, flag) {
  const n = Number(text);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag}: expected a positive integer`);
  return n;
}

function parseNonNegativeInt(text, flag) {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0)
    throw new UsageError(`${flag}: expected a non-negative integer`);
  return n;
}

class UsageError extends Error {}

const USAGE = `Usage:
  node scripts/load-test.mjs [options] --duration <t>       timed CPU load
  node scripts/load-test.mjs [options] -- <cmd> [args...]   run <cmd> under CPU load

Options:
  --workers <n>            spin workers to start (default: all cores)
  --duration <t>           how long to hold load, e.g. 500ms / 90s / 5m (timed mode only)
  --max-runtime <t>        hard wall-clock cap on the whole run (default 15m)
  --grace <t>              wait after SIGTERM before escalating (default 3s)
  --kill-wait <t>          wait after SIGKILL before declaring survivors (default 2s)
  --nice <n>               worker niceness 0..19 (default 0 = full-contention load)
  --evidence-dir <path>    where to write the evidence JSON (default .camino/load-test/)
  --reap-leftovers         terminate leftover load processes from earlier runs, then start
  --help                   this text`;

// ---------------------------------------------------------------------------
// Worker mode: one spinning CPU hog. Self-defending — exits on its own when
// the deadline passes or its parent (the leader) is gone, so even a leader
// SIGKILL cannot strand it.
function runWorker(opts) {
  const deadline = Number(opts["deadline-epoch-ms"]);
  const nice = Number(opts.nice ?? "0");
  if (nice > 0) {
    try {
      setPriority(nice);
    } catch {
      // Best effort; load fidelity does not depend on priority.
    }
  }
  const initialPpid = process.ppid;
  let spin = 0;
  for (;;) {
    spin = (spin + 1) & 0x3fffff;
    if (spin === 0 && (Date.now() >= deadline || process.ppid !== initialPpid)) {
      process.exit(0);
    }
  }
}

// ---------------------------------------------------------------------------
// Leader mode: process-group leader (spawned detached => own session). Spawns
// the workers as direct children, reports their pids upward, and enforces the
// two backstops (orphan watchdog + hard deadline) independently of the
// controller.
function runLeader(opts) {
  const runId = opts["run-id"];
  const workerCount = parsePositiveInt(opts.workers, "--workers");
  const deadlineEpochMs = Number(opts["deadline-epoch-ms"]);
  const watchdogMs = parsePositiveInt(opts["watchdog-ms"] ?? "250", "--watchdog-ms");
  const graceMs = Number(opts["grace-ms"] ?? "3000");
  const killWaitMs = Number(opts["kill-wait-ms"] ?? "2000");
  const controllerPid = Number(opts["controller-pid"]);
  const marker = `${repoMarker}${runId}`;

  // The controller may die (even by SIGKILL) while we still run; writing to
  // its closed pipe must never crash the leader mid-teardown.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  const send = (obj) => {
    try {
      process.stdout.write(`${JSON.stringify(obj)}\n`);
    } catch {
      // Controller is gone; the backstops still run.
    }
  };

  const workers = [];
  let tearingDown = false;

  function teardown(reason) {
    if (tearingDown) return;
    tearingDown = true;
    for (const w of workers) {
      if (!w.exited) {
        try {
          process.kill(w.pid, "SIGTERM");
        } catch {
          w.exited = true;
        }
      }
    }
    const started = Date.now();
    let escalated = false;
    const poll = setInterval(() => {
      const alive = workers.filter((w) => !w.exited);
      if (alive.length === 0) {
        clearInterval(poll);
        send({ type: "leader-exit", reason, survivors: [] });
        process.exit(0);
      }
      const waited = Date.now() - started;
      if (waited > graceMs && !escalated) {
        escalated = true;
        for (const w of alive) {
          try {
            process.kill(w.pid, "SIGKILL");
          } catch {
            w.exited = true;
          }
        }
      }
      if (waited > graceMs + killWaitMs) {
        clearInterval(poll);
        send({ type: "leader-exit", reason, survivors: alive.map((w) => w.pid) });
        process.exit(EXIT_CLEANUP_FAILED);
      }
    }, 25);
  }

  for (let i = 0; i < workerCount; i++) {
    const child = spawn(
      process.execPath,
      [
        scriptPath,
        "--worker",
        "--marker",
        marker,
        "--deadline-epoch-ms",
        String(deadlineEpochMs),
        "--nice",
        String(opts.nice ?? "0"),
      ],
      { stdio: "ignore" },
    );
    const entry = { pid: child.pid, exited: false };
    child.on("exit", () => {
      entry.exited = true;
      if (!tearingDown) send({ type: "worker-early-exit", pid: entry.pid });
    });
    child.on("error", () => {
      entry.exited = true;
      if (!tearingDown) send({ type: "worker-early-exit", pid: entry.pid });
    });
    workers.push(entry);
  }
  if (workers.some((w) => !w.pid)) {
    teardown("worker-spawn-failed");
    return;
  }
  send({ type: "ready", leaderPid: process.pid, workerPids: workers.map((w) => w.pid) });

  process.on("SIGTERM", () => teardown("sigterm"));
  process.on("SIGINT", () => teardown("sigint"));
  process.on("SIGHUP", () => teardown("sighup"));
  // Orphan watchdog and hard deadline are independent backstops: neither is
  // allowed to depend on the other's timer.
  setInterval(() => {
    if (process.ppid !== controllerPid) teardown("orphaned");
  }, watchdogMs);
  setTimeout(() => teardown("deadline"), Math.max(0, deadlineEpochMs - Date.now()));
}

// ---------------------------------------------------------------------------
// Controller mode: the public CLI. Owns the evidence record and the
// authoritative teardown/verification.
async function runController(opts, wrappedCmd) {
  if (process.platform === "win32") {
    throw new Error("load-test.mjs relies on POSIX process groups; Windows is unsupported");
  }

  const workers = opts.workers
    ? parsePositiveInt(opts.workers, "--workers")
    : availableParallelism();
  const durationMs = opts.duration ? parseDuration(opts.duration, "--duration") : null;
  const maxRuntimeMs = parseDuration(opts["max-runtime"] ?? "15m", "--max-runtime");
  const graceMs = parseDuration(opts.grace ?? "3s", "--grace");
  const killWaitMs = parseDuration(opts["kill-wait"] ?? "2s", "--kill-wait");
  const watchdogMs = opts["watchdog-ms"]
    ? parsePositiveInt(opts["watchdog-ms"], "--watchdog-ms")
    : 250;
  const backstopSlackMs =
    opts["backstop-slack-ms"] !== undefined
      ? parseNonNegativeInt(opts["backstop-slack-ms"], "--backstop-slack-ms")
      : 10_000;
  if (wrappedCmd.length === 0 && durationMs === null) {
    throw new UsageError("refusing unbounded load: pass --duration <t> or -- <cmd> [args...]");
  }
  if (wrappedCmd.length > 0 && durationMs !== null) {
    throw new UsageError(
      "--duration and a wrapped command are mutually exclusive (--max-runtime caps a wrapped run)",
    );
  }
  if (durationMs !== null && durationMs > maxRuntimeMs) {
    throw new UsageError("--duration exceeds --max-runtime; raise the cap explicitly");
  }

  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid.toString(36)}`;
  const evidenceDir = resolve(opts["evidence-dir"] ?? join(repoRoot, ".camino", "load-test"));
  mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = join(evidenceDir, `${runId}.json`);
  const evidence = {
    schema: "camino-load-test-evidence/1",
    runId,
    repoRoot,
    startedAt: new Date().toISOString(),
    options: { workers, durationMs, maxRuntimeMs, graceMs, killWaitMs, wrappedCmd },
    ownership: { pgid: null, leaderPid: null, workerPids: [] },
    phases: [],
    outcome: null,
  };
  // Temp-file + rename so a concurrent reader never observes a truncated file.
  const saveEvidence = () => {
    const tmp = `${evidencePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(evidence, null, 2)}\n`);
    renameSync(tmp, evidencePath);
  };
  const record = (type, extra = {}) => {
    evidence.phases.push({ type, at: new Date().toISOString(), ...extra });
    saveEvidence();
  };
  const say = (msg) => process.stdout.write(`[load-test] ${msg}\n`);

  // -- Preflight: any live process carrying this worktree's marker is a
  //    leftover from an earlier run (one load test at a time per worktree).
  const leftovers = markerRows(psSnapshot());
  if (leftovers.length > 0) {
    if (opts["reap-leftovers"]) {
      const reaped = reapSync(leftovers, graceMs, killWaitMs);
      record("leftovers-reaped", reaped);
      say(`reaped ${reaped.terminated.length} leftover load process(es) from earlier runs`);
      if (reaped.survivors.length > 0) {
        evidence.outcome = {
          reason: "leftover-reap-failed",
          cleanup: "survivors",
          survivors: reaped.survivors,
        };
        saveEvidence();
        process.stderr.write(
          `[load-test] could not terminate leftovers: ${reaped.survivors.join(" ")}\n`,
        );
        process.exit(EXIT_CLEANUP_FAILED);
      }
    } else {
      record("preflight-leftovers", { leftovers });
      evidence.outcome = { reason: "preflight-leftovers", cleanup: "not-started", leftovers };
      saveEvidence();
      process.stderr.write(
        `[load-test] refusing to start: ${leftovers.length} leftover load process(es) from an earlier run:\n`,
      );
      for (const r of leftovers) {
        process.stderr.write(
          `[load-test]   pid ${r.pid} ppid ${r.ppid} pgid ${r.pgid} ${r.command}\n`,
        );
      }
      process.stderr.write(`[load-test] rerun with --reap-leftovers to terminate them first\n`);
      process.exit(EXIT_LEFTOVERS);
    }
  }

  const owned = { pgid: null, leaderPid: null, workerPids: [] };
  let teardownResult = null;
  let wrappedChild = null;

  // Authoritative synchronous teardown: signal the owned group, wait for every
  // owned pid to leave the process table, escalate once, and report survivors.
  // Synchronous so it can run inside signal handlers and on 'exit'.
  function teardownSync(reason) {
    if (teardownResult) return teardownResult;
    if (owned.leaderPid === null) {
      teardownResult = {
        reason,
        cleanup: "verified-clean",
        survivors: [],
        escalated: false,
        waitedMs: 0,
      };
      return teardownResult;
    }
    const t0 = Date.now();
    const allPids = [owned.leaderPid, ...owned.workerPids];
    // A row counts as ours only if the pid is tracked AND its group/parentage
    // still matches — a recycled pid must not be mistaken for a survivor.
    const aliveOwned = () =>
      psSnapshot().filter(
        (r) =>
          allPids.includes(r.pid) &&
          (r.pgid === owned.pgid || (r.pid === owned.leaderPid && r.ppid === process.pid)),
      );
    try {
      process.kill(-owned.pgid, "SIGTERM");
    } catch {
      // ESRCH: the whole group is already gone.
    }
    try {
      process.kill(owned.leaderPid, "SIGTERM");
    } catch {
      // Already gone (or never left our group; covered by the group signal).
    }
    let alive = aliveOwned();
    const graceDeadline = Date.now() + graceMs;
    while (alive.length > 0 && Date.now() < graceDeadline) {
      sleepSync(50);
      alive = aliveOwned();
    }
    let escalated = false;
    if (alive.length > 0) {
      escalated = true;
      try {
        process.kill(-owned.pgid, "SIGKILL");
      } catch {
        // Group vanished between polls.
      }
      const killDeadline = Date.now() + killWaitMs;
      while (alive.length > 0 && Date.now() < killDeadline) {
        sleepSync(50);
        alive = aliveOwned();
      }
    }
    teardownResult = {
      reason,
      cleanup: alive.length === 0 ? "verified-clean" : "survivors",
      survivors: alive,
      escalated,
      waitedMs: Date.now() - t0,
    };
    return teardownResult;
  }

  // Safety net, run only after the ownership-based teardown: scan the process
  // table for this worktree's marker. Anything still carrying it escaped the
  // ownership machinery and is a hard failure.
  function finalize(reasonLabel, exitCode) {
    const t = teardownResult ?? teardownSync(reasonLabel);
    const scanMatches = markerRows(psSnapshot());
    evidence.outcome = {
      reason: reasonLabel,
      cleanup: t.cleanup,
      survivors: t.survivors,
      escalated: t.escalated,
      teardownWaitedMs: t.waitedMs,
      safetyNetScan: { at: new Date().toISOString(), matches: scanMatches },
    };
    saveEvidence();
    const failed = t.cleanup !== "verified-clean" || scanMatches.length > 0;
    say(
      `outcome ${reasonLabel}: cleanup ${t.cleanup}` +
        (t.escalated ? " (escalated to SIGKILL)" : "") +
        `, safety-net scan ${scanMatches.length} match(es); evidence ${evidencePath}`,
    );
    if (failed) {
      for (const r of [...t.survivors, ...scanMatches]) {
        process.stderr.write(
          `[load-test] SURVIVOR pid ${r.pid} ppid ${r.ppid} pgid ${r.pgid} ${r.command}\n`,
        );
      }
      process.exit(EXIT_CLEANUP_FAILED);
    }
    process.exit(exitCode);
  }

  // -- Cleanup registration precedes the first spawn (and the evidence proves
  //    the ordering).
  for (const [sig, code] of Object.entries(SIGNAL_EXIT)) {
    process.on(sig, () => {
      record("signal", { sig });
      if (wrappedChild && wrappedChild.exitCode === null) {
        try {
          wrappedChild.kill("SIGTERM");
        } catch {
          // Already exiting.
        }
      }
      teardownSync(`interrupted:${sig}`);
      finalize(`interrupted:${sig}`, code);
    });
  }
  process.on("uncaughtException", (err) => {
    record("uncaught-exception", { message: String(err?.stack ?? err) });
    teardownSync("error");
    finalize("error", EXIT_ERROR);
  });
  process.on("unhandledRejection", (err) => {
    record("unhandled-rejection", { message: String(err) });
    teardownSync("error");
    finalize("error", EXIT_ERROR);
  });
  process.on("exit", () => {
    // Backstop for exit paths that bypassed finalize(); never the primary path.
    if (!teardownResult && owned.leaderPid !== null) teardownSync("controller-exit");
  });
  record("cleanup-registered", { beforeSpawn: true });

  // -- Spawn the owned group.
  const deadlineEpochMs = Date.now() + maxRuntimeMs + backstopSlackMs;
  const leader = spawn(
    process.execPath,
    [
      scriptPath,
      "--leader",
      "--run-id",
      runId,
      "--marker",
      `${repoMarker}${runId}`,
      "--workers",
      String(workers),
      "--deadline-epoch-ms",
      String(deadlineEpochMs),
      "--watchdog-ms",
      String(watchdogMs),
      "--grace-ms",
      String(graceMs),
      "--kill-wait-ms",
      String(killWaitMs),
      "--controller-pid",
      String(process.pid),
      "--nice",
      String(opts.nice ?? "0"),
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  owned.leaderPid = leader.pid ?? null;
  owned.pgid = leader.pid ?? null; // detached spawn => new session, pgid == pid
  evidence.ownership.leaderPid = owned.leaderPid;
  evidence.ownership.pgid = owned.pgid;
  record("leader-spawned", { leaderPid: owned.leaderPid, pgid: owned.pgid });
  leader.stderr.on("data", (d) => process.stderr.write(d));

  const leaderEvents = createInterface({ input: leader.stdout });
  const earlyExits = [];
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(
      () => rejectReady(new Error("leader did not report ready within 15s")),
      15_000,
    );
    leader.on("error", (err) => {
      clearTimeout(timer);
      rejectReady(err);
    });
    leader.on("exit", (code, signal) => {
      clearTimeout(timer);
      rejectReady(new Error(`leader exited before ready (code ${code}, signal ${signal})`));
    });
    leaderEvents.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === "ready") {
        clearTimeout(timer);
        resolveReady(msg);
      } else if (msg.type === "worker-early-exit") {
        earlyExits.push(msg.pid);
        record("worker-early-exit", { pid: msg.pid });
      } else if (msg.type === "leader-exit") {
        record("leader-exit", msg);
      }
    });
  });

  let readyMsg;
  try {
    readyMsg = await ready;
  } catch (err) {
    record("leader-failed", { message: String(err) });
    teardownSync("error");
    finalize("error", EXIT_ERROR);
    return;
  }
  owned.workerPids = readyMsg.workerPids;
  evidence.ownership.workerPids = owned.workerPids;

  // Verify the ownership claim against the process table before declaring the
  // load live: the leader must lead its own group and every worker must be in it.
  const rows = psSnapshot();
  const leaderRow = rows.find((r) => r.pid === owned.leaderPid);
  const badLeader = !leaderRow || leaderRow.pgid !== owned.pgid;
  const badWorkers = owned.workerPids.filter(
    (pid) => !rows.some((r) => r.pid === pid && r.pgid === owned.pgid),
  );
  if (badLeader || badWorkers.length > 0) {
    record("ownership-verification-failed", { badLeader, badWorkers });
    teardownSync("error");
    finalize("error", EXIT_ERROR);
    return;
  }
  record("ready", { pgid: owned.pgid, leaderPid: owned.leaderPid, workerPids: owned.workerPids });
  say(
    `run ${runId}: ${workers} worker(s) live in owned pgid ${owned.pgid}; evidence ${evidencePath}`,
  );

  // Past this point a leader exit before teardown means the advertised load
  // stopped being delivered — that must fail the run, not pass silently.
  let leaderExitedEarly = false;
  leader.on("exit", (code, signal) => {
    if (!teardownResult) {
      leaderExitedEarly = true;
      record("leader-early-exit", { code, signal });
    }
  });

  // -- Hold the load: either for --duration, or for the wrapped command.
  // These timers stay ref'd: the event loop must not drain before the race
  // settles, whatever happens to the leader.
  const capTimer = new Promise((resolveCap) => {
    setTimeout(() => resolveCap({ kind: "cap" }), maxRuntimeMs);
  });
  let result;
  if (wrappedCmd.length > 0) {
    wrappedChild = spawn(wrappedCmd[0], wrappedCmd.slice(1), { stdio: "inherit" });
    record("wrapped-spawned", { pid: wrappedChild.pid, cmd: wrappedCmd });
    const wrappedDone = new Promise((resolveWrapped) => {
      wrappedChild.on("error", (err) => resolveWrapped({ kind: "wrapped-error", err }));
      wrappedChild.on("exit", (code, signal) =>
        resolveWrapped({ kind: "wrapped-exit", code, signal }),
      );
    });
    result = await Promise.race([wrappedDone, capTimer]);
    if (
      result.kind === "cap" &&
      wrappedChild.exitCode === null &&
      wrappedChild.signalCode === null
    ) {
      try {
        wrappedChild.kill("SIGTERM");
      } catch {
        // Already exiting.
      }
      // Poll the process table, not child.exitCode: the exit event cannot be
      // processed while we wait synchronously.
      const wrappedPid = wrappedChild.pid;
      const wrappedAlive = () => psSnapshot().some((r) => r.pid === wrappedPid);
      const wrappedDeadline = Date.now() + killWaitMs;
      while (wrappedAlive() && Date.now() < wrappedDeadline) sleepSync(50);
      if (wrappedAlive()) {
        try {
          wrappedChild.kill("SIGKILL");
        } catch {
          // Already exiting.
        }
      }
    }
  } else {
    const durationTimer = new Promise((resolveDur) => {
      setTimeout(() => resolveDur({ kind: "duration" }), durationMs);
    });
    result = await Promise.race([durationTimer, capTimer]);
  }

  if (earlyExits.length > 0 || leaderExitedEarly) {
    // Part of the owned tree died mid-run: the advertised load was not
    // delivered — fail loudly.
    record("load-degraded", { earlyExits, leaderExitedEarly });
    teardownSync("error");
    finalize("error", EXIT_ERROR);
    return;
  }
  if (result.kind === "cap") {
    record("max-runtime-cap", { maxRuntimeMs });
    teardownSync("timeout");
    finalize("timeout", EXIT_TIMEOUT);
  } else if (result.kind === "wrapped-error") {
    record("wrapped-error", { message: String(result.err) });
    teardownSync("error");
    finalize("error", EXIT_ERROR);
  } else if (result.kind === "wrapped-exit") {
    evidence.wrappedExit = { code: result.code, signal: result.signal };
    record("wrapped-exit", { code: result.code, signal: result.signal });
    teardownSync("completed");
    finalize("completed", typeof result.code === "number" ? result.code : EXIT_ERROR);
  } else {
    teardownSync("completed");
    finalize("completed", 0);
  }
}

// Terminate leftover marker processes one pid at a time (identity re-checked
// against a fresh snapshot immediately before each signal; pids never pass
// through a shell).
function reapSync(leftovers, graceMs, killWaitMs) {
  const pids = leftovers.map((r) => r.pid);
  const stillOurs = () => markerRows(psSnapshot()).filter((r) => pids.includes(r.pid));
  for (const r of stillOurs()) {
    try {
      process.kill(r.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  const graceDeadline = Date.now() + graceMs;
  let remaining = stillOurs();
  while (remaining.length > 0 && Date.now() < graceDeadline) {
    sleepSync(50);
    remaining = stillOurs();
  }
  if (remaining.length > 0) {
    for (const r of remaining) {
      try {
        process.kill(r.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    const killDeadline = Date.now() + killWaitMs;
    while (remaining.length > 0 && Date.now() < killDeadline) {
      sleepSync(50);
      remaining = stillOurs();
    }
  }
  return {
    terminated: pids.filter((p) => !remaining.some((r) => r.pid === p)),
    survivors: remaining.map((r) => r.pid),
  };
}

// ---------------------------------------------------------------------------
const rawArgs = process.argv.slice(2);
const dashDash = rawArgs.indexOf("--");
const optionArgs = dashDash === -1 ? rawArgs : rawArgs.slice(0, dashDash);
const wrappedCmd = dashDash === -1 ? [] : rawArgs.slice(dashDash + 1);

let opts;
try {
  ({ values: opts } = parseArgs({
    args: optionArgs,
    options: {
      workers: { type: "string" },
      duration: { type: "string" },
      "max-runtime": { type: "string" },
      grace: { type: "string" },
      "kill-wait": { type: "string" },
      nice: { type: "string" },
      "evidence-dir": { type: "string" },
      "reap-leftovers": { type: "boolean" },
      help: { type: "boolean" },
      // internal (leader/worker plumbing + test knobs)
      leader: { type: "boolean" },
      worker: { type: "boolean" },
      "run-id": { type: "string" },
      marker: { type: "string" },
      "deadline-epoch-ms": { type: "string" },
      "watchdog-ms": { type: "string" },
      "backstop-slack-ms": { type: "string" },
      "grace-ms": { type: "string" },
      "kill-wait-ms": { type: "string" },
      "controller-pid": { type: "string" },
    },
    allowPositionals: false,
  }));
} catch (err) {
  process.stderr.write(`[load-test] ${err.message}\n${USAGE}\n`);
  process.exit(EXIT_ERROR);
}

if (opts.help) {
  process.stdout.write(`${USAGE}\n`);
} else if (opts.worker) {
  runWorker(opts);
} else if (opts.leader) {
  runLeader(opts);
} else {
  try {
    await runController(opts, wrappedCmd);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`[load-test] ${err.message}\n${USAGE}\n`);
      process.exit(EXIT_ERROR);
    }
    throw err;
  }
}
