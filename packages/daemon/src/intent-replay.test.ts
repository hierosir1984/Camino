/**
 * Seeded duplicate-intent fixtures (WP-104, CAM-STATE-02): for EVERY §4.4
 * operation class, replaying a confirmed intent produces ZERO duplicate
 * external side effects — the executor completes it from the journal
 * without touching any transport — and the workflow-dispatch clause holds
 * specifically: at-most-once, `camino_intent_id` surfaced via run-name as
 * correlation only, no automatic retry on lost-response ambiguity.
 *
 * "One recorded ambiguity per genuinely ambiguous case" is asserted here
 * for the replay-adjacent paths; the kill-point suites assert it across
 * every crash window.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExternalOperationSpec } from "@camino/shared";
import { FakeGitHub } from "./chaos/fake-github.js";
import { FakeCatchAll, FakeTestService } from "./chaos/fake-services.js";
import { IntentExecutor } from "./intent-executor.js";
import { IntentJournal } from "./intent-journal.js";
import { reconcileIntents } from "./recovery.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

let dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-replay-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

interface Rig {
  journal: IntentJournal;
  github: FakeGitHub;
  testService: FakeTestService;
  catchAll: FakeCatchAll;
  executor: IntentExecutor;
}

function rig(): Rig {
  const dir = tempDir();
  const journal = new IntentJournal(join(dir, "intents.sqlite"));
  const github = new FakeGitHub(join(dir, "github.json"));
  const testService = new FakeTestService(join(dir, "test-service.json"));
  const catchAll = new FakeCatchAll(join(dir, "catch-all.json"));
  const executor = new IntentExecutor(journal, { github, testService, catchAll });
  return { journal, github, testService, catchAll, executor };
}

function seedRepo(github: FakeGitHub): void {
  github.seedCommit("r", SHA_A);
  github.seedCommit("r", SHA_B, [SHA_A]);
  github.seedRef("r", "main", SHA_A);
  github.seedRef("r", "feature", SHA_A);
}

/** Every §4.4 class as a seeded replay fixture. */
const FIXTURES: Array<{
  name: string;
  spec: ExternalOperationSpec;
  /** Applied-effect assertion after ONE confirmed execution + one replay. */
  assertOnce(r: Rig): void;
}> = [
  {
    name: "branch-create",
    spec: { op: "branch-create", repo: "r", branch: "b1", targetSha: SHA_A },
    assertOnce: (r) => expect(r.github.effectCounts().get("branch:r:b1")).toBe(1),
  },
  {
    name: "push",
    spec: { op: "push", repo: "r", ref: "feature", intendedSha: SHA_B, expectedBaseSha: SHA_A },
    assertOnce: (r) => {
      expect(r.github.effectCounts().get(`push:r:feature:${SHA_B}`)).toBe(1);
      expect(r.github.getRef("r", "feature")).toBe(SHA_B);
    },
  },
  {
    name: "pr-create",
    spec: {
      op: "pr-create",
      repo: "r",
      headBranch: "feature",
      baseBranch: "main",
      title: "t",
      bodyMarker: "camino-intent:pr",
      body: "b camino-intent:pr",
    },
    assertOnce: (r) => {
      expect(r.github.effectCounts().get("pr:r:feature:main")).toBe(1);
      expect(r.github.findPullRequestsByHead("r", "feature")).toHaveLength(1);
    },
  },
  {
    name: "merge-by-push",
    spec: {
      op: "merge-by-push",
      repo: "r",
      targetRef: "main",
      mergeSha: SHA_B,
      expectedBaseSha: SHA_A,
    },
    assertOnce: (r) => {
      expect(r.github.effectCounts().get(`merge:r:main:${SHA_B}`)).toBe(1);
      expect(r.github.getRef("r", "main")).toBe(SHA_B);
    },
  },
  {
    name: "label-set",
    spec: {
      op: "label-set",
      repo: "r",
      targetKind: "issue",
      targetNumber: 7,
      label: "l",
      desired: "present",
    },
    assertOnce: (r) => {
      expect(r.github.effectCounts().get("label:r:issue#7:l:present")).toBe(1);
      expect(r.github.isLabelPresent("r", "issue", 7, "l")).toBe(true);
    },
  },
  {
    name: "comment-post",
    spec: {
      op: "comment-post",
      repo: "r",
      targetKind: "issue",
      targetNumber: 7,
      body: "b camino-intent:c",
      marker: "camino-intent:c",
    },
    assertOnce: (r) =>
      expect(r.github.effectCounts().get("comment:r:issue#7:camino-intent:c")).toBe(1),
  },
  {
    name: "workflow-dispatch",
    spec: {
      op: "workflow-dispatch",
      repo: "r",
      workflow: "w.yml",
      ref: "main",
      correlationId: "d1",
    },
    assertOnce: (r) => {
      expect(r.github.effectCounts().get("dispatch:r:d1")).toBe(1);
      expect(r.github.findWorkflowRunsByCorrelation("r", "d1")).toHaveLength(1);
    },
  },
  {
    name: "test-service-mutation (resettable)",
    spec: {
      op: "test-service-mutation",
      environmentId: "e1",
      mutation: "seed",
      irreversible: false,
    },
    assertOnce: (r) => expect(r.testService.environmentCount("e1", "seed")).toBe(1),
  },
  {
    name: "test-service-mutation (irreversible)",
    spec: {
      op: "test-service-mutation",
      environmentId: "e1",
      mutation: "send",
      irreversible: true,
    },
    assertOnce: (r) => expect(r.testService.outboxCount("e1", "send")).toBe(1),
  },
  {
    name: "catch-all",
    spec: { op: "catch-all", description: "one-off effect" },
    assertOnce: (r) => expect(r.catchAll.effectCount("one-off effect")).toBe(1),
  },
];

describe("replayed intents per §4.4 class → zero duplicate external side effects", () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, () => {
      const r = rig();
      seedRepo(r.github);
      r.executor.submit("intent-1", fixture.spec);
      const first = r.executor.execute("intent-1");
      expect(first).toMatchObject({ kind: "confirmed", alreadyComplete: false });
      const githubCalls = r.github.state().mutationCalls;
      const serviceCalls = r.testService.state().mutationCalls;
      const catchAllCalls = r.catchAll.state().calls;

      // THE replay: same intent, executed again (a retrying scheduler, a
      // duplicated queue entry, a resumed workflow — all the same shape).
      const replay = r.executor.execute("intent-1");
      expect(replay).toMatchObject({ kind: "confirmed", alreadyComplete: true });
      expect(replay.kind === "confirmed" && replay.result).toEqual(
        first.kind === "confirmed" ? first.result : undefined,
      );

      // Zero transport touches, zero duplicate effects.
      expect(r.github.state().mutationCalls).toBe(githubCalls);
      expect(r.testService.state().mutationCalls).toBe(serviceCalls);
      expect(r.catchAll.state().calls).toBe(catchAllCalls);
      fixture.assertOnce(r);

      // No ambiguity was ever recorded on this clean path.
      expect(
        r.journal.read({ intentId: "intent-1" }).filter((e) => e.event === "ambiguity-recorded"),
      ).toHaveLength(0);
      r.journal.close();
    });
  }
});

describe("natural-key duplicates across DISTINCT intents (transport-level idempotence)", () => {
  it("a second branch-create intent for the same branch+SHA is a no-op success", () => {
    const r = rig();
    seedRepo(r.github);
    r.executor.submit("intent-1", {
      op: "branch-create",
      repo: "r",
      branch: "b1",
      targetSha: SHA_A,
    });
    r.executor.execute("intent-1");
    r.executor.submit("intent-2", {
      op: "branch-create",
      repo: "r",
      branch: "b1",
      targetSha: SHA_A,
    });
    const second = r.executor.execute("intent-2");
    expect(second.kind).toBe("confirmed");
    // The ledger records ONE applied creation; the second was observed-existing.
    expect(r.github.effectCounts().get("branch:r:b1")).toBe(1);
    r.journal.close();
  });

  it("a second label-set intent to an already-desired state changes nothing", () => {
    const r = rig();
    seedRepo(r.github);
    const spec = {
      op: "label-set",
      repo: "r",
      targetKind: "issue",
      targetNumber: 7,
      label: "l",
      desired: "present",
    } as const;
    r.executor.submit("intent-1", spec);
    r.executor.execute("intent-1");
    r.executor.submit("intent-2", spec);
    r.executor.execute("intent-2");
    expect(r.github.effectCounts().get("label:r:issue#7:l:present")).toBe(1);
    expect(r.github.isLabelPresent("r", "issue", 7, "l")).toBe(true);
    r.journal.close();
  });
});

describe("the workflow-dispatch clause of CAM-STATE-02, verbatim", () => {
  it("camino_intent_id rides the run-name (correlation for observability)", () => {
    const r = rig();
    seedRepo(r.github);
    r.executor.submit("dispatch-1", {
      op: "workflow-dispatch",
      repo: "r",
      workflow: "w.yml",
      ref: "main",
      correlationId: "dispatch-1",
    });
    r.executor.execute("dispatch-1");
    const runs = r.github.state().repos["r"]!.workflowRuns;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runName).toContain("camino_intent_id=dispatch-1");
    r.journal.close();
  });

  it("at-most-once: a replayed confirmed dispatch never creates a second run", () => {
    const r = rig();
    seedRepo(r.github);
    r.executor.submit("dispatch-1", {
      op: "workflow-dispatch",
      repo: "r",
      workflow: "w.yml",
      ref: "main",
      correlationId: "dispatch-1",
    });
    r.executor.execute("dispatch-1");
    r.executor.execute("dispatch-1"); // replay
    expect(r.github.findWorkflowRunsByCorrelation("r", "dispatch-1")).toHaveLength(1);
    r.journal.close();
  });

  it("lost-response ambiguity: ONE durable ambiguity row, escalation, and NO automatic retry ever", () => {
    const dir = tempDir();
    const journal = new IntentJournal(join(dir, "intents.sqlite"));
    const lossy = new FakeGitHub(join(dir, "github.json"), { loseResponses: "before-effect" });
    const testService = new FakeTestService(join(dir, "test-service.json"));
    const catchAll = new FakeCatchAll(join(dir, "catch-all.json"));
    const executor = new IntentExecutor(journal, { github: lossy, testService, catchAll });
    seedRepo(lossy);
    executor.submit("dispatch-1", {
      op: "workflow-dispatch",
      repo: "r",
      workflow: "w.yml",
      ref: "main",
      correlationId: "dispatch-1",
    });
    expect(executor.execute("dispatch-1").kind).toBe("indeterminate");

    const github = new FakeGitHub(join(dir, "github.json")); // healthy view, same world
    reconcileIntents(journal, { github });
    reconcileIntents(journal, { github }); // idempotent second pass
    const entry = journal.entry("dispatch-1")!;
    expect(entry.status).toBe("escalated");
    expect(
      journal.read({ intentId: "dispatch-1" }).filter((e) => e.event === "ambiguity-recorded"),
    ).toHaveLength(1);
    expect(entry.executionStartedCount).toBe(1); // no retry, automatic or otherwise
    expect(github.findWorkflowRunsByCorrelation("r", "dispatch-1")).toHaveLength(0);
    journal.close();
  });
});
