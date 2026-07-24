// Regression proof for scripts/load-test.mjs (2026-07-22 orphaned-load
// incident remediation). Each case captures the owned pgid/pids from the
// evidence record, exercises one lifecycle path — normal completion, wrapped
// command, forced interruption (TERM/INT/HUP), controller SIGKILL, hard
// runtime cap, leftover preflight — and then proves, from the live process
// table, that every owned process exited, none survived as a PID-1 orphan,
// and a subsequent run can start clean. A worktree-scoped marker scan runs
// last in each case as a safety net, after the ownership-based assertions.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "load-test.mjs");
const repoMarker = `camino-load-test::${repoRoot}::`;

interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

interface Evidence {
  runId: string;
  ownership: { pgid: number | null; leaderPid: number | null; workerPids: number[] };
  phases: { type: string; [k: string]: unknown }[];
  outcome: {
    reason: string;
    cleanup: string;
    survivors: unknown[];
    safetyNetScan?: { matches: unknown[] };
  } | null;
  wrappedExit?: { code: number | null; signal: string | null };
}

function psRows(): PsRow[] {
  const out = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(out.status).toBe(0);
  const rows: PsRow[] = [];
  for (const line of out.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m || (m[4] ?? "").startsWith("Z")) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      command: m[5] ?? "",
    });
  }
  return rows;
}

const markerRows = () => psRows().filter((r) => r.command.includes(repoMarker));
const aliveOwned = (ev: Evidence) => {
  const pids = [ev.ownership.leaderPid, ...ev.ownership.workerPids];
  return psRows().filter((r) => pids.includes(r.pid) && r.pgid === ev.ownership.pgid);
};

async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  expect.fail(`timed out waiting for ${what}`);
}

function readEvidence(dir: string): Evidence | null {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const file = files[0];
  if (file === undefined) return null;
  expect(files.length).toBe(1);
  try {
    return JSON.parse(readFileSync(join(dir, file), "utf8")) as Evidence;
  } catch {
    return null; // mid-write; caller polls
  }
}

const evidenceReady = (dir: string): Evidence | null => {
  const ev = readEvidence(dir);
  return ev && ev.phases.some((p) => p.type === "ready") ? ev : null;
};

interface Run {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: string | null }>;
}

const running: ChildProcess[] = [];
const tmpDirs: string[] = [];

function startHelper(args: string[]): { run: Run; evidenceDir: string } {
  const evidenceDir = mkdtempSync(join(tmpdir(), "camino-load-ev-"));
  tmpDirs.push(evidenceDir);
  const child = spawn(process.execPath, [script, "--evidence-dir", evidenceDir, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.push(child);
  let out = "";
  let err = "";
  child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
  const exited = new Promise<{ code: number | null; signal: string | null }>((res) => {
    child.on("exit", (code, signal) => res({ code, signal }));
  });
  return { run: { child, stdout: () => out, stderr: () => err, exited }, evidenceDir };
}

async function runHelper(args: string[]) {
  const { run, evidenceDir } = startHelper(args);
  const exit = await run.exited;
  return { ...exit, run, evidenceDir };
}

// The core post-condition of every case: nothing owned is alive, nothing
// carrying this worktree's marker is alive, and in particular nothing marked
// survives as an orphan (the incident's leak state).
function expectNoResidue(ev: Evidence | null) {
  if (ev) expect(aliveOwned(ev)).toEqual([]);
  const leftover = markerRows();
  expect(leftover).toEqual([]);
  expect(leftover.filter((r) => r.ppid === 1)).toEqual([]);
}

afterEach(async () => {
  for (const c of running) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  running.length = 0;
  // Failsafe reap so one failing case cannot leak load into the next; the
  // helper's own cleanup is what the assertions above prove.
  for (const attempt of ["SIGTERM", "SIGKILL"] as const) {
    const rows = markerRows();
    if (rows.length === 0) break;
    for (const r of rows) {
      try {
        process.kill(r.pid, attempt);
      } catch {
        // already gone
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("load-test helper: ownership and cleanup (incident regression)", () => {
  it("normal completion: owned group recorded, every owned process exits, a second run starts clean", async () => {
    const first = await runHelper(["--workers", "3", "--duration", "500ms"]);
    expect(first.code).toBe(0);
    const ev = readEvidence(first.evidenceDir)!;
    expect(ev).not.toBeNull();

    // Ownership evidence: a dedicated group, leader is its leader, 3 workers.
    expect(ev.ownership.pgid).toBeGreaterThan(0);
    expect(ev.ownership.pgid).toBe(ev.ownership.leaderPid);
    expect(ev.ownership.workerPids).toHaveLength(3);

    // Cleanup was registered before the first spawn.
    const phaseTypes = ev.phases.map((p) => p.type);
    expect(phaseTypes.indexOf("cleanup-registered")).toBeGreaterThanOrEqual(0);
    expect(phaseTypes.indexOf("cleanup-registered")).toBeLessThan(
      phaseTypes.indexOf("leader-spawned"),
    );

    // Outcome evidence: verified-clean cleanup, empty safety-net scan.
    expect(ev.outcome?.reason).toBe("completed");
    expect(ev.outcome?.cleanup).toBe("verified-clean");
    expect(ev.outcome?.survivors).toEqual([]);
    expect(ev.outcome?.safetyNetScan?.matches).toEqual([]);
    expectNoResidue(ev);

    // A second test starts without encountering leftovers.
    const second = await runHelper(["--workers", "2", "--duration", "300ms"]);
    expect(second.code).toBe(0);
    expectNoResidue(readEvidence(second.evidenceDir));
  });

  it("wrapped command: load is live while it runs, its exit code propagates, cleanup still verifies", async () => {
    const { run, evidenceDir } = startHelper([
      "--workers",
      "2",
      "--",
      process.execPath,
      "-e",
      "setTimeout(() => process.exit(7), 1500)",
    ]);
    await waitFor(() => evidenceReady(evidenceDir) !== null, "ready evidence");
    const live = evidenceReady(evidenceDir)!;
    // While the wrapped command runs, every owned pid is alive in the owned
    // group and parented inside it — not to PID 1.
    const during = aliveOwned(live);
    expect(during.map((r) => r.pid).sort()).toEqual(
      [live.ownership.leaderPid!, ...live.ownership.workerPids].sort(),
    );
    for (const w of during.filter((r) => r.pid !== live.ownership.leaderPid)) {
      expect(w.ppid).toBe(live.ownership.leaderPid);
    }

    const exit = await run.exited;
    expect(exit.code).toBe(7);
    const ev = readEvidence(evidenceDir)!;
    expect(ev.wrappedExit?.code).toBe(7);
    expect(ev.outcome?.cleanup).toBe("verified-clean");
    expectNoResidue(ev);
  });

  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ] as const)(
    "forced interruption (%s): controlling process is signaled mid-load and every owned process exits",
    async (signal, expectedCode) => {
      const { run, evidenceDir } = startHelper(["--workers", "2", "--duration", "60s"]);
      await waitFor(() => evidenceReady(evidenceDir) !== null, "ready evidence");
      const live = evidenceReady(evidenceDir)!;
      // Load must actually be active before we interrupt.
      expect(aliveOwned(live).length).toBe(1 + live.ownership.workerPids.length);

      run.child.kill(signal);
      const exit = await run.exited;
      expect(exit.code).toBe(expectedCode);

      const ev = readEvidence(evidenceDir)!;
      expect(ev.outcome?.reason).toBe(`interrupted:${signal}`);
      expect(ev.outcome?.cleanup).toBe("verified-clean");
      expect(ev.outcome?.survivors).toEqual([]);
      expectNoResidue(ev);
    },
  );

  it("controller SIGKILL (cleanup cannot run): the leader's watchdog self-terminates the whole group", async () => {
    const { run, evidenceDir } = startHelper([
      "--workers",
      "2",
      "--duration",
      "60s",
      "--watchdog-ms",
      "100",
    ]);
    await waitFor(() => evidenceReady(evidenceDir) !== null, "ready evidence");
    const live = evidenceReady(evidenceDir)!;
    expect(aliveOwned(live).length).toBe(1 + live.ownership.workerPids.length);

    run.child.kill("SIGKILL");
    const exit = await run.exited;
    expect(exit.signal).toBe("SIGKILL");

    // No controller survives to clean up; the group must reap itself.
    await waitFor(() => aliveOwned(live).length === 0, "owned group self-termination", 8_000);
    expectNoResidue(live);
  });

  it("leader hard-deadline backstop: group dies even with the watchdog effectively disabled", async () => {
    // Watchdog interval far beyond the test window, so ONLY the leader's own
    // wall-clock deadline can terminate the group after the controller is gone.
    const { run, evidenceDir } = startHelper([
      "--workers",
      "2",
      "--max-runtime",
      "1500ms",
      "--backstop-slack-ms",
      "0",
      "--watchdog-ms",
      "60000",
      "--",
      process.execPath,
      "-e",
      "setTimeout(() => {}, 5000)",
    ]);
    await waitFor(() => evidenceReady(evidenceDir) !== null, "ready evidence");
    const live = evidenceReady(evidenceDir)!;
    expect(aliveOwned(live).length).toBe(1 + live.ownership.workerPids.length);
    run.child.kill("SIGKILL");
    await run.exited;
    await waitFor(() => aliveOwned(live).length === 0, "backstop group termination", 8_000);
    expectNoResidue(live);
  });

  it("hard runtime cap with a live controller: wrapped run is stopped, clean teardown, distinct exit code", async () => {
    const capped = await runHelper([
      "--workers",
      "2",
      "--max-runtime",
      "700ms",
      "--kill-wait",
      "500ms",
      "--",
      process.execPath,
      "-e",
      "setTimeout(() => {}, 60000)",
    ]);
    expect(capped.code).toBe(72);
    const ev = readEvidence(capped.evidenceDir)!;
    expect(ev.outcome?.reason).toBe("timeout");
    expect(ev.outcome?.cleanup).toBe("verified-clean");
    expectNoResidue(ev);
  });

  it("preflight: refuses to start over a leftover load process; --reap-leftovers recovers", async () => {
    // Simulate the incident's leak state: a marker-carrying worker orphaned
    // away from any controller (spawned via an intermediate that exits).
    const fakeMarker = `${repoMarker}fake-leak-${Date.now().toString(36)}`;
    const orphanOut = spawnSync(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process");
         const c = spawn(process.execPath, [process.argv[1], "--worker", "--marker", process.argv[2], "--deadline-epoch-ms", String(Date.now() + 60_000), "--nice", "0"], { detached: true, stdio: "ignore" });
         c.unref();
         console.log(c.pid);`,
        script,
        fakeMarker,
      ],
      { encoding: "utf8" },
    );
    expect(orphanOut.status).toBe(0);
    const orphanPid = Number(orphanOut.stdout.trim());
    expect(orphanPid).toBeGreaterThan(0);
    try {
      await waitFor(
        () => psRows().some((r) => r.pid === orphanPid && r.command.includes(fakeMarker)),
        "simulated leftover process",
      );

      const refused = await runHelper(["--workers", "1", "--duration", "300ms"]);
      expect(refused.code).toBe(71);
      expect(refused.run.stderr()).toContain(String(orphanPid));
      // Refusal must not have killed anything it does not own.
      expect(psRows().some((r) => r.pid === orphanPid)).toBe(true);

      const reaped = await runHelper(["--reap-leftovers", "--workers", "1", "--duration", "300ms"]);
      expect(reaped.code).toBe(0);
      expect(psRows().some((r) => r.pid === orphanPid && r.command.includes(fakeMarker))).toBe(
        false,
      );
      expectNoResidue(readEvidence(reaped.evidenceDir));
    } finally {
      try {
        process.kill(orphanPid, "SIGKILL");
      } catch {
        // already reaped — the expected case
      }
    }
  });
});
