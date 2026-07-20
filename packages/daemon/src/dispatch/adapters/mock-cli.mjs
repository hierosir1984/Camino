#!/usr/bin/env node
// A fake headless coding CLI, standing in for a real vendor CLI so the dispatch
// lifecycle (spawn / stream / cancel / kill-confirm / cleanup / quota-classify
// / lease settlement) can be exercised in CI with ZERO subscription quota.
// Behavior via MOCK_MODE:
//
//   solve   (default)   — emit streaming-JSON events, create GREETING.txt, git
//                         commit it, emit a result event, exit 0.
//   hang                — spawn a `sleep` grandchild, IGNORE SIGTERM, stream
//                         forever → forces SIGKILL escalation and proves the
//                         whole process GROUP is cleaned up.
//   orphan              — leader exits on SIGTERM while a descendant ignores
//                         it → proves group-gated SIGKILL escalation.
//   grace-descendant    — leader exits instantly, descendant needs ~200ms →
//                         proves the full grace window (no premature SIGKILL).
//   linger-descendant   — leader exits 0 SUCCESSFULLY leaving a background
//                         descendant running → proves the post-exit group
//                         sweep (a finished dispatch must not leak workers).
//   graceful-cancel     — on SIGTERM, stop cleanly within the grace window.
//   quota               — emit a rate-limit event and exit nonzero.
//   quota-raw           — rate-limit signal on a non-JSON line only.
//   flood               — emit MOCK_FLOOD events (bounded-retention test).
//
// Every mode writes its pid to `.mock-pid` in the workspace at startup: the
// leader is the group leader (detached spawn), so tests can probe
// kill(-pid, 0) themselves to verify the whole group is genuinely gone —
// independent corroboration of the lifecycle's own group-gone claim.
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.MOCK_MODE ?? "solve";
const emit = (type, text) => process.stdout.write(JSON.stringify({ type, text }) + "\n");
// Synchronous emit: blocks until the bytes are delivered, so a following
// process.exit() cannot truncate them (process.exit does NOT drain stdout).
const emitSync = (type, text) => writeSync(1, JSON.stringify({ type, text }) + "\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

writeFileSync(join(process.cwd(), ".mock-pid"), String(process.pid));

if (mode === "hang") {
  // Grandchild so cancellation must kill the whole group, not just this pid.
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  process.on("SIGTERM", () => emit("other", "ignoring SIGTERM"));
  emit("assistant", "starting long task");
  // Keep the event loop alive indefinitely.
  setInterval(() => emit("other", "still working"), 200);
  // Reference child so it isn't GC'd; it dies with the group on SIGKILL.
  void child;
} else if (mode === "orphan") {
  // The nastier case (WP-001 review #1): the LEADER exits cleanly on SIGTERM,
  // but a descendant IGNORES SIGTERM. A leader-only wait would skip SIGKILL and
  // orphan the descendant; correct kill-confirm must SIGKILL the whole group.
  // The descendant uses a shell `trap` — installed synchronously at startup,
  // unlike a node SIGTERM handler that races process boot.
  //
  // Readiness handshake: the descendant writes a marker file only AFTER its
  // trap is active, and the leader emits nothing until the marker exists. The
  // test keys its cancel off the first event, so SIGTERM cannot arrive before
  // the descendant is actually ignoring it. (A fixed pre-event delay lost this
  // race on a loaded host: sh's fork/exec outran the budget, the descendant
  // died with the group, and no SIGKILL escalation was observed.)
  const marker = join(process.cwd(), ".orphan-descendant-ready");
  spawn("sh", ["-c", `trap "" TERM; : > "${marker}"; while :; do sleep 1; done`], {
    stdio: "ignore",
  });
  process.on("SIGTERM", () => process.exit(0)); // leader exits on TERM
  const gateStart = Date.now();
  const gate = setInterval(() => {
    // Cap the wait so a failed descendant spawn surfaces as a loud assertion
    // failure (no escalation recorded) instead of a hung dispatch.
    if (!existsSync(marker) && Date.now() - gateStart < 10_000) return;
    clearInterval(gate);
    emit("assistant", "spawned a SIGTERM-ignoring descendant");
    setInterval(() => emit("other", "leader alive"), 200);
  }, 10);
} else if (mode === "grace-descendant") {
  // Cooperative-but-slow descendant: the leader exits immediately on SIGTERM,
  // but a descendant takes ~200ms to shut down. With enough grace, NO SIGKILL
  // should fire — the descendant must get the full grace window, not be killed
  // the instant the leader exits (WP-001 review #1-new).
  spawn("sh", ["-c", 'trap "sleep 0.2; exit 0" TERM; while :; do sleep 1; done'], {
    stdio: "ignore",
  });
  process.on("SIGTERM", () => process.exit(0));
  setTimeout(() => {
    emit("assistant", "spawned a cooperative-but-slow descendant");
    setInterval(() => emit("other", "leader alive"), 200);
  }, 150);
} else if (mode === "linger-descendant") {
  // Natural-success leak case (WP-105): the leader finishes its work and exits
  // 0, but a background descendant it started is still running in the group.
  // Without the post-exit sweep the descendant outlives the dispatch — and a
  // lease released at that moment would have two effective owners of one
  // environment. The descendant traps TERM and exits promptly (cooperative),
  // so the sweep should confirm group-gone WITHOUT SIGKILL escalation.
  const marker = join(process.cwd(), ".linger-descendant-ready");
  spawn("sh", ["-c", `trap "exit 0" TERM; : > "${marker}"; while :; do sleep 1; done`], {
    stdio: "ignore",
  });
  const gateStart = Date.now();
  const gate = setInterval(() => {
    if (!existsSync(marker) && Date.now() - gateStart < 10_000) return;
    clearInterval(gate);
    emitSync("assistant", "work done; a background descendant is still running");
    emitSync("result", "finished while leaving a lingering descendant");
    process.exit(0);
  }, 10);
} else if (mode === "graceful-cancel") {
  let stop = false;
  process.on("SIGTERM", () => {
    stop = true;
  });
  emit("assistant", "starting cancellable task");
  const loop = async () => {
    while (!stop) {
      emit("other", "tick");
      await sleep(100);
    }
    emit("result", "cancelled cleanly");
    process.exit(0);
  };
  void loop();
} else if (mode === "quota") {
  emit("assistant", "attempting");
  emit("error", "429 rate_limit_exceeded: usage limit reached, retry later");
  process.exit(3);
} else if (mode === "quota-raw") {
  // A quota signal on a single NON-JSON line: the mock adapter's own non-JSON
  // (error-context) branch classifies it — the lifecycle has NO raw-line scan
  // (removed in round 3; round-4 finding 2 scoped dropped-line protection to
  // the parsers' error channels).
  process.stdout.write("provider error: 429 rate_limit_exceeded, retry later\n");
  process.exit(4);
} else if (mode === "flood") {
  // Emit many events to exercise the bounded retention cap. Synchronous writes
  // so process.exit() below can't truncate the stream (deterministic count
  // across platforms — CI caught the async-flush truncation).
  const n = Number(process.env.MOCK_FLOOD ?? "500");
  for (let i = 0; i < n; i++) emitSync("other", `event ${i}`);
  emitSync("result", "done flooding");
  process.exit(0);
} else {
  // solve
  emit("assistant", "I will create GREETING.txt");
  emit("tool", "write GREETING.txt");
  writeFileSync(join(process.cwd(), "GREETING.txt"), "hello from mock adapter\n");
  const git = (...a) =>
    execFileSync("git", ["-C", process.cwd(), ...a], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  try {
    git("add", "GREETING.txt");
    git("commit", "--quiet", "-m", "Add GREETING.txt (mock dispatch)");
    emit("result", "committed GREETING.txt");
  } catch {
    emit("result", "wrote GREETING.txt (no commit)");
  }
  process.exit(0);
}
