/**
 * Production entry smoke test (WP-122, round 1 finding 1 regression): the
 * unit/HTTP/Playwright suites all compose the daemon via `startDaemonServer`
 * and never exercised `main()` — which registered a Fastify hook AFTER
 * `listen()` and crashed the real daemon on boot with
 * FST_ERR_INSTANCE_ALREADY_LISTENING. This test runs the ACTUAL entry as a
 * child process and asserts it BOOTS and SERVES the ledger-backed register —
 * a crash-on-boot never reaches a 200. That is the whole regression.
 *
 * SCOPE, deliberately narrow: this test does NOT assert signal/exit-code
 * semantics. A SIGTERM-clean-exit assertion proved unreliable in Linux CI
 * containers (signal delivery + process reaping timing), which is a property
 * of the container, not of main(). The teardown WIRING main.ts depends on —
 * the onClose hook fires on close, registered before listen — is guarded
 * deterministically and signal-free in server-register.test.ts; the
 * force-exit-on-stop behavior is a plain timer in main.ts. Here we only prove
 * the entry point runs; cleanup SIGKILLs the child unconditionally.
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
 * port can be taken in the window before the child binds. Retrying keeps the
 * smoke test about main()'s WIRING, not port luck.
 */
async function boot(home: string): Promise<{ proc: ChildProcessWithoutNullStreams; port: number }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await freePort();
    const { proc, ready } = spawnDaemon(home, port);
    try {
      await ready;
      return { proc, port };
    } catch (error) {
      proc.kill("SIGKILL");
      if (attempt === 4 || !String(error).includes("already in use")) throw error;
    }
  }
  throw new Error("unreachable");
}

afterEach(() => {
  for (const proc of running.splice(0)) proc.kill("SIGKILL");
});

describe("production daemon entry (main.ts)", () => {
  it("boots and serves the ledger-backed register (a boot crash never reaches 200)", async () => {
    const home = mkdtempSync(`${tmpdir()}/camino-main-`);
    const { port } = await boot(home);

    // The register is reachable under the token from the 0600 file main writes.
    // The pre-fold defect (onClose registered after listen) crashed the process
    // during startup, so it never served this.
    const token = readFileSync(`${home}/auth-token`, "utf8").trim();
    const response = await fetch(`http://127.0.0.1:${port}/api/register`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // Honest until repo-head tracking lands: available:false, not a crash.
    expect(body).toHaveProperty("available");
  }, 30_000);
});
