/**
 * Production entry smoke test (WP-122, round 1 finding 1 regression): the
 * unit/HTTP/Playwright suites all compose the daemon via `startDaemonServer`
 * and never exercised `main()` — which registered a Fastify hook AFTER
 * `listen()` and crashed the real daemon on boot with
 * FST_ERR_INSTANCE_ALREADY_LISTENING. This test runs the ACTUAL entry as a
 * child process, so that class of "works in tests, dies in production" defect
 * is caught. It asserts the daemon boots, serves the ledger-backed register
 * under the auth token, and shuts down cleanly on SIGTERM (releasing its
 * writer lock — proven by a second boot in the same state dir succeeding).
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const GUI_ROOT = fileURLToPath(new URL("../../gui/static", import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const running: ChildProcessWithoutNullStreams[] = [];

function spawnDaemon(
  home: string,
  port: number,
): { proc: ChildProcessWithoutNullStreams; ready: Promise<string> } {
  const proc = spawn(process.execPath, ["--import", "tsx", MAIN], {
    env: {
      ...process.env,
      CAMINO_HOME: home,
      CAMINO_PORT: String(port),
      CAMINO_GUI_DIST: GUI_ROOT,
    },
  });
  running.push(proc);
  let out = "";
  const ready = new Promise<string>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      out += chunk.toString("utf8");
      if (out.includes("Camino daemon listening")) resolve(out);
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (codeVal) =>
      reject(new Error(`daemon exited before listening (code ${codeVal}); output:\n${out}`)),
    );
  });
  return { proc, ready };
}

/**
 * Boot the real entry, retrying on an early EADDRINUSE exit: this suite runs
 * alongside many other tests that bind ephemeral ports, so a pre-selected free
 * port can be taken in the window before the child binds. Retrying with a fresh
 * port keeps the smoke test about main()'s WIRING, not port luck.
 */
async function boot(home: string): Promise<{ proc: ChildProcessWithoutNullStreams; port: number }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await freePort();
    const { proc, ready } = spawnDaemon(home, port);
    try {
      await ready;
      return { proc, port };
    } catch (error) {
      await stop(proc);
      if (attempt === 4 || !String(error).includes("already in use")) throw error;
    }
  }
  throw new Error("unreachable");
}

async function stop(proc: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (proc.exitCode !== null) return proc.exitCode;
  const exited = new Promise<number | null>((resolve) => proc.on("exit", (c) => resolve(c)));
  proc.kill("SIGTERM");
  return exited;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((p) => stop(p)));
});

describe("production daemon entry (main.ts)", () => {
  it("boots, serves the ledger-backed register, and stops cleanly on SIGTERM", async () => {
    const home = mkdtempSync(`${tmpdir()}/camino-main-`);
    const { proc, port } = await boot(home);

    // The register is reachable under the token from the 0600 file main writes.
    const token = readFileSync(`${home}/auth-token`, "utf8").trim();
    const response = await fetch(`http://127.0.0.1:${port}/api/register`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // Honest until repo-head tracking lands: available:false, not a crash.
    expect(body).toHaveProperty("available");

    const exitCode = await stop(proc);
    expect(exitCode).toBe(0);

    // The writer lock was released on shutdown: a second boot in the SAME
    // state dir succeeds (a leaked lock would refuse to start).
    const second = await boot(home);
    expect(await stop(second.proc)).toBe(0);
  }, 45_000);
});
