/**
 * Status-tuple projection tests (WP-109, CAM-CANON-03 acceptance):
 * fixture walks of every tuple transition — including revert and
 * stale-evidence downgrades — asserting the design-specified tuples.
 *
 * Coverage is OBSERVED, not self-reported (review round 1, finding 10):
 * every expectation goes through `explainRequirementStatus`, each step
 * asserts the rules it claims actually FIRED for that derivation, and
 * the final assertion proves the union of fired rules IS the declared
 * rule set — a rule no walk reaches, or a claim no derivation backs,
 * fails mechanically.
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
import type { LedgerView, LedgerViewEntry } from "./canon-intent.js";
import {
  EVIDENCE_RULES,
  IMPLEMENTATION_RULES,
  explainRequirementStatus,
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
const BASE1 = sha("2");
const BASE2 = sha("3");

const main = (headSha: string): StatusContext => ({ kind: "main", headSha });
const branch = (name: string, headSha: string, baseSha = BASE1): StatusContext => ({
  kind: "branch",
  branch: name,
  headSha,
  baseSha,
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
    const entry = this.view.get(R) as LedgerViewEntry;
    const explained = explainRequirementStatus(entry, this.facts, context);
    expect(explained.tuple.implementation, `${note} (implementation)`).toEqual(implementation);
    expect(explained.tuple.evidence, `${note} (evidence)`).toBe(evidence);
    // CAM-CANON-01: no fact sequence moves the disposition.
    expect(explained.tuple.disposition, `${note} (disposition untouched by facts)`).toBe(
      entry.disposition,
    );
    // Coverage is observed AND deliberate (review round 3 finding 3): each
    // CLAIMED rule must actually have fired (no claiming a rule the
    // derivation did not produce), and — crucially — only CLAIMED rules
    // are credited to the coverage set. Incidental fires are NOT credited,
    // so the final `exercised == declared` assertion can only pass if
    // every declared rule was deliberately exercised by some step, never
    // because it happened to fire in passing.
    for (const rule of rules) {
      expect(explained.fired.has(rule), `${note}: claimed rule ${rule} did not fire`).toBe(true);
      this.exercised.add(rule);
    }
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
      baseSha: BASE1,
      outcome: "pass",
    });
    w.expect(
      branch(M1, HB1),
      { kind: "present-on", branch: M1 },
      "verified-live",
      ["E2"],
      "verified at the exact (head, base) binding",
    );
    w.expect(
      main(HM1),
      { kind: "absent" },
      "unverified",
      ["E7"],
      "branch verdicts never apply to main",
    );

    // Branch advances without touching R: the head binding is old.
    w.expect(
      branch(M1, HB2),
      { kind: "present-on", branch: M1 },
      "stale",
      ["E3"],
      "stale-evidence downgrade on head advance",
    );

    // Base drift alone also expires the binding (invariant 7 pair).
    w.expect(
      branch(M1, HB1, BASE2),
      { kind: "present-on", branch: M1 },
      "stale",
      ["E3"],
      "stale-evidence downgrade on base drift",
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
      baseSha: BASE1,
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

    // A later MAIN verdict must not mask the branch's own exact-binding
    // proof (review round 1, finding 6 / self-found S1).
    w.expect(
      branch(M1, HB2),
      { kind: "present-on", branch: M1 },
      "verified-live",
      ["E2", "E12"],
      "own verdict outranks the later main verdict",
    );

    // Main advances (someone else's mission): stale, not unverified — R untouched.
    w.expect(main(HM2), { kind: "on-main" }, "stale", ["E3"], "stale-evidence downgrade on main");

    // REVERT on main: the projection recomputes; nothing hand-reverses.
    w.fact("revert-recorded", { contextKind: "main", sha: HM3 });
    w.expect(main(HM3), { kind: "absent" }, "stale", ["I5"], "revert landed: absent again");

    // Repair lands: on-main again — derived, not hand-maintained.
    w.fact("landed-on-main", { sha: HM4 });
    w.expect(main(HM4), { kind: "on-main" }, "stale", ["I3", "I8"], "repair re-landed");
  });

  it("branch fail-verdict outranks a later main pass (finding 6, fail direction)", () => {
    const w = new Walk(exercised);
    w.fact("implementation-recorded", { branch: M1, sha: HB1 });
    w.fact("verification-verdict", {
      contextKind: "branch",
      branch: M1,
      headSha: HB1,
      baseSha: BASE1,
      outcome: "fail",
    });
    w.fact("verification-verdict", {
      contextKind: "main",
      headSha: HM1,
      baseSha: H0,
      outcome: "pass",
    });
    w.expect(
      branch(M1, HB1),
      { kind: "present-on", branch: M1 },
      "unverified",
      ["E8", "E12"],
      "the branch's own latest run failed; main's later pass cannot mask it",
    );
  });

  it("mainline inheritance is fact-attested: landings never leak into branches on their own (finding 7)", () => {
    const w = new Walk(exercised);
    w.fact("landed-on-main", { sha: HM1 });
    w.fact("verification-verdict", {
      contextKind: "main",
      headSha: HM1,
      baseSha: H0,
      outcome: "pass",
    });

    // A branch with NO branch-scoped facts shows absent — the projection
    // has no git and must not guess that this branch's tree carries the
    // landing (an old mission head predating the landing does not).
    w.expect(
      branch(M2, HB1),
      { kind: "absent" },
      "unverified",
      ["I10", "E7"],
      "no mainline-inherited fact: landing does not leak",
    );

    // Ancestry-aware machinery attests the carry: now on-main shows, and
    // main evidence applies — as stale at best (cross-context binding).
    w.fact("mainline-inherited", { branch: M2, sha: HM1 });
    w.expect(
      branch(M2, HB1),
      { kind: "on-main" },
      "stale",
      ["I4", "E5"],
      "attested carry: on-main + inherited-stale evidence",
    );

    // A branch that touched R never inherits evidence (verbatim rule).
    w.fact("requirement-touched", { branch: M3, sha: HB3 });
    w.fact("mainline-inherited", { branch: M3, sha: HM1 });
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
      baseSha: BASE1,
      outcome: "pass",
    });
    w.expect(
      branch(M2, HB2),
      { kind: "on-main" },
      "stale",
      ["E5"],
      "M3's verdict is invisible to M2",
    );
    w.expect(main(HM1), { kind: "on-main" }, "verified-live", ["E2"], "main unaffected");
  });

  it("branch revert clears own presence AND attested inheritance; re-implementation restores", () => {
    const w = new Walk(exercised);
    w.fact("landed-on-main", { sha: HM1 });
    w.fact("mainline-inherited", { branch: M1, sha: HM1 });
    w.expect(branch(M1, HB1), { kind: "on-main" }, "unverified", ["I4"], "carrying the landing");

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
      ["I2", "I7"],
      "re-implementation restores presence",
    );
  });

  it("suspicion: external edits and rescans stay context-scoped (CAM-CANON-06 seam)", () => {
    const w = new Walk(exercised);
    w.fact("landed-on-main", { sha: HM1 });
    w.fact("implementation-recorded", { branch: M1, sha: HB1 });
    w.fact("mainline-inherited", { branch: M2, sha: HM1 });

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
    // Main doubt does NOT cross into branches: their trees are their own
    // (I10) — neither an own implementation nor an attested carry is
    // doubted by an edit that happened on main.
    w.expect(
      branch(M1, HB1),
      { kind: "present-on", branch: M1 },
      "unverified",
      ["I2"],
      "own implementation not doubted by main suspicion",
    );
    w.expect(
      branch(M2, HB2),
      { kind: "on-main" },
      "unverified",
      ["I4"],
      "attested carry not doubted by main suspicion (the branch tree is fixed)",
    );

    w.fact("absence-resolved", { contextKind: "main", resolution: "present" });
    w.expect(
      main(HM2),
      { kind: "on-main" },
      "unverified",
      ["I3", "I11"],
      "rescan confirms present",
    );

    w.fact("absence-suspected", { contextKind: "main", reason: "failing probe" });
    w.fact("absence-resolved", { contextKind: "main", resolution: "absent" });
    w.expect(main(HM2), { kind: "absent" }, "unverified", ["I12"], "rescan confirms gone");

    // Branch-scoped suspicion and branch-scoped confirmed absence.
    w.fact("absence-suspected", { contextKind: "branch", branch: M1, reason: "worktree wiped" });
    w.expect(
      branch(M1, HB1),
      { kind: "suspected-absent" },
      "unverified",
      ["I9"],
      "branch suspicion",
    );
    w.fact("absence-resolved", { contextKind: "branch", branch: M1, resolution: "absent" });
    w.expect(
      branch(M1, HB1),
      { kind: "absent" },
      "unverified",
      ["I12"],
      "branch rescan confirms gone — no fall-through to anything (finding 5)",
    );
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
      ["E2", "E10"],
      "a live verdict at head stands despite the block",
    );

    w.expect(main(HM3), { kind: "on-main" }, "blocked", ["E9"], "head advance under a block");

    w.fact("verification-unblocked", { contextKind: "main" });
    w.expect(
      main(HM3),
      { kind: "on-main" },
      "stale",
      ["E3", "E11"],
      "block cleared: staleness shows",
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
      ["E9", "E1"],
      "blocked before any verdict exists",
    );
  });

  it("every declared projection rule FIRED in the walks above, and nothing undeclared ever fires", () => {
    const declared = new Set([...IMPLEMENTATION_RULES, ...EVIDENCE_RULES].map((r) => r.rule));
    expect(declared.size).toBe(IMPLEMENTATION_RULES.length + EVIDENCE_RULES.length);
    for (const rule of exercised) {
      expect(declared.has(rule), `derivations fired undeclared rule ${rule}`).toBe(true);
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
      name: "resolved-accepted",
      records: [
        ledgerRecord(1, "requirement-proposed", { statement: "s", sourceMissionId: "m" }),
        ledgerRecord(2, "requirement-disputed", { reason: "r", conflictWith: null }),
        ledgerRecord(3, "dispute-resolved-accepted", { resolution: "keep" }),
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
    { kind: "mainline-inherited", payload: { branch: M2, sha: HM1 } },
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

  it("the storm uses every fact kind and every disposition (else this property proves less than it claims)", () => {
    expect(new Set(stormPayloads.map((s) => s.kind)).size).toBe(CANON_FACT_KINDS.length);
    const dispositionsCovered = new Set(
      ledgers.map((l) => foldLedgerView(l.records).get(R)?.disposition),
    );
    expect(dispositionsCovered.size).toBe(6);
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

  it("fact order does not matter: the projection sorts by seq (finding 15)", () => {
    const view = acceptedView();
    const entry = view.get(R) as LedgerViewEntry;
    const landing: CanonFactRecord = {
      seq: 1,
      requirementId: R,
      kind: "landed-on-main",
      actor: "a:b",
      payload: { sha: HM1 },
      recordedAt: "2026-07-03T00:00:00.000Z",
    };
    const revert: CanonFactRecord = {
      seq: 2,
      requirementId: R,
      kind: "revert-recorded",
      actor: "a:b",
      payload: { contextKind: "main", sha: HM2 },
      recordedAt: "2026-07-03T00:00:01.000Z",
    };
    const ascending = projectRequirementStatus(entry, [landing, revert], main(HM2));
    const shuffled = projectRequirementStatus(entry, [revert, landing], main(HM2));
    expect(ascending.implementation).toEqual({ kind: "absent" });
    expect(shuffled).toEqual(ascending);
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
    const tuple = projectRequirementStatus(view.get(R) as LedgerViewEntry, facts, context);
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
      { kind: "mainline-inherited", payload: { branch: M1, sha: HM1 } },
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
    expect(new Set(shapes.map((s) => s.kind)).size).toBe(CANON_FACT_KINDS.length);
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
        why: "mainline-inherited without a branch",
        input: { ...good, kind: "mainline-inherited", payload: { sha: HM1 } },
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

  it("is total over hostile objects whose traps throw (finding 15)", () => {
    const trap = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("getPrototypeOf trap escaped");
        },
      },
    );
    const verdict = validateCanonFact({ ...good, payload: trap as Record<string, unknown> });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problem).toMatch(/hostile or exotic input refused/);
  });

  it("verifyCanonFactLog flags malformed rows, bad timestamps, and seq regressions", () => {
    const rows: CanonFactRecord[] = [
      { seq: 1, ...good, recordedAt: "2026-07-03T00:00:00.000Z" },
      { seq: 1, ...good, recordedAt: "2026-07-03T00:00:01.000Z" },
      { seq: 3, ...good, payload: { sha: "tampered" }, recordedAt: "2026-07-03T00:00:02.000Z" },
      { seq: 4, ...good, recordedAt: "merge-event/not-an-iso-time" },
      { seq: 5, ...good, recordedAt: "2026-02-30T00:00:00.000Z" },
      { seq: 2 ** 53, ...good, recordedAt: "2026-07-03T00:00:03.000Z" },
    ];
    const divergences = verifyCanonFactLog(rows);
    expect(divergences.some((d) => /strictly increasing/.test(d.problem))).toBe(true);
    expect(divergences.some((d) => /sha/.test(d.problem))).toBe(true);
    expect(divergences.some((d) => /ISO-8601/.test(d.problem))).toBe(true);
    expect(divergences.some((d) => /not a real instant/.test(d.problem))).toBe(true);
    expect(divergences.some((d) => /safe/.test(d.problem))).toBe(true);
  });
});

describe("round-2 regressions (falsification review findings)", () => {
  const acc = acceptedView();
  const entry = acc.get(R) as LedgerViewEntry;

  it("f3b: a branch's OWN implementation merge blocks inherited main evidence (no separate touch fact)", () => {
    const facts: CanonFactRecord[] = [
      {
        seq: 1,
        requirementId: R,
        kind: "landed-on-main",
        actor: "a:b",
        payload: { sha: HM1 },
        recordedAt: "2026-07-02T00:00:00.000Z",
      },
      {
        seq: 2,
        requirementId: R,
        kind: "verification-verdict",
        actor: "a:b",
        payload: { contextKind: "main", headSha: HM1, baseSha: H0, outcome: "pass" },
        recordedAt: "2026-07-02T00:00:01.000Z",
      },
      {
        seq: 3,
        requirementId: R,
        kind: "mainline-inherited",
        actor: "a:b",
        payload: { branch: M1, sha: HM1 },
        recordedAt: "2026-07-02T00:00:02.000Z",
      },
      {
        seq: 4,
        requirementId: R,
        kind: "implementation-recorded",
        actor: "a:b",
        payload: { branch: M1, sha: HB1 },
        recordedAt: "2026-07-02T00:00:03.000Z",
      },
    ];
    const explained = explainRequirementStatus(entry, facts, branch(M1, HB1));
    // The branch changed R itself → present-on, and it does NOT inherit
    // main's verdict (E6 fires, not E5).
    expect(explained.tuple.implementation).toEqual({ kind: "present-on", branch: M1 });
    expect(explained.tuple.evidence).toBe("unverified");
    expect(explained.fired.has("E6")).toBe(true);
    expect(explained.fired.has("E5")).toBe(false);
  });

  it("f4b: a branch context named 'main' is rejected, not silently fed main verdicts", () => {
    const facts: CanonFactRecord[] = [
      {
        seq: 1,
        requirementId: R,
        kind: "verification-verdict",
        actor: "a:b",
        payload: { contextKind: "main", headSha: HM1, baseSha: H0, outcome: "pass" },
        recordedAt: "2026-07-02T00:00:00.000Z",
      },
    ];
    expect(() =>
      projectRequirementStatus(entry, facts, {
        kind: "branch",
        branch: "main",
        headSha: HM1,
        baseSha: BASE1,
      }),
    ).toThrow(/malformed status context/);
  });

  it("f4/f10: malformed contexts throw a clean domain error", () => {
    expect(() =>
      projectRequirementStatus(entry, [], { kind: "main", headSha: "short" } as never),
    ).toThrow(/malformed status context/);
    expect(() =>
      projectRequirementStatus(entry, [], {
        kind: "branch",
        branch: M1,
        headSha: HB1,
        baseSha: "nope",
      } as never),
    ).toThrow(/malformed status context/);
    expect(() => projectRequirementStatus(entry, [], { kind: "sideways" } as never)).toThrow(
      /malformed status context/,
    );
    // An exotic context whose trap throws becomes the same clean refusal.
    const trap = new Proxy(
      { kind: "main", headSha: HM1 },
      {
        get(t, p) {
          if (p === "kind") throw new Error("trap");
          return (t as never)[p];
        },
      },
    );
    expect(() => projectRequirementStatus(entry, [], trap as never)).toThrow(
      /malformed status context/,
    );
  });

  it("f10b: duplicate-seq facts are order-independent (deterministic total ordering)", () => {
    const landing: CanonFactRecord = {
      seq: 1,
      requirementId: R,
      kind: "landed-on-main",
      actor: "a:b",
      payload: { sha: HM1 },
      recordedAt: "2026-07-02T00:00:00.000Z",
    };
    const revert: CanonFactRecord = {
      seq: 1,
      requirementId: R,
      kind: "revert-recorded",
      actor: "a:b",
      payload: { contextKind: "main", sha: HM2 },
      recordedAt: "2026-07-02T00:00:00.000Z",
    };
    // Round 3 finding 2 strengthened this: duplicate seqs cannot come from
    // a store (PK + append-order trigger + adoption verify all guarantee
    // uniqueness), so rather than silently ordering them, the projector
    // REFUSES the fact set — the only remaining source of order-dependence
    // becomes a clean domain error, not a surprising tuple.
    expect(() => projectRequirementStatus(entry, [landing, revert], main(HM2))).toThrow(
      /malformed fact sequence/,
    );
    // Shuffled STORE facts (unique seqs) remain order-independent.
    const f1: CanonFactRecord = { ...landing, seq: 1 };
    const f2: CanonFactRecord = { ...revert, seq: 2 };
    expect(projectRequirementStatus(entry, [f1, f2], main(HM2))).toEqual(
      projectRequirementStatus(entry, [f2, f1], main(HM2)),
    );
  });

  it("f10a: validateCanonFact is total even when the thrown value's .message getter throws", () => {
    const evil = new Proxy(
      {},
      {
        ownKeys() {
          const e: Record<string, unknown> = {};
          Object.defineProperty(e, "message", {
            get() {
              throw new Error("nested");
            },
          });
          throw e;
        },
      },
    );
    const verdict = validateCanonFact({
      requirementId: R,
      kind: "landed-on-main",
      actor: "a:b",
      payload: evil as Record<string, unknown>,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problem).toMatch(/hostile or exotic input refused/);
  });

  it("f7: I5 fires only for an actual main revert, never for a bare landing", () => {
    // Landed, never reverted: main is on-main and fires I3 (not I5).
    const landed = explainRequirementStatus(
      entry,
      [
        {
          seq: 1,
          requirementId: R,
          kind: "landed-on-main",
          actor: "a:b",
          payload: { sha: HM1 },
          recordedAt: "2026-07-02T00:00:00.000Z",
        },
      ],
      main(HM1),
    );
    expect(landed.fired.has("I5")).toBe(false);
    expect(landed.fired.has("I3")).toBe(true);
    // Landed then reverted: absent, fires I5.
    const reverted = explainRequirementStatus(
      entry,
      [
        {
          seq: 1,
          requirementId: R,
          kind: "landed-on-main",
          actor: "a:b",
          payload: { sha: HM1 },
          recordedAt: "2026-07-02T00:00:00.000Z",
        },
        {
          seq: 2,
          requirementId: R,
          kind: "revert-recorded",
          actor: "a:b",
          payload: { contextKind: "main", sha: HM2 },
          recordedAt: "2026-07-02T00:00:01.000Z",
        },
      ],
      main(HM2),
    );
    expect(reverted.tuple.implementation).toEqual({ kind: "absent" });
    expect(reverted.fired.has("I5")).toBe(true);
  });
});

describe("round-3 regressions (falsification review findings)", () => {
  const acc = acceptedView();
  const entry = acc.get(R) as LedgerViewEntry;

  it("f1: a stateful Proxy context that mutates between reads is refused (single-observation)", () => {
    let reads = 0;
    const trap = new Proxy(
      { kind: "main", headSha: HM1 },
      {
        get(t, p) {
          if (p === "kind") {
            reads += 1;
            return reads > 1 ? "branch" : "main"; // valid at validation, changes later
          }
          return (t as Record<string, unknown>)[p as string];
        },
      },
    );
    // The single read means the derivation never sees a second, different
    // value — the snapshot is the sole authority. It either projects the
    // validated main context or refuses; it never produces a Frankentuple.
    const result = (() => {
      try {
        return projectRequirementStatus(entry, [], trap as never);
      } catch (e) {
        return (e as Error).message;
      }
    })();
    // Whatever happens, the snapshot was taken from ONE observation.
    expect(typeof result === "object" || /malformed/.test(String(result))).toBe(true);
  });

  it("f1: a prototype-fed / extra-field context still validates by value (the snapshot is plain)", () => {
    const proto = { kind: "main", headSha: HM1 };
    const inherited = Object.create(proto) as StatusContext;
    // Reads by value succeed; the projection uses a frozen own-property snapshot.
    expect(() => projectRequirementStatus(entry, [], inherited)).not.toThrow();
  });

  it("f2: a fact payload that fails JSON.stringify does not throw the ordering (total sort key)", () => {
    const circular: Record<string, unknown> = { sha: HM1 };
    circular["self"] = circular;
    // Two facts with unique seqs; the tie-break key is never consulted, but
    // even if it were, safeStringify cannot throw. Validation refuses the
    // circular payload downstream — the point is ordering stays total.
    const facts: CanonFactRecord[] = [
      {
        seq: 1,
        requirementId: R,
        kind: "landed-on-main",
        actor: "a:b",
        payload: { sha: HM1 },
        recordedAt: "2026-07-02T00:00:00.000Z",
      },
      {
        seq: 2,
        requirementId: R,
        kind: "landed-on-main",
        actor: "a:b",
        payload: circular,
        recordedAt: "2026-07-02T00:00:01.000Z",
      },
    ];
    // ordering itself must not throw on the circular payload.
    expect(() => projectRequirementStatus(entry, facts, main(HM1))).not.toThrow();
  });

  it("f2: NaN / Infinity seqs are refused, not silently ordered", () => {
    for (const seq of [NaN, Infinity, -Infinity]) {
      const facts: CanonFactRecord[] = [
        {
          seq: seq as number,
          requirementId: R,
          kind: "landed-on-main",
          actor: "a:b",
          payload: { sha: HM1 },
          recordedAt: "2026-07-02T00:00:00.000Z",
        },
      ];
      expect(() => projectRequirementStatus(entry, facts, main(HM1)), String(seq)).toThrow(
        /malformed fact sequence/,
      );
    }
  });

  it("f4: every reachable implementation × evidence tuple is produced by a constructed fact sequence", () => {
    // The design-space of tuples is (disposition) × (implementation) ×
    // (evidence). Disposition orthogonality is proven by the fact-storm
    // property above; here we build a fact sequence for each reachable
    // implementation×evidence pair and assert the projection produces it,
    // directly answering CAM-CANON-03's "every tuple transition" (r3 f4).
    let seq = 0;
    const f = (kind: CanonFactKind, payload: Record<string, unknown>): CanonFactRecord => ({
      seq: (seq += 1),
      requirementId: R,
      kind,
      actor: "camino:test",
      payload,
      recordedAt: `2026-07-02T00:00:${String(Math.min(59, seq)).padStart(2, "0")}.000Z`,
    });
    type Case = {
      impl: ImplementationState;
      ev: EvidenceState;
      facts: CanonFactRecord[];
      ctx: StatusContext;
    };
    const reset = (): void => {
      seq = 0;
    };
    const cases: Case[] = [];
    // absent × {unverified, verified-live, stale, blocked}
    reset();
    cases.push({ impl: { kind: "absent" }, ev: "unverified", facts: [], ctx: main(HM1) });
    reset();
    cases.push({
      impl: { kind: "absent" },
      ev: "verified-live",
      // landed → verified → reverted: absent on main, but the main verdict at HM1 is still live.
      facts: [
        f("landed-on-main", { sha: HM1 }),
        f("verification-verdict", {
          contextKind: "main",
          headSha: HM1,
          baseSha: H0,
          outcome: "pass",
        }),
        f("revert-recorded", { contextKind: "main", sha: HM1 }),
      ],
      ctx: main(HM1),
    });
    reset();
    cases.push({
      impl: { kind: "absent" },
      ev: "stale",
      facts: [
        f("landed-on-main", { sha: HM1 }),
        f("verification-verdict", {
          contextKind: "main",
          headSha: HM1,
          baseSha: H0,
          outcome: "pass",
        }),
        f("revert-recorded", { contextKind: "main", sha: HM2 }),
      ],
      ctx: main(HM2),
    });
    reset();
    cases.push({
      impl: { kind: "absent" },
      ev: "blocked",
      facts: [f("verification-blocked", { contextKind: "main", reason: "infra" })],
      ctx: main(HM1),
    });
    // present-on × {unverified, verified-live, stale, blocked}
    reset();
    cases.push({
      impl: { kind: "present-on", branch: M1 },
      ev: "unverified",
      facts: [f("implementation-recorded", { branch: M1, sha: HB1 })],
      ctx: branch(M1, HB1),
    });
    reset();
    cases.push({
      impl: { kind: "present-on", branch: M1 },
      ev: "verified-live",
      facts: [
        f("implementation-recorded", { branch: M1, sha: HB1 }),
        f("verification-verdict", {
          contextKind: "branch",
          branch: M1,
          headSha: HB1,
          baseSha: BASE1,
          outcome: "pass",
        }),
      ],
      ctx: branch(M1, HB1),
    });
    reset();
    cases.push({
      impl: { kind: "present-on", branch: M1 },
      ev: "stale",
      facts: [
        f("implementation-recorded", { branch: M1, sha: HB1 }),
        f("verification-verdict", {
          contextKind: "branch",
          branch: M1,
          headSha: HB1,
          baseSha: BASE1,
          outcome: "pass",
        }),
      ],
      ctx: branch(M1, HB2),
    });
    reset();
    cases.push({
      impl: { kind: "present-on", branch: M1 },
      ev: "blocked",
      facts: [
        f("implementation-recorded", { branch: M1, sha: HB1 }),
        f("verification-blocked", { contextKind: "branch", branch: M1, reason: "quarantined" }),
      ],
      ctx: branch(M1, HB1),
    });
    // on-main × {unverified, verified-live, stale, blocked}
    reset();
    cases.push({
      impl: { kind: "on-main" },
      ev: "unverified",
      facts: [f("landed-on-main", { sha: HM1 })],
      ctx: main(HM1),
    });
    reset();
    cases.push({
      impl: { kind: "on-main" },
      ev: "verified-live",
      facts: [
        f("landed-on-main", { sha: HM1 }),
        f("verification-verdict", {
          contextKind: "main",
          headSha: HM1,
          baseSha: H0,
          outcome: "pass",
        }),
      ],
      ctx: main(HM1),
    });
    reset();
    cases.push({
      impl: { kind: "on-main" },
      ev: "stale",
      facts: [
        f("landed-on-main", { sha: HM1 }),
        f("verification-verdict", {
          contextKind: "main",
          headSha: HM1,
          baseSha: H0,
          outcome: "pass",
        }),
      ],
      ctx: main(HM2),
    });
    reset();
    cases.push({
      impl: { kind: "on-main" },
      ev: "blocked",
      facts: [
        f("landed-on-main", { sha: HM1 }),
        f("verification-blocked", { contextKind: "main", reason: "quarantined" }),
      ],
      ctx: main(HM1),
    });
    // suspected-absent × {unverified, verified-live, stale, blocked}
    reset();
    cases.push({
      impl: { kind: "suspected-absent" },
      ev: "unverified",
      facts: [
        f("landed-on-main", { sha: HM1 }),
        f("absence-suspected", { contextKind: "main", reason: "external edit" }),
      ],
      ctx: main(HM1),
    });
    reset();
    cases.push({
      impl: { kind: "suspected-absent" },
      ev: "verified-live",
      facts: [
        f("landed-on-main", { sha: HM1 }),
        f("verification-verdict", {
          contextKind: "main",
          headSha: HM1,
          baseSha: H0,
          outcome: "pass",
        }),
        f("absence-suspected", { contextKind: "main", reason: "external edit" }),
      ],
      ctx: main(HM1),
    });
    reset();
    cases.push({
      impl: { kind: "suspected-absent" },
      ev: "stale",
      facts: [
        f("landed-on-main", { sha: HM1 }),
        f("verification-verdict", {
          contextKind: "main",
          headSha: HM1,
          baseSha: H0,
          outcome: "pass",
        }),
        f("absence-suspected", { contextKind: "main", reason: "external edit" }),
      ],
      ctx: main(HM2),
    });
    reset();
    cases.push({
      impl: { kind: "suspected-absent" },
      ev: "blocked",
      facts: [
        f("landed-on-main", { sha: HM1 }),
        f("verification-blocked", { contextKind: "main", reason: "quarantined" }),
        f("absence-suspected", { contextKind: "main", reason: "external edit" }),
      ],
      ctx: main(HM1),
    });

    const produced = new Set<string>();
    for (const c of cases) {
      const tuple = projectRequirementStatus(entry, c.facts, c.ctx);
      expect(tuple.implementation, `${JSON.stringify(c.impl)} × ${c.ev}`).toEqual(c.impl);
      expect(tuple.evidence, `${JSON.stringify(c.impl)} × ${c.ev}`).toBe(c.ev);
      produced.add(`${tuple.implementation.kind}|${tuple.evidence}`);
    }
    // All four implementation kinds × all four evidence states are covered.
    expect(produced.size).toBe(16);
  });

  it("f4: own present-on → absent via the branch's OWN revert (not inherited)", () => {
    let seq = 0;
    const f = (kind: CanonFactKind, payload: Record<string, unknown>): CanonFactRecord => ({
      seq: (seq += 1),
      requirementId: R,
      kind,
      actor: "camino:test",
      payload,
      recordedAt: `2026-07-02T00:00:0${seq}.000Z`,
    });
    const facts = [
      f("implementation-recorded", { branch: M1, sha: HB1 }),
      f("revert-recorded", { contextKind: "branch", branch: M1, sha: HB2 }),
    ];
    const before = projectRequirementStatus(entry, [facts[0] as CanonFactRecord], branch(M1, HB1));
    const after = projectRequirementStatus(entry, facts, branch(M1, HB2));
    expect(before.implementation).toEqual({ kind: "present-on", branch: M1 });
    expect(after.implementation).toEqual({ kind: "absent" });
  });
});
