/**
 * Recovery + reconciliation (WP-104, CAM-STATE-03): the lock-guarded
 * composition, per-class reconciliation verdicts driven end-to-end
 * through the journal and the fakes (lost-response states manufactured
 * in-process; the chaos suite reproduces them with real SIGKILLs),
 * idempotent re-reconciliation, and the queries-only property.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { intentMarkerToken } from "@camino/shared";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { FakeGitHub } from "./chaos/fake-github.js";
import { FakeCatchAll, FakeTestService } from "./chaos/fake-services.js";
import { IntentExecutor } from "./intent-executor.js";
import { IntentJournal } from "./intent-journal.js";
import { STATE_FILES, openRecoveredState, reconcileIntents } from "./recovery.js";
import { WriterLock, WriterLockHeldError } from "./writer-lock.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

let dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-recovery-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

interface Rig {
  dir: string;
  journal: IntentJournal;
  github: FakeGitHub;
  testService: FakeTestService;
  catchAll: FakeCatchAll;
}

/**
 * Build a journal + fakes where executing `spec` loses its response at
 * the given side of the effect — the two crashed-like states every
 * reconciliation scenario starts from.
 */
function crashedRig(lose: "before-effect" | "after-effect"): Rig {
  const dir = tempDir();
  const journal = new IntentJournal(join(dir, "intents.sqlite"));
  const github = new FakeGitHub(join(dir, "github.json"), { loseResponses: lose });
  const testService = new FakeTestService(join(dir, "test-service.json"), {
    loseResponses: lose,
  });
  const catchAll = new FakeCatchAll(join(dir, "catch-all.json"), { loseResponses: lose });
  return { dir, journal, github, testService, catchAll };
}

/** Fakes over the same files WITHOUT response loss (recovery + completion side). */
function healthy(rig: Rig): {
  github: FakeGitHub;
  testService: FakeTestService;
  catchAll: FakeCatchAll;
  executor: IntentExecutor;
} {
  const github = new FakeGitHub(join(rig.dir, "github.json"));
  const testService = new FakeTestService(join(rig.dir, "test-service.json"));
  const catchAll = new FakeCatchAll(join(rig.dir, "catch-all.json"));
  const executor = new IntentExecutor(rig.journal, { github, testService, catchAll });
  return { github, testService, catchAll, executor };
}

function seedRepo(github: FakeGitHub): void {
  github.seedCommit("r", SHA_A);
  github.seedCommit("r", SHA_B, [SHA_A]);
  github.seedRef("r", "main", SHA_A);
}

describe("openRecoveredState (the lock-guarded composition)", () => {
  it("refuses a missing state directory", () => {
    const dir = join(tempDir(), "nope");
    expect(() =>
      openRecoveredState(dir, { github: new FakeGitHub(join(tempDir(), "g.json")) }),
    ).toThrow(/does not exist/);
  });

  it("opens fresh state, reports nothing, and releases the lock on close", () => {
    const dir = tempDir();
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    const github = new FakeGitHub(join(dir, "github.json"));
    const state = openRecoveredState(stateDir, { github });
    expect(state.report.reconciled).toEqual([]);
    expect(state.lock.held).toBe(true);
    state.close();
    // Lock released: a second open succeeds.
    const again = openRecoveredState(stateDir, { github });
    again.close();
  });

  it("refuses while another holder has the writer lock (single-writer recovery)", () => {
    const dir = tempDir();
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    const github = new FakeGitHub(join(dir, "github.json"));
    const held = WriterLock.acquire(join(stateDir, "writer-lock.sqlite"));
    try {
      expect(() => openRecoveredState(stateDir, { github })).toThrow(WriterLockHeldError);
    } finally {
      held.release();
    }
  });

  it("writes through the lock: stores opened by recovery refuse appends after release", () => {
    const dir = tempDir();
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    const github = new FakeGitHub(join(dir, "github.json"));
    const state = openRecoveredState(stateDir, { github });
    state.close();
    expect(() =>
      state.journal.append({
        intentId: "late",
        event: "recorded",
        actor: "x",
        payload: { op: "catch-all", description: "after close" },
      }),
    ).toThrow(/without the writer lock held/);
  });
});

describe("reconciliation verdicts per §4.4 class (lost-response states)", () => {
  it("branch-create: effect landed → confirmed via reconciliation, zero re-execution", () => {
    const rig = crashedRig("after-effect");
    seedRepo(rig.github);
    const executor = new IntentExecutor(rig.journal, {
      github: rig.github,
      testService: rig.testService,
      catchAll: rig.catchAll,
    });
    executor.submit("i1", { op: "branch-create", repo: "r", branch: "b1", targetSha: SHA_A });
    expect(executor.execute("i1").kind).toBe("indeterminate");
    const { github } = healthy(rig);
    const report = reconcileIntents(rig.journal, { github });
    expect(report.reconciled).toMatchObject([{ intentId: "i1", verdict: "confirmed-external" }]);
    const entry = rig.journal.entry("i1")!;
    expect(entry.status).toBe("confirmed");
    expect(entry.confirmedVia).toBe("reconciliation");
    expect(entry.executionStartedCount).toBe(1);
    expect(github.effectCounts().get("branch:r:b1")).toBe(1);
  });

  it("branch-create: effect absent → re-arm, completion applies it exactly once", () => {
    const rig = crashedRig("before-effect");
    seedRepo(rig.github);
    const executor = new IntentExecutor(rig.journal, {
      github: rig.github,
      testService: rig.testService,
      catchAll: rig.catchAll,
    });
    executor.submit("i1", { op: "branch-create", repo: "r", branch: "b1", targetSha: SHA_A });
    executor.execute("i1");
    const h = healthy(rig);
    const report = reconcileIntents(rig.journal, { github: h.github });
    expect(report.pendingExecution).toEqual(["i1"]);
    expect(h.executor.execute("i1").kind).toBe("confirmed");
    expect(h.github.effectCounts().get("branch:r:b1")).toBe(1);
    expect(rig.journal.entry("i1")!.executionStartedCount).toBe(2);
  });

  it("branch-create: branch at a DIFFERENT Sha → escalated (collision never overwritten)", () => {
    const rig = crashedRig("before-effect");
    seedRepo(rig.github);
    const executor = new IntentExecutor(rig.journal, {
      github: rig.github,
      testService: rig.testService,
      catchAll: rig.catchAll,
    });
    executor.submit("i1", { op: "branch-create", repo: "r", branch: "b1", targetSha: SHA_A });
    executor.execute("i1");
    rig.github.moveRefOutOfBand("r", "b1", SHA_C); // collision appears
    const { github } = healthy(rig);
    reconcileIntents(rig.journal, { github });
    expect(rig.journal.entry("i1")!.status).toBe("escalated");
    expect(github.effectCounts().get("branch:r:b1")).toBeUndefined();
  });

  it("push: landed → confirmed; still at base → re-arm + exactly-once; out-of-band → escalated", () => {
    // landed
    const landed = crashedRig("after-effect");
    seedRepo(landed.github);
    landed.github.seedRef("r", "feature", SHA_A);
    const executorLanded = new IntentExecutor(landed.journal, {
      github: landed.github,
      testService: landed.testService,
      catchAll: landed.catchAll,
    });
    executorLanded.submit("p1", {
      op: "push",
      repo: "r",
      ref: "feature",
      intendedSha: SHA_B,
      expectedBaseSha: SHA_A,
    });
    executorLanded.execute("p1");
    reconcileIntents(landed.journal, { github: healthy(landed).github });
    expect(landed.journal.entry("p1")!.status).toBe("confirmed");

    // absent → re-arm → exactly once
    const absent = crashedRig("before-effect");
    seedRepo(absent.github);
    absent.github.seedRef("r", "feature", SHA_A);
    const executorAbsent = new IntentExecutor(absent.journal, {
      github: absent.github,
      testService: absent.testService,
      catchAll: absent.catchAll,
    });
    executorAbsent.submit("p2", {
      op: "push",
      repo: "r",
      ref: "feature",
      intendedSha: SHA_B,
      expectedBaseSha: SHA_A,
    });
    executorAbsent.execute("p2");
    const h = healthy(absent);
    const report = reconcileIntents(absent.journal, { github: h.github });
    expect(report.pendingExecution).toEqual(["p2"]);
    h.executor.execute("p2");
    expect(h.github.getRef("r", "feature")).toBe(SHA_B);
    expect(h.github.effectCounts().get(`push:r:feature:${SHA_B}`)).toBe(1);

    // out-of-band move → escalated, never force-pushed
    const moved = crashedRig("before-effect");
    seedRepo(moved.github);
    moved.github.seedRef("r", "feature", SHA_A);
    const executorMoved = new IntentExecutor(moved.journal, {
      github: moved.github,
      testService: moved.testService,
      catchAll: moved.catchAll,
    });
    executorMoved.submit("p3", {
      op: "push",
      repo: "r",
      ref: "feature",
      intendedSha: SHA_B,
      expectedBaseSha: SHA_A,
    });
    executorMoved.execute("p3");
    moved.github.moveRefOutOfBand("r", "feature", SHA_C);
    reconcileIntents(moved.journal, { github: healthy(moved).github });
    expect(moved.journal.entry("p3")!.status).toBe("escalated");
    expect(healthy(moved).github.getRef("r", "feature")).toBe(SHA_C); // untouched
  });

  it("pr-create: open PR with marker → confirmed corroborated; body stripped → confirmed uncorroborated", () => {
    const marker = "pr1"; // the intent id — the binding the journal enforces
    const spec = {
      op: "pr-create",
      repo: "r",
      headBranch: "feature",
      baseBranch: "main",
      title: "t",
      bodyMarker: marker,
      body: `text ${intentMarkerToken(marker)}`,
    } as const;

    const corroborated = crashedRig("after-effect");
    seedRepo(corroborated.github);
    const e1 = new IntentExecutor(corroborated.journal, {
      github: corroborated.github,
      testService: corroborated.testService,
      catchAll: corroborated.catchAll,
    });
    e1.submit("pr1", spec);
    e1.execute("pr1");
    reconcileIntents(corroborated.journal, { github: healthy(corroborated).github });
    const entry = corroborated.journal.entry("pr1")!;
    expect(entry.status).toBe("confirmed");
    expect(entry.result).toMatchObject({ corroborated: true });

    const stripped = crashedRig("after-effect");
    seedRepo(stripped.github);
    const e2 = new IntentExecutor(stripped.journal, {
      github: stripped.github,
      testService: stripped.testService,
      catchAll: stripped.catchAll,
    });
    e2.submit("pr1", spec);
    e2.execute("pr1");
    stripped.github.setPullRequestBodyOutOfBand("r", 1, "body edited by someone");
    reconcileIntents(stripped.journal, { github: healthy(stripped).github });
    const strippedEntry = stripped.journal.entry("pr1")!;
    expect(strippedEntry.status).toBe("confirmed");
    expect(strippedEntry.result).toMatchObject({ prNumber: 1, corroborated: false });
  });

  it("pr-create: a closed PR on the head branch → escalated (closed/reused-branch class)", () => {
    const marker = "pr2";
    const rig = crashedRig("before-effect");
    seedRepo(rig.github);
    rig.github.seedPullRequest("r", {
      headBranch: "feature",
      baseBranch: "main",
      state: "closed",
      title: "an earlier mission's PR",
      body: "old",
    });
    const executor = new IntentExecutor(rig.journal, {
      github: rig.github,
      testService: rig.testService,
      catchAll: rig.catchAll,
    });
    executor.submit("pr2", {
      op: "pr-create",
      repo: "r",
      headBranch: "feature",
      baseBranch: "main",
      title: "t",
      bodyMarker: marker,
      body: `x ${intentMarkerToken(marker)}`,
    });
    executor.execute("pr2");
    reconcileIntents(rig.journal, { github: healthy(rig).github });
    const entry = rig.journal.entry("pr2")!;
    expect(entry.status).toBe("escalated");
    expect(entry.ambiguityReason).toMatch(/closed/);
  });

  it("merge-by-push: landed → confirmed; base intact → re-arm; superseded base → failed terminal", () => {
    const merge = () =>
      ({
        op: "merge-by-push",
        repo: "r",
        targetRef: "main",
        mergeSha: SHA_B,
        expectedBaseSha: SHA_A,
      }) as const;

    const landed = crashedRig("after-effect");
    seedRepo(landed.github);
    const e1 = new IntentExecutor(landed.journal, {
      github: landed.github,
      testService: landed.testService,
      catchAll: landed.catchAll,
    });
    e1.submit("m1", merge());
    e1.execute("m1");
    reconcileIntents(landed.journal, { github: healthy(landed).github });
    expect(landed.journal.entry("m1")!.status).toBe("confirmed");

    const intact = crashedRig("before-effect");
    seedRepo(intact.github);
    const e2 = new IntentExecutor(intact.journal, {
      github: intact.github,
      testService: intact.testService,
      catchAll: intact.catchAll,
    });
    e2.submit("m2", merge());
    e2.execute("m2");
    const h = healthy(intact);
    const report = reconcileIntents(intact.journal, { github: h.github });
    expect(report.pendingExecution).toEqual(["m2"]);
    h.executor.execute("m2");
    expect(h.github.getRef("r", "main")).toBe(SHA_B);

    const superseded = crashedRig("before-effect");
    seedRepo(superseded.github);
    const e3 = new IntentExecutor(superseded.journal, {
      github: superseded.github,
      testService: superseded.testService,
      catchAll: superseded.catchAll,
    });
    e3.submit("m3", merge());
    e3.execute("m3");
    superseded.github.moveRefOutOfBand("r", "main", SHA_C);
    reconcileIntents(superseded.journal, { github: healthy(superseded).github });
    expect(superseded.journal.entry("m3")!.status).toBe("failed");
    expect(healthy(superseded).github.getRef("r", "main")).toBe(SHA_C); // never touched
  });

  it("label-set: desired state observed → confirmed; drifted → re-arm re-applies", () => {
    const rig = crashedRig("after-effect");
    seedRepo(rig.github);
    const executor = new IntentExecutor(rig.journal, {
      github: rig.github,
      testService: rig.testService,
      catchAll: rig.catchAll,
    });
    executor.submit("l1", {
      op: "label-set",
      repo: "r",
      targetKind: "issue",
      targetNumber: 7,
      label: "camino:executing",
      desired: "present",
    });
    executor.execute("l1");
    reconcileIntents(rig.journal, { github: healthy(rig).github });
    expect(rig.journal.entry("l1")!.status).toBe("confirmed");
    expect(healthy(rig).github.isLabelPresent("r", "issue", 7, "camino:executing")).toBe(true);
  });

  it("comment-post: marker found → confirmed with the comment id; absent → re-arm posts once", () => {
    const commentSpec = (intentId: string) =>
      ({
        op: "comment-post",
        repo: "r",
        targetKind: "issue",
        targetNumber: 7,
        body: `hello ${intentMarkerToken(intentId)}`,
        marker: intentId,
      }) as const;

    const found = crashedRig("after-effect");
    seedRepo(found.github);
    const e1 = new IntentExecutor(found.journal, {
      github: found.github,
      testService: found.testService,
      catchAll: found.catchAll,
    });
    e1.submit("c1", commentSpec("c1"));
    e1.execute("c1");
    reconcileIntents(found.journal, { github: healthy(found).github });
    const entry = found.journal.entry("c1")!;
    expect(entry.status).toBe("confirmed");
    expect(entry.result).toMatchObject({ commentId: 1 });

    const absent = crashedRig("before-effect");
    seedRepo(absent.github);
    const e2 = new IntentExecutor(absent.journal, {
      github: absent.github,
      testService: absent.testService,
      catchAll: absent.catchAll,
    });
    e2.submit("c2", commentSpec("c2"));
    e2.execute("c2");
    const h = healthy(absent);
    reconcileIntents(absent.journal, { github: h.github });
    h.executor.execute("c2");
    expect(h.github.effectCounts().get("comment:r:issue#7:c2")).toBe(1);
  });

  it("workflow-dispatch: correlated run present → confirmed; absent → ONE ambiguity, escalated, never auto-retried", () => {
    const present = crashedRig("after-effect");
    seedRepo(present.github);
    const e1 = new IntentExecutor(present.journal, {
      github: present.github,
      testService: present.testService,
      catchAll: present.catchAll,
    });
    e1.submit("d1", {
      op: "workflow-dispatch",
      repo: "r",
      workflow: "w.yml",
      ref: "main",
      correlationId: "d1",
    });
    e1.execute("d1");
    reconcileIntents(present.journal, { github: healthy(present).github });
    const confirmedEntry = present.journal.entry("d1")!;
    expect(confirmedEntry.status).toBe("confirmed");
    expect(confirmedEntry.result).toMatchObject({ correlatedRuns: 1 });

    const lost = crashedRig("before-effect");
    seedRepo(lost.github);
    const e2 = new IntentExecutor(lost.journal, {
      github: lost.github,
      testService: lost.testService,
      catchAll: lost.catchAll,
    });
    e2.submit("d2", {
      op: "workflow-dispatch",
      repo: "r",
      workflow: "w.yml",
      ref: "main",
      correlationId: "d2",
    });
    e2.execute("d2");
    const h = healthy(lost);
    const report = reconcileIntents(lost.journal, { github: h.github });
    expect(report.awaitingHuman).toEqual(["d2"]);
    const entry = lost.journal.entry("d2")!;
    expect(entry.status).toBe("escalated");
    expect(entry.executionStartedCount).toBe(1); // at-most-once: never re-executed
    expect(
      lost.journal.read({ intentId: "d2" }).filter((r) => r.event === "ambiguity-recorded"),
    ).toHaveLength(1);
    expect(h.github.state().repos["r"]?.workflowRuns ?? []).toHaveLength(0); // zero dispatches
    expect(() => h.executor.execute("d2")).toThrow(/awaiting the human/);
  });

  it("test-service resettable: re-arm resets then re-executes — environment holds the mutation exactly once", () => {
    const rig = crashedRig("after-effect"); // effect APPLIED, response lost
    const executor = new IntentExecutor(rig.journal, {
      github: rig.github,
      testService: rig.testService,
      catchAll: rig.catchAll,
    });
    executor.submit("t1", {
      op: "test-service-mutation",
      environmentId: "env-1",
      mutation: "seed-database",
      irreversible: false,
    });
    executor.execute("t1");
    expect(rig.testService.environmentCount("env-1", "seed-database")).toBe(1); // applied pre-crash
    const h = healthy(rig);
    const report = reconcileIntents(rig.journal, { github: h.github });
    expect(report.pendingExecution).toEqual(["t1"]);
    h.executor.execute("t1"); // reset-before-use wipes, then re-applies
    expect(h.testService.environmentCount("env-1", "seed-database")).toBe(1); // EXACTLY once
    expect(rig.journal.entry("t1")!.status).toBe("confirmed");
  });

  it("test-service irreversible: ambiguity + escalation; the outbox never grows past one", () => {
    const rig = crashedRig("after-effect"); // email SENT, response lost
    const executor = new IntentExecutor(rig.journal, {
      github: rig.github,
      testService: rig.testService,
      catchAll: rig.catchAll,
    });
    executor.submit("t2", {
      op: "test-service-mutation",
      environmentId: "env-1",
      mutation: "send-email",
      irreversible: true,
    });
    executor.execute("t2");
    expect(rig.testService.outboxCount("env-1", "send-email")).toBe(1);
    const h = healthy(rig);
    reconcileIntents(rig.journal, { github: h.github });
    const entry = rig.journal.entry("t2")!;
    expect(entry.status).toBe("escalated");
    expect(h.testService.outboxCount("env-1", "send-email")).toBe(1); // never auto-retried
    expect(() => h.executor.execute("t2")).toThrow(/awaiting the human/);
  });

  it("catch-all: durable ambiguity before any MANUAL retry; David's authorization reopens execution", () => {
    const rig = crashedRig("before-effect"); // effect never applied
    const executor = new IntentExecutor(rig.journal, {
      github: rig.github,
      testService: rig.testService,
      catchAll: rig.catchAll,
    });
    executor.submit("x1", { op: "catch-all", description: "rotate the fixture token" });
    executor.execute("x1");
    const h = healthy(rig);
    reconcileIntents(rig.journal, { github: h.github });
    expect(rig.journal.entry("x1")!.status).toBe("escalated");

    // David authorizes the manual retry; the ambiguity row PRECEDES it durably.
    rig.journal.append({
      intentId: "x1",
      event: "retry-authorized",
      actor: "david",
      payload: { reason: "David reviewed the escalation: safe to retry" },
    });
    expect(h.executor.execute("x1").kind).toBe("confirmed");
    expect(h.catchAll.effectCount("rotate the fixture token")).toBe(1);
    const events = rig.journal.read({ intentId: "x1" }).map((r) => r.event);
    const ambiguityAt = events.indexOf("ambiguity-recorded");
    const retryAt = events.indexOf("retry-authorized");
    expect(ambiguityAt).toBeGreaterThan(-1);
    expect(retryAt).toBeGreaterThan(ambiguityAt);
  });
});

describe("reconciliation properties", () => {
  it("is idempotent: a second pass appends nothing and repeats no verdict", () => {
    const rig = crashedRig("before-effect");
    seedRepo(rig.github);
    const executor = new IntentExecutor(rig.journal, {
      github: rig.github,
      testService: rig.testService,
      catchAll: rig.catchAll,
    });
    executor.submit("d1", {
      op: "workflow-dispatch",
      repo: "r",
      workflow: "w.yml",
      ref: "main",
      correlationId: "d1",
    });
    executor.execute("d1");
    const { github } = healthy(rig);
    reconcileIntents(rig.journal, { github });
    const rowsAfterFirst = rig.journal.read().length;
    const second = reconcileIntents(rig.journal, { github });
    expect(rig.journal.read().length).toBe(rowsAfterFirst);
    expect(second.awaitingHuman).toEqual(["d1"]);
    expect(
      rig.journal.read({ intentId: "d1" }).filter((r) => r.event === "ambiguity-recorded"),
    ).toHaveLength(1);
  });

  it("finishes a half-appended escalation pair (crash between ambiguity and escalated)", () => {
    const rig = crashedRig("before-effect");
    const executor = new IntentExecutor(rig.journal, {
      github: rig.github,
      testService: rig.testService,
      catchAll: rig.catchAll,
    });
    executor.submit("x1", { op: "catch-all", description: "one-off" });
    executor.execute("x1");
    // Manufacture the mid-crash state: ambiguity recorded, escalation missing.
    rig.journal.append({
      intentId: "x1",
      event: "ambiguity-recorded",
      actor: "camino:recovery",
      payload: { reason: "no key to reconcile by" },
    });
    const { github } = healthy(rig);
    const report = reconcileIntents(rig.journal, { github });
    expect(report.awaitingHuman).toEqual(["x1"]);
    const events = rig.journal.read({ intentId: "x1" }).map((r) => r.event);
    expect(events.filter((e) => e === "ambiguity-recorded")).toHaveLength(1);
    expect(events.filter((e) => e === "escalated")).toHaveLength(1);
  });

  it("performs ZERO mutations while reconciling (queries only, by count)", () => {
    const rig = crashedRig("after-effect");
    seedRepo(rig.github);
    const executor = new IntentExecutor(rig.journal, {
      github: rig.github,
      testService: rig.testService,
      catchAll: rig.catchAll,
    });
    executor.submit("i1", { op: "branch-create", repo: "r", branch: "b1", targetSha: SHA_A });
    executor.execute("i1");
    const { github } = healthy(rig);
    const mutationsBefore = github.state().mutationCalls;
    const queriesBefore = github.state().queryCalls;
    reconcileIntents(rig.journal, { github });
    expect(github.state().mutationCalls).toBe(mutationsBefore);
    expect(github.state().queryCalls).toBeGreaterThan(queriesBefore);
  });

  it("reads decisions from the log: reconciliation uses the RECORDED intended SHA", () => {
    // The push landed at the recorded intended SHA; if reconciliation
    // re-derived intent from anywhere else it could not confirm.
    const rig = crashedRig("after-effect");
    seedRepo(rig.github);
    rig.github.seedRef("r", "feature", SHA_A);
    const executor = new IntentExecutor(rig.journal, {
      github: rig.github,
      testService: rig.testService,
      catchAll: rig.catchAll,
    });
    executor.submit("p1", {
      op: "push",
      repo: "r",
      ref: "feature",
      intendedSha: SHA_B,
      expectedBaseSha: SHA_A,
    });
    executor.execute("p1");
    const { github } = healthy(rig);
    const report = reconcileIntents(rig.journal, { github });
    expect(report.reconciled[0]).toMatchObject({
      intentId: "p1",
      verdict: "confirmed-external",
    });
    const confirmed = rig.journal.read({ intentId: "p1" }).find((r) => r.event === "confirmed")!;
    expect(confirmed.payload["result"]).toMatchObject({ sha: SHA_B });
  });
});

describe("round-1 regressions (falsification review findings)", () => {
  it("finding 1: a FOREIGN intent's marker token never confirms ours (comments)", () => {
    const rig = crashedRig("before-effect");
    seedRepo(rig.github);
    const executor = new IntentExecutor(rig.journal, {
      github: rig.github,
      testService: rig.testService,
      catchAll: rig.catchAll,
    });
    executor.submit("intent-c-1", {
      op: "comment-post",
      repo: "r",
      targetKind: "issue",
      targetNumber: 7,
      body: `mine ${intentMarkerToken("intent-c-1")}`,
      marker: "intent-c-1",
    });
    executor.execute("intent-c-1");
    const h = healthy(rig);
    // A DIFFERENT intent's comment exists — its id ("intent-c-10") even
    // contains ours as a prefix. It must not confirm us.
    h.github.postComment({
      op: "comment-post",
      repo: "r",
      targetKind: "issue",
      targetNumber: 7,
      body: `someone else's ${intentMarkerToken("intent-c-10")}`,
      marker: "intent-c-10",
    });
    const report = reconcileIntents(rig.journal, { github: h.github });
    expect(report.reconciled[0]!.verdict).toBe("re-arm"); // NOT confirmed-external
    h.executor.execute("intent-c-1");
    expect(h.github.effectCounts().get("comment:r:issue#7:intent-c-1")).toBe(1);
  });

  it("finding 1: a FOREIGN correlated run never confirms our dispatch (prefix ids)", () => {
    const rig = crashedRig("before-effect");
    seedRepo(rig.github);
    const executor = new IntentExecutor(rig.journal, {
      github: rig.github,
      testService: rig.testService,
      catchAll: rig.catchAll,
    });
    executor.submit("intent-d-1", {
      op: "workflow-dispatch",
      repo: "r",
      workflow: "w.yml",
      ref: "main",
      correlationId: "intent-d-1",
    });
    executor.execute("intent-d-1");
    const h = healthy(rig);
    // Another intent's run exists whose id carries ours as a prefix.
    h.github.dispatchWorkflow({
      op: "workflow-dispatch",
      repo: "r",
      workflow: "w.yml",
      ref: "main",
      correlationId: "intent-d-10",
    });
    reconcileIntents(rig.journal, { github: h.github });
    // Ours is still unknown → ONE ambiguity + escalation, never a false confirm.
    const entry = rig.journal.entry("intent-d-1")!;
    expect(entry.status).toBe("escalated");
    expect(entry.executionStartedCount).toBe(1);
  });

  it("finding 8: status-only recovery proceeds with the external system UNREACHABLE", () => {
    const rig = crashedRig("before-effect");
    const executor = new IntentExecutor(rig.journal, {
      github: rig.github,
      testService: rig.testService,
      catchAll: rig.catchAll,
    });
    // recorded (never executed), plus a half-appended escalation pair.
    rig.journal.append({
      intentId: "never-sent",
      event: "recorded",
      actor: "x",
      payload: { op: "catch-all", description: "pending work" },
    });
    executor.submit("parked", { op: "catch-all", description: "parked work" });
    executor.execute("parked");
    rig.journal.append({
      intentId: "parked",
      event: "ambiguity-recorded",
      actor: "camino:recovery",
      payload: { reason: "recorded before the outage" },
    });
    const offline: Parameters<typeof reconcileIntents>[1] = {
      github: new Proxy({} as never, {
        get: () => () => {
          throw new Error("GitHub offline");
        },
      }),
    };
    const report = reconcileIntents(rig.journal, offline);
    expect(report.pendingExecution).toEqual(["never-sent"]);
    expect(report.awaitingHuman).toEqual(["parked"]);
    expect(rig.journal.entry("parked")!.status).toBe("escalated");
  });

  it("finding 12: the pending-execution detail reflects real history after a re-arm", () => {
    const rig = crashedRig("before-effect");
    seedRepo(rig.github);
    const executor = new IntentExecutor(rig.journal, {
      github: rig.github,
      testService: rig.testService,
      catchAll: rig.catchAll,
    });
    executor.submit("i1", { op: "branch-create", repo: "r", branch: "b1", targetSha: SHA_A });
    executor.execute("i1");
    const { github } = healthy(rig);
    reconcileIntents(rig.journal, { github }); // re-arms
    const second = reconcileIntents(rig.journal, { github }); // status-only now
    expect(second.reconciled[0]!.verdict).toBe("pending-execution");
    expect(second.reconciled[0]!.detail).toMatch(/executable again after reconciliation/);
    expect(second.reconciled[0]!.detail).not.toMatch(/provably never sent/);
  });
});

describe("round-2 regressions", () => {
  it("finding 3: status-only work completes even when an EARLIER intent's query fails", () => {
    const rig = crashedRig("before-effect");
    seedRepo(rig.github);
    const executor = new IntentExecutor(rig.journal, {
      github: rig.github,
      testService: rig.testService,
      catchAll: rig.catchAll,
    });
    // FIRST (journal order): an execution-started intent that needs a query.
    executor.submit("query-first", {
      op: "branch-create",
      repo: "r",
      branch: "b1",
      targetSha: SHA_A,
    });
    executor.execute("query-first");
    // LATER: a half-appended escalation pair (status-only work).
    executor.submit("status-later", { op: "catch-all", description: "parked" });
    executor.execute("status-later");
    rig.journal.append({
      intentId: "status-later",
      event: "ambiguity-recorded",
      actor: "camino:recovery",
      payload: { reason: "recorded before the outage" },
    });
    const offline: Parameters<typeof reconcileIntents>[1] = {
      github: new Proxy({} as never, {
        get: () => () => {
          throw new Error("GitHub offline");
        },
      }),
    };
    // The pass still fails loudly on the query-needing intent...
    expect(() => reconcileIntents(rig.journal, offline)).toThrow(/GitHub offline/);
    // ...but the status-only escalation completed FIRST (pass-wide phase).
    expect(rig.journal.entry("status-later")!.status).toBe("escalated");
    // And the retry is idempotent: exactly one escalation row survives.
    const { github } = healthy(rig);
    reconcileIntents(rig.journal, { github });
    expect(
      rig.journal.read({ intentId: "status-later" }).filter((r) => r.event === "escalated"),
    ).toHaveLength(1);
  });

  it("finding 2 boundary: only David's explicit retry can duplicate a dispatch, and it stays visible", () => {
    // The lost-but-landed dispatch: effect applied, response lost.
    const rig = crashedRig("after-effect");
    seedRepo(rig.github);
    const executor = new IntentExecutor(rig.journal, {
      github: rig.github,
      testService: rig.testService,
      catchAll: rig.catchAll,
    });
    executor.submit("d1", {
      op: "workflow-dispatch",
      repo: "r",
      workflow: "w.yml",
      ref: "main",
      correlationId: "d1",
    });
    executor.execute("d1");
    const h = healthy(rig);
    // Automatic reconciliation CONFIRMS from the correlated run — no retry,
    // no duplicate (the automatic path is at-most-once).
    reconcileIntents(rig.journal, { github: h.github });
    expect(rig.journal.entry("d1")!.status).toBe("confirmed");
    expect(h.github.findWorkflowRunsByCorrelation("r", "d1")).toHaveLength(1);

    // The genuinely ambiguous variant: dispatch lost BEFORE landing, then
    // the run materializes AFTER escalation (queue lag) — and David,
    // seeing the escalation, authorizes a retry anyway. The duplicate is
    // his informed decision and stays visible via the correlation query.
    const lag = crashedRig("before-effect");
    seedRepo(lag.github);
    const e2 = new IntentExecutor(lag.journal, {
      github: lag.github,
      testService: lag.testService,
      catchAll: lag.catchAll,
    });
    e2.submit("d2", {
      op: "workflow-dispatch",
      repo: "r",
      workflow: "w.yml",
      ref: "main",
      correlationId: "d2",
    });
    e2.execute("d2");
    const h2 = healthy(lag);
    reconcileIntents(lag.journal, { github: h2.github });
    expect(lag.journal.entry("d2")!.status).toBe("escalated");
    // The lost dispatch lands late (out-of-band materialization).
    h2.github.dispatchWorkflow({
      op: "workflow-dispatch",
      repo: "r",
      workflow: "w.yml",
      ref: "main",
      correlationId: "d2",
    });
    // No automatic actor can authorize the retry — the row is David-bound.
    expect(() =>
      lag.journal.append({
        intentId: "d2",
        event: "retry-authorized",
        actor: "camino:recovery",
        payload: { reason: "automation must never do this" },
      }),
    ).toThrow(/David/);
    lag.journal.append({
      intentId: "d2",
      event: "retry-authorized",
      actor: "david",
      payload: { reason: "David reviewed the escalation and chose to re-dispatch" },
    });
    h2.executor.execute("d2");
    // Two runs exist — David's knowing duplicate, tolerable per the §4.4
    // table (advisory-only CI), and VISIBLE: the correlation query returns
    // both. No automatic path produced this.
    expect(h2.github.findWorkflowRunsByCorrelation("r", "d2")).toHaveLength(2);
  });
});

describe("round-3 regressions", () => {
  it("finding 1: a Camino intent cannot embed a FOREIGN intent's token (namespace reserved)", () => {
    const rig = crashedRig("before-effect");
    const executor = new IntentExecutor(rig.journal, {
      github: rig.github,
      testService: rig.testService,
      catchAll: rig.catchAll,
    });
    expect(() =>
      executor.submit("attacker-B", {
        op: "comment-post",
        repo: "r",
        targetKind: "issue",
        targetNumber: 7,
        body: `mine ${intentMarkerToken("attacker-B")} plus ${intentMarkerToken("victim-A")}`,
        marker: "attacker-B",
      }),
    ).toThrow(/namespace is reserved/);
  });

  it("finding 1: several token-bearing comments (out-of-band forgery) → ambiguity, never first-match", () => {
    const rig = crashedRig("after-effect"); // our comment LANDED, response lost
    seedRepo(rig.github);
    const executor = new IntentExecutor(rig.journal, {
      github: rig.github,
      testService: rig.testService,
      catchAll: rig.catchAll,
    });
    executor.submit("victim-A", {
      op: "comment-post",
      repo: "r",
      targetKind: "issue",
      targetNumber: 7,
      body: `mine ${intentMarkerToken("victim-A")}`,
      marker: "victim-A",
    });
    executor.execute("victim-A");
    const h = healthy(rig);
    // An out-of-band actor posts a SECOND comment carrying our token
    // (unconstructible through Camino's own journal — simulated raw).
    h.github.postComment({
      op: "comment-post",
      repo: "r",
      targetKind: "issue",
      targetNumber: 7,
      body: `forged copy ${intentMarkerToken("victim-A")}`,
      marker: "victim-A",
    });
    reconcileIntents(rig.journal, { github: h.github });
    expect(rig.journal.entry("victim-A")!.status).toBe("escalated");
    expect(rig.journal.entry("victim-A")!.ambiguityReason).toMatch(/out-of-band/);
  });

  it("finding 2: mutating the append-returned record cannot move the live fold", () => {
    const rig = crashedRig("before-effect");
    seedRepo(rig.github);
    const record = rig.journal.append({
      intentId: "i1",
      event: "recorded",
      actor: "x",
      payload: { op: "branch-create", repo: "r", branch: "original", targetSha: SHA_A },
    });
    (record.payload as Record<string, unknown>)["branch"] = "mutated";
    const entry = rig.journal.entry("i1")!;
    expect(entry.spec).toMatchObject({ branch: "original" });
    // The executor acts on the fold's owned copy, not the alias.
    const h = healthy(rig);
    h.executor.execute("i1");
    expect(h.github.effectCounts().get("branch:r:original")).toBe(1);
    expect(h.github.effectCounts().get("branch:r:mutated")).toBeUndefined();
  });
});

describe("WP-109: canon stores in the recovery composition", () => {
  it("opens the intent ledger and fact store under the writer lock and closes them with the state", () => {
    const dir = tempDir();
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    const github = new FakeGitHub(join(dir, "github.json"));

    const state = openRecoveredState(stateDir, { github });
    state.canonLedger.proposeRequirement("CAM-DEMO-01", {
      statement: "recovered intent survives",
      sourceMissionId: "mission-1",
    });
    state.canonLedger.acceptRequirement("CAM-DEMO-01");
    state.canonFacts.recordFact({
      requirementId: "CAM-DEMO-01",
      kind: "landed-on-main",
      actor: "camino:merge",
      payload: { sha: SHA_A },
    });
    state.close();

    // Everything durable survives the next recovery cycle, and the
    // fail-closed adoption paths (verifyLedgerLog / verifyCanonFactLog)
    // ran inside the constructors on the way back up.
    const again = openRecoveredState(stateDir, { github });
    expect(again.canonLedger.entry("CAM-DEMO-01")?.disposition).toBe("accepted");
    expect(again.canonFacts.read()).toHaveLength(1);
    again.close();
  });

  it("canon appends assert the SAME lock the composition acquired", () => {
    const dir = tempDir();
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    const github = new FakeGitHub(join(dir, "github.json"));
    const state = openRecoveredState(stateDir, { github });
    // Sabotage exactly what a daemon bug could: release the lock while
    // holding store handles. Every canon write must refuse loudly.
    state.lock.release();
    expect(() =>
      state.canonLedger.proposeRequirement("CAM-DEMO-01", {
        statement: "s",
        sourceMissionId: "m1",
      }),
    ).toThrow(/writer lock/);
    expect(() =>
      state.canonFacts.recordFact({
        requirementId: "CAM-DEMO-01",
        kind: "landed-on-main",
        actor: "camino:merge",
        payload: { sha: SHA_A },
      }),
    ).toThrow(/writer lock/);
    state.eventStore.close();
    state.journal.close();
    state.canonLedger.close();
    state.canonFacts.close();
  });

  it("a refused canon store open releases the lock and closes the earlier stores (ctor-cleanup chain)", () => {
    const dir = tempDir();
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    const github = new FakeGitHub(join(dir, "github.json"));
    openRecoveredState(stateDir, { github }).close();

    // Corrupt the LAST store in the open order: everything before it
    // must be unwound by the catch path.
    const raw = new Database(join(stateDir, STATE_FILES.canonFacts));
    raw.pragma("user_version = 9");
    raw.close();
    expect(() => openRecoveredState(stateDir, { github })).toThrow(/schema version 9/);

    // The lock was released by the cleanup chain: acquiring it directly
    // succeeds (a leaked lock would refuse instantly, WP-104 contract).
    const lock = WriterLock.acquire(join(stateDir, STATE_FILES.writerLock));
    lock.release();
  });
});
