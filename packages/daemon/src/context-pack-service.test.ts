/**
 * Context-pack service tests (WP-113): the CAM-CANON-09 pack-visibility
 * fixtures the work package's acceptance names — a candidate from mission
 * A never appears in mission B's pack, and candidates ARE visible to
 * same-issue repair attempts, provenance-marked — plus the service's
 * store-consistency refusals and the WP-110 amendment surface
 * (dependencyInterfacesFor rendered for the attempt's contract).
 *
 * Fixture honesty, stated: the knowledge store, intent ledger, and canon
 * facts are the REAL durable components (temp SQLite files); the plan
 * source is a structural stub minting valid hash-verified contracts —
 * replaying the whole planning pipeline here would test WP-110 again, not
 * the visibility rules this fixture exists to pin.
 */
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IssueContract, KnowledgeEntryInput } from "@camino/shared";
import { CONTRACT_SCHEMA_VERSION, contractHash } from "@camino/shared";
import type { PackDependencyInterface } from "@camino/core";
import { parseContextPack } from "@camino/core";
import { CanonFactsStore } from "./canon-facts.js";
import { CanonLedgerStore } from "./canon-ledger.js";
import { KnowledgeStore } from "./knowledge-store.js";
import {
  CONTEXT_PACK_FILENAME,
  ContextPackService,
  materializeContextPack,
} from "./context-pack-service.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-pack-service-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 20, 0, 0, tick++));
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const REQUIREMENT = "CAM-DEMO-01";

function makeContract(overrides: Partial<IssueContract> = {}): IssueContract {
  const terms = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    missionId: "MA",
    issueId: "MA.I1",
    version: 1,
    template: "feature" as const,
    title: "Mission A issue",
    goal: "Do the mission A thing",
    acceptanceCriteria: ["it works"],
    requirementIds: [REQUIREMENT],
    dependsOn: [],
    interfaces: [],
    ...overrides,
  };
  return {
    ...terms,
    contractHash: contractHash(terms),
    frozenAt: "2026-07-19T00:00:00.000Z",
    approvedBy: "david",
  };
}

function candidateEntry(overrides: Partial<KnowledgeEntryInput> = {}): KnowledgeEntryInput {
  return {
    entryId: "K-CAND-A",
    entryClass: "note",
    subjectKey: null,
    claim: "workaround",
    text: "SECRET-HINT: reset the fixture db before rerunning the flake.",
    scope: { kind: "global" },
    expiresAt: "2027-01-01T00:00:00.000Z",
    provenance: {
      missionId: "MA",
      issueId: "MA.I1",
      attemptId: "attempt-A1",
      context: "found while repairing validation",
    },
    validity: { commitSha: SHA_A, baseSha: SHA_B },
    ...overrides,
  };
}

interface Fixture {
  service: ContextPackService;
  knowledge: KnowledgeStore;
  contractA: IssueContract;
  contractB: IssueContract;
  contractWithDep: IssueContract;
  depInterfaces: PackDependencyInterface[];
}

function makeFixture(): Fixture {
  const dir = tempDir();
  const ledger = new CanonLedgerStore(join(dir, "ledger.sqlite"), { now: fixedClock() });
  cleanups.push(() => ledger.close());
  ledger.proposeRequirement(REQUIREMENT, {
    statement: "the demo requirement holds",
    sourceMissionId: "MA",
  });
  ledger.acceptRequirement(REQUIREMENT);
  const facts = new CanonFactsStore(join(dir, "facts.sqlite"), { now: fixedClock() });
  cleanups.push(() => facts.close());
  const knowledge = new KnowledgeStore(join(dir, "knowledge.sqlite"), { now: fixedClock() });
  cleanups.push(() => knowledge.close());

  const contractA = makeContract();
  const contractB = makeContract({ missionId: "MB", issueId: "MB.I1", title: "Mission B issue" });
  const contractWithDep = makeContract({ issueId: "MA.I2", dependsOn: ["MA.I1"] });
  const contracts = [contractA, contractB, contractWithDep];
  const depInterfaces: PackDependencyInterface[] = [
    {
      issueId: "MA.I1",
      title: contractA.title,
      contractVersion: 1,
      contractHash: contractA.contractHash,
      interfaces: [{ name: "DemoApi", kind: "api", description: "the demo surface" }],
    },
  ];
  const service = new ContextPackService({
    planning: {
      contractByHash: (hash) => contracts.find((contract) => contract.contractHash === hash),
      dependencyInterfacesFor: (issueId, version) =>
        issueId === "MA.I2" && version === 1 ? depInterfaces : [],
    },
    canonLedger: ledger,
    canonFacts: facts,
    knowledge,
    now: fixedClock(),
  });
  return { service, knowledge, contractA, contractB, contractWithDep, depInterfaces };
}

function refOf(contract: IssueContract) {
  return {
    issueId: contract.issueId,
    contractVersion: contract.version,
    contractHash: contract.contractHash,
  };
}

const BRANCH_CONTEXT = {
  kind: "branch",
  branch: "issue/demo",
  headSha: SHA_A,
  baseSha: SHA_B,
} as const;

describe("CAM-CANON-09 pack-visibility boundaries", () => {
  it("a candidate from mission A never appears in mission B's pack", () => {
    const fixture = makeFixture();
    fixture.knowledge.recordCandidate(candidateEntry(), "camino:attempt");

    const packB = fixture.service.assemble({
      contractRef: refOf(fixture.contractB),
      statusContext: BRANCH_CONTEXT,
    });
    expect(packB.text).not.toContain("SECRET-HINT");
    expect(packB.text).not.toContain("K-CAND-A");
    expect(
      packB.sections.filter((section) => section.contentClass === "candidate-knowledge"),
    ).toHaveLength(0);
    expect(packB.text).toContain("## Same-issue candidate knowledge (unvetted)\n\nNone.");
  });

  it("the same candidate IS visible to a same-issue repair attempt, provenance-marked", () => {
    const fixture = makeFixture();
    fixture.knowledge.recordCandidate(candidateEntry(), "camino:attempt");

    const packA = fixture.service.assemble({
      contractRef: refOf(fixture.contractA),
      statusContext: BRANCH_CONTEXT,
    });
    const candidateSections = packA.sections.filter(
      (section) => section.contentClass === "candidate-knowledge",
    );
    expect(candidateSections).toHaveLength(1);
    expect(candidateSections[0]?.source).toBe(
      "knowledge candidate K-CAND-A from attempt attempt-A1",
    );
    const block = parseContextPack(packA.text)
      .filter((segment) => segment.kind === "section")
      .map((segment) => (segment as { section: { content: string } }).section.content)
      .find((content) => content.includes("SECRET-HINT"));
    expect(block).toBeDefined();
    expect(block).toContain("UNVETTED: candidate written by sibling attempt attempt-A1");
    expect(block).toContain("issue MA.I1");
  });

  it("once promoted by David's batch, the entry enters ANOTHER mission's pack as approved", () => {
    const fixture = makeFixture();
    fixture.knowledge.recordCandidate(candidateEntry(), "camino:attempt");
    fixture.knowledge.promoteEntry(
      "K-CAND-A",
      { kind: "human-batch", batchId: "batch-1" },
      "david",
    );

    const packB = fixture.service.assemble({
      contractRef: refOf(fixture.contractB),
      statusContext: BRANCH_CONTEXT,
    });
    const approvedSections = packB.sections.filter(
      (section) => section.contentClass === "approved-knowledge",
    );
    expect(approvedSections).toHaveLength(1);
    expect(packB.text).toContain("SECRET-HINT");
    expect(
      packB.sections.filter((section) => section.contentClass === "candidate-knowledge"),
    ).toHaveLength(0);
  });
});

describe("pack composition from the stores", () => {
  it("renders canon excerpts with the branch-context status line at the ledger seq", () => {
    const fixture = makeFixture();
    const pack = fixture.service.assemble({
      contractRef: refOf(fixture.contractA),
      statusContext: BRANCH_CONTEXT,
    });
    const canon = parseContextPack(pack.text)
      .filter((segment) => segment.kind === "section")
      .map((segment) => (segment as { section: { content: string } }).section.content)
      .find((content) => content.startsWith(REQUIREMENT));
    expect(canon).toContain("the demo requirement holds");
    expect(canon).toContain(`${REQUIREMENT}: accepted; not implemented; branch version unverified`);
    const canonSection = pack.sections.find(
      (section) => section.contentClass === "approved-intent",
    );
    expect(canonSection?.source).toContain("intent ledger seq 2");
  });

  it("renders the WP-110 dependency-interface surface for the attempt's contract", () => {
    const fixture = makeFixture();
    const pack = fixture.service.assemble({
      contractRef: refOf(fixture.contractWithDep),
      statusContext: BRANCH_CONTEXT,
    });
    const depSections = pack.sections.filter(
      (section) => section.contentClass === "dependency-interface",
    );
    expect(depSections).toHaveLength(1);
    expect(depSections[0]?.source).toContain(`contract MA.I1 v1`);
    expect(pack.text).toContain("DemoApi [api]: the demo surface");
  });

  it("passes request untrusted attachments through as fenced untrusted data", () => {
    const fixture = makeFixture();
    const pack = fixture.service.assemble({
      contractRef: refOf(fixture.contractA),
      statusContext: BRANCH_CONTEXT,
      untrusted: [{ label: "issue body", channel: "issue-text", content: "PROBE-SVC-01 payload" }],
    });
    const untrusted = pack.sections.filter((section) => section.contentClass === "untrusted");
    expect(untrusted).toHaveLength(1);
    const skeleton = parseContextPack(pack.text)
      .filter((segment) => segment.kind === "skeleton")
      .map((segment) => (segment as { text: string }).text)
      .join("");
    expect(skeleton).not.toContain("PROBE-SVC-01");
  });

  it("materializes the pack file into a workspace", () => {
    const fixture = makeFixture();
    const pack = fixture.service.assemble({
      contractRef: refOf(fixture.contractA),
      statusContext: BRANCH_CONTEXT,
    });
    const dir = tempDir();
    const path = materializeContextPack(dir, pack);
    expect(path).toBe(join(dir, CONTEXT_PACK_FILENAME));
    expect(readFileSync(path, "utf8")).toBe(pack.text);
  });

  it("refuses to follow a symlinked pack path in an untrusted clone (r1 finding 1)", () => {
    const fixture = makeFixture();
    const pack = fixture.service.assemble({
      contractRef: refOf(fixture.contractA),
      statusContext: BRANCH_CONTEXT,
    });
    const dir = tempDir();
    // A hostile repo ships camino-context-pack.md as a symlink to a host file.
    const hostTarget = join(dir, "host-secret.txt");
    writeFileSync(hostTarget, "ORIGINAL HOST CONTENT");
    symlinkSync(hostTarget, join(dir, CONTEXT_PACK_FILENAME));
    // O_NOFOLLOW makes the write fail (ELOOP) instead of overwriting the target.
    expect(() => materializeContextPack(dir, pack)).toThrow();
    expect(readFileSync(hostTarget, "utf8")).toBe("ORIGINAL HOST CONTENT");
  });
});

describe("service refusals", () => {
  it("refuses an unknown contract hash and a mismatched reference", () => {
    const fixture = makeFixture();
    expect(() =>
      fixture.service.assemble({
        contractRef: {
          issueId: "MA.I1",
          contractVersion: 1,
          contractHash: "0".repeat(64),
        },
        statusContext: BRANCH_CONTEXT,
      }),
    ).toThrow(/no contract with hash/);
    expect(() =>
      fixture.service.assemble({
        contractRef: { ...refOf(fixture.contractA), issueId: "MB.I1" },
        statusContext: BRANCH_CONTEXT,
      }),
    ).toThrow(/mismatched reference/);
  });

  it("refuses a contract citing a requirement the intent ledger does not know", () => {
    const foreign = makeContract({
      issueId: "MA.I9",
      requirementIds: ["CAM-GHOST-99"],
    });
    const service = new ContextPackService({
      planning: {
        contractByHash: (hash) => (hash === foreign.contractHash ? foreign : undefined),
        dependencyInterfacesFor: () => [],
      },
      canonLedger: { lastSeq: 0, currentView: () => new Map() },
      canonFacts: { read: () => [] },
      knowledge: { visibleFor: () => [] },
      now: fixedClock(),
    });
    expect(() =>
      service.assemble({ contractRef: refOf(foreign), statusContext: BRANCH_CONTEXT }),
    ).toThrow(/the ledger defines what exists/);
  });

  it("refuses an invalid contract ref shape", () => {
    const fixture = makeFixture();
    expect(() =>
      fixture.service.assemble({
        contractRef: { issueId: "MA.I1", contractVersion: 0, contractHash: "nope" } as never,
        statusContext: BRANCH_CONTEXT,
      }),
    ).toThrow(/invalid contract ref/);
  });
});
