/**
 * Writer lock (WP-104, CAM-STATE-03): in-process contention, release
 * semantics, and the property the whole design leans on — a SIGKILLed
 * holder releases the lock by kernel guarantee, with zero cleanup code.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WriterLock, WriterLockHeldError } from "./writer-lock.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const HOLD_CHILD = fileURLToPath(new URL("./writer-lock.hold-child.ts", import.meta.url));

let dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-lock-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("WriterLock (in-process)", () => {
  it("holds after acquire and refuses a second acquire instantly", () => {
    const path = join(tempDir(), "writer-lock.sqlite");
    const lock = WriterLock.acquire(path);
    try {
      expect(lock.held).toBe(true);
      const started = Date.now();
      expect(() => WriterLock.acquire(path)).toThrow(WriterLockHeldError);
      // Fail-closed means fail FAST: a held lock refuses without waiting.
      expect(Date.now() - started).toBeLessThan(400);
    } finally {
      lock.release();
    }
  });

  it("release frees the lock for the next acquirer and is idempotent", () => {
    const path = join(tempDir(), "writer-lock.sqlite");
    const first = WriterLock.acquire(path);
    first.release();
    first.release(); // idempotent
    const second = WriterLock.acquire(path);
    expect(second.held).toBe(true);
    second.release();
  });

  it("assertHeld throws after release (stores surface the bug loudly)", () => {
    const path = join(tempDir(), "writer-lock.sqlite");
    const lock = WriterLock.acquire(path);
    lock.assertHeld("test append");
    lock.release();
    expect(lock.held).toBe(false);
    expect(() => lock.assertHeld("test append")).toThrow(/without the writer lock held/);
  });
});

describe("WriterLock (cross-process, the CAM-STATE-03 property)", () => {
  it("blocks a second process while held, and kill -9 releases it with no cleanup", async () => {
    const path = join(tempDir(), "writer-lock.sqlite");
    const child = spawn(process.execPath, ["--import", "tsx", HOLD_CHILD], {
      cwd: REPO_ROOT,
      env: { ...process.env, CAMINO_LOCK_PATH: path },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let out = "";
        const timer = setTimeout(
          () => reject(new Error(`hold-child never reported LOCK-HELD; stderr: ${stderr}`)),
          15_000,
        );
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          if (out.includes("LOCK-HELD")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on("exit", () => {
          clearTimeout(timer);
          reject(new Error(`hold-child exited early; stderr: ${stderr}`));
        });
      });

      // Another PROCESS holds it: acquisition here must refuse.
      expect(() => WriterLock.acquire(path)).toThrow(WriterLockHeldError);
    } finally {
      // kill -9 on EVERY path — a failed readiness wait must not leave a
      // live lock-holding child behind (round 3, finding 3). This is also
      // the test's real payload: no signal handler, no cleanup path,
      // nothing runs in the child.
      child.kill("SIGKILL");
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.on("exit", () => resolve());
    });

    // The kernel released the lock with the process; the successor acquires.
    const lock = WriterLock.acquire(path);
    expect(lock.held).toBe(true);
    lock.release();
  }, 30_000);
});
