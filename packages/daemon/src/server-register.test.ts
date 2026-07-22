/**
 * Register HTTP surface tests (WP-122) against a genuinely listening
 * loopback server: the new routes sit under the SAME global policy stack
 * as every other route (token on /api, CSRF on state changes — asserted
 * here, not assumed from the hook's by-construction claim), and the
 * error mapping surfaces the service's refusals — including the
 * CAM-CANON-05 waiver refusal — as clean JSON statuses.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { projectGapRegister } from "@camino/core";
import { DETECTOR_ACTOR_PREFIX } from "@camino/shared";
import type { StatusContext } from "@camino/shared";
import { CanonFactsStore } from "./canon-facts.js";
import { CanonLedgerStore } from "./canon-ledger.js";
import { GapDispositionsStore } from "./gap-dispositions.js";
import { RegisterService } from "./register-service.js";
import { startDaemonServer } from "./server.js";
import type { RunningDaemon } from "./server.js";
import { generateToken } from "./token.js";

const R1 = "CAM-DEMO-01"; // real unmet requirement
const R2 = "CAM-DEMO-02"; // detector-suspected
const HEAD = "d".repeat(40);
const MAIN: StatusContext = { kind: "main", headSha: HEAD };
const DETECTOR = `${DETECTOR_ACTOR_PREFIX}todo-scan`;
const TOKEN = generateToken();

let daemon: RunningDaemon;
let canonLedger: CanonLedgerStore;
let canonFacts: CanonFactsStore;
let gapDispositions: GapDispositionsStore;
let csrf: string;

async function api(
  path: string,
  init: { method?: string; body?: unknown; token?: string | null; csrf?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (init.token !== null) headers["authorization"] = `Bearer ${init.token ?? TOKEN}`;
  if (init.csrf !== undefined) headers["x-camino-csrf"] = init.csrf;
  const requestInit: RequestInit = { method: init.method ?? "GET", headers };
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    requestInit.body = JSON.stringify(init.body);
  }
  const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, requestInit);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "camino-register-http-"));
  // One shared fixed clock: an honest waiver co-timestamped with its finding
  // must still bind — waiver binding does not depend on timestamps (the
  // cross-log recency guard was removed; binding is by tuple/context/seq).
  const now = () => new Date("2026-07-03T00:00:00.000Z");
  canonLedger = new CanonLedgerStore(join(dir, "canon-ledger.sqlite"), { now });
  canonFacts = new CanonFactsStore(join(dir, "canon-facts.sqlite"), { now });
  gapDispositions = new GapDispositionsStore(join(dir, "gap-dispositions.sqlite"), { now });
  canonLedger.proposeRequirement(R1, { statement: "demo behavior one", sourceMissionId: "m1" });
  canonLedger.acceptRequirement(R1);
  canonLedger.proposeRequirement(R2, { statement: "demo behavior two", sourceMissionId: "m1" });
  canonLedger.acceptRequirement(R2);
  canonFacts.recordFact({
    requirementId: R2,
    kind: "absence-suspected",
    actor: DETECTOR,
    payload: { contextKind: "main", reason: "todo-scan: stub" },
  });
  const register = new RegisterService({
    canonLedger,
    canonFacts,
    gapDispositions,
    contextSource: { current: () => MAIN },
  });
  daemon = await startDaemonServer({ token: TOKEN, port: 0, register });
  csrf = (await api("/api/csrf")).body["csrfToken"] as string;
});

afterEach(async () => {
  await daemon.app.close();
  gapDispositions.close();
  canonFacts.close();
  canonLedger.close();
});

async function asOf(): Promise<Record<string, unknown>> {
  return (await api("/api/register")).body["asOf"] as Record<string, unknown>;
}

describe("policy stack on the register routes", () => {
  it("requires the GUI token on reads and the CSRF token on actions", async () => {
    expect((await api("/api/register", { token: null })).status).toBe(401);
    const noCsrf = await api(`/api/register/${R1}/disposition`, {
      method: "POST",
      body: { action: "fix-queued", reason: "r", asOf: await asOf() },
    });
    expect(noCsrf.status).toBe(403);
    expect(gapDispositions.read()).toHaveLength(0);
  });
});

describe("GET /api/register", () => {
  it("returns the ledger projection verbatim (CAM-CORE-10, HTTP slice)", async () => {
    const { status, body } = await api("/api/register");
    expect(status).toBe(200);
    expect(body["available"]).toBe(true);
    const independent = projectGapRegister(
      canonLedger.currentView(),
      canonFacts.read(),
      gapDispositions.read(),
      MAIN,
    );
    // Through-JSON comparison: what the wire carries IS the projection.
    expect(body["rows"]).toEqual(JSON.parse(JSON.stringify(independent)));
  });
});

describe("POST /api/register/:id/disposition", () => {
  it("records an action and returns the refreshed snapshot", async () => {
    const { status, body } = await api(`/api/register/${R1}/disposition`, {
      method: "POST",
      csrf,
      body: { action: "fix-queued", reason: "queueing repair", asOf: await asOf() },
    });
    expect(status).toBe(200);
    const record = body["record"] as Record<string, unknown>;
    expect(record["event"]).toBe("gap-fix-queued");
    expect(gapDispositions.read()).toHaveLength(1);
    const snapshot = body["snapshot"] as {
      rows: Array<{ requirementId: string; disposition: string }>;
    };
    expect(snapshot.rows.find((r) => r.requirementId === R1)?.disposition).toBe("fix-queued");
  });

  it("maps the CAM-CANON-05 waiver refusal to 409 refused", async () => {
    const { status, body } = await api(`/api/register/${R1}/disposition`, {
      method: "POST",
      csrf,
      body: {
        action: "false-positive-waived",
        reason: "waiving a real gap",
        waivedThroughSeq: 1,
        asOf: await asOf(),
      },
    });
    expect(status).toBe(409);
    expect(body["error"]).toBe("refused");
    expect(String(body["problem"])).toContain("detector false");
    expect(gapDispositions.read()).toHaveLength(0);
  });

  it("maps stale snapshots to 409, unknown rows to 404, malformed bodies to 400", async () => {
    const stale = await asOf();
    canonFacts.recordFact({
      requirementId: R2,
      kind: "absence-suspected",
      actor: DETECTOR,
      payload: { contextKind: "main", reason: "todo-scan: second hit" },
    });
    const advanced = await api(`/api/register/${R2}/disposition`, {
      method: "POST",
      csrf,
      body: { action: "fix-queued", reason: "r", asOf: stale },
    });
    expect(advanced.status).toBe(409);
    expect(advanced.body["error"]).toBe("register-advanced");

    const unknown = await api(`/api/register/CAM-NOPE-01/disposition`, {
      method: "POST",
      csrf,
      body: { action: "fix-queued", reason: "r", asOf: await asOf() },
    });
    expect(unknown.status).toBe(404);

    const malformed = await api(`/api/register/${R1}/disposition`, {
      method: "POST",
      csrf,
      body: [1, 2, 3],
    });
    expect(malformed.status).toBe(400);
  });
});

describe("POST /api/register/:id/descope", () => {
  it("descopes through the intent ledger and the row leaves the register", async () => {
    const { status, body } = await api(`/api/register/${R1}/descope`, {
      method: "POST",
      csrf,
      body: { reason: "descoping for v2", asOf: await asOf() },
    });
    expect(status).toBe(200);
    expect((body["record"] as Record<string, unknown>)["event"]).toBe("requirement-descoped");
    expect(canonLedger.entry(R1)?.disposition).toBe("descoped");
    const snapshot = body["snapshot"] as { rows: Array<{ requirementId: string }> };
    expect(snapshot.rows.map((r) => r.requirementId)).toEqual([R2]);
  });
});

describe("without a wired register service", () => {
  it("answers 503 register-not-wired (an explicit refusal, not a 404)", async () => {
    const bare = await startDaemonServer({ token: TOKEN, port: 0 });
    try {
      const response = await fetch(`http://127.0.0.1:${bare.port}/api/register`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(503);
      expect(((await response.json()) as Record<string, unknown>)["error"]).toBe(
        "register-not-wired",
      );
    } finally {
      await bare.app.close();
    }
  });
});

describe("own-property body reads (round 2, finding 4)", () => {
  it("an empty {} body is refused even with a polluted Object.prototype", async () => {
    const asOfBody = (await api("/api/register")).body["asOf"];
    const proto = Object.prototype as Record<string, unknown>;
    proto["action"] = "fix-queued";
    proto["reason"] = "inherited";
    proto["asOf"] = asOfBody;
    try {
      const before = gapDispositions.read().length;
      // A body that owns nothing must not borrow action/reason/asOf from the
      // prototype chain and become a real recorded action.
      const response = await api(`/api/register/${R1}/disposition`, {
        method: "POST",
        csrf,
        body: {},
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(gapDispositions.read()).toHaveLength(before); // nothing recorded
    } finally {
      delete proto["action"];
      delete proto["reason"];
      delete proto["asOf"];
    }
  });
});

describe("onClose teardown wiring (round 1, finding 1 — deterministic guard)", () => {
  it("runs the onClose hook on close BECAUSE it is registered before listen", async () => {
    // The mechanism main.ts relies on to release its stores. Registered inside
    // buildServer before listen(), so it never hits Fastify's post-listen
    // addHook refusal — the defect that crashed the daemon on boot. This is the
    // fast, signal-free companion to main.test.ts's child-process smoke test.
    let closed = 0;
    const daemon = await startDaemonServer({
      token: TOKEN,
      port: 0,
      onClose: () => {
        closed += 1;
      },
    });
    expect(closed).toBe(0); // not yet — only on close
    await daemon.app.close();
    expect(closed).toBe(1); // fired exactly once, on the real close path
  });

  it("a throwing onClose is logged, not propagated into close()", async () => {
    const daemon = await startDaemonServer({
      token: TOKEN,
      port: 0,
      onClose: () => {
        throw new Error("teardown blew up");
      },
    });
    // close() must resolve even though the hook threw (best-effort teardown).
    await expect(daemon.app.close()).resolves.toBeUndefined();
  });
});
