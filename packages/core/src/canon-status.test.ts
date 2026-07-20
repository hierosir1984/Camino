/**
 * Status-tuple projection tests (WP-109, CAM-CANON-03 acceptance):
 * fixture walks of every tuple transition — including revert and
 * stale-evidence downgrades — asserting the design-specified tuples, with
 * rule coverage anchored the WP-101 way: every expectation names the
 * IMPLEMENTATION_RULES / EVIDENCE_RULES rows it exercises, and a final
 * assertion proves the exercised set IS the declared set.
 *
 * The intent axis is walked exhaustively in canon-intent.test.ts; here
 * every step ALSO asserts the disposition column, proving facts never
 * move it (CAM-CANON-01).
 */
import { describe, expect, it } from "vitest";
import type {
  CanonFactInput,
  CanonFactKind,
  CanonFactRecord,
  EvidenceState,
  ImplementationState,
  StatusContext,
} from "@camino/shared";
import { CANON_FACT_KINDS } from "@camino/shared";
import { foldLedgerView } from "./canon-intent.js";
import type { LedgerView } from "./canon-intent.js";
import {
  EVIDENCE_RULES,
  IMPLEMENTATION_RULES,
  projectRequirementStatus,
  projectStatus,
  renderStatusLine,
  validateCanonFact,
  verifyCanonFactLog,
} from "./canon-status.js";
import type { LedgerEventName, LedgerEventRecord } from "@camino/shared";
import { DAVID_ACTOR } from "./intent-lifecycle.js";

const R = "CAM-DEMO-01";
const M1 = "mission-m1";
const M2 = "mission-m2";
const M3 = "mission-m3";

const sha = (c: string): string => c.repeat(40);
const H0 = sha("0");
const HB1 = sha("a");
const HB2 = sha("b");
const HB3 = sha("c");
const HM1 = sha("d");
const HM2 = sha("e");
const HM3 = sha("f");
const HM4 = sha("1");

const main = (headSha: string): StatusContext => ({ kind: "main", headSha });
const branch = (name: string, headSha: string): StatusContext => ({
  kind: "branch",
  branch: name,
  headSha,
});

function ledgerRecord(
  seq: number,
  event: LedgerEventName,
  payload: Record<string, unknown>,
): LedgerEventRecord {
  return {
    seq,
    requirementId: R,
    event,
    actor: DAVID_ACTOR,
    payload,
    recordedAt: "2026-07-01T00:00:00.000Z",
  };
}

function acceptedView(): LedgerView {
  return foldLedgerView([
    ledgerRecord(1, "requirement-proposed", { statement: "demo works", sourceMissionId: "m1" }),
    ledgerRecord(2, "requirement-accepted", {}),
  ]);
}

/** A fixture walk: append facts one at a time and assert tuples per context. */
class Walk {
  private readonly view: LedgerView;
  private readonly facts: CanonFactRecord[] = [];
  private seq = 0;
  readonly exercised: Set<string>;

  constructor(exercised: Set<string>, view: LedgerView = acceptedView()) {
    this.view = view;
    this.exercised = exercised;
  }

  fact(kind: CanonFactKind, payload: Record<string, unknown>): void {
    this.seq += 1;
    const record: CanonFactRecord = {
      seq: this.seq,
      requirementId: R,
      kind,
      actor: "camino:test-fixture",
      payload,
      recordedAt: `2026-07-02T00:00:${String(Math.min(59, this.seq)).padStart(2, "0")}.000Z`,
    };
    const validation = validateCanonFact(record);
    if (!validation.ok) throw new Error(`fixture bug: ${validation.problem}`);
    this.facts.push(record);
  }

  expect(
    context: StatusContext,
    implementation: ImplementationState,
    evidence: EvidenceState,
    rules: readonly string[],
    note: string,
  ): void {
    const tuple = projectRequirementStatus(
      this.view.get(R) as NonNullable<ReturnType<LedgerView["get"]>>,
      this.facts,
      context,
    );
    expect(tuple.implementation, `${note} (implementation)`).toEqual(implementation);
    expect(tuple.evidence, `${note} (evidence)`).toBe(evidence);
    // CAM-CANON-01: no fact sequence moves the disposition.
    expect(tuple.disposition, `${note} (disposition untouched by facts)`).toBe(
      this.view.get(R)?.disposition,
    );
    for (const rule of rules) this.exercised.add(rule);
  }
}

describe("fixture walks of every tuple transition (CAM-CANON-03 accept)", () => {
  const exercised = new Set<string>();

  it("full lifecycle: implement on branch, verify, stale, touch, land, verify, stale, revert, re-land", () => {
    const w = new Walk(exercised);

    w.expect(main(HM1), { kind: "absent" }, "unverified", ["I1", "E1"], "no facts yet (main)");
    w.expect(
      branch(M1, HB1),
      { kind: "absent" },
      "unverified",
      ["I1", "E1"],
      "no facts yet (branch)",
    );

    w.fact("requirement-touched", { branch: M1, sha: HB1 });
    w.expect(
      branch(M1, HB1),
      { kind: "absent" },
      "unverified",
      ["I1", "E1"],
      "touched but not implemented",
    );

    w.fact("implementation-recorded", { branch: M1, sha: HB1 });
    w.expect(
      branch(M1, HB1),
      { kind: "present-on", branch: M1 },
      "unverified",
      ["I2"],
      "implemented on branch",
    );
    w.expect(main(HM1), { kind: "absent" }, "unverified", ["I1"], "main untouched by branch work");

    w.fact("verification-verdict", {
      contextKind: "branch",
      branch: M1,
      headSha: HB1,
      baseSha: H0,
      outcome: "pass",
    });
    w.expect(
      branch(M1, HB1),
      { kind: "present-on", branch: M1 },
      "verified-live",
      ["E2"],
      "verified at branch head",
    );
    w.expect(
      main(HM1),
      { kind: "absent" },
      "unverified",
      ["E7"],
      "branch verdicts never apply to main",
    );

    // Branch advances without touching R: the verdict binding is old.
    w.expect(
      branch(M1, HB2),
      { kind: "present-on", branch: M1 },
      "stale",
      ["E3"],
      "stale-evidence downgrade on head advance",
    );

    // A later touch invalidates outright: never inherits across branch changes.
    w.fact("requirement-touched", { branch: M1, sha: HB2 });
    w.expect(
      branch(M1, HB2),
      { kind: "present-on", branch: M1 },
      "unverified",
      ["E4"],
      "touch after verdict",
    );

    w.fact("verification-verdict", {
      contextKind: "branch",
      branch: M1,
      headSha: HB2,
      baseSha: H0,
      outcome: "pass",
    });
    w.expect(
      branch(M1, HB2),
      { kind: "present-on", branch: M1 },
      "verified-live",
      ["E2"],
      "re-verified at new head",
    );

    // Confirmed landing (CAM-CANON-10): on-main from the landing, not approval.
    w.fact("landed-on-main", { sha: HM1 });
    w.expect(
      main(HM1),
      { kind: "on-main" },
      "unverified",
      ["I3", "E1"],
      "landed on main, main run pending",
    );
    w.expect(
      branch(M1, HB2),
      { kind: "present-on", branch: M1 },
      "verified-live",
      ["I2"],
      "branch keeps its own view",
    );

    w.fact("verification-verdict", {
      contextKind: "main",
      headSha: HM1,
      baseSha: H0,
      outcome: "pass",
    });
    w.expect(main(HM1), { kind: "on-main" }, "verified-live", ["E2"], "verified live on main");

    // Main advances (someone else's mission): stale, not unverified — R untouched.
    w.expect(main(HM2), { kind: "on-main" }, "stale", ["E3"], "stale-evidence downgrade on main");

    // REVERT on main: the projection recomputes; nothing hand-reverses.
    w.fact("revert-recorded", { contextKind: "main", sha: HM3 });
    w.expect(main(HM3), { kind: "absent" }, "stale", ["I5"], "revert landed: absent again");

    // Repair lands: on-main again — derived, not hand-maintained.
    w.fact("landed-on-main", { sha: HM4 });
    w.expect(main(HM4), { kind: "on-main" }, "stale", ["I8"], "repair re-landed");
  });

  it("branch inheritance: untouched branches see main's state; touched branches never inherit evidence", () => {
    const w = new Walk(exercised);
    w.fact("landed-on-main", { sha: HM1 });
    w.fact("verification-verdict", {
      contextKind: "main",
      headSha: HM1,
      baseSha: H0,
      outcome: "pass",
    });

    // M2 never touched R: main's implementation shows through; main's
    // evidence applies but a cross-context binding is never live.
    w.expect(
      branch(M2, HB1),
      { kind: "on-main" },
      "stale",
      ["I4", "E5"],
      "untouched branch inherits, stale at best",
    );

    // M3 touched R: the verbatim CAM-CANON-03 sentence — branch version unverified.
    w.fact("requirement-touched", { branch: M3, sha: HB3 });
    w.expect(
      branch(M3, HB3),
      { kind: "on-main" },
      "unverified",
      ["E6"],
      "touched branch never inherits verification",
    );

    // Verdicts on one branch never apply to another.
    w.fact("implementation-recorded", { branch: M3, sha: HB3 });
    w.fact("verification-verdict", {
      contextKind: "branch",
      branch: M3,
      headSha: HB3,
      baseSha: H0,
      outcome: "pass",
    });
    w.expect(
      branch(M2, HB2),
      { kind: "on-main" },
      "stale",
      ["E7"],
      "M3's verdict is invisible to M2",
    );
    w.expect(
      main(HM1),
      { kind: "on-main" },
      "verified-live",
      ["E2"],
      "main unaffected by branch verdicts",
    );
  });

  it("branch revert shadows inherited on-main; re-implementation clears the shadow", () => {
    const w = new Walk(exercised);
    w.fact("landed-on-main", { sha: HM1 });
    w.expect(
      branch(M1, HB1),
      { kind: "on-main" },
      "unverified",
      ["I4"],
      "inherited before the branch reverts",
    );

    w.fact("revert-recorded", { contextKind: "branch", branch: M1, sha: HB2 });
    w.expect(
      branch(M1, HB2),
      { kind: "absent" },
      "unverified",
      ["I6"],
      "branch tree lacks R after its revert",
    );
    w.expect(
      main(HM1),
      { kind: "on-main" },
      "unverified",
      ["I3"],
      "main unaffected by a branch revert",
    );

    w.fact("implementation-recorded", { branch: M1, sha: HB3 });
    w.expect(
      branch(M1, HB3),
      { kind: "present-on", branch: M1 },
      "unverified",
      ["I7"],
      "re-implementation clears the shadow",
    );
  });

  it("suspicion: external edits and rescans (CAM-CANON-06 seam)", () => {
    const w = new Walk(exercised);
    w.fact("landed-on-main", { sha: HM1 });
    w.fact("implementation-recorded", { branch: M1, sha: HB1 });

    w.fact("absence-suspected", {
      contextKind: "main",
      reason: "external edit deleted the module",
    });
    w.expect(
      main(HM2),
      { kind: "suspected-absent" },
      "unverified",
      ["I9"],
      "conservative invalidation until re-scanned",
    );
    // A branch merely inheriting main's copy shares the doubt; a branch
    // with its OWN implementation does not.
    w.expect(
      branch(M2, HB2),
      { kind: "suspected-absent" },
      "unverified",
      ["I10"],
      "inheriting branch shares the doubt",
    );
    w.expect(
      branch(M1, HB1),
      { kind: "present-on", branch: M1 },
      "unverified",
      ["I11"],
      "own implementation not doubted",
    );

    w.fact("absence-resolved", { contextKind: "main", resolution: "present" });
    w.expect(main(HM2), { kind: "on-main" }, "unverified", ["I12"], "rescan confirms present");

    w.fact("absence-suspected", { contextKind: "main", reason: "failing probe" });
    w.fact("absence-resolved", { contextKind: "main", resolution: "absent" });
    w.expect(main(HM2), { kind: "absent" }, "unverified", ["I13"], "rescan confirms gone");
  });

  it("evidence blocked: quarantined verification wins over unverified/stale, never over live", () => {
    const w = new Walk(exercised);
    w.fact("landed-on-main", { sha: HM1 });
    w.fact("verification-verdict", {
      contextKind: "main",
      headSha: HM1,
      baseSha: H0,
      outcome: "pass",
    });

    w.fact("verification-blocked", { contextKind: "main", reason: "probe quarantined" });
    w.expect(
      main(HM2),
      { kind: "on-main" },
      "blocked",
      ["E9"],
      "stale would understate: verification impossible",
    );

    w.fact("verification-verdict", {
      contextKind: "main",
      headSha: HM2,
      baseSha: H0,
      outcome: "pass",
    });
    w.expect(
      main(HM2),
      { kind: "on-main" },
      "verified-live",
      ["E10"],
      "a live verdict at head stands despite the block",
    );

    w.expect(main(HM3), { kind: "on-main" }, "blocked", ["E9"], "head advance under a block");

    w.fact("verification-unblocked", { contextKind: "main" });
    w.expect(
      main(HM3),
      { kind: "on-main" },
      "stale",
      ["E11"],
      "block cleared: underlying staleness shows",
    );

    w.fact("verification-verdict", {
      contextKind: "main",
      headSha: HM3,
      baseSha: H0,
      outcome: "fail",
    });
    w.expect(
      main(HM3),
      { kind: "on-main" },
      "unverified",
      ["E8"],
      "a failing verdict is not verification evidence",
    );
  });

  it("blocked with no verdict at all", () => {
    const w = new Walk(exercised);
    w.fact("verification-blocked", { contextKind: "branch", branch: M1, reason: "infra down" });
    w.expect(
      branch(M1, HB1),
      { kind: "absent" },
      "blocked",
      ["E9"],
      "blocked before any verdict exists",
    );
  });

  it("every declared projection rule was exercised by the walks above, and only declared rules", () => {
    const declared = new Set([...IMPLEMENTATION_RULES, ...EVIDENCE_RULES].map((r) => r.rule));
    expect(declared.size).toBe(IMPLEMENTATION_RULES.length + EVIDENCE_RULES.length);
    for (const rule of exercised) {
      expect(declared.has(rule), `walk exercised undeclared rule ${rule}`).toBe(true);
    }
    expect([...exercised].sort()).toEqual([...declared].sort());
  });
});

describe("dispositions and facts stay orthogonal (CAM-CANON-01 over the projection)", () => {
  // For every disposition the ledger can produce, a storm of every fact
  // kind leaves the disposition column bit-identical to the ledger fold.
  const ledgers: Array<{ name: string; records: LedgerEventRecord[] }> = [
    {
      name: "proposed",
      records: [ledgerRecord(1, "requirement-proposed", { statement: "s", sourceMissionId: "m" })],
    },
    {
      name: "accepted",
      records: [
        ledgerRecord(1, "requirement-proposed", { statement: "s", sourceMissionId: "m" }),
        ledgerRecord(2, "requirement-accepted", {}),
      ],
    },
    {
      name: "disputed",
      records: [
        ledgerRecord(1, "requirement-proposed", { statement: "s", sourceMissionId: "m" }),
        ledgerRecord(2, "requirement-disputed", { reason: "r", conflictWith: null }),
      ],
    },
    {
      name: "assumed",
      records: [
        ledgerRecord(1, "requirement-proposed", { statement: "s", sourceMissionId: "m" }),
        ledgerRecord(2, "requirement-disputed", { reason: "r", conflictWith: null }),
        ledgerRecord(3, "dispute-assumed", { assumption: "a" }),
      ],
    },
    {
      name: "descoped",
      records: [
        ledgerRecord(1, "requirement-proposed", { statement: "s", sourceMissionId: "m" }),
        ledgerRecord(2, "requirement-descoped", { reason: "r" }),
      ],
    },
  ];

  const stormPayloads: Array<{ kind: CanonFactKind; payload: Record<string, unknown> }> = [
    { kind: "requirement-touched", payload: { branch: M1, sha: HB1 } },
    { kind: "implementation-recorded", payload: { branch: M1, sha: HB1 } },
    { kind: "landed-on-main", payload: { sha: HM1 } },
    {
      kind: "verification-verdict",
      payload: { contextKind: "main", headSha: HM1, baseSha: H0, outcome: "pass" },
    },
    { kind: "revert-recorded", payload: { contextKind: "main", sha: HM2 } },
    { kind: "absence-suspected", payload: { contextKind: "main", reason: "external edit" } },
    { kind: "absence-resolved", payload: { contextKind: "main", resolution: "absent" } },
    { kind: "verification-blocked", payload: { contextKind: "main", reason: "quarantined" } },
    { kind: "verification-unblocked", payload: { contextKind: "main" } },
  ];

  it("the storm uses every fact kind (else this property proves less than it claims)", () => {
    expect(new Set(stormPayloads.map((s) => s.kind)).size).toBe(CANON_FACT_KINDS.length);
  });

  for (const { name, records } of ledgers) {
    it(`fact storm cannot move a ${name} disposition`, () => {
      const view = foldLedgerView(records);
      const before = view.get(R)?.disposition;
      const facts: CanonFactRecord[] = stormPayloads.map((s, i) => ({
        seq: i + 1,
        requirementId: R,
        kind: s.kind,
        actor: "camino:merge",
        payload: s.payload,
        recordedAt: "2026-07-03T00:00:00.000Z",
      }));
      for (const context of [main(HM1), branch(M1, HB1)]) {
        const tuples = projectStatus(view, facts, context);
        expect(tuples.get(R)?.disposition).toBe(before);
      }
      // And the ledger view itself is untouched by projecting.
      expect(view.get(R)?.disposition).toBe(before);
    });
  }

  it("facts for requirement ids the ledger does not know are ignored", () => {
    const view = acceptedView();
    const stray: CanonFactRecord = {
      seq: 1,
      requirementId: "CAM-GHOST-99",
      kind: "landed-on-main",
      actor: "camino:merge",
      payload: { sha: HM1 },
      recordedAt: "2026-07-03T00:00:00.000Z",
    };
    const tuples = projectStatus(view, [stray], main(HM1));
    expect(tuples.has("CAM-GHOST-99")).toBe(false);
    expect(tuples.get(R)?.implementation).toEqual({ kind: "absent" });
  });
});

describe("the design §3.1 example line, verbatim", () => {
  it('a worker on mission branch M sees "accepted; changed on this branch; branch version unverified"', () => {
    const view = acceptedView();
    const facts: CanonFactRecord[] = [
      {
        seq: 1,
        requirementId: R,
        kind: "requirement-touched",
        actor: "camino:quarantine",
        payload: { branch: M1, sha: HB1 },
        recordedAt: "2026-07-03T00:00:00.000Z",
      },
      {
        seq: 2,
        requirementId: R,
        kind: "implementation-recorded",
        actor: "camino:merge",
        payload: { branch: M1, sha: HB1 },
        recordedAt: "2026-07-03T00:00:01.000Z",
      },
    ];
    const context = branch(M1, HB1);
    const tuple = projectRequirementStatus(
      view.get(R) as NonNullable<ReturnType<LedgerView["get"]>>,
      facts,
      context,
    );
    expect(renderStatusLine(R, tuple, context)).toBe(
      `${R}: accepted; changed on this branch; branch version unverified`,
    );
  });
});

describe("validateCanonFact (shape hygiene)", () => {
  const good: CanonFactInput = {
    requirementId: R,
    kind: "landed-on-main",
    actor: "camino:merge",
    payload: { sha: HM1 },
  };

  it("accepts every kind with its documented shape", () => {
    const shapes: Array<{ kind: CanonFactKind; payload: Record<string, unknown> }> = [
      { kind: "requirement-touched", payload: { branch: M1, sha: HB1 } },
      { kind: "implementation-recorded", payload: { branch: M1, sha: HB1 } },
      { kind: "landed-on-main", payload: { sha: HM1 } },
      { kind: "revert-recorded", payload: { contextKind: "branch", branch: M1, sha: HB1 } },
      { kind: "revert-recorded", payload: { contextKind: "main", sha: HM1 } },
      { kind: "absence-suspected", payload: { contextKind: "main", reason: "gone" } },
      { kind: "absence-resolved", payload: { contextKind: "main", resolution: "present" } },
      {
        kind: "verification-verdict",
        payload: { contextKind: "branch", branch: M1, headSha: HB1, baseSha: H0, outcome: "fail" },
      },
      { kind: "verification-blocked", payload: { contextKind: "main", reason: "quarantined" } },
      { kind: "verification-unblocked", payload: { contextKind: "main" } },
    ];
    for (const shape of shapes) {
      expect(validateCanonFact({ ...good, ...shape }), shape.kind).toEqual({ ok: true });
    }
  });

  it("refuses malformed facts", () => {
    const bad: Array<{ why: string; input: CanonFactInput }> = [
      { why: "bad requirement id", input: { ...good, requirementId: "nope" } },
      { why: "unknown kind", input: { ...good, kind: "merge-landed" as CanonFactKind } },
      { why: "empty actor", input: { ...good, actor: "" } },
      { why: "short sha", input: { ...good, payload: { sha: "abc123" } } },
      { why: "extra field", input: { ...good, payload: { sha: HM1, note: "hi" } } },
      {
        why: "branch named main",
        input: {
          ...good,
          kind: "implementation-recorded",
          payload: { branch: "main", sha: HB1 },
        },
      },
      {
        why: "branch with forbidden characters",
        input: {
          ...good,
          kind: "implementation-recorded",
          payload: { branch: "bad branch", sha: HB1 },
        },
      },
      {
        why: "main context carrying a branch",
        input: {
          ...good,
          kind: "revert-recorded",
          payload: { contextKind: "main", branch: M1, sha: HM1 },
        },
      },
      {
        why: "bad outcome",
        input: {
          ...good,
          kind: "verification-verdict",
          payload: { contextKind: "main", headSha: HM1, baseSha: H0, outcome: "maybe" },
        },
      },
      {
        why: "bad resolution",
        input: {
          ...good,
          kind: "absence-resolved",
          payload: { contextKind: "main", resolution: "unsure" },
        },
      },
      {
        why: "class-instance payload",
        input: {
          ...good,
          payload: new (class {
            sha = HM1;
          })() as unknown as Record<string, unknown>,
        },
      },
    ];
    for (const { why, input } of bad) {
      expect(validateCanonFact(input).ok, why).toBe(false);
    }
  });

  it("verifyCanonFactLog flags malformed rows and seq regressions", () => {
    const rows: CanonFactRecord[] = [
      { seq: 1, ...good, recordedAt: "2026-07-03T00:00:00.000Z" },
      {
        seq: 1,
        ...good,
        recordedAt: "2026-07-03T00:00:01.000Z",
      },
      {
        seq: 3,
        ...good,
        payload: { sha: "tampered" },
        recordedAt: "2026-07-03T00:00:02.000Z",
      },
    ];
    const divergences = verifyCanonFactLog(rows);
    expect(divergences.some((d) => /strictly increasing/.test(d.problem))).toBe(true);
    expect(divergences.some((d) => /sha/.test(d.problem))).toBe(true);
  });
});
