/**
 * WP-106 routing contract (CAM-ROUTE-01/02): closed sets, policy-table
 * validation, cross-family geometry, and the shipped defaults.
 *
 * The cross-family suite is the acceptance surface for CAM-ROUTE-02's
 * "shipped defaults make planner/challenger/verifier cross-family by
 * construction" — including the explicit assertion that the default table
 * NEVER assigns the same provider family to the implementer and reviewer
 * roles, in any feature cell.
 */
import { describe, expect, it } from "vitest";
import {
  CROSS_FAMILY_CONSTRAINTS,
  DEFAULT_POLICY_TABLE,
  HARNESS_FAMILY,
  OFFICIAL_ADAPTER_NAMES,
  PROVIDER_FAMILIES,
  REASONING_TIERS,
  RISK_TIERS,
  ROUTING_ROLES,
  TASK_TEMPLATES,
  QUOTA_PAUSE_THRESHOLD,
  crossFamilyViolations,
  harnessFamily,
  makeCrossFamilyDefaults,
  resolveAssignment,
  validatePolicyTable,
} from "./index.js";
import type { PolicyTable, RiskTier, RoutingRole, TaskTemplate } from "./index.js";

/** Every (template, riskTier) coordinate — the sweep the AC tests run over. */
const ALL_CELLS: Array<[TaskTemplate, RiskTier]> = TASK_TEMPLATES.flatMap((template) =>
  RISK_TIERS.map((risk): [TaskTemplate, RiskTier] => [template, risk]),
);

function familyOf(table: PolicyTable, template: TaskTemplate, risk: RiskTier, role: RoutingRole) {
  return HARNESS_FAMILY[table.cells[template][risk][role].harness];
}

/** A structurally valid, fully mutable copy of the defaults to corrupt. */
interface EditableTable {
  providerAllowlist: string[];
  cells: Record<string, Record<string, Record<string, Record<string, unknown>>>>;
}
function editableCopy(): EditableTable {
  return JSON.parse(JSON.stringify(DEFAULT_POLICY_TABLE)) as EditableTable;
}

describe("closed sets and harness→family mapping", () => {
  it("maps every official harness to a known provider family (sweep, not a hand list)", () => {
    for (const harness of OFFICIAL_ADAPTER_NAMES) {
      expect(PROVIDER_FAMILIES).toContain(HARNESS_FAMILY[harness]);
      expect(harnessFamily(harness)).toBe(HARNESS_FAMILY[harness]);
    }
    // The mapping covers exactly the official set — no orphan entries.
    expect(Object.keys(HARNESS_FAMILY).sort()).toEqual([...OFFICIAL_ADAPTER_NAMES].sort());
  });

  it("refuses an unknown harness name", () => {
    expect(() => harnessFamily("shell-injected-cli")).toThrow(TypeError);
  });

  it("pins the role vocabulary and the registry-item-13 pause threshold", () => {
    expect(ROUTING_ROLES).toEqual(["planner", "challenger", "implementer", "reviewer", "verifier"]);
    expect(QUOTA_PAUSE_THRESHOLD).toBe(0.85);
    expect(REASONING_TIERS).toContain("xhigh");
  });
});

describe("DEFAULT_POLICY_TABLE — cross-family by construction (CAM-ROUTE-02)", () => {
  it("never assigns the same provider family to implementer and reviewer, in any cell", () => {
    for (const [template, risk] of ALL_CELLS) {
      expect(
        familyOf(DEFAULT_POLICY_TABLE, template, risk, "implementer"),
        `${template}/${risk}: implementer and reviewer must be cross-family (CAM-VAL-06b)`,
      ).not.toBe(familyOf(DEFAULT_POLICY_TABLE, template, risk, "reviewer"));
    }
  });

  it("never assigns the same provider family to implementer and verifier, in any cell", () => {
    for (const [template, risk] of ALL_CELLS) {
      expect(
        familyOf(DEFAULT_POLICY_TABLE, template, risk, "implementer"),
        `${template}/${risk}: mission verification must be cross-family from the implementer (CAM-VAL-06a)`,
      ).not.toBe(familyOf(DEFAULT_POLICY_TABLE, template, risk, "verifier"));
    }
  });

  it("keeps planner, challenger, and verifier pairwise cross-family in every cell", () => {
    for (const [template, risk] of ALL_CELLS) {
      const families = new Set(
        (["planner", "challenger", "verifier"] as const).map((role) =>
          familyOf(DEFAULT_POLICY_TABLE, template, risk, role),
        ),
      );
      expect(families.size, `${template}/${risk}: the triad must span three families`).toBe(3);
    }
  });

  it("reports zero violations against every named constraint", () => {
    expect(crossFamilyViolations(DEFAULT_POLICY_TABLE)).toEqual([]);
    // The constraint list itself names its requirements (nothing vacuous).
    expect(CROSS_FAMILY_CONSTRAINTS.map((c) => c.name)).toEqual([
      "plan-challenge",
      "implement-review",
      "mission-verify",
      "plan-verify-triad",
    ]);
  });

  it("is structurally valid, fully enumerated, and allowlists all three families", () => {
    expect(validatePolicyTable(DEFAULT_POLICY_TABLE)).toEqual([]);
    expect([...DEFAULT_POLICY_TABLE.providerAllowlist].sort()).toEqual(
      [...PROVIDER_FAMILIES].sort(),
    );
    for (const [template, risk] of ALL_CELLS) {
      for (const role of ROUTING_ROLES) {
        const assignment = DEFAULT_POLICY_TABLE.cells[template][risk][role];
        expect(OFFICIAL_ADAPTER_NAMES).toContain(assignment.harness);
        expect(REASONING_TIERS).toContain(assignment.reasoningTier);
        // Shipped defaults pin no model: the harness default is used, and
        // what that resolves to is a capability-registry observation.
        expect(assignment.model).toBeNull();
      }
    }
  });

  it("is deep-frozen: nested cells refuse mutation", () => {
    const cell = DEFAULT_POLICY_TABLE.cells.feature.high.reviewer as { harness: string };
    expect(() => {
      cell.harness = "claude-code";
    }).toThrow(TypeError);
    expect(() => {
      (DEFAULT_POLICY_TABLE.providerAllowlist as unknown as string[]).push("anthropic");
    }).toThrow(TypeError);
    expect(DEFAULT_POLICY_TABLE.cells.feature.high.reviewer.harness).toBe("codex-cli");
  });

  it("construction refuses a rotation that breaks the geometry", () => {
    // Same-family reviewer/implementer — the implement-review constraint.
    expect(() =>
      makeCrossFamilyDefaults({
        planner: "claude-code",
        challenger: "codex-cli",
        implementer: "claude-code",
        reviewer: "claude-code",
        verifier: "grok-build",
      }),
    ).toThrow(/cross-family construction/);
    // Non-distinct triad (verifier shares the challenger's family).
    expect(() =>
      makeCrossFamilyDefaults({
        planner: "claude-code",
        challenger: "codex-cli",
        implementer: "claude-code",
        reviewer: "grok-build",
        verifier: "codex-cli",
      }),
    ).toThrow(/cross-family construction/);
  });
});

describe("validatePolicyTable — structural refusals", () => {
  it("accepts a round-tripped copy of the defaults", () => {
    expect(validatePolicyTable(editableCopy())).toEqual([]);
  });

  it("refuses non-object candidates outright", () => {
    expect(validatePolicyTable(null)).toHaveLength(1);
    expect(validatePolicyTable([])).toHaveLength(1);
    expect(validatePolicyTable("table")).toHaveLength(1);
  });

  it("refuses an unknown harness with a precise path", () => {
    const table = editableCopy();
    table.cells["feature"]!["low"]!["planner"]!["harness"] = "unknown-cli";
    const violations = validatePolicyTable(table);
    expect(violations).toEqual([
      { path: "cells.feature.low.planner.harness", reason: 'unknown harness: "unknown-cli"' },
    ]);
  });

  it("refuses an assignment whose family is outside the project allowlist", () => {
    const table = editableCopy();
    table.providerAllowlist = ["anthropic", "openai"];
    const violations = validatePolicyTable(table);
    // Every verifier cell routes to grok-build (xai) in the defaults.
    expect(violations.length).toBe(ALL_CELLS.length);
    for (const violation of violations) {
      expect(violation.path).toMatch(/\.verifier\.harness$/);
      expect(violation.reason).toContain("not in the project's provider allowlist");
    }
  });

  it("refuses empty, unknown, and duplicate allowlist entries", () => {
    const table = editableCopy();
    table.providerAllowlist = [];
    expect(validatePolicyTable(table).some((v) => v.path === "providerAllowlist")).toBe(true);
    table.providerAllowlist = ["anthropic", "anthropic", "openrouter"];
    const violations = validatePolicyTable(table);
    expect(violations.some((v) => v.reason.includes("duplicate"))).toBe(true);
    expect(violations.some((v) => v.reason.includes("unknown provider family"))).toBe(true);
  });

  it("refuses unknown top-level fields, including an own __proto__ key from JSON", () => {
    // Round-1 review finding 10: top-level unknowns were silently accepted.
    const extra = editableCopy() as unknown as Record<string, unknown>;
    extra["extra"] = true;
    expect(validatePolicyTable(extra)).toEqual([
      { path: "extra", reason: "unknown policy-table field" },
    ]);
    const withProto = JSON.parse(
      `{"__proto__":{},${JSON.stringify(editableCopy()).slice(1)}`,
    ) as unknown;
    expect(validatePolicyTable(withProto)).toEqual([
      { path: "__proto__", reason: "unknown policy-table field" },
    ]);
  });

  it("refuses non-plain candidates: inherited-field carriers and class instances", () => {
    // Round-1 finding 3 / round-2 finding 7: only PLAIN objects are valid —
    // a candidate whose fields live on its prototype, or whose behavior
    // lives on a class, diverges from the JSON snapshot that persists.
    const carrier = Object.create(editableCopy()) as Record<string, unknown>;
    expect(validatePolicyTable(carrier)).toEqual([
      { path: "", reason: "policy table must be a plain object" },
    ]);
    class PolicyCarrier {}
    const instance = Object.assign(new PolicyCarrier(), editableCopy());
    expect(validatePolicyTable(instance)).toEqual([
      { path: "", reason: "policy table must be a plain object" },
    ]);
  });

  it("refuses model identifiers that are not clean printable strings", () => {
    // Round-1 review finding 7: NUL, unpaired surrogates, whitespace
    // padding, control characters, and unbounded length are all shape
    // defects. (Harness ACCEPTANCE of a clean id is the named dispatch-time
    // boundary — see the PolicyAssignment doc.)
    // ALLOWLIST regression (round-3 finding 5): rounds 2 and 3 each found
    // another invisible class a deny-list missed, so the validator now
    // admits printable non-space ASCII only.
    const cases: Array<[unknown, RegExp]> = [
      ["\u0000", /printable non-space ASCII/],
      ["\ud800", /printable non-space ASCII/], // unpaired surrogate
      ["  gpt-5.6-sol", /printable non-space ASCII/],
      ["gpt\n5", /printable non-space ASCII/],
      ["gpt\u200bmodel", /printable non-space ASCII/], // zero-width space
      ["\u202egpt", /printable non-space ASCII/], // bidirectional override
      ["a\u2028b", /printable non-space ASCII/], // line separator
      ["gpt\u034fmodel", /printable non-space ASCII/], // combining grapheme joiner
      ["gpt\ufe0fmodel", /printable non-space ASCII/], // variation selector 16
      ["gpt\u3164model", /printable non-space ASCII/], // Hangul filler
      ["x".repeat(300), /exceeds/],
      [42, /must be null/],
      [undefined, /must be null/],
    ];
    for (const [model, expected] of cases) {
      const table = editableCopy();
      if (model === undefined) {
        delete table.cells["feature"]!["low"]!["planner"]!["model"];
      } else {
        table.cells["feature"]!["low"]!["planner"]!["model"] = model;
      }
      const violations = validatePolicyTable(table);
      expect(
        violations.some(
          (v) => v.path === "cells.feature.low.planner.model" && expected.test(v.reason),
        ),
        `model ${JSON.stringify(model)} must be refused with ${expected}`,
      ).toBe(true);
    }
    // A clean pinned identifier is accepted.
    const table = editableCopy();
    table.cells["feature"]!["low"]!["planner"]!["model"] = "claude-opus-4-8";
    expect(validatePolicyTable(table)).toEqual([]);
  });

  it("refuses missing cells, unknown keys, bad tiers, and bad models", () => {
    const table = editableCopy();
    delete table.cells["quick-task"]!["medium"]!["verifier"];
    table.cells["feature"]!["low"]!["challenger"]!["reasoningTier"] = "maximum-overdrive";
    table.cells["feature"]!["low"]!["implementer"]!["model"] = "";
    (table.cells as Record<string, unknown>)["hotfix"] = {};
    (table.cells["feature"] as Record<string, unknown>)["extreme"] = {};
    table.cells["feature"]!["high"]!["planner"]!["billing"] = "prepaid";
    const reasons = validatePolicyTable(table);
    expect(reasons.some((v) => v.path === "cells.quick-task.medium.verifier")).toBe(true);
    expect(reasons.some((v) => v.path === "cells.feature.low.challenger.reasoningTier")).toBe(true);
    expect(reasons.some((v) => v.path === "cells.feature.low.implementer.model")).toBe(true);
    expect(reasons.some((v) => v.path === "cells.hotfix")).toBe(true);
    expect(reasons.some((v) => v.path === "cells.feature.extreme")).toBe(true);
    expect(reasons.some((v) => v.path === "cells.feature.high.planner.billing")).toBe(true);
  });
});

describe("crossFamilyViolations — measurement on valid tables", () => {
  it("names the constraint, requirement, cell, and role pair for a same-family edit", () => {
    const table = editableCopy();
    // Route the reviewer to the implementer's family in one cell.
    table.cells["feature"]!["high"]!["reviewer"]!["harness"] = "claude-code";
    expect(validatePolicyTable(table)).toEqual([]); // structurally fine — the trade-off is the point
    const violations = crossFamilyViolations(table as unknown as PolicyTable);
    expect(violations).toEqual([
      {
        template: "feature",
        riskTier: "high",
        constraint: "implement-review",
        requirement: "CAM-VAL-06b",
        roles: ["implementer", "reviewer"],
        family: "anthropic",
      },
    ]);
  });

  it("reports every pairwise failure of the triad when one family covers it", () => {
    const table = editableCopy();
    for (const [template, risk] of ALL_CELLS) {
      for (const role of ROUTING_ROLES) {
        table.cells[template]![risk]![role]!["harness"] = "codex-cli";
      }
    }
    const violations = crossFamilyViolations(table as unknown as PolicyTable);
    // Per cell: plan-challenge (1) + implement-review (1) + mission-verify (1)
    // + triad pairs (3) = 6 pairwise failures.
    expect(violations.length).toBe(ALL_CELLS.length * 6);
    expect(new Set(violations.map((v) => v.family))).toEqual(new Set(["openai"]));
  });
});

describe("resolveAssignment — the WP-114 dispatch lookup", () => {
  it("returns the exact (harness, model, tier) tuple for a cell", () => {
    const assignment = resolveAssignment(DEFAULT_POLICY_TABLE, "challenger", {
      template: "feature",
      riskTier: "medium",
    });
    expect(assignment).toEqual({ harness: "codex-cli", model: null, reasoningTier: "xhigh" });
  });

  it("scales review depth with risk tier and template in the defaults", () => {
    const lowRisk = resolveAssignment(DEFAULT_POLICY_TABLE, "reviewer", {
      template: "feature",
      riskTier: "low",
    });
    const highRisk = resolveAssignment(DEFAULT_POLICY_TABLE, "reviewer", {
      template: "feature",
      riskTier: "high",
    });
    expect(REASONING_TIERS.indexOf(highRisk.reasoningTier)).toBeGreaterThan(
      REASONING_TIERS.indexOf(lowRisk.reasoningTier),
    );
    const quickChallenge = resolveAssignment(DEFAULT_POLICY_TABLE, "challenger", {
      template: "quick-task",
      riskTier: "low",
    });
    // Quick tasks get the proportionate mini-review depth (CAM-PLAN-03).
    expect(REASONING_TIERS.indexOf(quickChallenge.reasoningTier)).toBeLessThan(
      REASONING_TIERS.indexOf(
        resolveAssignment(DEFAULT_POLICY_TABLE, "challenger", {
          template: "feature",
          riskTier: "low",
        }).reasoningTier,
      ),
    );
  });

  it("throws on coordinates outside the closed sets — no silent default", () => {
    expect(() =>
      resolveAssignment(DEFAULT_POLICY_TABLE, "auditor" as RoutingRole, {
        template: "feature",
        riskTier: "low",
      }),
    ).toThrow(TypeError);
    expect(() =>
      resolveAssignment(DEFAULT_POLICY_TABLE, "planner", {
        template: "hotfix" as TaskTemplate,
        riskTier: "low",
      }),
    ).toThrow(TypeError);
    expect(() =>
      resolveAssignment(DEFAULT_POLICY_TABLE, "planner", {
        template: "feature",
        riskTier: "extreme" as RiskTier,
      }),
    ).toThrow(TypeError);
  });
});
