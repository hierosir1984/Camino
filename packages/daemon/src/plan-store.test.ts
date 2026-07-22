/**
 * Plan-store tests (WP-110): append-only enforcement, tamper-evident open,
 * contract immutability (CAM-PLAN-04), and fail-closed adoption.
 */
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_SCHEMA_VERSION, contractHash } from "@camino/shared";
import type { ContractTerms, IssueContract } from "@camino/shared";
import { PlanStore, reviewArtifactProblems } from "./plan-store.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-plan-store-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function openStore(path: string): PlanStore {
  const store = new PlanStore(path);
  cleanups.push(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });
  return store;
}

function sampleContract(): IssueContract {
  const terms: ContractTerms = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    missionId: "m1",
    issueId: "m1.I1",
    version: 1,
    template: "feature",
    title: "Deliver the exporter",
    goal: "CSV export works.",
    acceptanceCriteria: ["Export downloads a CSV."],
    requirementIds: ["CAM-APP-01"],
    dependsOn: [],
    interfaces: [],
  };
  return {
    ...terms,
    contractHash: contractHash(terms),
    frozenAt: "2026-07-22T10:00:00.000Z",
    approvedBy: "david",
  };
}

function seedSession(store: PlanStore, sessionId = "plan-m1-1"): void {
  store.createSession({
    sessionId,
    missionId: "m1",
    template: "feature",
    prdSha256: "a".repeat(64),
  });
}

describe("PlanStore append-only enforcement", () => {
  it("rejects raw UPDATE and DELETE on every table via triggers", () => {
    const dir = tempDir();
    const path = join(dir, "plan.sqlite");
    const store = openStore(path);
    seedSession(store);
    store.appendStream("plan-m1-1", "construction-complete", { kind: "construction-complete" });
    store.insertContract(sampleContract(), "plan-m1-1");
    store.close();
    const raw = new Database(path);
    cleanups.push(() => raw.close());
    expect(() => raw.prepare("UPDATE plan_sessions SET template = 'quick-task'").run()).toThrow(
      /append-only/,
    );
    expect(() => raw.prepare("DELETE FROM plan_stream").run()).toThrow(/append-only/);
    expect(() =>
      raw.prepare("UPDATE contracts SET record = '{}' WHERE issue_id = 'm1.I1'").run(),
    ).toThrow(/append-only/);
    expect(() => raw.prepare("DELETE FROM contracts").run()).toThrow(/append-only/);
  });
});

describe("PlanStore contract immutability (CAM-PLAN-04)", () => {
  it("re-inserting the identical contract is the idempotent resume no-op", () => {
    const store = openStore(":memory:");
    seedSession(store);
    const contract = sampleContract();
    store.insertContract(contract, "plan-m1-1");
    expect(() => store.insertContract(contract, "plan-m1-1")).not.toThrow();
    expect(store.contractsForMission("m1")).toHaveLength(1);
  });

  it("refuses to overwrite a version with different terms", () => {
    const store = openStore(":memory:");
    seedSession(store);
    store.insertContract(sampleContract(), "plan-m1-1");
    const edited: IssueContract = (() => {
      const base = sampleContract();
      const terms: ContractTerms = {
        schemaVersion: base.schemaVersion,
        missionId: base.missionId,
        issueId: base.issueId,
        version: base.version,
        template: base.template,
        title: "Edited title",
        goal: base.goal,
        acceptanceCriteria: [...base.acceptanceCriteria],
        requirementIds: [...base.requirementIds],
        dependsOn: [...base.dependsOn],
        interfaces: [...base.interfaces],
      };
      return {
        ...terms,
        contractHash: contractHash(terms),
        frozenAt: base.frozenAt,
        approvedBy: base.approvedBy,
      };
    })();
    expect(() => store.insertContract(edited, "plan-m1-1")).toThrow(/refusing to overwrite/);
  });

  it("refuses a contract whose hash does not match its terms", () => {
    const store = openStore(":memory:");
    seedSession(store);
    const bad = { ...sampleContract(), contractHash: "0".repeat(64) };
    expect(() => store.insertContract(bad, "plan-m1-1")).toThrow(/does not match the recomputed/);
  });

  it("serves frozen (immutable) contract objects", () => {
    const store = openStore(":memory:");
    seedSession(store);
    store.insertContract(sampleContract(), "plan-m1-1");
    const served = store.contract("m1.I1", 1);
    expect(served).toBeDefined();
    expect(Object.isFrozen(served)).toBe(true);
    expect(Object.isFrozen(served?.acceptanceCriteria)).toBe(true);
    expect(() => {
      (served as { title: string }).title = "mutated";
    }).toThrow(TypeError);
  });

  it("looks contracts up by hash and by latest version", () => {
    const store = openStore(":memory:");
    seedSession(store);
    const contract = sampleContract();
    store.insertContract(contract, "plan-m1-1");
    expect(store.contractByHash(contract.contractHash)?.issueId).toBe("m1.I1");
    expect(store.contractByHash("f".repeat(64))).toBeUndefined();
    expect(store.latestContract("m1.I1")?.version).toBe(1);
  });
});

describe("PlanStore fail-closed adoption", () => {
  it("refuses to open a store whose contract row was edited behind the triggers", () => {
    const dir = tempDir();
    const path = join(dir, "plan.sqlite");
    const store = openStore(path);
    seedSession(store);
    store.insertContract(sampleContract(), "plan-m1-1");
    store.close();
    // A raw writer drops the triggers and edits the record in place.
    const raw = new Database(path);
    raw.exec("DROP TRIGGER contracts_append_only_update");
    raw
      .prepare("UPDATE contracts SET record = ? WHERE issue_id = 'm1.I1'")
      .run(JSON.stringify({ ...sampleContract(), title: "Edited after freeze" }));
    raw.close();
    // The dropped trigger itself fails the schema-definition comparison.
    expect(() => new PlanStore(path)).toThrow(/refusing to open a tampered or foreign store/);
  });

  it("refuses a store holding stream rows this build's validators reject", () => {
    const dir = tempDir();
    const path = join(dir, "plan.sqlite");
    const store = openStore(path);
    seedSession(store);
    store.close();
    const raw = new Database(path);
    raw
      .prepare(
        "INSERT INTO plan_stream (session_id, seq, kind, payload, recorded_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("plan-m1-1", 1, "issue", JSON.stringify({ kind: "issue", issue: { bogus: true } }), "t");
    raw.close();
    expect(() => new PlanStore(path)).toThrow(/fails validation/);
  });

  it("refuses a schema-version it does not speak", () => {
    const dir = tempDir();
    const path = join(dir, "plan.sqlite");
    const store = openStore(path);
    store.close();
    const raw = new Database(path);
    raw.pragma("user_version = 99");
    raw.close();
    expect(() => new PlanStore(path)).toThrow(/schema version 99/);
  });

  it("re-validates contracts on read, refusing a row edited in memory of a live handle", () => {
    // Tampering through a second connection while the store is open: the
    // read seam recomputes the hash and refuses.
    const dir = tempDir();
    const path = join(dir, "plan.sqlite");
    const store = openStore(path);
    seedSession(store);
    store.insertContract(sampleContract(), "plan-m1-1");
    const raw = new Database(path);
    raw.exec("DROP TRIGGER contracts_append_only_update");
    raw
      .prepare("UPDATE contracts SET record = ? WHERE issue_id = 'm1.I1'")
      .run(JSON.stringify({ ...sampleContract(), title: "Edited live" }));
    raw.close();
    expect(() => store.contract("m1.I1", 1)).toThrow(/fails validation on read/);
  });
});

/**
 * Build a session whose stream satisfies every store-derivable gate
 * condition: one issue, Q1, S1 mapped (statement "s"), completion, review.
 */
function seedCoherentSession(store: PlanStore, sessionId = "plan-m1-1"): void {
  seedSession(store, sessionId);
  store.appendStream(sessionId, "issue", {
    kind: "issue",
    issue: {
      planIssueId: "I1",
      title: "Deliver the exporter",
      goal: "CSV export works.",
      acceptanceCriteria: ["Export downloads a CSV."],
      dependsOn: [],
      interfaces: [],
    },
  });
  store.appendStream(sessionId, "clarification", {
    kind: "clarification",
    clarification: {
      clarificationId: "Q1",
      question: "Which fields?",
      whyItMatters: "Unstated.",
      assumptionIfUnanswered: "All visible fields.",
      relatedSegmentIds: ["S1"],
      relatedPlanIssueIds: ["I1"],
    },
  });
  store.appendStream(sessionId, "checklist-row", {
    kind: "checklist-row",
    row: {
      segmentId: "S1",
      disposition: "mapped",
      proposedStatement: "s",
      proposedArea: "APP",
      mappedPlanIssueIds: ["I1"],
    },
  });
  store.appendStream(sessionId, "construction-complete", { kind: "construction-complete" });
  store.appendStream(sessionId, "review-attached", {
    reviewClass: "full-falsification",
    reviewer: "codex-cli",
  });
}

/** David's acts over the coherent session, ready for a valid approval act. */
function actEverything(store: PlanStore, sessionId = "plan-m1-1"): void {
  store.recordAcknowledgment(sessionId, "Q1", { kind: "assumption-confirmed" }, "david");
  store.recordConfirmation(
    sessionId,
    { segmentId: "S1", requirementId: "CAM-APP-01", statement: "s" },
    "david",
  );
}

describe("PlanStore user-act constraints", () => {
  it("CHECK-pins act actors to david (the canon-ledger precedent)", () => {
    const store = openStore(":memory:");
    seedCoherentSession(store);
    expect(() =>
      store.recordAcknowledgment(
        "plan-m1-1",
        "Q1",
        { kind: "assumption-confirmed" },
        "camino:planner",
      ),
    ).toThrow(/CHECK/);
    actEverything(store);
    expect(() => store.recordApproval("plan-m1-1", "camino:scheduler")).toThrow(/CHECK/);
  });

  it("keeps one acknowledgment per clarification and one confirmation per segment", () => {
    const store = openStore(":memory:");
    seedCoherentSession(store);
    store.recordAcknowledgment("plan-m1-1", "Q1", { kind: "assumption-confirmed" }, "david");
    expect(() =>
      store.recordAcknowledgment("plan-m1-1", "Q1", { kind: "assumption-confirmed" }, "david"),
    ).toThrow(/UNIQUE|PRIMARY/);
    store.recordConfirmation(
      "plan-m1-1",
      { segmentId: "S1", requirementId: "CAM-APP-01", statement: "s" },
      "david",
    );
    expect(() =>
      store.recordConfirmation(
        "plan-m1-1",
        { segmentId: "S1", requirementId: "CAM-APP-02", statement: "s" },
        "david",
      ),
    ).toThrow(/UNIQUE|PRIMARY/);
  });

  it("tracks pending approvals until completion lands, and completion demands contracts", () => {
    const store = openStore(":memory:");
    seedCoherentSession(store);
    actEverything(store);
    store.recordApproval("plan-m1-1", "david");
    expect(store.pendingApprovalSessions().map((s) => s.sessionId)).toEqual(["plan-m1-1"]);
    // Completion without the issue's contract refuses (r2 findings 1/3).
    expect(() => store.recordApprovalCompletion("plan-m1-1")).toThrow(/no contract stored/);
    store.insertContract(sampleContract(), "plan-m1-1");
    store.recordApprovalCompletion("plan-m1-1");
    expect(store.pendingApprovalSessions()).toEqual([]);
    expect(store.completedApprovalSessions().map((s) => s.sessionId)).toEqual(["plan-m1-1"]);
  });

  it("acts recorded once the approval act exists are refused (r2 finding 2)", () => {
    const store = openStore(":memory:");
    seedCoherentSession(store);
    actEverything(store);
    store.recordApproval("plan-m1-1", "david");
    expect(() =>
      store.recordAcknowledgment("plan-m1-1", "Q1", { kind: "assumption-confirmed" }, "david"),
    ).toThrow(/acts after approval/);
    expect(() =>
      store.recordConfirmation(
        "plan-m1-1",
        { segmentId: "S1", requirementId: "CAM-APP-09", statement: "s" },
        "david",
      ),
    ).toThrow(/acts after approval/);
    expect(() => store.recordRejection("plan-m1-1", "david")).toThrow(/acts after approval/);
  });

  it("refuses the approval act while any derivable gate condition is unmet (r2 finding 1)", () => {
    const store = openStore(":memory:");
    seedCoherentSession(store);
    // No acts at all: every unmet condition is named.
    expect(() => store.recordApproval("plan-m1-1", "david")).toThrow(
      /unacknowledged.*unconfirmed|unconfirmed.*unacknowledged/s,
    );
  });

  it("binds confirmations to their checklist row's statement (r2 finding 2)", () => {
    const store = openStore(":memory:");
    seedCoherentSession(store);
    expect(() =>
      store.recordConfirmation(
        "plan-m1-1",
        { segmentId: "S1", requirementId: "CAM-APP-01", statement: "forged unrelated statement" },
        "david",
      ),
    ).toThrow(/does not match the checklist row/);
    expect(() =>
      store.recordAcknowledgment(
        "plan-m1-1",
        "Q1",
        {} as unknown as { kind: "assumption-confirmed" },
        "david",
      ),
    ).toThrow(/response refused/);
  });
});

describe("reviewArtifactProblems", () => {
  it("accepts a bounded artifact and refuses malformed ones", () => {
    expect(
      reviewArtifactProblems({ reviewClass: "full-falsification", reviewer: "codex-cli" }),
    ).toEqual([]);
    expect(reviewArtifactProblems({ reviewClass: "casual-glance", reviewer: "x" })).not.toEqual([]);
    expect(reviewArtifactProblems({ reviewClass: "mini-falsification" })).not.toEqual([]);
    expect(
      reviewArtifactProblems({
        reviewClass: "mini-falsification",
        reviewer: "x",
        riskTierLow: "yes",
      }),
    ).not.toEqual([]);
    expect(reviewArtifactProblems(null)).not.toEqual([]);
    expect(reviewArtifactProblems([])).not.toEqual([]);
  });
});

describe("appendStream store-level guards (r1 finding 1)", () => {
  it("refuses payloads the validators reject and kind/payload mismatches", () => {
    const store = openStore(":memory:");
    seedSession(store);
    expect(() =>
      store.appendStream("plan-m1-1", "issue", { kind: "issue", issue: { bogus: true } }),
    ).toThrow(/construction record refused/);
    expect(() =>
      store.appendStream("plan-m1-1", "clarification", { kind: "construction-complete" }),
    ).toThrow(/does not match the record's kind/);
    expect(() =>
      store.appendStream("plan-m1-1", "review-attached", { reviewClass: "casual" }),
    ).toThrow(/review artifact refused/);
  });

  it("refuses appends to unknown or closed sessions and after construction-complete", () => {
    const store = openStore(":memory:");
    seedSession(store);
    expect(() =>
      store.appendStream("missing", "construction-complete", { kind: "construction-complete" }),
    ).toThrow(/does not exist/);
    store.appendStream("plan-m1-1", "construction-complete", { kind: "construction-complete" });
    expect(() =>
      store.appendStream("plan-m1-1", "construction-complete", { kind: "construction-complete" }),
    ).toThrow(/only review-attached records may follow/);
    // review-attached is still allowed after completion…
    store.appendStream("plan-m1-1", "review-attached", {
      reviewClass: "full-falsification",
      reviewer: "codex-cli",
    });
    // …but nothing lands once the session is closed by a rejection act.
    store.recordRejection("plan-m1-1", "david");
    expect(() =>
      store.appendStream("plan-m1-1", "review-attached", {
        reviewClass: "full-falsification",
        reviewer: "codex-cli",
      }),
    ).toThrow(/closed to stream appends/);
  });

  it("binds the review artifact's class to the session template (r2 finding 2)", () => {
    const store = openStore(":memory:");
    seedSession(store); // feature template
    expect(() =>
      store.appendStream("plan-m1-1", "review-attached", {
        reviewClass: "mini-falsification",
        reviewer: "codex-cli",
      }),
    ).toThrow(/does not match the feature template/);
  });

  it("adoption refuses a stream with duplicates or post-completion records (raw-writer class)", () => {
    const dir = tempDir();
    const path = join(dir, "plan.sqlite");
    const store = openStore(path);
    seedSession(store);
    store.appendStream("plan-m1-1", "construction-complete", { kind: "construction-complete" });
    store.close();
    const raw = new Database(path);
    raw
      .prepare(
        "INSERT INTO plan_stream (session_id, seq, kind, payload, recorded_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "plan-m1-1",
        2,
        "issue",
        JSON.stringify({
          kind: "issue",
          issue: {
            planIssueId: "I1",
            title: "Smuggled after completion",
            goal: "g",
            acceptanceCriteria: ["c"],
            dependsOn: [],
            interfaces: [],
          },
        }),
        "2026-07-22T00:00:00.000Z",
      );
    raw.close();
    expect(() => new PlanStore(path)).toThrow(/follows construction-complete/);
  });
});

describe("contract index binding (r1 finding 8)", () => {
  it("refuses a record re-keyed under a foreign hash index", () => {
    const dir = tempDir();
    const path = join(dir, "plan.sqlite");
    const store = openStore(path);
    seedSession(store);
    const contract = sampleContract();
    store.insertContract(contract, "plan-m1-1");
    store.close();
    const raw = new Database(path);
    raw.exec("DROP TRIGGER contracts_append_only_update");
    // Re-key the row: valid record, foreign index hash.
    raw
      .prepare("UPDATE contracts SET contract_hash = ? WHERE issue_id = 'm1.I1'")
      .run("f".repeat(64));
    raw.close();
    // The dropped trigger fails adoption outright (definition comparison).
    expect(() => new PlanStore(path)).toThrow(/tampered or foreign store/);
  });

  it("insertContract snapshots canonically — accessor tricks cannot split validate and persist", () => {
    const store = openStore(":memory:");
    seedSession(store);
    const base = sampleContract();
    let reads = 0;
    const shifty = Object.defineProperty({ ...base }, "title", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? base.title : "Different on second read";
      },
    }) as typeof base;
    // ONE observation: the getter is read exactly once (by the canonical
    // snapshot), so what validated is byte-for-byte what persisted — the
    // shifting second value never exists anywhere. The stored record is
    // self-consistent and re-validates on read.
    const inserted = store.insertContract(shifty, "plan-m1-1");
    expect(inserted.title).toBe(base.title);
    expect(reads).toBe(1);
    const served = store.contract("m1.I1", 1);
    expect(served?.title).toBe(base.title);
    expect(served?.contractHash).toBe(base.contractHash);
  });
});
