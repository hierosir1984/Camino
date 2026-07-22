import { describe, expect, it } from "vitest";
import {
  CONTRACT_REFERENCE_OBLIGATIONS,
  CONTRACT_SCHEMA_VERSION,
  contractHash,
  contractProblems,
  contractRefProblems,
  contractTermsOf,
  isSha256Hex,
} from "./contract.js";
import type { ContractTerms, IssueContract } from "./contract.js";

function terms(overrides: Partial<ContractTerms> = {}): ContractTerms {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    missionId: "m1",
    issueId: "m1.I1",
    version: 1,
    template: "feature",
    title: "Deliver the export module",
    goal: "Users can export their data as CSV.",
    acceptanceCriteria: ["A CSV downloads with one row per record."],
    requirementIds: ["CAM-APP-01"],
    dependsOn: [],
    interfaces: [{ name: "export-api", kind: "api", description: "GET /export returns CSV" }],
    ...overrides,
  };
}

function contract(overrides: Partial<IssueContract> = {}): IssueContract {
  const base = terms();
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    contractHash: overrides.contractHash ?? contractHash(contractTermsOf(merged as IssueContract)),
    frozenAt: overrides.frozenAt ?? "2026-07-22T10:00:00.000Z",
    approvedBy: overrides.approvedBy ?? "david",
  };
}

describe("contractHash", () => {
  it("is stable across key insertion order (content-addressed identity)", () => {
    const a = terms();
    const reordered = JSON.parse(
      `{"interfaces":${JSON.stringify(a.interfaces)},"schemaVersion":${a.schemaVersion},` +
        `"version":1,"missionId":"m1","issueId":"m1.I1","template":"feature",` +
        `"title":${JSON.stringify(a.title)},"goal":${JSON.stringify(a.goal)},` +
        `"acceptanceCriteria":${JSON.stringify(a.acceptanceCriteria)},` +
        `"requirementIds":${JSON.stringify(a.requirementIds)},"dependsOn":[]}`,
    ) as ContractTerms;
    expect(contractHash(reordered)).toBe(contractHash(a));
  });

  it("changes when any term changes", () => {
    const base = contractHash(terms());
    expect(contractHash(terms({ title: "Different" }))).not.toBe(base);
    expect(contractHash(terms({ version: 2 }))).not.toBe(base);
    expect(contractHash(terms({ acceptanceCriteria: ["Other criterion."] }))).not.toBe(base);
    expect(contractHash(terms({ dependsOn: ["m1.I2"] }))).not.toBe(base);
    expect(contractHash(terms({ interfaces: [] }))).not.toBe(base);
  });

  it("is a lowercase sha-256 hex string", () => {
    expect(isSha256Hex(contractHash(terms()))).toBe(true);
  });
});

describe("contractProblems", () => {
  it("accepts a well-formed contract whose hash matches its terms", () => {
    expect(contractProblems(contract())).toEqual([]);
  });

  it("names a hash that does not match the terms (tamper evidence)", () => {
    const tampered = { ...contract(), title: "Edited after freeze" };
    const problems = contractProblems(tampered);
    expect(problems.some((p) => p.includes("does not match the recomputed"))).toBe(true);
  });

  it("refuses a mutated-in-place criteria list via the same hash check", () => {
    const c = contract();
    const mutated = { ...c, acceptanceCriteria: [...c.acceptanceCriteria, "Smuggled criterion."] };
    expect(contractProblems(mutated)).not.toEqual([]);
  });

  it("requires issueId to be namespaced under missionId", () => {
    const c = contract({ issueId: "other.I1" });
    expect(contractProblems(c).some((p) => p.includes("namespaced"))).toBe(true);
  });

  it("requires sorted duplicate-free requirementIds and dependsOn", () => {
    const unsorted = contract({ requirementIds: ["CAM-APP-02", "CAM-APP-01"] });
    expect(contractProblems(unsorted).some((p) => p.includes("strictly sorted"))).toBe(true);
    const duplicated = contract({ dependsOn: ["m1.I2", "m1.I2"] });
    expect(contractProblems(duplicated).some((p) => p.includes("strictly sorted"))).toBe(true);
  });

  it("refuses a self-dependency", () => {
    const c = contract({ dependsOn: ["m1.I1"] });
    expect(contractProblems(c).some((p) => p.includes("own issueId"))).toBe(true);
  });

  it("refuses malformed requirement ids, versions, templates, and instants", () => {
    expect(contractProblems(contract({ requirementIds: ["not-an-id"] }))).not.toEqual([]);
    expect(contractProblems(contract({ version: 0 }))).not.toEqual([]);
    expect(contractProblems({ ...contract(), template: "refactor" })).not.toEqual([]);
    expect(contractProblems(contract({ frozenAt: "2026-02-30T00:00:00.000Z" }))).not.toEqual([]);
    expect(contractProblems(contract({ frozenAt: "2026-07-22 10:00" }))).not.toEqual([]);
  });

  it("refuses unknown fields (closed schema)", () => {
    const c = { ...contract(), extra: true };
    expect(contractProblems(c).some((p) => p.includes("unknown field"))).toBe(true);
  });

  it("requires at least one acceptance criterion", () => {
    expect(contractProblems(contract({ acceptanceCriteria: [] }))).not.toEqual([]);
  });

  it("is total over junk", () => {
    for (const junk of [null, 7, "x", [], undefined]) {
      expect(Array.isArray(contractProblems(junk))).toBe(true);
      expect(contractProblems(junk)).not.toEqual([]);
    }
  });
});

describe("contractTermsOf", () => {
  it("strips exactly the record metadata and copies deeply", () => {
    const c = contract();
    const t = contractTermsOf(c);
    expect(Object.keys(t).sort()).toEqual([
      "acceptanceCriteria",
      "dependsOn",
      "goal",
      "interfaces",
      "issueId",
      "missionId",
      "requirementIds",
      "schemaVersion",
      "template",
      "title",
      "version",
    ]);
    expect(t.interfaces[0]).not.toBe(c.interfaces[0]);
    expect(contractHash(t)).toBe(c.contractHash);
  });
});

describe("contractRefProblems", () => {
  it("accepts a well-formed reference", () => {
    expect(
      contractRefProblems({
        issueId: "m1.I1",
        contractVersion: 1,
        contractHash: contractHash(terms()),
      }),
    ).toEqual([]);
  });

  it("refuses missing or malformed fields and unknown fields", () => {
    expect(contractRefProblems({})).not.toEqual([]);
    expect(
      contractRefProblems({ issueId: "m1.I1", contractVersion: 0, contractHash: "0".repeat(64) }),
    ).not.toEqual([]);
    expect(
      contractRefProblems({
        issueId: "m1.I1",
        contractVersion: 1,
        contractHash: "NOT-HEX",
      }),
    ).not.toEqual([]);
    expect(
      contractRefProblems({
        issueId: "m1.I1",
        contractVersion: 1,
        contractHash: contractHash(terms()),
        extra: 1,
      }),
    ).not.toEqual([]);
  });
});

describe("CONTRACT_REFERENCE_OBLIGATIONS", () => {
  it("pins the artifacts that owe a ContractRef (CAM-PLAN-04)", () => {
    // Exact-list pin: a consuming WP deleting its obligation trips this test.
    expect(CONTRACT_REFERENCE_OBLIGATIONS).toEqual([
      "issue-created event payload carries { contractVersion, contractHash } (WP-110, at freeze)",
      "attempt records carry a ContractRef for the contract they execute (WP-114 dispatch)",
      "issue PRs embed their ContractRef in the PR body (WP-117)",
      "mission PRs embed the ContractRef set of their issues (WP-117)",
      "evidence packets carry the ContractRef their evidence binds to (WP-116)",
      "context packs cite the ContractRef they were assembled against (WP-113)",
    ]);
    expect(Object.isFrozen(CONTRACT_REFERENCE_OBLIGATIONS)).toBe(true);
  });
});
