/**
 * Daemon HTTP shell (WP-102, CAM-CORE-01): loopback-only Fastify server that
 * serves the GUI build and enforces the request policy for every route that
 * exists now or is added by later work packages.
 *
 * Enforcement runs in a single global onRequest hook. Fastify's lifecycle is
 * Routing → onRequest (the hook fires AFTER the route is matched), and a
 * global onRequest hook fires for every request including ones that match no
 * route (they reach the not-found handler through the same hook chain). So a
 * future route — or an unrouted path — is covered by construction: the policy
 * does not depend on any per-route opt-in. Because the hook sees the matched
 * request, path classification must derive the path the way the router did
 * (URL pathname, not a substring of the raw target); an earlier version read
 * the raw target and let an absolute-form request target dodge the token
 * check (round 1, finding 1).
 *
 * Layers, in order:
 *   0. listener binds 127.0.0.1 only (startDaemonServer) — remote connection
 *      attempts fail at the TCP layer;
 *   1. request target must be origin-form (`/path`); absolute-form and
 *      asterisk-form targets have no legitimate use from the GUI and are
 *      refused, closing the classification-divergence class outright;
 *   2. a security-relevant header (Host, Origin, Authorization, X-Camino-Csrf)
 *      appearing more than once is refused — no first-wins header smuggling
 *      (round 1, finding 7);
 *   3. Host header must be one of the daemon's own authorities (127.0.0.1:port
 *      or localhost:port); the Origin header, when present, must be the origin
 *      OF THAT SAME host — the two are bound as a pair, not checked against
 *      independent allowlists (round 1, finding 6);
 *   4. every /api request must carry the GUI token as `Authorization:
 *      Bearer <token>` (the static GUI shell itself is public code and is
 *      served without the token — it has to load before it can hold one);
 *   5. every state-changing request (any method outside GET/HEAD/OPTIONS)
 *      must carry the per-process CSRF token in `X-Camino-Csrf`.
 *
 * Layers 3 and 5 are each sufficient against cross-site request forgery on
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
import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

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

/**
 * True iff `pathName` (a request path) resolves to a file within `realRoot`,
 * following symlinks. Used to keep static serving inside the GUI build dir.
 */
function staticPathContained(realRoot: string, pathName: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathName);
  } catch {
    return false;
  }
  if (decoded.includes("\0")) return false;
  const candidate = resolve(realRoot, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  const within = (p: string): boolean => p === realRoot || p.startsWith(realRoot + sep);
  try {
    return within(realpathSync(candidate));
  } catch {
    // Non-existent target: let the static handler 404 normally, but only if the
    // lexical path is still inside root (a broken symlink must not escape).
    return within(candidate);
  }
}

/** Security-relevant headers that must appear at most once (no smuggling). */
const SINGLE_VALUE_HEADERS = ["host", "origin", "authorization", "x-camino-csrf"];

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

/**
 * Classify a request target for the auth layer. The target must be origin-form
 * (`/path…`); an absolute-form target (`http://host/api/…`) or asterisk-form
 * (`*`) is refused, because Fastify routes by the URL path while a naive
 * substring check on the raw target would classify it as non-API — the exact
 * divergence that let an absolute-form request reach `/api` tokenlessly (round
 * 1, finding 1). Within origin-form, the path is treated as /api if either its
 * raw or percent-decoded pathname says so; malformed encodings and backslashes
 * are refused.
 */
function classifyPath(rawUrl: string): { api: boolean } | { malformed: true } {
  if (!rawUrl.startsWith("/")) return { malformed: true }; // not origin-form
  // Parse against a fixed base so the pathname is exactly what the router used;
  // query/fragment fall away. A parse failure is a refusal, not a guess.
  let pathname: string;
  try {
    pathname = new URL(rawUrl, "http://localhost").pathname;
  } catch {
    return { malformed: true };
  }
  if (pathname.includes("\\")) return { malformed: true };
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { malformed: true };
  }
  if (decoded.includes("\\")) return { malformed: true };
  return { api: isApiPath(pathname) || isApiPath(decoded) };
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

  /** The `host:port` authorities the daemon answers as, from the bound port. */
  function selfHosts(): Set<string> | undefined {
    const address = app.server.address();
    if (address === null || typeof address === "string") return undefined;
    return new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);
  }

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const hosts = selfHosts();
    if (hosts === undefined) {
      // Not answering over a bound TCP listener (e.g. inject()) — fail closed.
      return reply.code(403).send({ error: "listener-not-bound" });
    }

    // A security-relevant header appearing more than once is rejected: Node
    // collapses duplicates in `request.headers` to a single (first-seen for
    // Host) value, so a smuggled second Host/Origin/Authorization/CSRF would
    // otherwise ride along invisibly (round 1, finding 7). rawHeaders is the
    // flat [k, v, k, v, …] list that preserves every occurrence.
    const rawHeaders = request.raw.rawHeaders;
    const seen = new Map<string, number>();
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const name = rawHeaders[i]!.toLowerCase();
      if (SINGLE_VALUE_HEADERS.includes(name)) {
        const count = (seen.get(name) ?? 0) + 1;
        if (count > 1) return reply.code(400).send({ error: "duplicate-header", header: name });
        seen.set(name, count);
      }
    }

    // Origin-form target only; absolute/asterisk forms are refused (finding 1).
    const path = classifyPath(request.url);
    if ("malformed" in path) {
      return reply.code(400).send({ error: "malformed-path" });
    }

    // Host must be one of our authorities; the Origin, when present, must be
    // the origin of THAT SAME host — the pair is bound, not two independent
    // allowlists (round 1, finding 6).
    const host = request.headers.host?.trim().toLowerCase();
    if (host === undefined || !hosts.has(host)) {
      return reply.code(403).send({ error: "host-not-allowed" });
    }
    const origin = request.headers.origin?.trim().toLowerCase();
    if (origin !== undefined && origin !== `http://${host}`) {
      return reply.code(403).send({ error: "origin-not-allowed" });
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
    // @fastify/static (via @fastify/send) follows symlinks, so a symlink
    // planted in the build directory could disclose a file outside it (round
    // 1, finding 3). We fully own the build dir, but the claim must hold: an
    // allowedPath hook realpath-resolves each candidate and refuses anything
    // that resolves outside the real build root. realpath on both sides also
    // handles a symlinked root (e.g. macOS /tmp → /private/tmp).
    const realGuiRoot = realpathSync(guiRoot!);
    void app.register(fastifyStatic, {
      root: guiRoot!,
      prefix: "/",
      allowedPath: (pathName) => staticPathContained(realGuiRoot, pathName),
    });
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
