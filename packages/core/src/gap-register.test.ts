/**
 * Gap-register projection + disposition decision tests (WP-122,
 * CAM-CANON-05 acceptance, core layer):
 *
 *  - register MEMBERSHIP is derived: accepted-family intent not
 *    demonstrably delivered ⇒ row; everything else ⇒ no row;
 *  - the row's tuple is the status projection's answer verbatim, and
 *    provenance cites context-relevant facts only;
 *  - WAIVABILITY is derived from detector provenance, and
 *    `decideGapDisposition` refuses a waiver anywhere else — the
 *    CAM-CANON-05 sentence as a mechanical check;
 *  - BASIS BINDING: disposition events govern only while the state they
 *    recorded still holds; new facts recompute the fold.
 *
 * The daemon-side store/service/HTTP layers re-assert the same rules
 * end-to-end (gap-dispositions.test.ts, register-service.test.ts, and
 * the Playwright suite).
 */
import { describe, expect, it } from "vitest";
import type {
  CanonFactKind,
  CanonFactRecord,
  GapDispositionAppendInput,
  GapDispositionEventName,
  GapDispositionRecord,
  StatusContext,
  StatusTuple,
} from "@camino/shared";
import { DETECTOR_ACTOR_PREFIX } from "@camino/shared";
import { foldLedgerView } from "./canon-intent.js";
import type { LedgerView } from "./canon-intent.js";
import { validateCanonFact } from "./canon-status.js";
import {
  decideGapDisposition,
  gapDispositionPayloadProblem,
  projectGapRegister,
  statusTupleEquals,
  statusTupleProblem,
  verifyGapDispositionLog,
} from "./gap-register.js";
import type { GapRegisterRow } from "./gap-register.js";
import { DAVID_ACTOR } from "./intent-lifecycle.js";

const R1 = "CAM-DEMO-01";
const R2 = "CAM-DEMO-02";
const R3 = "CAM-OTHER-01";

const sha = (c: string): string => c.repeat(40);
const HEAD = sha("d");
const BASE = sha("2");
const MAIN: StatusContext = { kind: "main", headSha: HEAD };

const DETECTOR = `${DETECTOR_ACTOR_PREFIX}todo-scan`;
const RECONCILER = "camino:reconciler";

function ledgerView(
  entries: ReadonlyArray<{ id: string; disposition: "proposed" | "accepted" | "descoped" }>,
): LedgerView {
  let seq = 0;
  const records = entries.flatMap((entry) => {
    const rows = [
      {
        seq: ++seq,
        requirementId: entry.id,
        event: "requirement-proposed" as const,
        actor: DAVID_ACTOR,
        payload: { statement: `${entry.id} behavior`, sourceMissionId: "m1" },
        recordedAt: "2026-07-01T00:00:00.000Z",
      },
    ];
    if (entry.disposition === "accepted" || entry.disposition === "descoped") {
      rows.push({
        seq: ++seq,
        requirementId: entry.id,
        event: "requirement-accepted" as never,
        actor: DAVID_ACTOR,
        payload: {} as never,
        recordedAt: "2026-07-01T00:00:01.000Z",
      });
    }
    if (entry.disposition === "descoped") {
      rows.push({
        seq: ++seq,
        requirementId: entry.id,
        event: "requirement-descoped" as never,
        actor: DAVID_ACTOR,
        payload: { reason: "out of scope" } as never,
        recordedAt: "2026-07-01T00:00:02.000Z",
      });
    }
    return rows;
  });
  return foldLedgerView(records);
}

class FactLog {
  readonly records: CanonFactRecord[] = [];
  #seq = 0;

  add(requirementId: string, kind: CanonFactKind, actor: string, payload: Record<string, unknown>) {
    this.#seq += 1;
    const record: CanonFactRecord = {
      seq: this.#seq,
      requirementId,
      kind,
      actor,
      payload,
      recordedAt: "2026-07-02T00:00:00.000Z",
    };
    const validation = validateCanonFact(record);
    if (!validation.ok) throw new Error(`fixture bug: ${validation.problem}`);
    this.records.push(record);
    return record;
  }
}

/** Default context for fixtures whose payload omits `contextKey`. */
const withContext = (payload: Record<string, unknown>): Record<string, unknown> =>
  "contextKey" in payload ? payload : { ...payload, contextKey: "main" };

class DispositionLog {
  readonly records: GapDispositionRecord[] = [];
  #seq = 0;

  add(
    requirementId: string,
    event: GapDispositionEventName,
    payload: Record<string, unknown>,
    // Disposition timestamps default AFTER the FactLog's (2026-07-02) so an
    // honest waiver is recorded no earlier than the finding it waives; a
    // pre-seed test passes an earlier value explicitly.
    recordedAt = "2026-07-03T00:00:00.000Z",
  ): GapDispositionRecord {
    this.#seq += 1;
    const record: GapDispositionRecord = {
      seq: this.#seq,
      requirementId,
      event,
      actor: DAVID_ACTOR,
      payload: withContext(payload),
      recordedAt,
    };
    const divergences = verifyGapDispositionLog([record]);
    // Deliberately-bad fixtures skip the guard by writing records directly.
    if (divergences.length > 0) throw new Error(`fixture bug: ${divergences[0]!.problem}`);
    this.records.push(record);
    return record;
  }
}

const openTuple = (disposition: StatusTuple["disposition"] = "accepted"): StatusTuple => ({
  disposition,
  implementation: { kind: "absent" },
  evidence: "unverified",
});

const suspectedTuple = (): StatusTuple => ({
  disposition: "accepted",
  implementation: { kind: "suspected-absent" },
  evidence: "unverified",
});

function project(
  view: LedgerView,
  facts: FactLog = new FactLog(),
  dispositions: DispositionLog = new DispositionLog(),
  context: StatusContext = MAIN,
): GapRegisterRow[] {
  return projectGapRegister(view, facts.records, dispositions.records, context);
}

describe("register membership (CAM-CANON-05: rows are derived, never stored)", () => {
  it("lists an accepted requirement with no facts as an open gap (absent, unverified)", () => {
    const rows = project(ledgerView([{ id: R1, disposition: "accepted" }]));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.requirementId).toBe(R1);
    expect(row.statement).toBe(`${R1} behavior`);
    expect(row.tuple).toEqual(openTuple());
    expect(row.disposition).toBe("open");
    expect(row.dispositionRecord).toBeNull();
    expect(row.waivableThroughSeq).toBeNull();
    expect(row.provenance).toEqual([]);
  });

  it("excludes proposed and descoped intent — the register holds accepted-family gaps only", () => {
    const rows = project(
      ledgerView([
        { id: R1, disposition: "proposed" },
        { id: R2, disposition: "descoped" },
        { id: R3, disposition: "accepted" },
      ]),
    );
    expect(rows.map((r) => r.requirementId)).toEqual([R3]);
  });

  it("excludes a delivered requirement (on-main × verified-live) and keeps evidence gaps", () => {
    const view = ledgerView([
      { id: R1, disposition: "accepted" },
      { id: R2, disposition: "accepted" },
    ]);
    const facts = new FactLog();
    // R1 delivered and proven at the context head.
    facts.add(R1, "landed-on-main", "camino:merge", { sha: HEAD });
    facts.add(R1, "verification-verdict", "camino:validation", {
      contextKind: "main",
      headSha: HEAD,
      baseSha: BASE,
      outcome: "pass",
    });
    // R2 landed but never verified — an evidence gap stays listed.
    facts.add(R2, "landed-on-main", "camino:merge", { sha: HEAD });
    const rows = project(view, facts);
    expect(rows.map((r) => r.requirementId)).toEqual([R2]);
    expect(rows[0]!.tuple.implementation).toEqual({ kind: "on-main" });
    expect(rows[0]!.tuple.evidence).toBe("unverified");
  });

  it("orders rows by requirement id", () => {
    const rows = project(
      ledgerView([
        { id: R3, disposition: "accepted" },
        { id: R1, disposition: "accepted" },
      ]),
    );
    expect(rows.map((r) => r.requirementId)).toEqual([R1, R3]);
  });
});

describe("evidence provenance (context-relevant facts + fired rules)", () => {
  it("cites main-context facts and excludes branch-only facts from a main row", () => {
    const view = ledgerView([{ id: R1, disposition: "accepted" }]);
    const facts = new FactLog();
    facts.add(R1, "requirement-touched", "camino:merge", { branch: "mission/m1", sha: sha("a") });
    const landing = facts.add(R1, "landed-on-main", "camino:merge", { sha: HEAD });
    const rows = project(view, facts);
    expect(rows[0]!.provenance.map((f) => f.seq)).toEqual([landing.seq]);
    expect(rows[0]!.firedRules.length).toBeGreaterThan(0);
  });

  it("lists outstanding detector findings and derives waivability from them", () => {
    const view = ledgerView([{ id: R1, disposition: "accepted" }]);
    const facts = new FactLog();
    const finding = facts.add(R1, "absence-suspected", DETECTOR, {
      contextKind: "main",
      reason: "todo-scan: unimplemented stub at src/x.ts:3",
    });
    const rows = project(view, facts);
    expect(rows[0]!.tuple.implementation).toEqual({ kind: "suspected-absent" });
    expect(rows[0]!.detectorFindings.map((f) => f.seq)).toEqual([finding.seq]);
    expect(rows[0]!.waivableThroughSeq).toBe(finding.seq);
  });

  it("a non-detector suspicion is never waivable (real doubt, not a detector false positive)", () => {
    const view = ledgerView([{ id: R1, disposition: "accepted" }]);
    const facts = new FactLog();
    facts.add(R1, "absence-suspected", RECONCILER, {
      contextKind: "main",
      reason: "external edit removed the implementing change",
    });
    const rows = project(view, facts);
    expect(rows[0]!.tuple.implementation).toEqual({ kind: "suspected-absent" });
    expect(rows[0]!.detectorFindings).toEqual([]);
    expect(rows[0]!.waivableThroughSeq).toBeNull();
  });

  it("mixed detector + non-detector suspicions are not waivable", () => {
    const view = ledgerView([{ id: R1, disposition: "accepted" }]);
    const facts = new FactLog();
    facts.add(R1, "absence-suspected", DETECTOR, { contextKind: "main", reason: "todo-scan hit" });
    facts.add(R1, "absence-suspected", RECONCILER, {
      contextKind: "main",
      reason: "external edit",
    });
    const rows = project(view, facts);
    expect(rows[0]!.waivableThroughSeq).toBeNull();
    expect(rows[0]!.detectorFindings).toHaveLength(1);
  });

  it("a resolution clears outstanding findings (waivability recomputes)", () => {
    const view = ledgerView([{ id: R1, disposition: "accepted" }]);
    const facts = new FactLog();
    facts.add(R1, "absence-suspected", DETECTOR, { contextKind: "main", reason: "todo-scan hit" });
    facts.add(R1, "absence-resolved", RECONCILER, { contextKind: "main", resolution: "present" });
    const rows = project(view, facts);
    expect(rows[0]!.tuple.implementation).toEqual({ kind: "absent" });
    expect(rows[0]!.detectorFindings).toEqual([]);
    expect(rows[0]!.waivableThroughSeq).toBeNull();
  });
});

describe("decideGapDisposition (CAM-CANON-05 enforcement)", () => {
  function rowsWithDetectorFinding(): { rows: GapRegisterRow[]; findingSeq: number } {
    const view = ledgerView([
      { id: R1, disposition: "accepted" },
      { id: R2, disposition: "accepted" },
    ]);
    const facts = new FactLog();
    const finding = facts.add(R1, "absence-suspected", DETECTOR, {
      contextKind: "main",
      reason: "todo-scan hit",
    });
    return { rows: project(view, facts), findingSeq: finding.seq };
  }

  const input = (
    over: Partial<GapDispositionAppendInput> & { payload?: Record<string, unknown> },
  ): GapDispositionAppendInput => {
    const { payload, ...rest } = over;
    return {
      requirementId: R2,
      event: "gap-fix-queued",
      actor: DAVID_ACTOR,
      ...rest,
      payload: withContext(payload ?? { tuple: openTuple(), reason: "queueing a fix" }),
    };
  };

  it("accepts fix-queued and disputed on any live row", () => {
    const { rows } = rowsWithDetectorFinding();
    expect(decideGapDisposition(rows, "main", input({}))).toEqual({ ok: true });
    expect(
      decideGapDisposition(
        rows,
        "main",
        input({ event: "gap-disputed", payload: { tuple: openTuple(), reason: "not a gap" } }),
      ),
    ).toEqual({ ok: true });
  });

  it("REFUSES a waiver on a row not backed solely by detector findings — the CAM-CANON-05 rule", () => {
    const { rows } = rowsWithDetectorFinding();
    const decision = decideGapDisposition(
      rows,
      "main",
      input({
        requirementId: R2, // a real unmet requirement: no detector finding behind it
        event: "gap-false-positive-waived",
        payload: { tuple: openTuple(), reason: "waiving", waivedThroughSeq: 1 },
      }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.problem).toContain("detector false");
  });

  it("accepts a waiver bound to the exact outstanding detector findings", () => {
    const { rows, findingSeq } = rowsWithDetectorFinding();
    const decision = decideGapDisposition(
      rows,
      "main",
      input({
        requirementId: R1,
        event: "gap-false-positive-waived",
        payload: {
          tuple: suspectedTuple(),
          reason: "stub is intentional",
          waivedThroughSeq: findingSeq,
        },
      }),
    );
    expect(decision).toEqual({ ok: true });
  });

  it("refuses a waiver naming the wrong finding seq", () => {
    const { rows, findingSeq } = rowsWithDetectorFinding();
    const decision = decideGapDisposition(
      rows,
      "main",
      input({
        requirementId: R1,
        event: "gap-false-positive-waived",
        payload: {
          tuple: suspectedTuple(),
          reason: "stub is intentional",
          waivedThroughSeq: findingSeq + 7,
        },
      }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.problem).toContain("binds");
  });

  it("refuses a disposition whose recorded tuple does not match the row (basis binding)", () => {
    const { rows } = rowsWithDetectorFinding();
    const decision = decideGapDisposition(
      rows,
      "main",
      input({
        requirementId: R1, // its tuple is suspected-absent, not the recorded absent
        payload: { tuple: openTuple(), reason: "queueing a fix" },
      }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.problem).toContain("basis");
  });

  it("refuses actions on requirements without a live row, reopen of an open row, wrong actors, and unknown events", () => {
    const { rows } = rowsWithDetectorFinding();
    expect(decideGapDisposition(rows, "main", input({ requirementId: R3 })).ok).toBe(false);
    expect(
      decideGapDisposition(
        rows,
        "main",
        input({ event: "gap-reopened", payload: { tuple: openTuple(), reason: "reopen" } }),
      ).ok,
    ).toBe(false); // R2 is already open
    expect(decideGapDisposition(rows, "main", input({ actor: "camino:scheduler" })).ok).toBe(false);
    expect(decideGapDisposition(rows, "main", input({ event: "waive" as never })).ok).toBe(false);
  });

  it("refuses malformed payloads: extra fields, multi-line reasons, missing tuple, bad waive seq", () => {
    const { rows, findingSeq } = rowsWithDetectorFinding();
    const cases: Array<Record<string, unknown>> = [
      { tuple: openTuple(), reason: "ok", extra: true },
      { tuple: openTuple(), reason: "two\nlines" },
      { reason: "no tuple" },
      { tuple: { disposition: "accepted" }, reason: "truncated tuple" },
    ];
    for (const payload of cases) {
      expect(decideGapDisposition(rows, "main", input({ payload })).ok).toBe(false);
    }
    expect(
      decideGapDisposition(
        rows,
        "main",
        input({
          requirementId: R1,
          event: "gap-false-positive-waived",
          payload: { tuple: suspectedTuple(), reason: "waive", waivedThroughSeq: 0.5 },
        }),
      ).ok,
    ).toBe(false);
    void findingSeq;
  });

  it("refuses hostile inputs (throwing traps) as clean decisions, never throws", () => {
    const { rows } = rowsWithDetectorFinding();
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("trap");
        },
      },
    ) as GapDispositionAppendInput;
    const decision = decideGapDisposition(rows, "main", hostile);
    expect(decision.ok).toBe(false);
  });
});

describe("disposition fold (basis binding: dispositions recompute like everything else)", () => {
  it("applies a fix-queued event while its recorded basis holds", () => {
    const view = ledgerView([{ id: R1, disposition: "accepted" }]);
    const dispositions = new DispositionLog();
    dispositions.add(R1, "gap-fix-queued", { tuple: openTuple(), reason: "queued" });
    const rows = project(view, new FactLog(), dispositions);
    expect(rows[0]!.disposition).toBe("fix-queued");
    expect(rows[0]!.dispositionRecord?.reason).toBe("queued");
  });

  it("recomputes to open when a new fact changes the tuple, and re-applies when the state returns", () => {
    // NOTE: the re-application on identical return is a v1 SEMANTICS CHOICE
    // pending David's ruling (see foldDisposition's "DECISION PENDING" note).
    // The recommendation is re-triage (no resurrection); if adopted, this
    // final expectation flips to "open" and the fold changes with it.
    const view = ledgerView([{ id: R1, disposition: "accepted" }]);
    const dispositions = new DispositionLog();
    dispositions.add(R1, "gap-fix-queued", { tuple: openTuple(), reason: "queued" });

    const changed = new FactLog();
    changed.add(R1, "absence-suspected", RECONCILER, { contextKind: "main", reason: "doubt" });
    expect(project(view, changed, dispositions)[0]!.disposition).toBe("open");

    const returned = new FactLog();
    returned.add(R1, "absence-suspected", RECONCILER, { contextKind: "main", reason: "doubt" });
    returned.add(R1, "absence-resolved", RECONCILER, {
      contextKind: "main",
      resolution: "present",
    });
    expect(project(view, returned, dispositions)[0]!.disposition).toBe("fix-queued");
  });

  it("a waiver stops governing when a NEW finding arrives, even with an identical tuple", () => {
    const view = ledgerView([{ id: R1, disposition: "accepted" }]);
    const facts = new FactLog();
    const first = facts.add(R1, "absence-suspected", DETECTOR, {
      contextKind: "main",
      reason: "todo-scan hit",
    });
    const dispositions = new DispositionLog();
    dispositions.add(R1, "gap-false-positive-waived", {
      tuple: suspectedTuple(),
      reason: "intentional stub",
      waivedThroughSeq: first.seq,
    });
    expect(project(view, facts, dispositions)[0]!.disposition).toBe("false-positive-waived");

    facts.add(R1, "absence-suspected", DETECTOR, {
      contextKind: "main",
      reason: "todo-scan: a second, different hit",
    });
    const rows = project(view, facts, dispositions);
    expect(rows[0]!.tuple).toEqual(suspectedTuple()); // same tuple…
    expect(rows[0]!.disposition).toBe("open"); // …but the waiver no longer binds
  });

  it("gap-reopened returns the row to open; a later-recorded non-matching basis is skipped", () => {
    const view = ledgerView([{ id: R1, disposition: "accepted" }]);
    const dispositions = new DispositionLog();
    dispositions.add(R1, "gap-fix-queued", { tuple: openTuple(), reason: "queued" });
    dispositions.add(R1, "gap-reopened", { tuple: openTuple(), reason: "changed my mind" });
    // Recorded against a state the row is not in — must not govern.
    dispositions.add(R1, "gap-disputed", { tuple: suspectedTuple(), reason: "stale basis" });
    const rows = project(view, new FactLog(), dispositions);
    expect(rows[0]!.disposition).toBe("open");
    expect(rows[0]!.dispositionRecord).toBeNull();
  });
});

describe("round-1 falsification regressions", () => {
  const branch = (name: string): StatusContext => ({
    kind: "branch",
    branch: name,
    headSha: HEAD,
    baseSha: BASE,
  });

  it("F5: a waiver recorded BEFORE the finding it names never springs to life (pre-seed via raw store)", () => {
    const view = ledgerView([{ id: R1, disposition: "accepted" }]);
    const dispositions = new DispositionLog();
    // Pre-seeded against a guessed future finding seq=1, recorded 2026-07-01
    // — BEFORE any detector fact exists.
    dispositions.add(
      R1,
      "gap-false-positive-waived",
      { tuple: suspectedTuple(), reason: "pre-seed", waivedThroughSeq: 1 },
      "2026-07-01T00:00:00.000Z",
    );
    // The detector finding arrives later (FactLog records at 2026-07-02) at seq 1.
    const facts = new FactLog();
    facts.add(R1, "absence-suspected", DETECTOR, { contextKind: "main", reason: "real hit" });
    const rows = project(view, facts, dispositions);
    expect(rows[0]!.tuple).toEqual(suspectedTuple()); // tuple + seq both match…
    expect(rows[0]!.disposition).toBe("open"); // …but the waiver predates the finding, so it is inert
  });

  it("F5: an honest waiver recorded after the finding does bind", () => {
    const view = ledgerView([{ id: R1, disposition: "accepted" }]);
    const facts = new FactLog();
    const finding = facts.add(R1, "absence-suspected", DETECTOR, {
      contextKind: "main",
      reason: "hit",
    });
    const dispositions = new DispositionLog(); // default recordedAt 2026-07-03 > finding's 2026-07-02
    dispositions.add(R1, "gap-false-positive-waived", {
      tuple: suspectedTuple(),
      reason: "intentional",
      waivedThroughSeq: finding.seq,
    });
    expect(project(view, facts, dispositions)[0]!.disposition).toBe("false-positive-waived");
  });

  it("F5 (round 3): an honest waiver at the SAME instant as the finding DOES bind (no-earlier-than)", () => {
    // A service-recorded waiver is co-timestamped with its finding when both
    // stores share a clock. The guard is "no earlier than", not "strictly
    // after": the honest path decided against the live projection, so a
    // same-instant waiver must bind — a strictly-after guard would persist it
    // as a successful-but-inert row (round 3, finding 4). The raw-store
    // BEFORE-the-finding pre-seed stays inert (asserted separately above).
    const view = ledgerView([{ id: R1, disposition: "accepted" }]);
    const facts = new FactLog(); // records at 2026-07-02T00:00:00.000Z
    facts.add(R1, "absence-suspected", DETECTOR, { contextKind: "main", reason: "hit" });
    const dispositions = new DispositionLog();
    dispositions.add(
      R1,
      "gap-false-positive-waived",
      { tuple: suspectedTuple(), reason: "co-timestamped honest waiver", waivedThroughSeq: 1 },
      "2026-07-02T00:00:00.000Z",
    );
    expect(project(view, facts, dispositions)[0]!.disposition).toBe("false-positive-waived");
  });

  it("F7: a disposition recorded in one context never governs another (main ↛ branch)", () => {
    const view = ledgerView([{ id: R1, disposition: "accepted" }]);
    const dispositions = new DispositionLog();
    // fix-queued in main, on the (accepted, absent, unverified) tuple.
    dispositions.add(R1, "gap-fix-queued", {
      tuple: openTuple(),
      contextKey: "main",
      reason: "main-context fix",
    });
    const facts = new FactLog();
    expect(project(view, facts, dispositions, MAIN)[0]!.disposition).toBe("fix-queued");
    // A branch with the SAME tuple must NOT inherit the main disposition.
    const branchRows = project(view, facts, dispositions, branch("mission/m1"));
    expect(branchRows[0]!.tuple).toEqual(openTuple());
    expect(branchRows[0]!.disposition).toBe("open");
  });

  it("F7: decideGapDisposition refuses a payload whose contextKey is not the projected context", () => {
    const view = ledgerView([{ id: R1, disposition: "accepted" }]);
    const rows = project(view);
    const decision = decideGapDisposition(rows, "main", {
      requirementId: R1,
      event: "gap-fix-queued",
      actor: DAVID_ACTOR,
      payload: { tuple: openTuple(), contextKey: "mission/m1", reason: "wrong context" },
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.problem).toContain("context");
  });

  it("F15: prototype pollution does not satisfy the closed payload schema", () => {
    const view = ledgerView([{ id: R1, disposition: "accepted" }]);
    const rows = project(view);
    const proto = Object.prototype as Record<string, unknown>;
    proto["tuple"] = openTuple();
    proto["contextKey"] = "main";
    proto["reason"] = "polluted";
    try {
      const decision = decideGapDisposition(rows, "main", {
        requirementId: R1,
        event: "gap-fix-queued",
        actor: DAVID_ACTOR,
        payload: {}, // owns nothing; only the prototype carries the fields
      });
      expect(decision.ok).toBe(false);
    } finally {
      delete proto["tuple"];
      delete proto["contextKey"];
      delete proto["reason"];
    }
  });

  it("F4: a malformed or bare detector actor does not make a row waivable", () => {
    const view = ledgerView([{ id: R1, disposition: "accepted" }]);
    for (const actor of ["camino:detector:", "camino:detector:Bad Name", "camino:detector"]) {
      const facts = new FactLog();
      facts.add(R1, "absence-suspected", actor, { contextKind: "main", reason: "hit" });
      const row = project(view, facts)[0]!;
      expect(row.waivableThroughSeq).toBeNull();
      expect(row.detectorFindings).toEqual([]);
    }
    // A well-formed detector actor DOES qualify (control).
    const ok = new FactLog();
    ok.add(R1, "absence-suspected", "camino:detector:todo-scan", {
      contextKind: "main",
      reason: "hit",
    });
    expect(project(view, ok)[0]!.waivableThroughSeq).not.toBeNull();
  });
});

describe("projection hygiene (defined over store-produced records only)", () => {
  it("refuses malformed contexts and non-monotone sequences", () => {
    const view = ledgerView([{ id: R1, disposition: "accepted" }]);
    expect(() =>
      projectGapRegister(view, [], [], { kind: "main", headSha: "nope" } as StatusContext),
    ).toThrow(/malformed status context/);

    const dup = new FactLog();
    const fact = dup.add(R1, "landed-on-main", "camino:merge", { sha: HEAD });
    expect(() => projectGapRegister(view, [fact, fact], [], MAIN)).toThrow(/strictly increasing/);

    const dispositions = new DispositionLog();
    const record = dispositions.add(R1, "gap-fix-queued", { tuple: openTuple(), reason: "x" });
    expect(() => projectGapRegister(view, [], [record, record], MAIN)).toThrow(
      /strictly increasing/,
    );
  });
});

describe("verifyGapDispositionLog (store adoption hygiene)", () => {
  const good: GapDispositionRecord = {
    seq: 1,
    requirementId: R1,
    event: "gap-fix-queued",
    actor: DAVID_ACTOR,
    payload: { tuple: openTuple(), contextKey: "main", reason: "queued" },
    recordedAt: "2026-07-03T00:00:00.000Z",
  };

  it("passes a clean log and reports each divergence class by seq", () => {
    expect(verifyGapDispositionLog([good])).toEqual([]);
    const divergences = verifyGapDispositionLog([
      good,
      { ...good, seq: 1 }, // non-increasing
      { ...good, seq: 3, recordedAt: "yesterday" },
      { ...good, seq: 4, requirementId: "not-an-id" },
      { ...good, seq: 5, event: "waive" as never },
      { ...good, seq: 6, actor: "camino:scheduler" },
      {
        ...good,
        seq: 7,
        payload: { tuple: openTuple(), contextKey: "main", reason: "x", extra: 1 },
      },
      { ...good, seq: 8, payload: { tuple: openTuple(), reason: "no context" } },
    ]);
    expect(divergences.map((d) => d.seq)).toEqual([1, 3, 4, 5, 6, 7, 8]);
  });
});

describe("tuple helpers", () => {
  it("statusTupleProblem accepts the closed shapes and refuses everything else", () => {
    expect(statusTupleProblem(openTuple())).toBeNull();
    expect(
      statusTupleProblem({
        disposition: "accepted",
        implementation: { kind: "present-on", branch: "mission/m1" },
        evidence: "stale",
      }),
    ).toBeNull();
    expect(statusTupleProblem(null)).not.toBeNull();
    expect(statusTupleProblem({ disposition: "accepted", evidence: "unverified" })).not.toBeNull();
    expect(
      statusTupleProblem({
        disposition: "accepted",
        implementation: { kind: "present-on" },
        evidence: "unverified",
      }),
    ).not.toBeNull();
    expect(
      statusTupleProblem({
        disposition: "accepted",
        implementation: { kind: "on-main", branch: "x" },
        evidence: "unverified",
      }),
    ).not.toBeNull();
    expect(
      statusTupleProblem({
        disposition: "maybe",
        implementation: { kind: "absent" },
        evidence: "unverified",
      }),
    ).not.toBeNull();
  });

  it("statusTupleEquals compares the closed shape deeply", () => {
    expect(statusTupleEquals(openTuple(), openTuple())).toBe(true);
    expect(statusTupleEquals(openTuple(), suspectedTuple())).toBe(false);
    expect(
      statusTupleEquals(
        {
          disposition: "accepted",
          implementation: { kind: "present-on", branch: "a" },
          evidence: "stale",
        },
        {
          disposition: "accepted",
          implementation: { kind: "present-on", branch: "b" },
          evidence: "stale",
        },
      ),
    ).toBe(false);
  });
});

describe("payload schema", () => {
  it("gapDispositionPayloadProblem enforces the closed per-event schemas", () => {
    expect(
      gapDispositionPayloadProblem("gap-fix-queued", {
        tuple: openTuple(),
        contextKey: "main",
        reason: "r",
      }),
    ).toBeNull();
    expect(
      gapDispositionPayloadProblem("gap-fix-queued", {
        tuple: openTuple(),
        contextKey: "main",
        reason: "r",
        waivedThroughSeq: 3,
      }),
    ).not.toBeNull(); // waive-only field on a non-waive event
    expect(
      gapDispositionPayloadProblem("gap-false-positive-waived", {
        tuple: suspectedTuple(),
        contextKey: "main",
        reason: "r",
        waivedThroughSeq: 3,
      }),
    ).toBeNull();
    expect(
      gapDispositionPayloadProblem("gap-false-positive-waived", {
        tuple: suspectedTuple(),
        contextKey: "main",
        reason: "r",
      }),
    ).not.toBeNull(); // a waiver must name what it waives
    expect(
      gapDispositionPayloadProblem("gap-fix-queued", { tuple: openTuple(), reason: "r" }),
    ).not.toBeNull(); // contextKey is required (round 1, finding 7)
    expect(
      gapDispositionPayloadProblem("gap-fix-queued", {
        tuple: openTuple(),
        contextKey: "two\nlines",
        reason: "r",
      }),
    ).not.toBeNull(); // contextKey obeys single-line hygiene
  });
});
