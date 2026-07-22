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
 * SHA-256 digests. Every APPLICATION response carries restrictive security
 * headers (CSP self-only, nosniff, deny framing, no-store) via an onSend hook —
 * the GUI is served exclusively by this daemon, so the tight policy is free.
 * A request rejected by the HTTP parser or router BEFORE Fastify's hook chain
 * (a malformed URL, a duplicate Content-Length, an illegal Transfer-Encoding
 * combination) receives Fastify's default client-error response — a fixed
 * generic JSON body (`{"error":"Bad Request",...}`) WITHOUT these headers
 * (round 2 finding 5 / round 3 finding 7). That body carries no
 * attacker-controlled or reflected content, so the absent CSP protects nothing
 * that exists; the headers are guaranteed on every response the application
 * itself produces.
 *
 * KNOWN LIMITATION — loopback-origin service-worker squatting (round 5, finding
 * 1): the daemon's origin (http://127.0.0.1:<port>) is not exclusively owned by
 * the daemon across restarts. A malicious LOCAL process can bind the port while
 * the daemon is stopped and, if the user's browser loads that origin, register a
 * persistent service worker that survives the port returning to the real daemon
 * and can then read the GUI token and drive the API. This needs no filesystem
 * write, so it is outside the token/GUI directory boundaries. Partial mitigation
 * here: `worker-src 'none'` (the legitimate GUI never uses a worker; the token
 * is per-launch). It does NOT evict a worker already registered by a squatter.
 * The complete fix is an origin a squatter cannot pre-seed — an ephemeral
 * per-launch port, or a per-launch path/subdomain nonce — which changes the
 * daemon⇄GUI addressing contract. DECISION (David, 2026-07-19): DEFERRED to the
 * real GUI/launch work (WP-122+), where the addressing contract is designed;
 * this shell keeps the `worker-src 'none'` partial mitigation and the
 * placeholder GUI uses no service worker.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { BIND_HOST } from "./config.js";
import { RegisterActionError } from "./register-service.js";
import type { RegisterActionInput as RegisterActionInputShape } from "./register-service.js";
import type { RegisterAsOf, RegisterService } from "./register-service.js";
import { generateToken } from "./token.js";

export interface BuildServerOptions {
  /** The GUI auth token (from the 0600 token file; see token.ts). */
  token: string;
  /** Directory served as the GUI build; missing directory → 503 hint page. */
  guiRoot?: string;
  /**
   * The gap-register surface (WP-122). Optional so the bare shell keeps
   * working; when absent, /api/register answers 503 register-not-wired —
   * an explicit refusal, not a 404 that could be mistaken for a routing
   * bug. All register routes sit behind the same global policy hook as
   * every other route (token + CSRF, by construction).
   */
  register?: RegisterService;
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
 * Validate that a GUI build directory is a PLAIN, CONTAINED tree: every entry
 * is a regular file or directory (no symlinks, FIFOs, devices, sockets) inside
 * `root`. A daemon that serves the tree is only as contained as the tree is —
 * @fastify/static follows symlinks, and its `allowedPath` check runs before the
 * open, so a symlink used as a directory index (or swapped in at runtime) can
 * disclose a file outside the root (round 2, finding 1). Rather than chase that
 * check-then-open race inside the plugin, we refuse at startup to serve a tree
 * that is not plain, and serve a 503 instead — Camino owns and builds this
 * directory, so a plain tree is the correct, verifiable invariant.
 *
 * A "plain contained tree" here means: every entry is a regular file (with a
 * single link — a hardlink whose inode also has a name outside the tree is
 * refused, round 3, finding 8) or a directory, and nothing is a symlink,
 * device, FIFO, or socket.
 *
 * Scope (documented residual): the daemon serves a directory whose path is
 * under the user's own control. Its integrity depends on the OS enforcing the
 * permissions of every component of that path — the build directory and each of
 * its ancestors. An attacker who can rename or rebind those directories (round
 * 4, findings 2/3) either IS the owner (attacking themselves, meaningless) or
 * has already compromised the user's account, at which point the served content
 * — and the token, and everything else — is forfeit. This is the same boundary
 * as the token's state directory: it rests on the user's own filesystem
 * integrity, which is the OS's job, not the daemon's. What the daemon adds is
 * defense against the ACCIDENTAL and the DETECTABLE: a non-plain tree is refused
 * at startup, the resolved root is pinned, and each request re-confirms the root
 * still names the startup inode (rootInodeUnchanged) so a persistent post-start
 * swap is caught rather than served. A sub-request-window TOCTOU remains and is
 * within the boundary above.
 */
function isPlainContainedTree(root: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  const stack: string[] = [realRoot];
  let budget = 100_000; // bound the walk; the GUI build is small
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (--budget <= 0) return false;
      const full = join(dir, entry.name);
      let lst: import("node:fs").Stats;
      try {
        lst = lstatSync(full);
      } catch {
        return false;
      }
      if (lst.isSymbolicLink()) return false;
      if (lst.isDirectory()) stack.push(full);
      else if (!lst.isFile())
        return false; // FIFO / device / socket
      else if (lst.nlink > 1) return false; // hardlink: inode may be named outside the tree
    }
  }
  return true;
}

/** A GUI root resolved once at startup, with the inode identity it then had. */
interface ResolvedGuiRoot {
  realRoot: string;
  inode: string; // `${dev}:${ino}` of realRoot at startup
}

/** Resolve the GUI root's real path and record its inode identity (once). */
function resolveGuiRoot(guiRoot: string): ResolvedGuiRoot | undefined {
  try {
    const realRoot = realpathSync(guiRoot);
    const stat = lstatSync(realRoot);
    return { realRoot, inode: `${stat.dev}:${stat.ino}` };
  } catch {
    return undefined;
  }
}

/**
 * True iff the resolved root path still names the SAME inode it did at startup.
 * A parent-directory rename can swap a different directory into the resolved
 * pathname without touching the build directory itself (round 4, finding 3);
 * detecting the changed inode lets the request be refused instead of serving
 * the swapped tree.
 */
function rootInodeUnchanged(gui: ResolvedGuiRoot): boolean {
  try {
    const stat = lstatSync(gui.realRoot);
    return `${stat.dev}:${stat.ino}` === gui.inode;
  } catch {
    return false;
  }
}

/**
 * True iff `pathName` (a request path) resolves to a file within `realRoot`,
 * following symlinks. Defense-in-depth for static serving alongside the
 * startup plain-tree check; catches lexical `..` escapes regardless.
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
 * 1, finding 1).
 *
 * The classification is a CONSERVATIVE over-approximation of "is this /api",
 * not a byte-for-byte reproduction of Fastify's router (round 2, finding 4):
 * `new URL().pathname` normalises dot segments and converts `\` to `/`, so a
 * few spellings the router would NOT match as `/api/health` (e.g. `/./api/…`,
 * `/api\health`) are still classified as /api and token-gated. That is the safe
 * direction — the failure mode is "an extra request needs a token", never "an
 * API request skips the token". The percent-decoded form is checked too, so an
 * encoded `/%61pi` spelling is caught; only a genuinely malformed encoding is
 * refused outright.
 */
function classifyPath(rawUrl: string): { api: boolean } | { malformed: true } {
  if (!rawUrl.startsWith("/")) return { malformed: true }; // not origin-form
  // Parse against a fixed base to extract the pathname; query/fragment fall
  // away. A parse failure is a refusal, not a guess.
  let pathname: string;
  try {
    pathname = new URL(rawUrl, "http://localhost").pathname;
  } catch {
    return { malformed: true };
  }
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
  const guiExists = guiRoot !== undefined && existsSync(guiRoot);
  // Resolve the GUI root to its real path EXACTLY ONCE (round 4, finding 2:
  // separate realpath calls for validate vs. serve could resolve different
  // trees if a symlink was rebound between them). Everything downstream —
  // validation, the served root, and the runtime identity pin — uses this one
  // resolved path and its inode.
  const gui = guiExists ? resolveGuiRoot(guiRoot!) : undefined;
  const guiValid = gui !== undefined && isPlainContainedTree(gui.realRoot);
  const guiMissingReason = guiExists ? "gui-build-invalid" : "gui-build-missing";

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
      // worker-src 'none' (round 5, finding 1): the legitimate GUI never uses a
      // service or web worker, so the security model does not depend on one —
      // and a GUI XSS cannot register a persistent worker. (This does NOT evict
      // a worker a port-squatter registered on this origin while the daemon was
      // stopped; see the loopback-origin residual in the module notes.)
      "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; worker-src 'none'",
    );
    // Nothing the shell serves benefits from caching yet, and the API must
    // never be cached; revisit selectively when the real GUI bundle lands.
    reply.header("cache-control", "no-store");
    return payload;
  });

  // Never surface a raw OS error (message or absolute path) to a client — e.g.
  // @fastify/static's open() error on an unreadable file (round 5, finding 2).
  // The detail is logged server-side; the client gets a generic error. Send a
  // pre-serialized string so the payload passes cleanly through the onSend hook.
  // Framework error HEADERS are preserved (round 6, finding 1): @fastify/send
  // attaches semantically-required headers to some errors — e.g. `Content-Range`
  // on a 416 unsatisfiable range — and dropping them is an HTTP regression. Only
  // the error BODY is replaced, never the protocol headers.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error(error);
    const errorHeaders = (error as { headers?: Record<string, number | string | string[]> })
      .headers;
    if (errorHeaders && typeof errorHeaders === "object") {
      for (const [name, value] of Object.entries(errorHeaders)) {
        reply.header(name, value);
      }
    }
    const raw = error.statusCode;
    const status = typeof raw === "number" && raw >= 400 && raw < 600 ? raw : 500;
    void reply
      .code(status)
      .type("application/json")
      .send(JSON.stringify({ error: "internal-error" }));
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

  // ——— Gap register (WP-122, CAM-CANON-05 / CAM-CORE-09 / CAM-CORE-10) ———
  // The GUI's ONLY canon/requirement read path: everything below returns
  // ledger projections computed by the register service; no repo canon
  // text is reachable from these handlers (see register-service.ts for
  // the full CAM-CORE-10 construction argument).
  const register = options.register;
  const registerErrorStatus: Record<RegisterActionError["code"], number> = {
    unavailable: 503,
    malformed: 400,
    "register-advanced": 409,
    "unknown-row": 404,
    refused: 409,
  };
  const sendRegisterError = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof RegisterActionError) {
      return reply
        .code(registerErrorStatus[error.code])
        .send({ error: error.code, problem: error.message });
    }
    throw error; // genuine daemon bug → the generic error handler
  };
  /** Body must be a plain JSON object (Fastify parsed it; refuse arrays/null). */
  const plainBody = (body: unknown): Record<string, unknown> | null =>
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;

  app.get("/api/register", async (request, reply) => {
    if (register === undefined) {
      return reply.code(503).send({ error: "register-not-wired" });
    }
    return register.snapshot();
  });

  app.post<{ Params: { requirementId: string } }>(
    "/api/register/:requirementId/disposition",
    async (request, reply) => {
      if (register === undefined) {
        return reply.code(503).send({ error: "register-not-wired" });
      }
      const body = plainBody(request.body);
      if (body === null) {
        return reply.code(400).send({ error: "malformed", problem: "body must be a JSON object" });
      }
      try {
        // The service validates every field at runtime (action membership,
        // reason hygiene, asOf shape); the casts only name the wire shape.
        return register.recordDisposition(request.params.requirementId, {
          action: body["action"] as RegisterActionInputShape["action"],
          reason: body["reason"] as string,
          asOf: body["asOf"] as RegisterAsOf,
          ...(body["waivedThroughSeq"] === undefined
            ? {}
            : { waivedThroughSeq: body["waivedThroughSeq"] as number }),
        });
      } catch (error) {
        return sendRegisterError(reply, error);
      }
    },
  );

  app.post<{ Params: { requirementId: string } }>(
    "/api/register/:requirementId/descope",
    async (request, reply) => {
      if (register === undefined) {
        return reply.code(503).send({ error: "register-not-wired" });
      }
      const body = plainBody(request.body);
      if (body === null) {
        return reply.code(400).send({ error: "malformed", problem: "body must be a JSON object" });
      }
      try {
        return register.descope(request.params.requirementId, {
          reason: body["reason"] as string,
          asOf: body["asOf"] as RegisterAsOf,
        });
      } catch (error) {
        return sendRegisterError(reply, error);
      }
    },
  );

  if (guiValid) {
    // Serve from the single resolved real path (round 4, finding 2). Two
    // startup defenses plus one runtime defense:
    //  - the tree was verified plain and contained (isPlainContainedTree), so
    //    no symlink can be a file or directory index;
    //  - `dotfiles: 'deny'` keeps hidden files unreadable (round 2, finding 3);
    //  - the allowedPath hook re-confirms, per request, that the resolved root
    //    still names the SAME inode observed at startup (round 4, finding 3: a
    //    directory swapped in by renaming the parent would otherwise be served)
    //    and that the target stays within it (defense against lexical `..`).
    const served = gui!;
    void app.register(fastifyStatic, {
      root: served.realRoot,
      prefix: "/",
      dotfiles: "deny",
      allowedPath: (pathName) =>
        rootInodeUnchanged(served) && staticPathContained(served.realRoot, pathName),
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const path = classifyPath(request.url);
    const api = "malformed" in path ? true : path.api;
    if (!api && SAFE_METHODS.has(request.method)) {
      if (guiValid && rootInodeUnchanged(gui!)) {
        // Single-page fallback: unknown GUI routes render the app shell.
        return reply.sendFile("index.html");
      }
      return reply.code(503).send({
        error: guiMissingReason,
        hint:
          guiMissingReason === "gui-build-invalid"
            ? "the GUI build directory must be a plain tree (no symlinks); rebuild it"
            : "run: npm run build -w @camino/gui (or set CAMINO_GUI_DIST)",
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
