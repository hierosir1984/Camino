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
    // An unsafe integer version is refused HERE too (not just in the ref), so a
    // contract cannot mint a version its own ContractRef would reject — r7.
    expect(contractProblems(contract({ version: 9007199254740992 }))).not.toEqual([]);
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

  it("refuses a contractVersion that is an integer but not SAFE (loses precision) — r6", () => {
    for (const bad of [9007199254740992, Number.MAX_VALUE, 1.7976931348623157e308]) {
      expect(
        contractRefProblems({
          issueId: "m1.I1",
          contractVersion: bad,
          contractHash: "0".repeat(64),
        }),
      ).not.toEqual([]);
    }
    // A JSON literal beyond 2^53 already lost precision on parse; still refused.
    const parsed = JSON.parse(
      '{"issueId":"m1.I1","contractVersion":9007199254740993,"contractHash":"0000000000000000000000000000000000000000000000000000000000000000"}',
    );
    expect(contractRefProblems(parsed)).not.toEqual([]);
  });

  it("refuses an inherited-only reference (fields on the prototype vanish on storage) — r7", () => {
    const valid = { issueId: "m1.I1", contractVersion: 1, contractHash: contractHash(terms()) };
    const inherited = Object.create(valid) as Record<string, unknown>;
    // Every field is on the prototype; it serializes to "{}".
    expect(JSON.stringify(inherited)).toBe("{}");
    expect(contractRefProblems(inherited)).not.toEqual([]);
    // A null-prototype record with the same OWN fields is still accepted.
    const ownNull = Object.assign(Object.create(null), valid);
    expect(contractRefProblems(ownNull)).toEqual([]);
  });

  it("refuses an inherited-only contract and Object.prototype-polluted fields (own-enumerable only) — r8", () => {
    // An inherited-only IssueContract serializes to {} — must be rejected.
    const inheritedContract = Object.create(contract()) as Record<string, unknown>;
    expect(JSON.stringify(inheritedContract)).toBe("{}");
    expect(contractProblems(inheritedContract)).not.toEqual([]);

    // Object.prototype pollution: valid fields installed NON-ENUMERABLY on the
    // global prototype make even {} read as populated via the chain. Both
    // validators must still reject {} (they copy own-enumerable fields only).
    const fields: Record<string, unknown> = {
      issueId: "m1.I1",
      contractVersion: 1,
      contractHash: "a".repeat(64),
    };
    for (const [k, v] of Object.entries(fields)) {
      Object.defineProperty(Object.prototype, k, {
        value: v,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    try {
      expect(JSON.stringify({})).toBe("{}");
      expect(contractRefProblems({})).not.toEqual([]);
    } finally {
      for (const k of Object.keys(fields)) {
        delete (Object.prototype as Record<string, unknown>)[k];
      }
    }
  });

  it("is TOTAL over a revoked Proxy and defeats NESTED Object.prototype pollution — r10", () => {
    // A revoked Proxy makes `Array.isArray`/serialization throw — the validator
    // must return problems, never throw (its "total" guarantee, r10 finding 3).
    const revocableRef = Proxy.revocable({}, {});
    revocableRef.revoke();
    expect(() => contractRefProblems(revocableRef.proxy)).not.toThrow();
    expect(contractRefProblems(revocableRef.proxy).length).toBeGreaterThan(0);
    const revocableContract = Proxy.revocable({}, {});
    revocableContract.revoke();
    expect(() => contractProblems(revocableContract.proxy)).not.toThrow();
    expect(contractProblems(revocableContract.proxy).length).toBeGreaterThan(0);

    // NESTED Object.prototype pollution: a `{}` interface must still be rejected —
    // the recursive null-proto snapshot blocks the chain at every level (r10 #2).
    const nested: Record<string, unknown> = { name: "x", kind: "api", description: "y" };
    for (const [k, v] of Object.entries(nested)) {
      Object.defineProperty(Object.prototype, k, {
        value: v,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    try {
      expect(contractProblems({ ...contract(), interfaces: [{}] })).not.toEqual([]);
    } finally {
      for (const k of Object.keys(nested)) {
        delete (Object.prototype as Record<string, unknown>)[k];
      }
    }
  });

  it("stays total when the THROWN error is itself hostile (thrown null / throwing message) — r11 #2", () => {
    // A getter that throws `null` during serialization: the validator must return
    // problems, never throw (`(err as Error).message` on null would throw).
    const throwsNull = {
      get issueId(): string {
        throw null;
      },
    };
    expect(() => contractRefProblems(throwsNull)).not.toThrow();
    expect(contractRefProblems(throwsNull).length).toBeGreaterThan(0);
    expect(() => contractProblems(throwsNull)).not.toThrow();

    // A value whose serialization throws an Error with a THROWING `message` getter.
    const hostile = {
      toJSON(): never {
        const e = new Error();
        Object.defineProperty(e, "message", {
          get(): string {
            throw new Error("message trap");
          },
        });
        throw e;
      },
    };
    expect(() => contractRefProblems(hostile)).not.toThrow();
    expect(() => contractProblems(hostile)).not.toThrow();
  });

  it("stays total even when input POISONS a realm intrinsic during serialization — r12 #2", () => {
    // A `toJSON` that replaces `Number.isSafeInteger` while it serializes would
    // make a later check throw — an outer guard must still return problems.
    const saved = Number.isSafeInteger;
    const poison = {
      toJSON(): Record<string, unknown> {
        (Number as unknown as { isSafeInteger: unknown }).isSafeInteger = (): never => {
          throw new Error("poisoned");
        };
        return { issueId: "x", contractVersion: 1, contractHash: "a".repeat(64) };
      },
    };
    try {
      expect(() => contractProblems(poison)).not.toThrow();
      expect(() => contractRefProblems(poison)).not.toThrow();
    } finally {
      (Number as unknown as { isSafeInteger: typeof Number.isSafeInteger }).isSafeInteger = saved;
    }
  });

  it("rejects a NESTED inherited interface and a stateful Proxy ref (JSON snapshot) — r9", () => {
    // A nested interface whose fields are inherited serializes to {} — the
    // top-level own-copy missed it; the JSON snapshot catches it.
    const ifaceProto = { name: "x", kind: "api", description: "y" };
    const inheritedIface = Object.create(ifaceProto);
    expect(JSON.stringify(inheritedIface)).toBe("{}");
    expect(contractProblems({ ...contract(), interfaces: [inheritedIface] })).not.toEqual([]);

    // A Proxy that reads valid during validation but serializes to a malformed
    // record must be rejected on its serialized (persisted) form.
    const proxy = new Proxy(
      { issueId: "", contractVersion: 9007199254740992, contractHash: "" },
      { get: (t, p) => (t as Record<string, unknown>)[p as string] },
    );
    expect(contractRefProblems(proxy)).not.toEqual([]);
  });
});

describe("CONTRACT_REFERENCE_OBLIGATIONS", () => {
  it("pins the artifacts that owe a ContractRef (CAM-PLAN-04)", () => {
    // Exact-list pin: a consuming WP deleting its obligation trips this test.
    expect(CONTRACT_REFERENCE_OBLIGATIONS).toEqual([
      "issue-created event payload carries { contractVersion, contractHash } (WP-110, at freeze)",
      "attempt records carry a ContractRef for the contract they execute (WP-114 dispatch)",
      "issue PRs embed their ContractRef in the PR body (WP-120 PR lifecycle; enforced at push by WP-119)",
      "mission PRs embed the ContractRef set of their issues (WP-120 PR lifecycle; enforced at push by WP-119)",
      "evidence packets carry the ContractRef their evidence binds to (WP-116)",
      "context packs cite the ContractRef they were assembled against (WP-113)",
    ]);
    expect(Object.isFrozen(CONTRACT_REFERENCE_OBLIGATIONS)).toBe(true);
  });
});

describe("total validation over sparse arrays (r1 finding 7)", () => {
  // The validator snapshots via a JSON round-trip (r9 finding 5), which is what a
  // store does: a sparse-array HOLE becomes `null`. The guarantee is unchanged —
  // the validator never THROWS and rejects the record (now as a null element, the
  // exact form that would persist), matching quarantinedDiffProblems.
  it("rejects a sparse acceptanceCriteria hole instead of throwing", () => {
    const holed = contract();
    const criteria: unknown[] = ["A criterion."];
    criteria[2] = "Another.";
    const candidate = { ...holed, acceptanceCriteria: criteria };
    const problems = contractProblems(candidate);
    expect(Array.isArray(problems)).toBe(true);
    expect(problems.length).toBeGreaterThan(0);
  });

  it("rejects holes in requirementIds and interfaces too", () => {
    const ids: unknown[] = [];
    ids[1] = "CAM-APP-01";
    expect(contractProblems({ ...contract(), requirementIds: ids })).not.toEqual([]);
    const ifaces: unknown[] = [];
    ifaces[1] = { name: "x", kind: "api", description: "y" };
    expect(contractProblems({ ...contract(), interfaces: ifaces })).not.toEqual([]);
  });
});
