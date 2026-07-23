// WP-108 — the quarantined-diff durable schema validator (CAM-EXEC-04).
//
// The intake never EMITS a malformed diff (it validates before returning), but
// a downstream consumer (WP-111 / WP-116) adopts a serialized artifact from the
// store and must refuse a forged one. These lock the round-1 hardening (finding
// 9): mixed object formats, non-repo-relative paths, and prototype-inherited
// fields are rejected, while a genuine diff and the null-contractRef form pass.
import { describe, expect, it } from "vitest";
import { quarantinedDiffProblems, workerAttributionTrailer } from "./quarantine-diff.js";

const SHA1_A = "a".repeat(40);
const SHA1_B = "b".repeat(40);
const SHA1_C = "c".repeat(40);
const SHA1_D = "d".repeat(40);

function validDiff(): Record<string, unknown> {
  return {
    candidateSha: SHA1_A,
    baseSha: SHA1_B,
    treeSha: SHA1_C,
    workerHeadSha: SHA1_D,
    attributionTrailer: workerAttributionTrailer(SHA1_D),
    contractRef: null,
    changedPaths: [{ path: "src/app.js", change: "modified" }],
  };
}

describe("quarantinedDiffProblems", () => {
  it("accepts a well-formed diff (null contractRef is the no-binding form)", () => {
    expect(quarantinedDiffProblems(validDiff())).toEqual([]);
  });

  it("rejects mixed sha-1 / sha-256 object identities in one record", () => {
    const d = validDiff();
    d["treeSha"] = "e".repeat(64); // 64-hex among 40-hex
    expect(quarantinedDiffProblems(d).join(" ")).toMatch(/object formats/);
  });

  it("rejects an absolute or parent-traversal changed path", () => {
    for (const bad of ["/etc/passwd", "../outside", "a/../../b", "./x"]) {
      const d = validDiff();
      d["changedPaths"] = [{ path: bad, change: "added" }];
      expect(quarantinedDiffProblems(d).join(" ")).toMatch(/repo-root-relative/);
    }
  });

  it("rejects a record whose fields are inherited, not own (serializes to {})", () => {
    const inherited = Object.create(validDiff()) as Record<string, unknown>;
    // Every field is on the prototype; JSON.stringify(inherited) === "{}".
    expect(JSON.stringify(inherited)).toBe("{}");
    expect(quarantinedDiffProblems(inherited).length).toBeGreaterThan(0);
  });

  it("rejects a changed-path entry whose fields are inherited, not own", () => {
    const d = validDiff();
    d["changedPaths"] = [Object.create({ path: "src/x", change: "added" })];
    expect(quarantinedDiffProblems(d).length).toBeGreaterThan(0);
  });

  it("rejects an inherited attributionTrailer or contractRef (own-property only) — r2", () => {
    // A record with a forged prototype (fields on the prototype) is rejected by
    // the plain-object guard before field checks — the stronger r3 behaviour.
    const inhTrailer = validDiff();
    delete inhTrailer["attributionTrailer"];
    Object.setPrototypeOf(inhTrailer, { attributionTrailer: workerAttributionTrailer(SHA1_D) });
    expect(quarantinedDiffProblems(inhTrailer).join(" ")).toMatch(/plain object/);

    const inhRef = validDiff();
    inhRef["contractRef"] = Object.create({
      issueId: "M1.1",
      contractVersion: 1,
      contractHash: "a".repeat(64),
    });
    expect(quarantinedDiffProblems(inhRef).length).toBeGreaterThan(0);
  });

  it("rejects an impossible candidate==tree id, and non-canonical paths — r2", () => {
    const sameTree = validDiff();
    sameTree["treeSha"] = SHA1_A; // == candidateSha
    expect(quarantinedDiffProblems(sameTree).join(" ")).toMatch(/cannot equal its tree/);

    for (const bad of ["a\\b", "a/./b", "a//b", "a/", "a/../b"]) {
      const d = validDiff();
      d["changedPaths"] = [{ path: bad, change: "added" }];
      expect(quarantinedDiffProblems(d).join(" ")).toMatch(/canonical repo-root-relative/);
    }
  });

  it("rejects a JSON __proto__ contractRef bypass and a class-instance record — r3", () => {
    const protoRef = validDiff();
    protoRef["contractRef"] = JSON.parse(
      `{"__proto__":{"issueId":"M1.1","contractVersion":1,"contractHash":"${"e".repeat(64)}"}}`,
    );
    expect(quarantinedDiffProblems(protoRef).length).toBeGreaterThan(0);

    class Forged {}
    const inst = Object.assign(new Forged(), validDiff());
    expect(quarantinedDiffProblems(inst).join(" ")).toMatch(/plain object/);
  });

  it("rejects base/worker head sha equal to the tree sha (impossible ids) — r3", () => {
    for (const field of ["baseSha", "workerHeadSha"]) {
      const d = validDiff();
      d[field] = d["treeSha"];
      expect(quarantinedDiffProblems(d).join(" ")).toMatch(/cannot equal its tree/);
    }
  });

  it("still rejects the controls it rejected before (sparse holes, unsorted, bad trailer)", () => {
    const sparse = validDiff();
    const holed: unknown[] = [{ path: "a", change: "added" }];
    holed[2] = { path: "c", change: "added" }; // index 1 is a hole
    sparse["changedPaths"] = holed;
    expect(quarantinedDiffProblems(sparse).join(" ")).toMatch(/sparse-array hole/);

    const unsorted = validDiff();
    unsorted["changedPaths"] = [
      { path: "src/b", change: "added" },
      { path: "src/a", change: "added" },
    ];
    expect(quarantinedDiffProblems(unsorted).join(" ")).toMatch(/strictly sorted/);

    const badTrailer = validDiff();
    badTrailer["attributionTrailer"] = "Camino-Worker-Attribution: " + SHA1_A; // names candidate, not worker
    expect(quarantinedDiffProblems(badTrailer).join(" ")).toMatch(/attributionTrailer/);
  });
});
