#!/usr/bin/env node
// A fake headless coding CLI, standing in for a real vendor CLI so the dispatch
// lifecycle (spawn / stream / cancel / kill-confirm / cleanup / quota-classify)
// can be exercised in CI with ZERO subscription quota. Behavior via MOCK_MODE:
//
//   solve   (default) — emit streaming-JSON events, create GREETING.txt, git
//                        commit it, emit a result event, exit 0.
//   hang              — spawn a `sleep` grandchild, IGNORE SIGTERM, stream
//                        forever → forces SIGKILL escalation and proves the
//                        whole process TREE is cleaned up.
//   graceful-cancel   — on SIGTERM, stop cleanly within the grace window.
//   quota             — emit a rate-limit event and exit nonzero.
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.MOCK_MODE ?? "solve";
const emit = (type, text) => process.stdout.write(JSON.stringify({ type, text }) + "\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  spawn("sh", ["-c", 'trap "" TERM; while :; do sleep 1; done'], { stdio: "ignore" });
  process.on("SIGTERM", () => process.exit(0)); // leader exits on TERM
  // Give the descendant a beat to install its trap before work "starts", so a
  // cancel arriving shortly after the first event hits a ready descendant.
  setTimeout(() => {
    emit("assistant", "spawned a SIGTERM-ignoring descendant");
    setInterval(() => emit("other", "leader alive"), 200);
  }, 150);
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
