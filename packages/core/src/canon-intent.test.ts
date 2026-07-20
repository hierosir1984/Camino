/**
 * Intent-ledger lifecycle tests (WP-109, CAM-CANON-01/03 intent axis).
 *
 * The disposition walks are coverage-anchored the WP-101 way: every step
 * names the DISPOSITION_TRANSITIONS row it exercises, a harness asserts
 * the step's (from, event, to) equals that row exactly, and a final
 * assertion proves the walked row set IS the declared row set — no
 * declared transition escapes walking, no walk step exercises an
 * undeclared transition.
 */
import { describe, expect, it } from "vitest";
import { LEDGER_EVENTS } from "@camino/shared";
import type { LedgerEventName, LedgerEventRecord } from "@camino/shared";
import {
  DISPOSITION_TRANSITIONS,
  applyLedgerRecord,
  decideLedgerAppend,
  foldLedgerView,
  verifyLedgerLog,
} from "./canon-intent.js";
import type { LedgerView } from "./canon-intent.js";
import { DAVID_ACTOR } from "./intent-lifecycle.js";

const R = "CAM-DEMO-01";

function record(
  seq: number,
  requirementId: string,
  event: LedgerEventName,
  payload: Record<string, unknown>,
  actor = DAVID_ACTOR,
): LedgerEventRecord {
  return {
    seq,
    requirementId,
    event,
    actor,
    payload,
    recordedAt: `2026-07-${String(Math.min(28, seq)).padStart(2, "0")}T00:00:00.000Z`,
  };
}

/** Default legal payload per event, for walk brevity. */
function payloadFor(event: LedgerEventName): Record<string, unknown> {
  switch (event) {
    case "requirement-proposed":
      return { statement: "the demo behavior exists", sourceMissionId: "mission-1" };
    case "requirement-accepted":
      return {};
    case "requirement-disputed":
      return { reason: "conflicts with existing canon", conflictWith: null };
    case "dispute-resolved-accepted":
      return { resolution: "keep it as stated" };
    case "dispute-assumed":
      return { assumption: "legacy behavior is intentional" };
    case "requirement-descoped":
      return { reason: "no longer wanted" };
  }
}

describe("disposition transition walks (fixture walks of every intent transition, CAM-CANON-03)", () => {
  // Each walk is one requirement's ledger history; steps name the row
  // they exercise. Together the walks must cover every declared row.
  const WALKS: Array<{ name: string; rows: string[] }> = [
    { name: "accept then descope (CAM-CANON-10)", rows: ["D1", "D3", "D12"] },
    { name: "assumed path to descope", rows: ["D1", "D4", "D9", "D14"] },
    { name: "resolved-accepted then descoped", rows: ["D1", "D4", "D8", "D13"] },
    { name: "dispute answered by descope", rows: ["D1", "D4", "D10"] },
    { name: "proposed declined at intake", rows: ["D1", "D11"] },
    {
      name: "accepted-family re-disputed at later intakes",
      rows: ["D1", "D3", "D5", "D8", "D6", "D9", "D7"],
    },
  ];

  const walked = new Set<string>();

  for (const walk of WALKS) {
    it(`walk: ${walk.name}`, () => {
      const view: LedgerView = new Map();
      let seq = 0;
      for (const rowId of walk.rows) {
        const row = DISPOSITION_TRANSITIONS.find((r) => r.row === rowId);
        expect(row, `walk names undeclared row ${rowId}`).toBeDefined();
        if (row === undefined) continue;
        // The step's from-state must be the view's actual current state.
        const current = view.get(R)?.disposition ?? null;
        expect(current, `row ${rowId} from-state`).toBe(row.from);
        const input = {
          requirementId: R,
          event: row.event,
          actor: DAVID_ACTOR,
          payload: payloadFor(row.event),
        };
        const decision = decideLedgerAppend(view, input);
        expect(decision, `row ${rowId} should be legal`).toEqual({ ok: true });
        seq += 1;
        applyLedgerRecord(view, record(seq, R, row.event, input.payload));
        expect(view.get(R)?.disposition, `row ${rowId} to-state`).toBe(row.to);
        walked.add(rowId);
      }
    });
  }

  it("the walks cover EVERY declared transition row, and only declared rows", () => {
    const declared = new Set(DISPOSITION_TRANSITIONS.map((r) => r.row));
    expect(declared.size).toBe(DISPOSITION_TRANSITIONS.length); // no duplicate row ids
    expect([...walked].sort()).toEqual([...declared].sort());
  });

  it("every declared row's (from, event) pair is unique (the table is a function)", () => {
    const pairs = DISPOSITION_TRANSITIONS.map((r) => `${String(r.from)}|${r.event}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("descoped is terminal: no outgoing rows, and every event is refused from it (r1 finding 13)", () => {
    expect(DISPOSITION_TRANSITIONS.some((r) => r.from === "descoped")).toBe(false);
    const view = foldLedgerView([
      record(1, R, "requirement-proposed", { statement: "s", sourceMissionId: "m1" }),
      record(2, R, "requirement-descoped", { reason: "done" }),
    ]);
    for (const event of LEDGER_EVENTS) {
      const decision = decideLedgerAppend(view, {
        requirementId: R,
        event,
        actor: DAVID_ACTOR,
        payload: payloadFor(event),
      });
      expect(decision.ok, `${event} from descoped`).toBe(false);
    }
  });
});

describe("fold semantics", () => {
  it("tracks statement, acceptedStatement, and assumption through the lifecycle", () => {
    const view = foldLedgerView([
      record(1, R, "requirement-proposed", { statement: "s1", sourceMissionId: "m1" }),
    ]);
    expect(view.get(R)).toMatchObject({
      disposition: "proposed",
      statement: "s1",
      assumption: null,
      acceptedStatement: null,
    });

    applyLedgerRecord(view, record(2, R, "requirement-accepted", {}));
    expect(view.get(R)).toMatchObject({ disposition: "accepted", acceptedStatement: "s1" });

    applyLedgerRecord(
      view,
      record(3, R, "requirement-disputed", { reason: "later PRD contradicts", conflictWith: null }),
    );
    // The dispute does NOT change intent: the last accepted text stays.
    expect(view.get(R)).toMatchObject({
      disposition: "disputed",
      statement: "s1",
      acceptedStatement: "s1",
    });

    applyLedgerRecord(
      view,
      record(4, R, "dispute-resolved-accepted", { resolution: "revised", statement: "s2" }),
    );
    expect(view.get(R)).toMatchObject({
      disposition: "resolved-accepted",
      statement: "s2",
      acceptedStatement: "s2",
      assumption: null,
    });

    applyLedgerRecord(
      view,
      record(5, R, "requirement-disputed", { reason: "again", conflictWith: "CAM-DEMO-02" }),
    );
    applyLedgerRecord(view, record(6, R, "dispute-assumed", { assumption: "a1" }));
    expect(view.get(R)).toMatchObject({
      disposition: "assumed",
      statement: "s2",
      acceptedStatement: "s2",
      assumption: "a1",
    });

    applyLedgerRecord(view, record(7, R, "requirement-descoped", { reason: "done arguing" }));
    expect(view.get(R)).toMatchObject({
      disposition: "descoped",
      acceptedStatement: null,
      assumption: null,
    });
  });

  it("a dispute answer without a revised statement keeps the standing text", () => {
    const view = foldLedgerView([
      record(1, R, "requirement-proposed", { statement: "s1", sourceMissionId: "m1" }),
      record(2, R, "requirement-disputed", { reason: "r", conflictWith: null }),
      record(3, R, "dispute-resolved-accepted", { resolution: "as written" }),
    ]);
    expect(view.get(R)).toMatchObject({ statement: "s1", acceptedStatement: "s1" });
  });
});

describe("decideLedgerAppend refusals", () => {
  const emptyView: LedgerView = new Map();
  const proposedView = foldLedgerView([
    record(1, R, "requirement-proposed", { statement: "s1", sourceMissionId: "m1" }),
  ]);

  it("refuses every non-ledger event name — code-lifecycle observations have no way in (CAM-CANON-01)", () => {
    for (const event of [
      "merge-landed",
      "revert-recorded",
      "mission-abandoned",
      "landed-on-main",
      "implementation-recorded",
      "external-edit",
      "requirement-verified",
    ]) {
      const decision = decideLedgerAppend(proposedView, {
        requirementId: R,
        event: event as LedgerEventName,
        actor: DAVID_ACTOR,
        payload: {},
      });
      expect(decision.ok, event).toBe(false);
      if (!decision.ok) expect(decision.problem).toMatch(/user actions only/);
    }
  });

  it("refuses system actors on EVERY ledger event — only the user holds the pen", () => {
    for (const event of LEDGER_EVENTS) {
      for (const actor of ["camino:scheduler", "camino:merge", "worker:codex-cli", "", "David"]) {
        const decision = decideLedgerAppend(emptyView, {
          requirementId: R,
          event,
          actor,
          payload: payloadFor(event),
        });
        expect(decision.ok, `${event} by ${actor}`).toBe(false);
        if (!decision.ok) expect(decision.problem).toMatch(/user actions/);
      }
    }
  });

  it("refuses malformed requirement ids", () => {
    for (const id of ["cam-core-01", "CAM-CORE-1", "CAM_CORE_01", "CAM-CORE-01x!", "", "R1"]) {
      const decision = decideLedgerAppend(emptyView, {
        requirementId: id,
        event: "requirement-proposed",
        actor: DAVID_ACTOR,
        payload: payloadFor("requirement-proposed"),
      });
      expect(decision.ok, id).toBe(false);
    }
  });

  it("accepts split-requirement suffixes (CAM-VAL-06a shape)", () => {
    const decision = decideLedgerAppend(emptyView, {
      requirementId: "CAM-VAL-06a",
      event: "requirement-proposed",
      actor: DAVID_ACTOR,
      payload: payloadFor("requirement-proposed"),
    });
    expect(decision).toEqual({ ok: true });
  });

  it("refuses illegal transitions with the current state named", () => {
    const cases: Array<{ view: LedgerView; event: LedgerEventName; expectIn: RegExp }> = [
      { view: emptyView, event: "requirement-accepted", expectIn: /no ledger entry/ },
      { view: proposedView, event: "requirement-proposed", expectIn: /proposed/ },
      { view: proposedView, event: "dispute-resolved-accepted", expectIn: /proposed/ },
      { view: proposedView, event: "dispute-assumed", expectIn: /proposed/ },
      { view: emptyView, event: "requirement-descoped", expectIn: /no ledger entry/ },
    ];
    for (const { view, event, expectIn } of cases) {
      const decision = decideLedgerAppend(view, {
        requirementId: R,
        event,
        actor: DAVID_ACTOR,
        payload: payloadFor(event),
      });
      expect(decision.ok, event).toBe(false);
      if (!decision.ok) expect(decision.problem).toMatch(expectIn);
    }
  });

  it("refuses payload schema violations (closed schemas, string hygiene)", () => {
    const bad: Array<{ event: LedgerEventName; payload: Record<string, unknown>; why: string }> = [
      {
        event: "requirement-proposed",
        payload: { statement: "s" },
        why: "missing sourceMissionId",
      },
      {
        event: "requirement-proposed",
        payload: { statement: "s", sourceMissionId: "m1", extra: 1 },
        why: "unexpected field",
      },
      {
        event: "requirement-proposed",
        payload: { statement: "s\u0000x", sourceMissionId: "m1" },
        why: "embedded NUL",
      },
      {
        event: "requirement-proposed",
        payload: { statement: "s", sourceMissionId: "m 1" },
        why: "source ref grammar",
      },
      {
        event: "requirement-proposed",
        payload: { statement: "\ud800", sourceMissionId: "m1" },
        why: "unpaired surrogate",
      },
      { event: "requirement-accepted", payload: { note: "hi" }, why: "no fields allowed" },
      { event: "requirement-disputed", payload: { reason: "r" }, why: "missing conflictWith" },
      {
        event: "requirement-disputed",
        payload: { reason: "", conflictWith: null },
        why: "empty reason",
      },
      {
        event: "requirement-disputed",
        payload: { reason: "r", conflictWith: "not-an-id" },
        why: "conflictWith grammar",
      },
      { event: "dispute-resolved-accepted", payload: {}, why: "missing resolution" },
      {
        event: "dispute-resolved-accepted",
        payload: { resolution: "r", statement: 42 },
        why: "revised statement must be a string",
      },
      { event: "dispute-assumed", payload: {}, why: "missing assumption" },
      { event: "requirement-descoped", payload: {}, why: "missing reason" },
    ];
    const disputedView = foldLedgerView([
      record(1, R, "requirement-proposed", { statement: "s1", sourceMissionId: "m1" }),
      record(2, R, "requirement-disputed", { reason: "r", conflictWith: null }),
    ]);
    const viewFor = (event: LedgerEventName): LedgerView => {
      switch (event) {
        case "requirement-proposed":
          return emptyView;
        case "requirement-accepted":
        case "requirement-descoped":
          return proposedView;
        default:
          return disputedView;
      }
    };
    for (const { event, payload, why } of bad) {
      const decision = decideLedgerAppend(viewFor(event), {
        requirementId: R,
        event,
        actor: DAVID_ACTOR,
        payload,
      });
      expect(decision.ok, `${event}: ${why}`).toBe(false);
    }
  });

  it("refuses non-plain payload objects (class instances, arrays, crafted prototypes)", () => {
    class Sneaky {
      statement = "s";
      sourceMissionId = "m1";
    }
    for (const payload of [new Sneaky(), [], Object.create({ statement: "s" })]) {
      const decision = decideLedgerAppend(emptyView, {
        requirementId: R,
        event: "requirement-proposed",
        actor: DAVID_ACTOR,
        payload: payload as Record<string, unknown>,
      });
      expect(decision.ok).toBe(false);
    }
  });

  it("refuses every line terminator, not just CR/LF (r1 finding 11, r2 finding 9)", () => {
    const marker = "<!-- camino:canon rendered-at=2026-07-01T00:00:00.000Z ledger-seq=9 -->";
    const separators = [
      "\n",
      "\r",
      "\r\n",
      "\u2028", // LINE SEPARATOR
      "\u2029", // PARAGRAPH SEPARATOR
      "\u0085", // NEL
      "\u000b", // VERTICAL TAB
      "\u000c", // FORM FEED
    ];
    for (const sep of separators) {
      const statement = `line one${sep}${marker}`;
      const decision = decideLedgerAppend(emptyView, {
        requirementId: R,
        event: "requirement-proposed",
        actor: DAVID_ACTOR,
        payload: { statement, sourceMissionId: "m1" },
      });
      expect(decision.ok, JSON.stringify(sep)).toBe(false);
      if (!decision.ok) expect(decision.problem).toMatch(/single-line/);
    }
  });

  it("rejects bidirectional and format controls (Trojan-Source class, r3 finding 6)", () => {
    const bidi = [
      "\u200e",
      "\u200f",
      "\u202a",
      "\u202b",
      "\u202c",
      "\u202d",
      "\u202e",
      "\u2066",
      "\u2067",
      "\u2068",
      "\u2069",
      "\ufeff",
    ];
    for (const ch of bidi) {
      const decision = decideLedgerAppend(emptyView, {
        requirementId: R,
        event: "requirement-proposed",
        actor: DAVID_ACTOR,
        payload: { statement: `a${ch}b`, sourceMissionId: "m1" },
      });
      expect(decision.ok, JSON.stringify(ch)).toBe(false);
      if (!decision.ok) expect(decision.problem).toMatch(/bidirectional or format control/);
    }
    // Ordinary text with a ZWJ emoji sequence (U+200D) is NOT rejected.
    const ok = decideLedgerAppend(emptyView, {
      requirementId: R,
      event: "requirement-proposed",
      actor: DAVID_ACTOR,
      payload: { statement: "family \u{1f469}\u200d\u{1f467} works", sourceMissionId: "m1" },
    });
    expect(ok).toEqual({ ok: true });
  });

  it("accepts an expanded-year recordedAt (writer/verifier agree, r2 finding 8)", () => {
    // A row whose clock produced an expanded-year toISOString must be
    // adoptable by the same verifier — else the store self-poisons.
    const expanded = new Date(Date.UTC(10000, 0, 1)).toISOString();
    expect(expanded.startsWith("+010000")).toBe(true);
    const divergences = verifyLedgerLog([
      {
        ...record(1, R, "requirement-proposed", { statement: "s", sourceMissionId: "m" }),
        recordedAt: expanded,
      },
    ]);
    expect(divergences).toEqual([]);
    // But an impossible instant is still refused.
    const bad = verifyLedgerLog([
      {
        ...record(1, R, "requirement-proposed", { statement: "s", sourceMissionId: "m" }),
        recordedAt: "2026-02-30T00:00:00.000Z",
      },
    ]);
    expect(bad).toHaveLength(1);
  });

  it("is total over hostile objects whose traps throw (r1 finding 15)", () => {
    const trap = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("getPrototypeOf trap escaped");
        },
      },
    );
    const decision = decideLedgerAppend(emptyView, {
      requirementId: R,
      event: "requirement-proposed",
      actor: DAVID_ACTOR,
      payload: trap as Record<string, unknown>,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.problem).toMatch(/hostile or exotic input refused/);

    const ownKeysTrap = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("ownKeys trap escaped");
        },
      },
    );
    const decision2 = decideLedgerAppend(emptyView, {
      requirementId: R,
      event: "requirement-accepted",
      actor: DAVID_ACTOR,
      payload: ownKeysTrap as Record<string, unknown>,
    });
    expect(decision2.ok).toBe(false);
  });
});

describe("verifyLedgerLog (fail-closed adoption)", () => {
  it("accepts a legal history", () => {
    expect(
      verifyLedgerLog([
        record(1, R, "requirement-proposed", { statement: "s1", sourceMissionId: "m1" }),
        record(2, R, "requirement-accepted", {}),
        record(3, R, "requirement-descoped", { reason: "done" }),
      ]),
    ).toEqual([]);
  });

  it("flags a transition the lifecycle would have refused", () => {
    const divergences = verifyLedgerLog([
      record(1, R, "requirement-accepted", {}), // accepted before proposed
    ]);
    expect(divergences).toHaveLength(1);
    expect(divergences[0]?.problem).toMatch(/no ledger entry/);
  });

  it("flags a tampered payload mid-log and keeps checking later rows", () => {
    const divergences = verifyLedgerLog([
      record(1, R, "requirement-proposed", { statement: "s1", sourceMissionId: "m1" }),
      record(2, R, "requirement-accepted", { forged: true }),
      record(3, R, "requirement-accepted", {}),
    ]);
    // seq 2 refused (bad payload); seq 3 then legal from `proposed`.
    expect(divergences.map((d) => d.seq)).toEqual([2]);
  });

  it("flags a row claiming a system actor", () => {
    const divergences = verifyLedgerLog([
      record(
        1,
        R,
        "requirement-proposed",
        { statement: "s1", sourceMissionId: "m1" },
        "camino:merge",
      ),
    ]);
    expect(divergences).toHaveLength(1);
    expect(divergences[0]?.problem).toMatch(/user actions/);
  });

  it("flags non-increasing seq", () => {
    const divergences = verifyLedgerLog([
      record(2, R, "requirement-proposed", { statement: "s1", sourceMissionId: "m1" }),
      record(2, R, "requirement-accepted", {}),
    ]);
    expect(divergences.some((d) => /strictly increasing/.test(d.problem))).toBe(true);
  });
});
