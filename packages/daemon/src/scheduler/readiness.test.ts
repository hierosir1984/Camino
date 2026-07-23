// WP-114: dependency readiness + dispatch order (CAM-PLAN-12) — pure.
import { describe, expect, it } from "vitest";
import { CONTRACT_SCHEMA_VERSION, contractHash } from "@camino/shared";
import type { ContractTerms, IssueContract } from "@camino/shared";
import {
  dependencyOrder,
  dependentsOf,
  latestContracts,
  selectNextDispatch,
  unmetDependencies,
} from "./readiness.js";
import type { IssueStateSnapshot } from "./readiness.js";

function contract(issueId: string, dependsOn: string[], version = 1): IssueContract {
  const terms: ContractTerms = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    missionId: "m1",
    issueId,
    version,
    template: "feature",
    title: `t ${issueId}`,
    goal: `g ${issueId}`,
    acceptanceCriteria: ["done"],
    requirementIds: [],
    dependsOn: [...dependsOn].sort(),
    interfaces: [],
  };
  return {
    ...terms,
    contractHash: contractHash(terms),
    frozenAt: "2026-07-23T10:00:00.000Z",
    approvedBy: "david",
  };
}

function states(map: Record<string, string>): (id: string) => IssueStateSnapshot | undefined {
  return (id) => (map[id] === undefined ? undefined : { state: map[id], failureCount: 0 });
}

describe("latestContracts + dependencyOrder", () => {
  it("keeps the newest version per issue and orders deterministically", () => {
    const latest = latestContracts([
      contract("m1.I2", ["m1.I1"]),
      contract("m1.I1", []),
      contract("m1.I2", [], 2), // v2 DROPS the dependency — the edit wins
    ]);
    expect(latest.get("m1.I2")?.version).toBe(2);
    expect(dependencyOrder(latest)).toEqual(["m1.I1", "m1.I2"]);
  });

  it("breaks ties lexicographically (stable dispatch order)", () => {
    const latest = latestContracts([
      contract("m1.I3", []),
      contract("m1.I1", []),
      contract("m1.I2", []),
    ]);
    expect(dependencyOrder(latest)).toEqual(["m1.I1", "m1.I2", "m1.I3"]);
  });

  it("refuses a cycle loudly (plans validate acyclic at approval)", () => {
    const latest = latestContracts([contract("m1.I1", ["m1.I2"]), contract("m1.I2", ["m1.I1"])]);
    expect(() => dependencyOrder(latest)).toThrow(/cycle/);
  });
});

describe("unmetDependencies", () => {
  it("counts unmerged and OUTSIDE-THE-SET dependencies as unmet (fail-closed)", () => {
    const latest = latestContracts([contract("m1.I1", []), contract("m1.I2", ["m1.I1", "m1.I9"])]);
    const c = latest.get("m1.I2") as IssueContract;
    expect(unmetDependencies(c, latest, states({ "m1.I1": "merged" }))).toEqual(["m1.I9"]);
    expect(unmetDependencies(c, latest, states({ "m1.I1": "ready" }))).toEqual(["m1.I1", "m1.I9"]);
  });
});

describe("selectNextDispatch (CAM-PLAN-12 acceptance)", () => {
  const contracts = [contract("m1.I1", []), contract("m1.I2", ["m1.I1"])];

  it("an issue with an unmerged dependency is never selected", () => {
    // I2 is (wrongly) recorded ready while I1 is not merged: the re-check
    // holds the dispatch rather than trusting the stale readiness.
    const sel = selectNextDispatch(contracts, states({ "m1.I1": "escalated", "m1.I2": "ready" }));
    expect(sel).toMatchObject({
      ok: false,
      hold: { kind: "ready-issue-has-unmet-deps", issueId: "m1.I2", unmet: ["m1.I1"] },
    });
  });

  it("selects in dependency order once deps are merged", () => {
    const sel = selectNextDispatch(contracts, states({ "m1.I1": "merged", "m1.I2": "ready" }));
    expect(sel).toMatchObject({ ok: true, issueId: "m1.I2" });
  });

  it("holds while ANY issue of the mission has an attempt in flight (sequential per mission)", () => {
    for (const inFlight of ["claimed", "implementing", "validating"]) {
      const sel = selectNextDispatch(contracts, states({ "m1.I1": inFlight, "m1.I2": "ready" }));
      expect(sel).toMatchObject({ ok: false, hold: { kind: "attempt-active", issueId: "m1.I1" } });
    }
  });

  it("a contract edit changes the very next decision (readiness recomputed fresh)", () => {
    // v1: I2 depends on I1 (merged) → dispatchable.
    const before = selectNextDispatch(contracts, states({ "m1.I1": "merged", "m1.I2": "ready" }));
    expect(before.ok).toBe(true);
    // v2 EDIT: I2 now also depends on I3 (not merged, and itself blocked
    // so it is not simply dispatched first) → I2 held immediately.
    const edited = [...contracts, contract("m1.I2", ["m1.I1", "m1.I3"], 2), contract("m1.I3", [])];
    const after = selectNextDispatch(
      edited,
      states({ "m1.I1": "merged", "m1.I2": "ready", "m1.I3": "blocked" }),
    );
    expect(after).toMatchObject({
      ok: false,
      hold: { kind: "ready-issue-has-unmet-deps", issueId: "m1.I2", unmet: ["m1.I3"] },
    });
  });
});

describe("dependentsOf", () => {
  it("names direct dependents from the latest contracts", () => {
    const latest = latestContracts([contract("m1.I1", []), contract("m1.I2", ["m1.I1"])]);
    expect(dependentsOf(latest, "m1.I1")).toEqual(["m1.I2"]);
  });
});
