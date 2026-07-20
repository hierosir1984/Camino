/**
 * Intent lifecycle decisions (WP-104): spec validation at the durable
 * boundary, event legality, the David-actor binding, folding, and the
 * fail-closed log verification recovery rides on.
 */
import { describe, expect, it } from "vitest";
import { correlationToken, intentMarkerToken, isValidIntentId } from "@camino/shared";
import type { IntentEventRecord } from "@camino/shared";
import {
  DAVID_ACTOR,
  applyIntentRecord,
  decideIntentAppend,
  foldIntentView,
  validateOperationSpec,
  verifyIntentLog,
} from "./intent-lifecycle.js";
import type { IntentAppendInput, IntentView } from "./intent-lifecycle.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const BRANCH_SPEC = {
  op: "branch-create",
  repo: "r",
  branch: "camino/issue-1",
  targetSha: SHA_A,
} as const;

describe("validateOperationSpec", () => {
  it("accepts a complete spec for every class", () => {
    const specs: unknown[] = [
      BRANCH_SPEC,
      { op: "push", repo: "r", ref: "b", intendedSha: SHA_A, expectedBaseSha: SHA_B },
      {
        op: "pr-create",
        repo: "r",
        headBranch: "h",
        baseBranch: "main",
        title: "t",
        bodyMarker: "m-1",
        body: "text m-1",
      },
      {
        op: "merge-by-push",
        repo: "r",
        targetRef: "main",
        mergeSha: SHA_A,
        expectedBaseSha: SHA_B,
      },
      {
        op: "label-set",
        repo: "r",
        targetKind: "issue",
        targetNumber: 1,
        label: "l",
        desired: "present",
      },
      {
        op: "comment-post",
        repo: "r",
        targetKind: "pull-request",
        targetNumber: 2,
        body: "x m-2",
        marker: "m-2",
      },
      { op: "workflow-dispatch", repo: "r", workflow: "w.yml", ref: "main", correlationId: "c-1" },
      { op: "test-service-mutation", environmentId: "e", mutation: "seed", irreversible: false },
      { op: "catch-all", description: "one-off" },
    ];
    for (const spec of specs) {
      const result = validateOperationSpec(spec);
      expect(result.ok, JSON.stringify(spec)).toBe(true);
    }
  });

  it("refuses non-objects and unknown classes", () => {
    expect(validateOperationSpec(null).ok).toBe(false);
    expect(validateOperationSpec("push").ok).toBe(false);
    expect(validateOperationSpec({ op: "unknown-op" }).ok).toBe(false);
  });

  it("refuses a missing field and an extra field (closed schema)", () => {
    expect(validateOperationSpec({ op: "branch-create", repo: "r", branch: "b" }).ok).toBe(false);
    expect(validateOperationSpec({ ...BRANCH_SPEC, extra: "field" }).ok).toBe(false);
  });

  it("pins SHA shape (length, case, hex)", () => {
    expect(validateOperationSpec({ ...BRANCH_SPEC, targetSha: "abc" }).ok).toBe(false);
    expect(validateOperationSpec({ ...BRANCH_SPEC, targetSha: SHA_A.toUpperCase() }).ok).toBe(
      false,
    );
    expect(validateOperationSpec({ ...BRANCH_SPEC, targetSha: "g".repeat(40) }).ok).toBe(false);
  });

  it("refuses embedded NUL and lone surrogates in strings (exact round-trip discipline)", () => {
    expect(validateOperationSpec({ ...BRANCH_SPEC, branch: "bad\u0000name" }).ok).toBe(false);
    expect(validateOperationSpec({ ...BRANCH_SPEC, branch: "bad\uD800name" }).ok).toBe(false);
  });

  it("requires the PR body to embed its marker (the corroboration mechanism)", () => {
    const result = validateOperationSpec({
      op: "pr-create",
      repo: "r",
      headBranch: "h",
      baseBranch: "main",
      title: "t",
      bodyMarker: "marker-1",
      body: "no marker here",
    });
    expect(result.ok).toBe(false);
  });

  it("requires the comment body to embed its marker", () => {
    const result = validateOperationSpec({
      op: "comment-post",
      repo: "r",
      targetKind: "issue",
      targetNumber: 1,
      body: "no marker",
      marker: "m-9",
    });
    expect(result.ok).toBe(false);
  });

  it("pins targetNumber to positive integers and irreversible to boolean", () => {
    expect(
      validateOperationSpec({
        op: "label-set",
        repo: "r",
        targetKind: "issue",
        targetNumber: 0,
        label: "l",
        desired: "present",
      }).ok,
    ).toBe(false);
    expect(
      validateOperationSpec({
        op: "label-set",
        repo: "r",
        targetKind: "issue",
        targetNumber: 1.5,
        label: "l",
        desired: "present",
      }).ok,
    ).toBe(false);
    expect(
      validateOperationSpec({
        op: "test-service-mutation",
        environmentId: "e",
        mutation: "m",
        irreversible: "yes",
      }).ok,
    ).toBe(false);
  });

  it("pins enum fields (targetKind, desired)", () => {
    expect(
      validateOperationSpec({
        op: "label-set",
        repo: "r",
        targetKind: "discussion",
        targetNumber: 1,
        label: "l",
        desired: "present",
      }).ok,
    ).toBe(false);
    expect(
      validateOperationSpec({
        op: "label-set",
        repo: "r",
        targetKind: "issue",
        targetNumber: 1,
        label: "l",
        desired: "toggled",
      }).ok,
    ).toBe(false);
  });
});

function record(
  seq: number,
  intentId: string,
  event: IntentEventRecord["event"],
  payload: Record<string, unknown>,
  actor = "camino:executor",
): IntentEventRecord {
  return { seq, intentId, event, actor, payload, recordedAt: "2026-07-19T00:00:00.000Z" };
}

/** The canonical happy walk: recorded → execution-started → confirmed. */
function happyWalk(intentId = "i1"): IntentEventRecord[] {
  return [
    record(1, intentId, "recorded", { ...BRANCH_SPEC }),
    record(2, intentId, "execution-started", {}),
    record(3, intentId, "confirmed", {
      via: "response",
      result: { branch: "camino/issue-1" },
      note: "ok",
    }),
  ];
}

function viewAfter(records: IntentEventRecord[]): IntentView {
  return foldIntentView(records);
}

describe("decideIntentAppend legality", () => {
  it("admits the full happy path and the recovery paths", () => {
    const walks: IntentEventRecord[][] = [
      happyWalk(),
      // crash → re-arm → complete
      [
        record(1, "i1", "recorded", { ...BRANCH_SPEC }),
        record(2, "i1", "execution-started", {}),
        record(3, "i1", "re-armed", { note: "absent", resetBeforeUse: false }),
        record(4, "i1", "execution-started", {}),
        record(5, "i1", "confirmed", { via: "response", result: {}, note: "ok" }),
      ],
      // crash → ambiguity → escalation → David authorizes retry → complete
      [
        record(1, "i1", "recorded", { ...BRANCH_SPEC }),
        record(2, "i1", "execution-started", {}),
        record(3, "i1", "ambiguity-recorded", { reason: "unknown" }),
        record(4, "i1", "escalated", { reason: "unknown" }),
        record(5, "i1", "retry-authorized", { reason: "David: safe to retry" }, DAVID_ACTOR),
        record(6, "i1", "execution-started", {}),
        record(7, "i1", "confirmed", { via: "reconciliation", result: {}, note: "ok" }),
      ],
      // crash → ambiguity → escalation → David abandons
      [
        record(1, "i1", "recorded", { ...BRANCH_SPEC }),
        record(2, "i1", "execution-started", {}),
        record(3, "i1", "ambiguity-recorded", { reason: "unknown" }),
        record(4, "i1", "escalated", { reason: "unknown" }),
        record(5, "i1", "abandoned", { reason: "David: not worth retrying" }, DAVID_ACTOR),
      ],
      // clean failure
      [
        record(1, "i1", "recorded", { ...BRANCH_SPEC }),
        record(2, "i1", "execution-started", {}),
        record(3, "i1", "failed", { via: "response", reason: "refused" }),
      ],
    ];
    for (const walk of walks) {
      expect(verifyIntentLog(walk)).toEqual([]);
    }
  });

  it("refuses a duplicate recorded row (intent ids are unique forever)", () => {
    const view = viewAfter(happyWalk());
    const decision = decideIntentAppend(view, {
      intentId: "i1",
      event: "recorded",
      actor: "x",
      payload: { ...BRANCH_SPEC },
    });
    expect(decision.ok).toBe(false);
  });

  it("refuses any event as an intent's first row except recorded", () => {
    const decision = decideIntentAppend(new Map(), {
      intentId: "ghost",
      event: "execution-started",
      actor: "x",
      payload: {},
    });
    expect(decision.ok).toBe(false);
  });

  it.each([
    ["confirmed from recorded", happyWalk().slice(0, 1), "confirmed"],
    ["execution-started from confirmed", happyWalk(), "execution-started"],
    ["re-armed from recorded", happyWalk().slice(0, 1), "re-armed"],
    ["escalated from execution-started", happyWalk().slice(0, 2), "escalated"],
    ["retry-authorized from execution-started", happyWalk().slice(0, 2), "retry-authorized"],
    ["abandoned from confirmed", happyWalk(), "abandoned"],
  ] as const)("refuses %s", (_name, walk, event) => {
    const view = viewAfter([...walk]);
    const payloads: Record<string, Record<string, unknown>> = {
      confirmed: { via: "response", result: {}, note: "n" },
      "execution-started": {},
      "re-armed": { note: "n", resetBeforeUse: false },
      escalated: { reason: "r" },
      "retry-authorized": { reason: "r" },
      abandoned: { reason: "r" },
    };
    const decision = decideIntentAppend(view, {
      intentId: "i1",
      event,
      actor: DAVID_ACTOR,
      payload: payloads[event]!,
    });
    expect(decision.ok).toBe(false);
  });

  it("binds retry-authorized and abandoned to the David actor", () => {
    const parked = [
      record(1, "i1", "recorded", { ...BRANCH_SPEC }),
      record(2, "i1", "execution-started", {}),
      record(3, "i1", "ambiguity-recorded", { reason: "unknown" }),
      record(4, "i1", "escalated", { reason: "unknown" }),
    ];
    const view = viewAfter(parked);
    for (const event of ["retry-authorized", "abandoned"] as const) {
      const denied = decideIntentAppend(view, {
        intentId: "i1",
        event,
        actor: "camino:recovery",
        payload: { reason: "r" },
      });
      expect(denied.ok).toBe(false);
      const allowed = decideIntentAppend(view, {
        intentId: "i1",
        event,
        actor: DAVID_ACTOR,
        payload: { reason: "r" },
      });
      expect(allowed.ok).toBe(true);
    }
  });

  it("refuses malformed event payloads (closed schemas per event)", () => {
    const afterBarrier = viewAfter(happyWalk().slice(0, 2));
    const cases: IntentAppendInput[] = [
      // confirmed without via
      {
        intentId: "i1",
        event: "confirmed",
        actor: "x",
        payload: { result: {}, note: "n" },
      },
      // confirmed with a non-primitive result value
      {
        intentId: "i1",
        event: "confirmed",
        actor: "x",
        payload: { via: "response", result: { nested: {} }, note: "n" },
      },
      // re-armed without resetBeforeUse
      { intentId: "i1", event: "re-armed", actor: "x", payload: { note: "n" } },
      // ambiguity without reason
      { intentId: "i1", event: "ambiguity-recorded", actor: "x", payload: {} },
    ];
    for (const input of cases) {
      expect(decideIntentAppend(afterBarrier, input).ok, input.event).toBe(false);
    }
    // execution-started payload is exactly empty
    const fresh = viewAfter(happyWalk().slice(0, 1));
    expect(
      decideIntentAppend(fresh, {
        intentId: "i1",
        event: "execution-started",
        actor: "x",
        payload: { surprise: 1 },
      }).ok,
    ).toBe(false);
  });

  it("refuses an invalid spec on recorded (validation happens at the boundary)", () => {
    const decision = decideIntentAppend(new Map(), {
      intentId: "i1",
      event: "recorded",
      actor: "x",
      payload: { op: "branch-create", repo: "r", branch: "b", targetSha: "short" },
    });
    expect(decision.ok).toBe(false);
  });
});

describe("folding", () => {
  it("tracks status, execution count, result, and ambiguity through the recovery walk", () => {
    const walk = [
      record(1, "i1", "recorded", { ...BRANCH_SPEC }),
      record(2, "i1", "execution-started", {}),
      record(3, "i1", "re-armed", { note: "absent", resetBeforeUse: false }),
      record(4, "i1", "execution-started", {}),
      record(5, "i1", "confirmed", {
        via: "reconciliation",
        result: { branch: "camino/issue-1" },
        note: "observed",
      }),
    ];
    const view = foldIntentView(walk);
    const entry = view.get("i1")!;
    expect(entry.status).toBe("confirmed");
    expect(entry.executionStartedCount).toBe(2);
    expect(entry.confirmedVia).toBe("reconciliation");
    expect(entry.result).toEqual({ branch: "camino/issue-1" });
    expect(entry.spec).toEqual(BRANCH_SPEC);
  });

  it("records the ambiguity reason on the entry", () => {
    const walk = [
      record(1, "i1", "recorded", { ...BRANCH_SPEC }),
      record(2, "i1", "execution-started", {}),
      record(3, "i1", "ambiguity-recorded", { reason: "lost response" }),
    ];
    const view = foldIntentView(walk);
    expect(view.get("i1")!.ambiguityReason).toBe("lost response");
    expect(view.get("i1")!.status).toBe("ambiguity-recorded");
  });

  it("applyIntentRecord refuses folding events for unknown intents", () => {
    const view: IntentView = new Map();
    expect(() => applyIntentRecord(view, record(1, "ghost", "execution-started", {}))).toThrow(
      /unknown intent/,
    );
  });
});

describe("verifyIntentLog (the fail-closed recovery gate)", () => {
  it("returns [] for a legal history", () => {
    expect(verifyIntentLog(happyWalk())).toEqual([]);
  });

  it("flags an illegal transition in the middle of a history", () => {
    const tampered = [
      record(1, "i1", "recorded", { ...BRANCH_SPEC }),
      record(2, "i1", "confirmed", { via: "response", result: {}, note: "forged" }),
    ];
    const divergences = verifyIntentLog(tampered);
    expect(divergences).toHaveLength(1);
    expect(divergences[0]!.seq).toBe(2);
  });

  it("flags non-increasing seq (reordered or duplicated rows)", () => {
    const walk = happyWalk();
    const reordered = [walk[0]!, { ...walk[1]!, seq: 1 }, walk[2]!];
    const divergences = verifyIntentLog(reordered);
    expect(divergences.some((d) => /strictly increasing/.test(d.problem))).toBe(true);
  });

  it("flags a David-bound row appended by another actor", () => {
    const tampered = [
      record(1, "i1", "recorded", { ...BRANCH_SPEC }),
      record(2, "i1", "execution-started", {}),
      record(3, "i1", "ambiguity-recorded", { reason: "r" }),
      record(4, "i1", "escalated", { reason: "r" }),
      record(5, "i1", "retry-authorized", { reason: "r" }, "camino:executor"),
    ];
    const divergences = verifyIntentLog(tampered);
    expect(divergences).toHaveLength(1);
    expect(divergences[0]!.problem).toMatch(/David/);
  });
});

describe("intent-id grammar and token containment (round 2, finding 1)", () => {
  it("refuses ids carrying token delimiters or other out-of-grammar characters", () => {
    for (const bad of [
      "intent-A]foreign",
      "bad[id",
      "a:b",
      "a b",
      "",
      "x".repeat(129),
      "a\u0000b",
    ]) {
      const decision = decideIntentAppend(new Map(), {
        intentId: bad,
        event: "recorded",
        actor: "x",
        payload: { ...BRANCH_SPEC },
      });
      expect(decision.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(isValidIntentId("intent-A.2_ok")).toBe(true);
  });

  it("token containment is impossible for distinct grammar-legal ids", () => {
    // Adversarial pairs: prefixes, suffixes, dotted extensions — under the
    // grammar no id's token can contain another's.
    const ids = ["intent-A", "intent-A2", "intent-A.b", "A", "intent", "intent-A-foreign"];
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        expect(
          intentMarkerToken(b).includes(intentMarkerToken(a)),
          `${b} token contains ${a} token`,
        ).toBe(false);
        expect(
          correlationToken(b).includes(correlationToken(a)),
          `${b} correlation contains ${a} correlation`,
        ).toBe(false);
      }
    }
  });
});

describe("round-5 regression: prototype-backed specs (finding 1)", () => {
  it("refuses specs whose fields are inherited — validator and fold must see the same object", () => {
    // The reviewer's probe: every declared field lives on the PROTOTYPE,
    // so an `in` check passes while the canonical JSON form is {}.
    const inherited = Object.create({ ...BRANCH_SPEC }) as Record<string, unknown>;
    expect(validateOperationSpec(inherited, "i1").ok).toBe(false);
    const decision = decideIntentAppend(new Map(), {
      intentId: "i1",
      event: "recorded",
      actor: "x",
      payload: inherited,
    });
    expect(decision.ok).toBe(false);
  });

  it("refuses class instances while accepting null-prototype and literal objects", () => {
    class SpecLike {
      op = "catch-all";
      description = "d";
    }
    expect(validateOperationSpec(new SpecLike()).ok).toBe(false);
    const nullProto = Object.assign(Object.create(null), {
      op: "catch-all",
      description: "d",
    }) as Record<string, unknown>;
    expect(validateOperationSpec(nullProto).ok).toBe(true);
    expect(validateOperationSpec({ op: "catch-all", description: "d" }).ok).toBe(true);
  });
});
