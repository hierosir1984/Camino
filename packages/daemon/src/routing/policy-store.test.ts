/**
 * WP-106 per-project routing policy store (CAM-ROUTE-02): user-editable
 * role × task-features → (harness, model, reasoning tier) with per-project
 * provider allowlists; shipped defaults when no edit is stored; structural
 * refusals; cross-family trade-offs recorded, never silent.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY_TABLE } from "@camino/shared";
import { RoutingPolicyStore } from "./policy-store.js";

let dirs: string[] = [];
function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-policy-"));
  dirs.push(dir);
  return join(dir, "policies.sqlite");
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

type Editable = {
  providerAllowlist: string[];
  cells: Record<
    string,
    Record<string, Record<string, { harness: string; model: string | null; reasoningTier: string }>>
  >;
};
function copyOfDefaults(): Editable {
  return JSON.parse(JSON.stringify(DEFAULT_POLICY_TABLE)) as Editable;
}

const CLOCK = { now: () => new Date("2026-07-22T12:00:00Z") };

describe("defaults and provenance", () => {
  it("routes an unedited project on the shipped defaults, provenance stated", () => {
    const store = new RoutingPolicyStore(tempPath(), CLOCK);
    try {
      const policy = store.getEffectivePolicy("project-a");
      expect(policy.source).toBe("default");
      expect(policy.table).toBe(DEFAULT_POLICY_TABLE);
      expect(policy.crossFamilyViolations).toEqual([]);
      expect(policy.updatedAt).toBeUndefined();
      const resolved = store.resolve("project-a", "verifier", {
        template: "feature",
        riskTier: "high",
      });
      expect(resolved.source).toBe("default");
      expect(resolved.assignment.harness).toBe("grok-build");
    } finally {
      store.close();
    }
  });
});

describe("user edits", () => {
  it("stores a valid edit per project, isolated, and resolves from it", () => {
    const store = new RoutingPolicyStore(tempPath(), CLOCK);
    try {
      const edited = copyOfDefaults();
      edited.cells["feature"]!["high"]!["implementer"]!.harness = "codex-cli";
      edited.cells["feature"]!["high"]!["implementer"]!.reasoningTier = "xhigh";
      edited.cells["feature"]!["high"]!["reviewer"]!.harness = "claude-code";
      const result = store.setPolicyTable("project-a", edited, "David");
      expect(result).toEqual({ ok: true, crossFamilyViolations: [] });

      const policy = store.getEffectivePolicy("project-a");
      expect(policy.source).toBe("project");
      expect(policy.updatedAt).toBe("2026-07-22T12:00:00.000Z");
      expect(policy.updatedBy).toBe("David");
      expect(
        store.resolve("project-a", "implementer", { template: "feature", riskTier: "high" })
          .assignment,
      ).toEqual({ harness: "codex-cli", model: null, reasoningTier: "xhigh" });

      // A different project is untouched by the edit.
      expect(store.getEffectivePolicy("project-b").source).toBe("default");
    } finally {
      store.close();
    }
  });

  it("persists edits across a store reopen", () => {
    const path = tempPath();
    const store = new RoutingPolicyStore(path, CLOCK);
    const edited = copyOfDefaults();
    edited.cells["quick-task"]!["low"]!["implementer"]!.reasoningTier = "low";
    expect(store.setPolicyTable("project-a", edited, "David").ok).toBe(true);
    store.close();

    const reopened = new RoutingPolicyStore(path, CLOCK);
    try {
      const policy = reopened.getEffectivePolicy("project-a");
      expect(policy.source).toBe("project");
      expect(
        reopened.resolve("project-a", "implementer", { template: "quick-task", riskTier: "low" })
          .assignment.reasoningTier,
      ).toBe("low");
    } finally {
      reopened.close();
    }
  });

  it("resets a project to the defaults by deleting its stored table", () => {
    const store = new RoutingPolicyStore(tempPath(), CLOCK);
    try {
      expect(store.setPolicyTable("project-a", copyOfDefaults(), "David").ok).toBe(true);
      expect(store.getEffectivePolicy("project-a").source).toBe("project");
      store.resetToDefault("project-a");
      expect(store.getEffectivePolicy("project-a").source).toBe("default");
    } finally {
      store.close();
    }
  });

  it("supports per-project provider allowlists that narrow routing", () => {
    const store = new RoutingPolicyStore(tempPath(), CLOCK);
    try {
      const edited = copyOfDefaults();
      edited.providerAllowlist = ["anthropic", "openai"];
      // With xai disallowed, every verifier cell must move off grok-build.
      for (const template of Object.keys(edited.cells)) {
        for (const risk of Object.keys(edited.cells[template]!)) {
          edited.cells[template]![risk]!["verifier"]!.harness = "codex-cli";
        }
      }
      const result = store.setPolicyTable("project-a", edited, "David");
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The narrowed allowlist costs the plan-verify triad (challenger and
        // verifier now share a family) — recorded, not hidden.
        expect(result.crossFamilyViolations.length).toBeGreaterThan(0);
        expect(
          result.crossFamilyViolations.every((v) => v.constraint === "plan-verify-triad"),
        ).toBe(true);
      }
      const readBack = store.getEffectivePolicy("project-a");
      expect(readBack.crossFamilyViolations).toEqual(result.ok ? result.crossFamilyViolations : []);
    } finally {
      store.close();
    }
  });
});

describe("refusals", () => {
  it("refuses a structurally invalid table with precise violations and stores nothing", () => {
    const store = new RoutingPolicyStore(tempPath(), CLOCK);
    try {
      const edited = copyOfDefaults();
      edited.cells["feature"]!["low"]!["planner"]!.harness = "unsanctioned-cli";
      const result = store.setPolicyTable("project-a", edited, "David");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("invalid-table");
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0]?.path).toBe("cells.feature.low.planner.harness");
      }
      expect(store.getEffectivePolicy("project-a").source).toBe("default");
    } finally {
      store.close();
    }
  });

  it("refuses candidates whose live shape diverges from their serialized snapshot", () => {
    // Round-1 review finding 3: validation must run on the exact snapshot
    // that would persist, so toJSON handlers and prototype-inherited fields
    // cannot pass validation as one shape and store another.
    const store = new RoutingPolicyStore(tempPath(), CLOCK);
    try {
      const withToJson = Object.assign(copyOfDefaults(), {
        toJSON: () => ({ providerAllowlist: ["anthropic"], cells: {} }),
      });
      const toJsonResult = store.setPolicyTable("project-a", withToJson, "David");
      expect(toJsonResult.ok).toBe(false);
      expect(store.getEffectivePolicy("project-a").source).toBe("default");

      const prototypeCarrier = Object.create(copyOfDefaults()) as unknown;
      const protoResult = store.setPolicyTable("project-a", prototypeCarrier, "David");
      expect(protoResult.ok).toBe(false);
      expect(store.getEffectivePolicy("project-a").source).toBe("default");

      const circular: Record<string, unknown> = copyOfDefaults();
      circular["cells"] = circular; // JSON-unserializable
      const circularResult = store.setPolicyTable("project-a", circular, "David");
      expect(circularResult).toMatchObject({ ok: false, code: "invalid-table" });
      expect(store.getEffectivePolicy("project-a").source).toBe("default");
    } finally {
      store.close();
    }
  });

  it("persists exactly the validated snapshot — a toJSON that MANUFACTURES a valid table is that table", () => {
    // Round-2 review finding 6 pinned as semantics: the live object is
    // never consulted; only its serialized snapshot is validated and
    // persisted, so a valid manufactured snapshot is accepted exactly as
    // if passed directly, and later reads agree with it byte-for-byte.
    const store = new RoutingPolicyStore(tempPath(), CLOCK);
    try {
      const manufactured = copyOfDefaults();
      manufactured.cells["feature"]!["low"]!["implementer"]!.reasoningTier = "xhigh";
      const weirdLiveObject = { marker: "not a policy table at all", toJSON: () => manufactured };
      const result = store.setPolicyTable("project-a", weirdLiveObject, "David");
      expect(result.ok).toBe(true);
      const readBack = store.getEffectivePolicy("project-a");
      expect(readBack.source).toBe("project");
      expect(JSON.parse(JSON.stringify(readBack.table))).toEqual(manufactured);
    } finally {
      store.close();
    }
  });

  it("surfaces the resolved cell's recorded cross-family trade-offs at lookup time", () => {
    // Round-1 review finding 9: the dispatch lookup must not hide what the
    // edit path recorded.
    const store = new RoutingPolicyStore(tempPath(), CLOCK);
    try {
      const edited = copyOfDefaults();
      edited.cells["feature"]!["high"]!["reviewer"]!.harness = "claude-code"; // implementer's family
      expect(store.setPolicyTable("project-a", edited, "David").ok).toBe(true);
      const affected = store.resolve("project-a", "reviewer", {
        template: "feature",
        riskTier: "high",
      });
      expect(affected.crossFamilyViolations).toHaveLength(1);
      expect(affected.crossFamilyViolations[0]).toMatchObject({
        constraint: "implement-review",
        requirement: "CAM-VAL-06b",
      });
      const untouched = store.resolve("project-a", "reviewer", {
        template: "feature",
        riskTier: "low",
      });
      expect(untouched.crossFamilyViolations).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("refuses malformed request fields (empty, NUL, unpaired surrogate)", () => {
    const store = new RoutingPolicyStore(tempPath(), CLOCK);
    try {
      const table = copyOfDefaults();
      expect(store.setPolicyTable("", table, "David")).toMatchObject({
        ok: false,
        code: "invalid-request",
      });
      expect(store.setPolicyTable("project\0a", table, "David")).toMatchObject({
        ok: false,
        code: "invalid-request",
      });
      expect(store.setPolicyTable("project-a", table, "\ud800")).toMatchObject({
        ok: false,
        code: "invalid-request",
      });
      expect(() => store.getEffectivePolicy("")).toThrow(TypeError);
    } finally {
      store.close();
    }
  });

  it("fails closed on a stored row that no longer parses or validates", () => {
    const path = tempPath();
    const store = new RoutingPolicyStore(path, CLOCK);
    expect(store.setPolicyTable("project-a", copyOfDefaults(), "David").ok).toBe(true);
    expect(store.setPolicyTable("project-b", copyOfDefaults(), "David").ok).toBe(true);
    store.close();

    const db = new Database(path);
    db.prepare(
      "UPDATE routing_policies SET table_json = 'not json' WHERE project_id = 'project-a'",
    ).run();
    db.prepare(
      'UPDATE routing_policies SET table_json = \'{"providerAllowlist":["anthropic"],"cells":{}}\' WHERE project_id = \'project-b\'',
    ).run();
    db.close();

    const reopened = new RoutingPolicyStore(path, CLOCK);
    try {
      expect(() => reopened.getEffectivePolicy("project-a")).toThrow(/not valid JSON/);
      expect(() => reopened.getEffectivePolicy("project-b")).toThrow(/fails validation/);
    } finally {
      reopened.close();
    }
  });

  it("returns a deep-frozen table so a caller cannot mutate stored policy in memory", () => {
    const store = new RoutingPolicyStore(tempPath(), CLOCK);
    try {
      expect(store.setPolicyTable("project-a", copyOfDefaults(), "David").ok).toBe(true);
      const policy = store.getEffectivePolicy("project-a");
      const cell = policy.table.cells.feature.high.reviewer as { harness: string };
      expect(() => {
        cell.harness = "claude-code";
      }).toThrow(TypeError);
    } finally {
      store.close();
    }
  });
});
