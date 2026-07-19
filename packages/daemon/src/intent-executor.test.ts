/**
 * Intent executor (WP-104): the durable protocol order, idempotent
 * completion from the journal, refusals per status, the indeterminate-
 * outcome path, and reset-before-use for test-service mutations.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefinitiveRefusalError } from "@camino/shared";
import type { GitHubMutationTransport } from "@camino/shared";
import { FakeGitHub } from "./chaos/fake-github.js";
import { FakeCatchAll, FakeTestService } from "./chaos/fake-services.js";
import { IntentExecutor } from "./intent-executor.js";
import { IntentJournal } from "./intent-journal.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

let dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-exec-"));
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

function rig(options: { loseResponses?: "before-effect" | "after-effect" } = {}): Rig {
  const dir = tempDir();
  const journal = new IntentJournal(join(dir, "intents.sqlite"));
  const fakeOptions = options.loseResponses ? { loseResponses: options.loseResponses } : {};
  const github = new FakeGitHub(join(dir, "github.json"), fakeOptions);
  const testService = new FakeTestService(join(dir, "test-service.json"), fakeOptions);
  const catchAll = new FakeCatchAll(join(dir, "catch-all.json"), fakeOptions);
  const executor = new IntentExecutor(journal, { github, testService, catchAll });
  return { journal, github, testService, catchAll, executor };
}

function seedRepo(github: FakeGitHub): void {
  github.seedCommit("r", SHA_A);
  github.seedCommit("r", SHA_B, [SHA_A]);
  github.seedRef("r", "main", SHA_A);
}

describe("the durable protocol", () => {
  it("submit → execute leaves [recorded, execution-started, confirmed] and one applied effect", () => {
    const { journal, github, executor } = rig();
    seedRepo(github);
    executor.submit("i1", { op: "branch-create", repo: "r", branch: "b1", targetSha: SHA_A });
    const outcome = executor.execute("i1");
    expect(outcome).toMatchObject({
      kind: "confirmed",
      alreadyComplete: false,
      result: { branch: "b1", sha: SHA_A },
    });
    expect(journal.read().map((r) => r.event)).toEqual([
      "recorded",
      "execution-started",
      "confirmed",
    ]);
    expect(github.effectCounts().get("branch:r:b1")).toBe(1);
  });

  it("the barrier is durable BEFORE the transport runs (hook order proves it)", () => {
    const dir = tempDir();
    const journal = new IntentJournal(join(dir, "intents.sqlite"));
    const seen: string[] = [];
    const github = new FakeGitHub(join(dir, "github.json"), {
      hook: (point) => seen.push(`${point}:barrier=${journal.entry("i1")?.status ?? "none"}`),
    });
    const testService = new FakeTestService(join(dir, "ts.json"));
    const catchAll = new FakeCatchAll(join(dir, "ca.json"));
    const executor = new IntentExecutor(journal, { github, testService, catchAll });
    seedRepo(github);
    executor.submit("i1", { op: "branch-create", repo: "r", branch: "b1", targetSha: SHA_A });
    executor.execute("i1");
    // At the moment the transport was about to commit the effect, the
    // journal already durably said execution-started.
    expect(seen[0]).toBe("in-transport-before-effect:barrier=execution-started");
    journal.close();
  });

  it("submitting a duplicate intent id refuses", () => {
    const { executor, github } = rig();
    seedRepo(github);
    executor.submit("i1", { op: "branch-create", repo: "r", branch: "b1", targetSha: SHA_A });
    expect(() =>
      executor.submit("i1", { op: "branch-create", repo: "r", branch: "b2", targetSha: SHA_A }),
    ).toThrow(/already exists/);
  });

  it("executing an unknown intent refuses", () => {
    const { executor } = rig();
    expect(() => executor.execute("ghost")).toThrow(/no recorded row/);
  });
});

describe("idempotent completion (the CAM-STATE-02 replay behavior)", () => {
  it("re-executing a confirmed intent returns the recorded result with zero transport calls", () => {
    const { executor, github } = rig();
    seedRepo(github);
    executor.submit("i1", { op: "branch-create", repo: "r", branch: "b1", targetSha: SHA_A });
    executor.execute("i1");
    const callsAfterFirst = github.state().mutationCalls;
    const replay = executor.execute("i1");
    expect(replay).toMatchObject({
      kind: "confirmed",
      alreadyComplete: true,
      result: { branch: "b1", sha: SHA_A },
    });
    expect(github.state().mutationCalls).toBe(callsAfterFirst);
    expect(github.effectCounts().get("branch:r:b1")).toBe(1);
  });
});

describe("refusals by status", () => {
  it("refuses to execute an in-flight (execution-started) intent — recovery's job", () => {
    const { executor, github } = rig({ loseResponses: "after-effect" });
    seedRepo(github);
    executor.submit("i1", { op: "branch-create", repo: "r", branch: "b1", targetSha: SHA_A });
    const outcome = executor.execute("i1");
    expect(outcome.kind).toBe("indeterminate");
    expect(() => executor.execute("i1")).toThrow(/only reconciliation/);
  });

  it("refuses to execute escalated and terminal intents", () => {
    const { journal, executor } = rig();
    journal.append({
      intentId: "i1",
      event: "recorded",
      actor: "x",
      payload: { op: "catch-all", description: "one-off" },
    });
    journal.append({ intentId: "i1", event: "execution-started", actor: "x", payload: {} });
    journal.append({
      intentId: "i1",
      event: "ambiguity-recorded",
      actor: "x",
      payload: { reason: "r" },
    });
    journal.append({ intentId: "i1", event: "escalated", actor: "x", payload: { reason: "r" } });
    expect(() => executor.execute("i1")).toThrow(/awaiting the human decision/);
    journal.append({
      intentId: "i1",
      event: "abandoned",
      actor: "david",
      payload: { reason: "r" },
    });
    expect(() => executor.execute("i1")).toThrow(/terminally abandoned/);
  });
});

describe("transport outcomes", () => {
  it("a clean transport refusal records failed (effect known-absent)", () => {
    const { journal, executor, github } = rig();
    seedRepo(github);
    github.seedRef("r", "b1", SHA_B); // collision at a different SHA
    executor.submit("i1", { op: "branch-create", repo: "r", branch: "b1", targetSha: SHA_A });
    const outcome = executor.execute("i1");
    expect(outcome.kind).toBe("failed");
    expect(journal.entry("i1")!.status).toBe("failed");
    expect(github.effectCounts().get("branch:r:b1")).toBeUndefined();
  });

  it("an indeterminate outcome leaves the ambiguity window intact (no failed, no confirmed)", () => {
    const { journal, executor, github } = rig({ loseResponses: "before-effect" });
    seedRepo(github);
    executor.submit("i1", { op: "branch-create", repo: "r", branch: "b1", targetSha: SHA_A });
    const outcome = executor.execute("i1");
    expect(outcome.kind).toBe("indeterminate");
    expect(journal.entry("i1")!.status).toBe("execution-started");
    expect(journal.read().map((r) => r.event)).toEqual(["recorded", "execution-started"]);
  });
});

describe("test-service mutations", () => {
  it("reset-before-use runs on EVERY execution (the environment is the idempotency unit)", () => {
    const { executor, testService } = rig();
    // Dirty the environment out-of-band first.
    testService.mutate({
      op: "test-service-mutation",
      environmentId: "env-1",
      mutation: "leftover-junk",
      irreversible: false,
    });
    expect(testService.environmentCount("env-1", "leftover-junk")).toBe(1);
    executor.submit("i1", {
      op: "test-service-mutation",
      environmentId: "env-1",
      mutation: "seed-database",
      irreversible: false,
    });
    executor.execute("i1");
    expect(testService.state().resetCalls).toBe(1);
    expect(testService.environmentCount("env-1", "leftover-junk")).toBe(0); // reset wiped it
    expect(testService.environmentCount("env-1", "seed-database")).toBe(1);
  });

  it("irreversible effects land in the outbox, which reset never clears", () => {
    const { executor, testService } = rig();
    executor.submit("i1", {
      op: "test-service-mutation",
      environmentId: "env-1",
      mutation: "send-email",
      irreversible: true,
    });
    executor.execute("i1");
    expect(testService.outboxCount("env-1", "send-email")).toBe(1);
    testService.resetEnvironment("env-1");
    expect(testService.outboxCount("env-1", "send-email")).toBe(1);
    expect(testService.environmentCount("env-1", "send-email")).toBe(0);
  });
});

describe("round-1 finding 3: the transport outcome contract is fail-safe", () => {
  it("a PLAIN throw after the external commit becomes indeterminate, and reconciliation confirms", async () => {
    const dir = tempDir();
    const journal = new IntentJournal(join(dir, "intents.sqlite"));
    const github = new FakeGitHub(join(dir, "github.json"));
    github.seedCommit("r", SHA_A);
    // A transport whose response path dies AFTER the upstream applied the
    // effect — the exact adapter behavior a socket reset produces.
    const flaky: GitHubMutationTransport = Object.create(github) as GitHubMutationTransport;
    flaky.createBranch = (spec) => {
      github.createBranch(spec);
      throw new Error("socket reset after upstream committed");
    };
    const testService = new FakeTestService(join(dir, "ts.json"));
    const catchAll = new FakeCatchAll(join(dir, "ca.json"));
    const executor = new IntentExecutor(journal, { github: flaky, testService, catchAll });
    executor.submit("i1", { op: "branch-create", repo: "r", branch: "b1", targetSha: SHA_A });
    const outcome = executor.execute("i1");
    // NOT failed: nothing proved the effect absent.
    expect(outcome.kind).toBe("indeterminate");
    expect(journal.entry("i1")!.status).toBe("execution-started");
    // Reconciliation settles it from the external truth: the effect IS there.
    const { reconcileIntents } = await import("./recovery.js");
    reconcileIntents(journal, { github });
    expect(journal.entry("i1")!.status).toBe("confirmed");
    expect(github.effectCounts().get("branch:r:b1")).toBe(1);
    journal.close();
  });

  it("only DefinitiveRefusalError records failed", () => {
    const { journal, executor, github } = rig();
    seedRepo(github);
    github.seedRef("r", "b1", SHA_B); // collision → the fake throws DefinitiveRefusalError
    executor.submit("i1", { op: "branch-create", repo: "r", branch: "b1", targetSha: SHA_A });
    const outcome = executor.execute("i1");
    expect(outcome.kind).toBe("failed");
    expect(journal.entry("i1")!.status).toBe("failed");
    // And the class is exported for real adapters to use:
    expect(new DefinitiveRefusalError("x")).toBeInstanceOf(Error);
  });
});
