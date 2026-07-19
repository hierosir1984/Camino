/**
 * decideReconciliation (WP-104): every verdict branch of every §4.4
 * operation class, exercised as the pure function — the daemon's recovery
 * and the chaos suite ride these same branches through I/O.
 */
import { describe, expect, it } from "vitest";
import type { ExternalOperationSpec, IntentStatus, ObservedPullRequest } from "@camino/shared";
import { decideReconciliation, ReconcileFactsMismatchError } from "./reconcile.js";
import type { IntentSnapshot } from "./reconcile.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function snapshot(
  spec: ExternalOperationSpec,
  status: IntentStatus = "execution-started",
): IntentSnapshot {
  return { intentId: "intent-1", status, spec };
}

const branchSpec: ExternalOperationSpec = {
  op: "branch-create",
  repo: "r",
  branch: "camino/issue-1",
  targetSha: SHA_A,
};

describe("status routing (total over every status)", () => {
  it("recorded → pending-execution (the barrier proves the call never happened)", () => {
    const verdict = decideReconciliation(snapshot(branchSpec, "recorded"), {
      op: "branch-create",
      branchSha: null,
    });
    expect(verdict.kind).toBe("pending-execution");
  });

  it("ambiguity-recorded → complete-escalation", () => {
    const verdict = decideReconciliation(snapshot(branchSpec, "ambiguity-recorded"), {
      op: "branch-create",
      branchSha: null,
    });
    expect(verdict.kind).toBe("complete-escalation");
  });

  it("escalated → awaiting-human", () => {
    const verdict = decideReconciliation(snapshot(branchSpec, "escalated"), {
      op: "branch-create",
      branchSha: null,
    });
    expect(verdict.kind).toBe("awaiting-human");
  });

  it.each(["confirmed", "failed", "abandoned"] as const)("%s → already-resolved", (status) => {
    const verdict = decideReconciliation(snapshot(branchSpec, status), {
      op: "branch-create",
      branchSha: null,
    });
    expect(verdict.kind).toBe("already-resolved");
  });

  it("refuses facts whose class does not match the recorded intent", () => {
    expect(() => decideReconciliation(snapshot(branchSpec), { op: "push", refSha: null })).toThrow(
      ReconcileFactsMismatchError,
    );
  });
});

describe("branch-create (natural key + state query)", () => {
  it("branch at the intended SHA → confirmed-external", () => {
    const verdict = decideReconciliation(snapshot(branchSpec), {
      op: "branch-create",
      branchSha: SHA_A,
    });
    expect(verdict).toMatchObject({
      kind: "confirmed-external",
      result: { branch: "camino/issue-1", sha: SHA_A },
    });
  });

  it("branch absent → re-arm (no reset)", () => {
    const verdict = decideReconciliation(snapshot(branchSpec), {
      op: "branch-create",
      branchSha: null,
    });
    expect(verdict).toMatchObject({ kind: "re-arm", resetBeforeUse: false });
  });

  it("branch at a different SHA → ambiguous (collision, never overwritten)", () => {
    const verdict = decideReconciliation(snapshot(branchSpec), {
      op: "branch-create",
      branchSha: SHA_B,
    });
    expect(verdict.kind).toBe("ambiguous");
  });
});

describe("push (intended SHA in the intent event)", () => {
  const pushSpec: ExternalOperationSpec = {
    op: "push",
    repo: "r",
    ref: "camino/issue-1",
    intendedSha: SHA_B,
    expectedBaseSha: SHA_A,
  };

  it("ref at the intended SHA → confirmed-external", () => {
    expect(decideReconciliation(snapshot(pushSpec), { op: "push", refSha: SHA_B }).kind).toBe(
      "confirmed-external",
    );
  });

  it("ref still at the recorded base → re-arm", () => {
    expect(decideReconciliation(snapshot(pushSpec), { op: "push", refSha: SHA_A })).toMatchObject({
      kind: "re-arm",
      resetBeforeUse: false,
    });
  });

  it("ref at a third SHA → ambiguous (out-of-band move; never force-pushed)", () => {
    expect(decideReconciliation(snapshot(pushSpec), { op: "push", refSha: SHA_C }).kind).toBe(
      "ambiguous",
    );
  });

  it("ref deleted → ambiguous", () => {
    expect(decideReconciliation(snapshot(pushSpec), { op: "push", refSha: null }).kind).toBe(
      "ambiguous",
    );
  });
});

describe("pr-create (branch key primary, UUID corroborates)", () => {
  const marker = "camino-intent:intent-1";
  const prSpec: ExternalOperationSpec = {
    op: "pr-create",
    repo: "r",
    headBranch: "camino/issue-1",
    baseBranch: "main",
    title: "t",
    bodyMarker: marker,
    body: `body ${marker}`,
  };
  const pr = (number: number, state: "open" | "closed", body: string): ObservedPullRequest => ({
    number,
    state,
    headBranch: "camino/issue-1",
    body,
  });

  it("one open PR carrying the marker → confirmed, corroborated", () => {
    const verdict = decideReconciliation(snapshot(prSpec), {
      op: "pr-create",
      pullRequests: [pr(5, "open", `hello ${marker}`)],
    });
    expect(verdict).toMatchObject({
      kind: "confirmed-external",
      result: { prNumber: 5, corroborated: true },
    });
  });

  it("one open PR without the marker → confirmed, uncorroborated (bodies are mutable)", () => {
    const verdict = decideReconciliation(snapshot(prSpec), {
      op: "pr-create",
      pullRequests: [pr(5, "open", "body was edited")],
    });
    expect(verdict).toMatchObject({
      kind: "confirmed-external",
      result: { prNumber: 5, corroborated: false },
    });
  });

  it("marker singles one out among several open PRs → confirmed", () => {
    const verdict = decideReconciliation(snapshot(prSpec), {
      op: "pr-create",
      pullRequests: [pr(5, "open", "other"), pr(6, "open", `mine ${marker}`)],
    });
    expect(verdict).toMatchObject({
      kind: "confirmed-external",
      result: { prNumber: 6, corroborated: true },
    });
  });

  it("no PRs at all → re-arm", () => {
    const verdict = decideReconciliation(snapshot(prSpec), {
      op: "pr-create",
      pullRequests: [],
    });
    expect(verdict).toMatchObject({ kind: "re-arm" });
  });

  it("ANY closed PR on the head branch → ambiguous (closed/reused-branch escalation class)", () => {
    const verdict = decideReconciliation(snapshot(prSpec), {
      op: "pr-create",
      pullRequests: [pr(3, "closed", `even carrying ${marker}`)],
    });
    expect(verdict.kind).toBe("ambiguous");
  });

  it("a closed PR escalates even beside a marker-carrying open PR", () => {
    const verdict = decideReconciliation(snapshot(prSpec), {
      op: "pr-create",
      pullRequests: [pr(3, "closed", "old"), pr(5, "open", `mine ${marker}`)],
    });
    expect(verdict.kind).toBe("ambiguous");
  });

  it("several open PRs, marker in none → ambiguous", () => {
    const verdict = decideReconciliation(snapshot(prSpec), {
      op: "pr-create",
      pullRequests: [pr(5, "open", "a"), pr(6, "open", "b")],
    });
    expect(verdict.kind).toBe("ambiguous");
  });

  it("several open PRs, marker in more than one → ambiguous", () => {
    const verdict = decideReconciliation(snapshot(prSpec), {
      op: "pr-create",
      pullRequests: [pr(5, "open", marker), pr(6, "open", marker)],
    });
    expect(verdict.kind).toBe("ambiguous");
  });
});

describe("merge-by-push (ref-state idempotence)", () => {
  const mergeSpec: ExternalOperationSpec = {
    op: "merge-by-push",
    repo: "r",
    targetRef: "main",
    mergeSha: SHA_B,
    expectedBaseSha: SHA_A,
  };

  it("target at/past the merge commit → confirmed-external", () => {
    const verdict = decideReconciliation(snapshot(mergeSpec), {
      op: "merge-by-push",
      targetAtOrPastMerge: true,
      targetSha: SHA_C,
    });
    expect(verdict.kind).toBe("confirmed-external");
  });

  it("target still at the expected base → re-arm", () => {
    const verdict = decideReconciliation(snapshot(mergeSpec), {
      op: "merge-by-push",
      targetAtOrPastMerge: false,
      targetSha: SHA_A,
    });
    expect(verdict).toMatchObject({ kind: "re-arm", resetBeforeUse: false });
  });

  it("target moved past the base without the merge → failed-terminal (superseded)", () => {
    const verdict = decideReconciliation(snapshot(mergeSpec), {
      op: "merge-by-push",
      targetAtOrPastMerge: false,
      targetSha: SHA_C,
    });
    expect(verdict.kind).toBe("failed-terminal");
  });

  it("target ref absent → failed-terminal", () => {
    const verdict = decideReconciliation(snapshot(mergeSpec), {
      op: "merge-by-push",
      targetAtOrPastMerge: false,
      targetSha: null,
    });
    expect(verdict.kind).toBe("failed-terminal");
  });
});

describe("label-set (desired state, naturally idempotent)", () => {
  const labelSpec: ExternalOperationSpec = {
    op: "label-set",
    repo: "r",
    targetKind: "issue",
    targetNumber: 7,
    label: "l",
    desired: "present",
  };

  it("observed equals desired → confirmed-external", () => {
    expect(
      decideReconciliation(snapshot(labelSpec), { op: "label-set", labelPresent: true }).kind,
    ).toBe("confirmed-external");
  });

  it("observed differs → re-arm (re-apply is idempotent)", () => {
    expect(
      decideReconciliation(snapshot(labelSpec), { op: "label-set", labelPresent: false }),
    ).toMatchObject({ kind: "re-arm" });
  });

  it("desired absent works symmetrically", () => {
    const absentSpec: ExternalOperationSpec = { ...labelSpec, desired: "absent" };
    expect(
      decideReconciliation(snapshot(absentSpec), { op: "label-set", labelPresent: false }).kind,
    ).toBe("confirmed-external");
    expect(
      decideReconciliation(snapshot(absentSpec), { op: "label-set", labelPresent: true }).kind,
    ).toBe("re-arm");
  });
});

describe("comment-post (embedded UUID marker)", () => {
  const commentSpec: ExternalOperationSpec = {
    op: "comment-post",
    repo: "r",
    targetKind: "issue",
    targetNumber: 7,
    body: "b camino-intent:intent-1",
    marker: "camino-intent:intent-1",
  };

  it("marker found → confirmed-external with the comment id", () => {
    const verdict = decideReconciliation(snapshot(commentSpec), {
      op: "comment-post",
      comment: { commentId: 42 },
    });
    expect(verdict).toMatchObject({ kind: "confirmed-external", result: { commentId: 42 } });
  });

  it("marker absent → re-arm", () => {
    expect(
      decideReconciliation(snapshot(commentSpec), { op: "comment-post", comment: null }),
    ).toMatchObject({ kind: "re-arm" });
  });
});

describe("workflow-dispatch (at-most-once; correlation presence conclusive, absence not)", () => {
  const dispatchSpec: ExternalOperationSpec = {
    op: "workflow-dispatch",
    repo: "r",
    workflow: "w.yml",
    ref: "main",
    correlationId: "intent-1",
  };

  it("a correlated run exists → confirmed-external (presence proves our dispatch)", () => {
    const verdict = decideReconciliation(snapshot(dispatchSpec), {
      op: "workflow-dispatch",
      runs: [{ runId: 9, runName: "w.yml [camino_intent_id=intent-1]" }],
    });
    expect(verdict).toMatchObject({
      kind: "confirmed-external",
      result: { runId: 9, correlatedRuns: 1 },
    });
  });

  it("several correlated runs → still confirmed, count recorded honestly", () => {
    const verdict = decideReconciliation(snapshot(dispatchSpec), {
      op: "workflow-dispatch",
      runs: [
        { runId: 9, runName: "w.yml [camino_intent_id=intent-1]" },
        { runId: 10, runName: "w.yml [camino_intent_id=intent-1]" },
      ],
    });
    expect(verdict).toMatchObject({
      kind: "confirmed-external",
      result: { correlatedRuns: 2 },
    });
  });

  it("no correlated run → ambiguous, never re-arm (absence proves nothing)", () => {
    const verdict = decideReconciliation(snapshot(dispatchSpec), {
      op: "workflow-dispatch",
      runs: [],
    });
    expect(verdict.kind).toBe("ambiguous");
  });
});

describe("test-service-mutation (environment is the idempotency unit)", () => {
  it("resettable → re-arm WITH reset-before-use", () => {
    const verdict = decideReconciliation(
      snapshot({
        op: "test-service-mutation",
        environmentId: "env",
        mutation: "seed",
        irreversible: false,
      }),
      { op: "test-service-mutation" },
    );
    expect(verdict).toMatchObject({ kind: "re-arm", resetBeforeUse: true });
  });

  it("irreversible → ambiguous (reset cannot unsend; never auto-retried)", () => {
    const verdict = decideReconciliation(
      snapshot({
        op: "test-service-mutation",
        environmentId: "env",
        mutation: "send-email",
        irreversible: true,
      }),
      { op: "test-service-mutation" },
    );
    expect(verdict.kind).toBe("ambiguous");
  });
});

describe("catch-all (at-most-once, durable ambiguity, escalation)", () => {
  it("always ambiguous in the window — there is no key to reconcile by", () => {
    const verdict = decideReconciliation(
      snapshot({ op: "catch-all", description: "one-off effect" }),
      { op: "catch-all" },
    );
    expect(verdict.kind).toBe("ambiguous");
  });
});
