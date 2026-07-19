/**
 * Daemon HTTP shell (WP-102, CAM-CORE-01): loopback-only Fastify server that
 * serves the GUI build and enforces the request policy for every route that
 * exists now or is added by later work packages.
 *
 * Enforcement is layered, and deliberately runs in a single global onRequest
 * hook so it applies BEFORE route matching — a future route cannot forget to
 * opt in, and unrouted paths get the same refusals (a pinned test property):
 *
 *   0. listener binds 127.0.0.1 only (startDaemonServer) — remote connection
 *      attempts fail at the TCP layer;
 *   1. Host header must be the daemon's own authority (127.0.0.1:port or
 *      localhost:port) — refuses requests routed here under a foreign name
 *      (browser-resolved hostnames pointing at loopback);
 *   2. Origin header, when present, must be the daemon's own origin — a
 *      cross-origin browser request is refused regardless of method;
 *   3. every /api request must carry the GUI token as `Authorization:
 *      Bearer <token>` (the static GUI shell itself is public code and is
 *      served without the token — it has to load before it can hold one);
 *   4. every state-changing request (any method outside GET/HEAD/OPTIONS)
 *      must carry the per-process CSRF token in `X-Camino-Csrf`.
 *
 * Layers 2 and 4 are each sufficient against cross-site request forgery on
 * their own (the token in a custom header already forces a CORS preflight we
 * never grant); they are kept separate and explicit per CAM-CORE-01, so the
 * property survives any one layer being weakened by a future change.
 *
 * No CORS grant is ever emitted: cross-origin pages cannot read responses,
 * and preflighted requests fail. Token comparison is constant-time over
 * SHA-256 digests. Responses carry restrictive security headers (CSP
 * self-only, nosniff, deny framing) — the GUI is served exclusively by this
 * daemon, so the tight policy is free.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";

import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { BIND_HOST } from "./config.js";
import { generateToken } from "./token.js";

export interface BuildServerOptions {
  /** The GUI auth token (from the 0600 token file; see token.ts). */
  token: string;
  /** Directory served as the GUI build; missing directory → 503 hint page. */
  guiRoot?: string;
  logger?: boolean;
}

export interface RunningDaemon {
  app: FastifyInstance;
  /** The actually-bound port (useful when options requested port 0). */
  port: number;
  url: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time equality over equal-length digests (length never leaks). */
function timingSafeStringEqual(presented: string, expected: string): boolean {
  return timingSafeEqual(sha256(presented), sha256(expected));
}

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

/**
 * Path classification for the auth layer. Query/fragment stripped; a path is
 * treated as /api if either its raw or percent-decoded form says so, so an
 * encoded spelling cannot slip past the prefix check. Malformed encodings and
 * backslashes have no legitimate use and are refused outright.
 */
function classifyPath(rawUrl: string): { api: boolean } | { malformed: true } {
  const raw = rawUrl.split("?", 1)[0]!.split("#", 1)[0]!;
  if (raw.includes("\\")) return { malformed: true };
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { malformed: true };
  }
  if (decoded.includes("\\")) return { malformed: true };
  return { api: isApiPath(raw) || isApiPath(decoded) };
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    // Close idle keep-alive connections on shutdown instead of waiting on them.
    forceCloseConnections: "idle",
    bodyLimit: 1024 * 1024,
  });

  const csrfToken = generateToken();
  const guiRoot = options.guiRoot;
  const guiAvailable = guiRoot !== undefined && existsSync(guiRoot);

  /** Authorities/origins the daemon answers as; computed from the bound port. */
  function selfAuthorities(): { hosts: Set<string>; origins: Set<string> } | undefined {
    const address = app.server.address();
    if (address === null || typeof address === "string") return undefined;
    const port = address.port;
    return {
      hosts: new Set([`127.0.0.1:${port}`, `localhost:${port}`]),
      origins: new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]),
    };
  }

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const authorities = selfAuthorities();
    if (authorities === undefined) {
      // Not answering over a bound TCP listener (e.g. inject()) — fail closed.
      return reply.code(403).send({ error: "listener-not-bound" });
    }

    const host = request.headers.host?.trim().toLowerCase();
    if (host === undefined || !authorities.hosts.has(host)) {
      return reply.code(403).send({ error: "host-not-allowed" });
    }

    const origin = request.headers.origin?.trim().toLowerCase();
    if (origin !== undefined && !authorities.origins.has(origin)) {
      return reply.code(403).send({ error: "origin-not-allowed" });
    }

    const path = classifyPath(request.url);
    if ("malformed" in path) {
      return reply.code(400).send({ error: "malformed-path" });
    }

    if (path.api) {
      const authorization = request.headers.authorization;
      const match = authorization?.match(/^Bearer (.+)$/);
      if (!match || !timingSafeStringEqual(match[1]!, options.token)) {
        reply.header("www-authenticate", 'Bearer realm="camino"');
        return reply.code(401).send({ error: "token-missing-or-invalid" });
      }
    }

    if (!SAFE_METHODS.has(request.method)) {
      const presented = request.headers["x-camino-csrf"];
      if (typeof presented !== "string" || !timingSafeStringEqual(presented, csrfToken)) {
        return reply.code(403).send({ error: "csrf-token-missing-or-invalid" });
      }
    }

    return undefined;
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    reply.header("cross-origin-resource-policy", "same-origin");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header(
      "content-security-policy",
      "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    // Nothing the shell serves benefits from caching yet, and the API must
    // never be cached; revisit selectively when the real GUI bundle lands.
    reply.header("cache-control", "no-store");
    return payload;
  });

  app.get("/api/health", async () => ({ status: "ok" }));

  // The GUI fetches this once (with the auth token) and echoes the value in
  // X-Camino-Csrf on every state-changing call. Per-process value: restarting
  // the daemon invalidates outstanding copies.
  app.get("/api/csrf", async () => ({ csrfToken }));

  // Graceful stop, so the GUI can shut the daemon down — and so the shell
  // ships with a real state-changing endpoint under the full policy stack.
  let stopping = false;
  app.post("/api/shutdown", async () => {
    if (!stopping) {
      stopping = true;
      setImmediate(() => {
        void app.close();
      });
    }
    return { stopping: true };
  });

  if (guiAvailable) {
    void app.register(fastifyStatic, { root: guiRoot!, prefix: "/" });
  }

  app.setNotFoundHandler((request, reply) => {
    const path = classifyPath(request.url);
    const api = "malformed" in path ? true : path.api;
    if (!api && SAFE_METHODS.has(request.method)) {
      if (guiAvailable) {
        // Single-page fallback: unknown GUI routes render the app shell.
        return reply.sendFile("index.html");
      }
      return reply.code(503).send({
        error: "gui-build-missing",
        hint: "run: npm run build -w @camino/gui (or set CAMINO_GUI_DIST)",
      });
    }
    return reply.code(404).send({ error: "not-found" });
  });

  return app;
}

export interface StartDaemonOptions extends BuildServerOptions {
  /** Port to bind on 127.0.0.1; 0 asks the OS for a free port (tests). */
  port: number;
}

/** Bind and listen — always on BIND_HOST (127.0.0.1), never configurable. */
export async function startDaemonServer(options: StartDaemonOptions): Promise<RunningDaemon> {
  const app = buildServer(options);
  await app.listen({ host: BIND_HOST, port: options.port });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    await app.close();
    throw new Error("daemon listener did not report a TCP address");
  }
  return { app, port: address.port, url: `http://${BIND_HOST}:${address.port}` };
}
