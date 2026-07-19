/**
 * GUI serving tests (WP-102, CAM-CORE-01 "serves the GUI"): the daemon serves
 * the GUI build directory with restrictive response headers, falls back to the
 * app shell for unknown GUI routes, refuses path escapes out of the build
 * directory, and serves the REAL @camino/gui build output end-to-end.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { homedir, tmpdir } from "node:os";
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

/**
 * Round-2 regressions: a GUI build directory that is not a plain, contained
 * tree (a symlink used as a file OR as the directory index) is refused at
 * startup and served as 503 — never disclosing the symlink's target (finding
 * 1). Hidden files inside a plain tree are not served (finding 3).
 */
describe("round 2 regressions — GUI build containment", () => {
  function makeGui(build: (dist: string, scratch: string) => void): {
    gui: string;
    scratch: string;
  } {
    const scratch = mkdtempSync(join(tmpdir(), "camino-r2-static-"));
    const gui = join(scratch, "dist");
    mkdirSync(gui);
    build(gui, scratch);
    return { gui, scratch };
  }

  it("finding 1: a symlinked directory index does not disclose its target (served 503)", async () => {
    const secret = `index-secret-${generateToken()}`;
    const { gui } = makeGui((dist, scratch) => {
      writeFileSync(join(scratch, "outside.html"), secret);
      symlinkSync(join(scratch, "outside.html"), join(dist, "index.html"));
    });
    const daemon = await startDaemonServer({ token: TOKEN, guiRoot: gui, port: 0 });
    try {
      const response = await fetch(`${daemon.url}/`);
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(body).toContain("gui-build-invalid");
      expect(body).not.toContain(secret);
    } finally {
      await daemon.app.close();
    }
  });

  it("finding 1: an in-tree symlink invalidates the tree; its target is never served", async () => {
    const secret = `leak-secret-${generateToken()}`;
    const { gui } = makeGui((dist, scratch) => {
      writeFileSync(join(dist, "index.html"), "<title>shell</title>");
      writeFileSync(join(scratch, "outside.txt"), secret);
      symlinkSync(join(scratch, "outside.txt"), join(dist, "leak.txt"));
    });
    const daemon = await startDaemonServer({ token: TOKEN, guiRoot: gui, port: 0 });
    try {
      for (const path of ["/", "/leak.txt"]) {
        const response = await fetch(`${daemon.url}${path}`);
        expect(response.status, path).toBe(503);
        expect(await response.text(), path).not.toContain(secret);
      }
    } finally {
      await daemon.app.close();
    }
  });

  it("finding 1: a symlinked SUBDIRECTORY escaping the root is refused", async () => {
    const secret = `subdir-secret-${generateToken()}`;
    const { gui } = makeGui((dist, scratch) => {
      writeFileSync(join(dist, "index.html"), "<title>shell</title>");
      const outsideDir = join(scratch, "outside-dir");
      mkdirSync(outsideDir);
      writeFileSync(join(outsideDir, "secret.txt"), secret);
      symlinkSync(outsideDir, join(dist, "assets"));
    });
    const daemon = await startDaemonServer({ token: TOKEN, guiRoot: gui, port: 0 });
    try {
      const response = await fetch(`${daemon.url}/assets/secret.txt`);
      expect(await response.text()).not.toContain(secret);
    } finally {
      await daemon.app.close();
    }
  });

  it("finding 3: hidden files inside a plain tree are not served", async () => {
    const secret = `dotfile-secret-${generateToken()}`;
    const { gui } = makeGui((dist) => {
      writeFileSync(join(dist, "index.html"), "<title>shell</title>");
      writeFileSync(join(dist, ".secret"), secret);
      mkdirSync(join(dist, ".hidden"));
      writeFileSync(join(dist, ".hidden", "secret.txt"), secret);
    });
    const daemon = await startDaemonServer({ token: TOKEN, guiRoot: gui, port: 0 });
    try {
      for (const path of ["/.secret", "/.hidden/secret.txt"]) {
        const response = await fetch(`${daemon.url}${path}`);
        expect(response.status, path).not.toBe(200);
        expect(await response.text(), path).not.toContain(secret);
      }
    } finally {
      await daemon.app.close();
    }
  });

  it("a plain, contained tree still serves normally (no false invalidation)", async () => {
    const { gui } = makeGui((dist) => {
      writeFileSync(join(dist, "index.html"), "<title>SHELL_OK</title>");
      mkdirSync(join(dist, "assets"));
      writeFileSync(join(dist, "assets", "app.js"), "1;");
    });
    const daemon = await startDaemonServer({ token: TOKEN, guiRoot: gui, port: 0 });
    try {
      expect(await (await fetch(`${daemon.url}/`)).text()).toContain("SHELL_OK");
      expect((await fetch(`${daemon.url}/assets/app.js`)).status).toBe(200);
      // SPA fallback still contained.
      expect(await (await fetch(`${daemon.url}/some/spa/route`)).text()).toContain("SHELL_OK");
    } finally {
      await daemon.app.close();
    }
  });

  it("finding 3: rebinding a symlinked GUI root after startup does not change what is served", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "camino-root-rebind-"));
    const targetA = join(scratch, "a");
    const targetB = join(scratch, "b");
    mkdirSync(targetA);
    mkdirSync(targetB);
    writeFileSync(join(targetA, "index.html"), "<title>SHELL_A</title>");
    const secret = `rebind-secret-${generateToken()}`;
    writeFileSync(join(targetB, "index.html"), `<title>${secret}</title>`);
    writeFileSync(join(targetB, "loot.txt"), secret);
    const rootLink = join(scratch, "root");
    symlinkSync(targetA, rootLink);

    const daemon = await startDaemonServer({ token: TOKEN, guiRoot: rootLink, port: 0 });
    try {
      expect(await (await fetch(`${daemon.url}/`)).text()).toContain("SHELL_A");
      // Rebind the root symlink to a pre-existing dir NOT modified after startup.
      rmSync(rootLink);
      symlinkSync(targetB, rootLink);
      expect(await (await fetch(`${daemon.url}/`)).text()).toContain("SHELL_A");
      expect(await (await fetch(`${daemon.url}/loot.txt`)).text()).not.toContain(secret);
    } finally {
      await daemon.app.close();
    }
  });

  it("finding 8: a hardlink whose inode is named outside the tree invalidates it", async () => {
    const secret = `hardlink-secret-${generateToken()}`;
    const { gui } = makeGui((dist, scratch) => {
      writeFileSync(join(dist, "index.html"), "<title>shell</title>");
      writeFileSync(join(scratch, "outside.txt"), secret);
      linkSync(join(scratch, "outside.txt"), join(dist, "hard.txt")); // hardlink, nlink=2
    });
    const daemon = await startDaemonServer({ token: TOKEN, guiRoot: gui, port: 0 });
    try {
      for (const path of ["/", "/hard.txt"]) {
        const response = await fetch(`${daemon.url}${path}`);
        expect(response.status, path).toBe(503);
        expect(await response.text(), path).not.toContain(secret);
      }
    } finally {
      await daemon.app.close();
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

  it("finding 6: the build refuses a dangerous OUT_DIR instead of wiping it", () => {
    const buildScript = fileURLToPath(new URL("../../gui/build.mjs", import.meta.url));
    // A directory with a sentinel that must survive a refused build.
    const guard = mkdtempSync(join(tmpdir(), "camino-outdir-guard-"));
    const sentinel = join(guard, "sentinel.txt");
    writeFileSync(sentinel, "keep me");

    for (const dangerous of ["/", homedir()]) {
      let threw = false;
      try {
        execFileSync(process.execPath, [buildScript], {
          env: { ...process.env, OUT_DIR: dangerous },
          stdio: "pipe",
        });
      } catch {
        threw = true;
      }
      expect(threw, `OUT_DIR=${dangerous} should be refused`).toBe(true);
    }
    // The refusal never ran rmSync; unrelated files are untouched.
    expect(existsSync(sentinel)).toBe(true);
  });
});
