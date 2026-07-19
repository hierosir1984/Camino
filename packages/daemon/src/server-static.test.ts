/**
 * GUI serving tests (WP-102, CAM-CORE-01 "serves the GUI"): the daemon serves
 * the GUI build directory with restrictive response headers, falls back to the
 * app shell for unknown GUI routes, refuses path escapes out of the build
 * directory, and serves the REAL @camino/gui build output end-to-end.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startDaemonServer } from "./server.js";
import type { RunningDaemon } from "./server.js";
import { generateToken } from "./token.js";

const TOKEN = generateToken();

let scratch: string;
let guiRoot: string;
let sentinelBody: string;
let daemon: RunningDaemon;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "camino-static-"));
  guiRoot = join(scratch, "dist");
  mkdirSync(guiRoot);
  writeFileSync(
    join(guiRoot, "index.html"),
    "<!doctype html><title>Camino fixture shell</title><p>shell</p>",
  );
  writeFileSync(join(guiRoot, "app.js"), "console.log('fixture');\n");
  // A file OUTSIDE the served directory: reachable only via a path escape.
  sentinelBody = `sentinel-${generateToken()}`;
  writeFileSync(join(scratch, "outside.txt"), sentinelBody);
  daemon = await startDaemonServer({ token: TOKEN, guiRoot, port: 0 });
});

afterAll(async () => {
  await daemon.app.close();
});

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${daemon.url}${path}`, { headers, redirect: "manual" });

describe("GUI serving", () => {
  it("serves the app shell at / with restrictive headers", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Camino fixture shell");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("serves assets and applies the same headers", async () => {
    const response = await get("/app.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("falls back to the app shell for unknown GUI routes (single-page app)", async () => {
    const response = await get("/missions/some-future-route");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Camino fixture shell");
  });

  it("keeps /api out of the shell fallback: unknown API routes are JSON 404", async () => {
    const response = await get("/api/does-not-exist", { authorization: `Bearer ${TOKEN}` });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).toContain("not-found");
  });

  it("does not serve files outside the GUI build directory", async () => {
    // fetch() normalizes dot segments away client-side; send the raw request
    // line via node:http so the server itself sees each spelling.
    const rawGet = (path: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port: daemon.port, path }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });
        req.on("error", reject);
        req.end();
      });
    for (const path of [
      "/../outside.txt",
      "/..%2foutside.txt",
      "/%2e%2e/outside.txt",
      "/%2e%2e%2foutside.txt",
      "/assets/../../outside.txt",
      "/assets/..%2f..%2foutside.txt",
    ]) {
      expect(await rawGet(path), path).not.toContain(sentinelBody);
    }
  });

  it("finding 3: does not disclose a file reached by a symlink out of the build dir", async () => {
    // @fastify/static follows symlinks; the allowedPath realpath check must
    // refuse a link that resolves outside the build root.
    const linked = mkdtempSync(join(tmpdir(), "camino-symlink-"));
    const linkedGui = join(linked, "dist");
    mkdirSync(linkedGui);
    writeFileSync(join(linkedGui, "index.html"), "<title>linked shell</title>");
    const secret = `symlink-secret-${generateToken()}`;
    writeFileSync(join(linked, "outside.txt"), secret);
    symlinkSync(join(linked, "outside.txt"), join(linkedGui, "leak.txt"));
    symlinkSync(join(linked, "outside.txt"), join(linkedGui, "leak.html"));

    const linkedDaemon = await startDaemonServer({ token: TOKEN, guiRoot: linkedGui, port: 0 });
    try {
      for (const path of ["/leak.txt", "/leak.html"]) {
        const response = await fetch(`${linkedDaemon.url}${path}`);
        expect(await response.text(), path).not.toContain(secret);
      }
    } finally {
      await linkedDaemon.app.close();
    }
  });

  it("answers 503 with a build hint when the GUI build is absent", async () => {
    const bare = await startDaemonServer({ token: TOKEN, port: 0 });
    try {
      const response = await fetch(`${bare.url}/`);
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("gui-build-missing");
    } finally {
      await bare.app.close();
    }
  });
});

describe("real GUI build end-to-end", () => {
  it("builds @camino/gui and serves the produced dist", async () => {
    const buildScript = fileURLToPath(new URL("../../gui/build.mjs", import.meta.url));
    const out = join(mkdtempSync(join(tmpdir(), "camino-gui-build-")), "dist");
    execFileSync(process.execPath, [buildScript], {
      env: { ...process.env, OUT_DIR: out },
      stdio: "pipe",
    });

    const real = await startDaemonServer({ token: TOKEN, guiRoot: out, port: 0 });
    try {
      const page = await fetch(`${real.url}/`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("Camino");
      expect(html).toContain("/app.js");

      for (const asset of ["/app.js", "/style.css"]) {
        const response = await fetch(`${real.url}${asset}`);
        expect(response.status, asset).toBe(200);
      }
    } finally {
      await real.app.close();
    }
  });
});
