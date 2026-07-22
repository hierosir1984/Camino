/**
 * Register-service tests (WP-122): the composition layer over real
 * stores — snapshot agreement with the core projection (the module-level
 * CAM-CORE-10 check), the CAM-CANON-05 waiver refusal end-to-end, the
 * optimistic-concurrency guard, and the descope path through the intent
 * ledger. The HTTP layer re-asserts the same over real requests
 * (server-register.test.ts); the browser layer in the Playwright suite.
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
import { RegisterActionError, RegisterService } from "./register-service.js";
import type { RegisterAsOf } from "./register-service.js";

const R1 = "CAM-DEMO-01"; // a real unmet requirement (no facts)
const R2 = "CAM-DEMO-02"; // suspected via a detector finding
const HEAD = "d".repeat(40);
const MAIN: StatusContext = { kind: "main", headSha: HEAD };
const DETECTOR = `${DETECTOR_ACTOR_PREFIX}todo-scan`;

let dir: string;
let canonLedger: CanonLedgerStore;
let canonFacts: CanonFactsStore;
let gapDispositions: GapDispositionsStore;
let context: StatusContext | null;
let service: RegisterService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "camino-register-"));
  const now = () => new Date("2026-07-03T00:00:00.000Z");
  canonLedger = new CanonLedgerStore(join(dir, "canon-ledger.sqlite"), { now });
  canonFacts = new CanonFactsStore(join(dir, "canon-facts.sqlite"), { now });
  gapDispositions = new GapDispositionsStore(join(dir, "gap-dispositions.sqlite"), { now });
  context = MAIN;
  service = new RegisterService({
    canonLedger,
    canonFacts,
    gapDispositions,
    contextSource: { current: () => context },
  });

  canonLedger.proposeRequirement(R1, { statement: "demo behavior one", sourceMissionId: "m1" });
  canonLedger.acceptRequirement(R1);
  canonLedger.proposeRequirement(R2, { statement: "demo behavior two", sourceMissionId: "m1" });
  canonLedger.acceptRequirement(R2);
  canonFacts.recordFact({
    requirementId: R2,
    kind: "absence-suspected",
    actor: DETECTOR,
    payload: { contextKind: "main", reason: "todo-scan: stub at src/two.ts:1" },
  });
});

afterEach(() => {
  gapDispositions.close();
  canonFacts.close();
  canonLedger.close();
});

function currentAsOf(): RegisterAsOf {
  const snapshot = service.snapshot();
  if (!snapshot.available) throw new Error("fixture expects an available register");
  return snapshot.asOf;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof RegisterActionError) return error.code;
    throw error;
  }
  throw new Error("expected a RegisterActionError");
}

describe("snapshot", () => {
  it("is honestly unavailable without a repository context", () => {
    context = null;
    expect(service.snapshot()).toEqual({ available: false, reason: "no-repository-context" });
    expect(
      code(() =>
        service.recordDisposition(R1, {
          action: "fix-queued",
          reason: "r",
          asOf: { ledgerSeq: 0, factsSeq: 0, dispositionsSeq: 0, context: MAIN },
        }),
      ),
    ).toBe("unavailable");
  });

  it("returns exactly the core projection over the stores' current reads (CAM-CORE-10, module level)", () => {
    const snapshot = service.snapshot();
    if (!snapshot.available) throw new Error("expected available");
    const independent = projectGapRegister(
      canonLedger.currentView(),
      canonFacts.read(),
      gapDispositions.read(),
      MAIN,
    );
    expect(snapshot.rows).toEqual(independent);
    expect(snapshot.rows.map((r) => r.requirementId)).toEqual([R1, R2]);
    expect(snapshot.asOf).toEqual({
      ledgerSeq: canonLedger.lastSeq,
      factsSeq: canonFacts.read().at(-1)?.seq ?? 0,
      dispositionsSeq: gapDispositions.lastSeq,
      context: MAIN,
    });
  });
});

describe("disposition actions", () => {
  it("records fix-queued with the basis taken from the service's own projection", () => {
    const result = service.recordDisposition(R1, {
      action: "fix-queued",
      reason: "queueing repair",
      asOf: currentAsOf(),
    });
    expect(result.record.event).toBe("gap-fix-queued");
    expect(result.record.payload["tuple"]).toEqual({
      disposition: "accepted",
      implementation: { kind: "absent" },
      evidence: "unverified",
    });
    if (!result.snapshot.available) throw new Error("expected available");
    const row = result.snapshot.rows.find((r) => r.requirementId === R1);
    expect(row?.disposition).toBe("fix-queued");
    expect(gapDispositions.read()).toHaveLength(1);
  });

  it("REFUSES waiving a real unmet requirement (CAM-CANON-05) end-to-end", () => {
    expect(
      code(() =>
        service.recordDisposition(R1, {
          action: "false-positive-waived",
          reason: "trying to waive a real gap",
          waivedThroughSeq: 1,
          asOf: currentAsOf(),
        }),
      ),
    ).toBe("refused");
    expect(gapDispositions.read()).toHaveLength(0); // nothing was recorded
  });

  it("waives a detector finding bound to its exact seq, and refuses a stale binding", () => {
    const snapshot = service.snapshot();
    if (!snapshot.available) throw new Error("expected available");
    const row = snapshot.rows.find((r) => r.requirementId === R2);
    expect(row?.waivableThroughSeq).toBe(1);

    expect(
      code(() =>
        service.recordDisposition(R2, {
          action: "false-positive-waived",
          reason: "stale finding reference",
          waivedThroughSeq: 99,
          asOf: snapshot.asOf,
        }),
      ),
    ).toBe("refused");

    const result = service.recordDisposition(R2, {
      action: "false-positive-waived",
      reason: "stub is intentional scaffolding",
      waivedThroughSeq: 1,
      asOf: snapshot.asOf,
    });
    if (!result.snapshot.available) throw new Error("expected available");
    expect(result.snapshot.rows.find((r) => r.requirementId === R2)?.disposition).toBe(
      "false-positive-waived",
    );
  });

  it("refuses an action taken on a stale snapshot (register-advanced)", () => {
    const stale = currentAsOf();
    canonFacts.recordFact({
      requirementId: R2,
      kind: "absence-suspected",
      actor: DETECTOR,
      payload: { contextKind: "main", reason: "todo-scan: second hit" },
    });
    expect(
      code(() =>
        service.recordDisposition(R2, {
          action: "false-positive-waived",
          reason: "acting on stale render",
          waivedThroughSeq: 1,
          asOf: stale,
        }),
      ),
    ).toBe("register-advanced");
  });

  it("F6: a context head change WITHOUT any store write invalidates a stale action", () => {
    const stale = currentAsOf();
    // No ledger/fact/disposition write — only the reader's head advances (a
    // fresh main SHA the register now projects against). The tuple a user saw
    // (e.g. verified-live at the old head) may differ at the new head, so the
    // action must be refused even though all three store sequences are unchanged.
    context = { kind: "main", headSha: "b".repeat(40) };
    expect(
      code(() =>
        service.recordDisposition(R1, {
          action: "fix-queued",
          reason: "acting on a head-stale render",
          asOf: stale,
        }),
      ),
    ).toBe("register-advanced");
    // An action taken against the CURRENT context succeeds.
    context = { kind: "main", headSha: HEAD };
  });

  it("refuses unknown rows, malformed reasons, and unknown actions", () => {
    expect(
      code(() =>
        service.recordDisposition("CAM-NOPE-01", {
          action: "fix-queued",
          reason: "r",
          asOf: currentAsOf(),
        }),
      ),
    ).toBe("unknown-row");
    expect(
      code(() =>
        service.recordDisposition(R1, {
          action: "fix-queued",
          reason: "two\nlines",
          asOf: currentAsOf(),
        }),
      ),
    ).toBe("malformed");
    expect(
      code(() =>
        service.recordDisposition(R1, {
          action: "waive" as never,
          reason: "r",
          asOf: currentAsOf(),
        }),
      ),
    ).toBe("malformed");
  });
});

describe("descope (the intent-ledger path for real unmet requirements)", () => {
  it("records requirement-descoped in the LEDGER and the row leaves the register", () => {
    const result = service.descope(R1, { reason: "descoping for v2", asOf: currentAsOf() });
    expect(result.record.event).toBe("requirement-descoped");
    expect(canonLedger.entry(R1)?.disposition).toBe("descoped");
    if (!result.snapshot.available) throw new Error("expected available");
    expect(result.snapshot.rows.map((r) => r.requirementId)).toEqual([R2]);
    // The gap-disposition log is untouched: descope is an intent action.
    expect(gapDispositions.read()).toHaveLength(0);
  });

  it("refuses descoping without a live row and with a stale snapshot", () => {
    expect(code(() => service.descope("CAM-NOPE-01", { reason: "r", asOf: currentAsOf() }))).toBe(
      "unknown-row",
    );
    const stale = currentAsOf();
    canonLedger.proposeRequirement("CAM-DEMO-03", {
      statement: "third",
      sourceMissionId: "m1",
    });
    expect(code(() => service.descope(R1, { reason: "r", asOf: stale }))).toBe("register-advanced");
  });
});
