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

describe("PlanStore user-act constraints", () => {
  it("CHECK-pins act actors to david (the canon-ledger precedent)", () => {
    const store = openStore(":memory:");
    seedSession(store);
    expect(() =>
      store.recordAcknowledgment(
        "plan-m1-1",
        "Q1",
        { kind: "assumption-confirmed" },
        "camino:planner",
      ),
    ).toThrow(/CHECK/);
    expect(() => store.recordApproval("plan-m1-1", "camino:scheduler")).toThrow(/CHECK/);
  });

  it("keeps one acknowledgment per clarification and one confirmation per segment", () => {
    const store = openStore(":memory:");
    seedSession(store);
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

  it("tracks pending approvals until completion lands", () => {
    const store = openStore(":memory:");
    seedSession(store);
    store.recordApproval("plan-m1-1", "david");
    expect(store.pendingApprovalSessions().map((s) => s.sessionId)).toEqual(["plan-m1-1"]);
    store.recordApprovalCompletion("plan-m1-1");
    expect(store.pendingApprovalSessions()).toEqual([]);
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
