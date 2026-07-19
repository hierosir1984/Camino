/**
 * Request-policy tests (WP-102, CAM-CORE-01) against a genuinely listening
 * loopback server — inject() would fake away exactly the properties under
 * test. Raw node:http requests are used so every header (Host, Origin,
 * Authorization) is fully controlled, free of fetch()'s header restrictions.
 *
 * Pinned properties:
 *  - /api requests without (or with a wrong) token are rejected;
 *  - state-changing requests without the CSRF token are rejected, INCLUDING
 *    on unrouted paths — enforcement runs before route matching, so a future
 *    route cannot forget to opt in;
 *  - cross-origin state-changing requests are rejected outright;
 *  - requests carrying a foreign Host authority are rejected;
 *  - no CORS grant is ever emitted.
 */
import { request as httpRequest } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildServer, startDaemonServer } from "./server.js";
import type { RunningDaemon } from "./server.js";
import { generateToken } from "./token.js";

const TOKEN = generateToken();

interface RawResponse {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
}

interface RawRequestOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  /** Replace the Host header (default: the daemon's own authority). */
  hostHeader?: string;
  omitHost?: boolean;
  body?: string;
}

function rawRequest(port: number, options: RawRequestOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.hostHeader !== undefined) headers["host"] = options.hostHeader;
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path,
        headers,
        setHost: options.omitHost !== true && options.hostHeader === undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const authed = (extra: Record<string, string> = {}): Record<string, string> => ({
  authorization: `Bearer ${TOKEN}`,
  ...extra,
});

let guiFixture: string;
let daemon: RunningDaemon;
const extraDaemons: RunningDaemon[] = [];

async function fetchCsrfToken(): Promise<string> {
  const response = await rawRequest(daemon.port, { path: "/api/csrf", headers: authed() });
  expect(response.status).toBe(200);
  return (JSON.parse(response.body) as { csrfToken: string }).csrfToken;
}

beforeAll(async () => {
  guiFixture = mkdtempSync(join(tmpdir(), "camino-gui-fixture-"));
  writeFileSync(join(guiFixture, "index.html"), "<!doctype html><title>Camino fixture</title>");
  writeFileSync(join(guiFixture, "app.js"), "console.log('fixture');\n");
  daemon = await startDaemonServer({ token: TOKEN, guiRoot: guiFixture, port: 0 });
  return async () => {
    await daemon.app.close();
  };
});

afterEach(async () => {
  for (const extra of extraDaemons.splice(0)) {
    await extra.app.close().catch(() => undefined);
  }
});

describe("token auth on /api", () => {
  it("rejects an /api request without the token", async () => {
    const response = await rawRequest(daemon.port, { path: "/api/health" });
    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("Bearer");
  });

  it("rejects a wrong token and a malformed Authorization header", async () => {
    // (A trailing space after the token is not probed: HTTP servers strip
    // optional whitespace around header values at the protocol layer.)
    for (const authorization of [
      `Bearer ${generateToken()}`,
      `Bearer  ${TOKEN}`,
      TOKEN,
      `Basic ${TOKEN}`,
      "Bearer",
    ]) {
      const response = await rawRequest(daemon.port, {
        path: "/api/health",
        headers: { authorization },
      });
      expect(response.status, authorization).toBe(401);
    }
  });

  it("accepts the token from the token file flow", async () => {
    const response = await rawRequest(daemon.port, { path: "/api/health", headers: authed() });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: "ok" });
  });

  it("requires the token on percent-encoded spellings of /api paths", async () => {
    const response = await rawRequest(daemon.port, { path: "/%61pi/health" });
    expect(response.status).toBe(401);
  });

  it("refuses malformed paths outright", async () => {
    for (const path of ["/%zz", "/api\\health"]) {
      const response = await rawRequest(daemon.port, { path });
      expect([400, 401]).toContain(response.status);
      expect(response.status, path).not.toBe(200);
    }
  });
});

describe("CSRF on state-changing requests", () => {
  it("rejects a state-changing request without the CSRF token, even with a valid auth token", async () => {
    const response = await rawRequest(daemon.port, {
      method: "POST",
      path: "/api/shutdown",
      headers: authed(),
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain("csrf");
  });

  it("rejects a wrong CSRF token", async () => {
    const response = await rawRequest(daemon.port, {
      method: "POST",
      path: "/api/shutdown",
      headers: authed({ "x-camino-csrf": generateToken() }),
    });
    expect(response.status).toBe(403);
  });

  it("enforces CSRF before route matching — unrouted /api paths are rejected 403, not 404", async () => {
    const response = await rawRequest(daemon.port, {
      method: "POST",
      path: "/api/does-not-exist",
      headers: authed(),
    });
    expect(response.status).toBe(403);
  });

  it("enforces CSRF on state-changing requests outside /api too", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await rawRequest(daemon.port, { method, path: "/anywhere" });
      expect(response.status, method).toBe(403);
    }
  });

  it("safe methods need no CSRF token", async () => {
    const response = await rawRequest(daemon.port, { path: "/" });
    expect(response.status).toBe(200);
  });
});

describe("cross-origin requests (acceptance: cross-origin state-changing request rejected)", () => {
  it("rejects a cross-origin state-changing request without the CSRF token", async () => {
    const response = await rawRequest(daemon.port, {
      method: "POST",
      path: "/api/shutdown",
      headers: authed({ origin: "http://other.example" }),
    });
    expect(response.status).toBe(403);
  });

  it("rejects a cross-origin state-changing request even when it carries valid tokens", async () => {
    const csrf = await fetchCsrfToken();
    const response = await rawRequest(daemon.port, {
      method: "POST",
      path: "/api/shutdown",
      headers: authed({ origin: "http://other.example", "x-camino-csrf": csrf }),
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain("origin");
  });

  it("rejects the opaque 'null' origin (sandboxed and file: pages)", async () => {
    const response = await rawRequest(daemon.port, {
      method: "POST",
      path: "/api/shutdown",
      headers: authed({ origin: "null" }),
    });
    expect(response.status).toBe(403);
  });

  it("rejects a same-host wrong-port origin", async () => {
    const response = await rawRequest(daemon.port, {
      method: "POST",
      path: "/api/shutdown",
      headers: authed({ origin: `http://127.0.0.1:${daemon.port + 1}` }),
    });
    expect(response.status).toBe(403);
  });

  it("never emits a CORS grant, so cross-origin pages cannot read responses", async () => {
    const plain = await rawRequest(daemon.port, {
      path: "/",
      headers: { origin: "http://other.example" },
    });
    expect(plain.status).toBe(403);
    expect(plain.headers["access-control-allow-origin"]).toBeUndefined();

    const preflight = await rawRequest(daemon.port, {
      method: "OPTIONS",
      path: "/api/shutdown",
      headers: {
        origin: "http://other.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,x-camino-csrf",
      },
    });
    expect(preflight.status).toBe(403);
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    expect(preflight.headers["access-control-allow-headers"]).toBeUndefined();
  });

  it("accepts the daemon's own origin on the full flow, and shutdown stops the daemon", async () => {
    const dedicated = await startDaemonServer({ token: TOKEN, guiRoot: guiFixture, port: 0 });
    extraDaemons.push(dedicated);
    const csrfResponse = await rawRequest(dedicated.port, {
      path: "/api/csrf",
      headers: authed(),
    });
    const csrf = (JSON.parse(csrfResponse.body) as { csrfToken: string }).csrfToken;

    const response = await rawRequest(dedicated.port, {
      method: "POST",
      path: "/api/shutdown",
      headers: authed({
        origin: `http://127.0.0.1:${dedicated.port}`,
        "x-camino-csrf": csrf,
      }),
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ stopping: true });

    // The daemon closes its listener; new connections must start failing.
    // Poll rather than assume timing — this machine may be under sibling load.
    const deadline = Date.now() + 10_000;
    let refused = false;
    while (!refused && Date.now() < deadline) {
      try {
        await rawRequest(dedicated.port, { path: "/" });
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        refused = true;
      }
    }
    expect(refused).toBe(true);
  });
});

describe("Host authority", () => {
  it("rejects requests addressed to a foreign Host authority", async () => {
    const response = await rawRequest(daemon.port, {
      path: "/api/health",
      headers: authed(),
      hostHeader: `other.example:${daemon.port}`,
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain("host");
  });

  it("rejects requests without any Host header", async () => {
    // Node's HTTP layer itself refuses host-less HTTP/1.1 with 400 before the
    // policy hook can 403 — either way the request is refused, which is the
    // pinned property.
    const response = await rawRequest(daemon.port, {
      path: "/",
      omitHost: true,
    });
    expect([400, 403]).toContain(response.status);
  });

  it("accepts localhost:port as the daemon's own authority", async () => {
    const response = await rawRequest(daemon.port, {
      path: "/api/health",
      headers: authed(),
      hostHeader: `localhost:${daemon.port}`,
    });
    expect(response.status).toBe(200);
  });
});

describe("CSRF token issuance", () => {
  it("hands the CSRF token only to token-holders", async () => {
    const response = await rawRequest(daemon.port, { path: "/api/csrf" });
    expect(response.status).toBe(401);
  });

  it("issues a per-process CSRF token that then passes the state-changing gate", async () => {
    const csrf = await fetchCsrfToken();
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Valid on an unrouted POST: passes CSRF (403 would mean rejected), lands 404.
    const response = await rawRequest(daemon.port, {
      method: "POST",
      path: "/api/does-not-exist",
      headers: authed({ "x-camino-csrf": csrf }),
    });
    expect(response.status).toBe(404);
  });
});

describe("fail-closed off-listener behaviour", () => {
  it("refuses requests when not answering over a bound listener (inject)", async () => {
    const app = buildServer({ token: TOKEN });
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
