/**
 * Knowledge lifecycle fold tests (WP-113, CAM-CANON-09): candidate recording,
 * observation tallies, deterministic + human promotion, contradiction
 * escalation, resolution/invalidation, visibility, and append validation —
 * each behavior named so a failing it() states the invariant it guards.
 */
import { describe, expect, it } from "vitest";
import type {
  KnowledgeAppendInput,
  KnowledgeEntryInput,
  KnowledgeEventName,
  KnowledgeEventRecord,
  KnowledgePromotionAuthority,
} from "@camino/shared";
import {
  emptyKnowledgeView,
  foldKnowledge,
  knowledgeAppendProblems,
  knowledgeClaimsConflict,
  knowledgeCurationQueue,
  standingApprovedConflicts,
  visibleKnowledgeFor,
} from "./knowledge.js";
import { DAVID_ACTOR } from "./intent-lifecycle.js";

const T0 = "2026-07-01T00:00:00.000Z";
const T1 = "2026-07-02T00:00:00.000Z";
const T2 = "2026-07-03T00:00:00.000Z";
const EXPIRES_FAR = "2026-12-31T00:00:00.000Z";
const EXPIRES_NEAR = "2026-07-01T12:00:00.000Z";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const CMD = "npm test";

function makeEntry(overrides: Partial<KnowledgeEntryInput> = {}): KnowledgeEntryInput {
  return {
    entryId: "k-1",
    entryClass: "command",
    subjectKey: CMD,
    claim: "succeeds",
    text: "npm test succeeds in CI",
    scope: { kind: "global" },
    expiresAt: EXPIRES_FAR,
    provenance: {
      missionId: "m-1",
      issueId: "m-1.i-1",
      attemptId: "a-1",
      context: "observed during attempt",
    },
    validity: { commitSha: SHA_A, baseSha: SHA_B },
    ...overrides,
  };
}

function rec(
  seq: number,
  event: KnowledgeEventName,
  payload: Readonly<Record<string, unknown>>,
  actor: string = DAVID_ACTOR,
  recordedAt: string = T0,
): KnowledgeEventRecord {
  return { seq, recordedAt, event, actor, payload };
}

function observe(
  seq: number,
  commandKey: string,
  missionId: string,
  attemptId: string,
  succeeded: boolean,
  recordedAt: string = T0,
  validity: { commitSha: string; baseSha: string } = { commitSha: SHA_A, baseSha: SHA_B },
): KnowledgeEventRecord {
  return rec(
    seq,
    "command-observation",
    { commandKey, missionId, attemptId, succeeded, ...validity },
    "camino:dispatcher",
    recordedAt,
  );
}

function quarantine(
  seq: number,
  testId: string,
  missionId: string,
  reference: string,
  validity: { commitSha: string; baseSha: string } = { commitSha: SHA_A, baseSha: SHA_B },
): KnowledgeEventRecord {
  return rec(
    seq,
    "quarantine-confirmation",
    { testId, missionId, reference, ...validity },
    "camino:quarantine",
  );
}

function promote(
  seq: number,
  entryId: string,
  authority: KnowledgePromotionAuthority,
  actor: string = DAVID_ACTOR,
  recordedAt: string = T0,
): KnowledgeEventRecord {
  return rec(seq, "entry-promoted", { entryId, authority }, actor, recordedAt);
}

function candidateRec(
  seq: number,
  entry: KnowledgeEntryInput,
  recordedAt: string = T0,
): KnowledgeEventRecord {
  return rec(seq, "candidate-recorded", { entry }, "camino:attempt", recordedAt);
}

function problemsOf(
  records: readonly KnowledgeEventRecord[],
  input: KnowledgeAppendInput,
  atIso: string = T0,
): string[] {
  return knowledgeAppendProblems(foldKnowledge(records), input, atIso);
}

describe("foldKnowledge — candidate recording", () => {
  it("candidate-recorded folds to a candidate snapshot with null promotion", () => {
    const entry = makeEntry();
    const view = foldKnowledge([candidateRec(1, entry)]);
    const snap = view.entries.get("k-1");
    expect(snap).toEqual({
      entry,
      state: "candidate",
      recordedSeq: 1,
      recordedAt: T0,
      promotion: null,
      resolution: null,
      invalidation: null,
    });
    expect(view.lastSeq).toBe(1);
  });
});

describe("foldKnowledge — append validation at fold", () => {
  it("duplicate entryId is named by knowledgeAppendProblems and throws in foldKnowledge", () => {
    const entry = makeEntry();
    const prior = [candidateRec(1, entry)];
    const dupInput: KnowledgeAppendInput = {
      event: "candidate-recorded",
      actor: "camino:attempt",
      payload: { entry: makeEntry({ entryId: "k-1", text: "other" }) },
    };
    const problems = problemsOf(prior, dupInput, T1);
    expect(problems.some((p) => p.includes("already exists"))).toBe(true);

    expect(() =>
      foldKnowledge([candidateRec(1, entry), candidateRec(2, makeEntry({ text: "other" }), T1)]),
    ).toThrow(/already exists/);
  });

  it("born-expired candidate (expiresAt <= recordedAt) is refused", () => {
    const entry = makeEntry({ expiresAt: T0 });
    const input: KnowledgeAppendInput = {
      event: "candidate-recorded",
      actor: "camino:attempt",
      payload: { entry },
    };
    const problems = knowledgeAppendProblems(emptyKnowledgeView(), input, T0);
    expect(problems.some((p) => p.includes("born expired"))).toBe(true);
    expect(() => foldKnowledge([candidateRec(1, entry, T0)])).toThrow(/born expired/);
  });
});

describe("foldKnowledge — command-observation tallies", () => {
  it("counts successes and failures separately; missionsWithSuccess is distinct and sorted; failures do not add missions", () => {
    const view = foldKnowledge([
      observe(1, CMD, "m-z", "a-1", true),
      observe(2, CMD, "m-a", "a-2", true),
      observe(3, CMD, "m-z", "a-3", true),
      observe(4, CMD, "m-fail", "a-4", false),
      observe(5, CMD, "m-fail", "a-5", false),
    ]);
    const tally = view.commandTallies.get(CMD);
    expect(tally).toEqual({
      successes: 3,
      failures: 2,
      missionsWithSuccess: ["m-a", "m-z"],
    });
    expect(tally?.missionsWithSuccess).not.toContain("m-fail");
  });
});

describe("promotion rules — rule-command-success", () => {
  it("promotes at the boundary of 3 successes across 2 missions and records authority + actor + seq", () => {
    const entry = makeEntry({ entryId: "k-cmd" });
    const records = [
      candidateRec(1, entry),
      observe(2, CMD, "m-1", "a-1", true),
      observe(3, CMD, "m-1", "a-2", true),
      observe(4, CMD, "m-2", "a-3", true),
      promote(5, "k-cmd", { kind: "rule-command-success" }, "camino:rule", T1),
    ];
    const view = foldKnowledge(records);
    const snap = view.entries.get("k-cmd");
    expect(snap?.state).toBe("approved");
    expect(snap?.promotion).toEqual({
      authority: { kind: "rule-command-success" },
      actor: "camino:rule",
      seq: 5,
      recordedAt: T1,
    });
  });

  it("refuses 3 successes in 1 mission", () => {
    const entry = makeEntry({ entryId: "k-cmd" });
    const prior = [
      candidateRec(1, entry),
      observe(2, CMD, "m-only", "a-1", true),
      observe(3, CMD, "m-only", "a-2", true),
      observe(4, CMD, "m-only", "a-3", true),
    ];
    const problems = problemsOf(prior, {
      event: "entry-promoted",
      actor: "camino:rule",
      payload: { entryId: "k-cmd", authority: { kind: "rule-command-success" } },
    });
    expect(problems.some((p) => /1\/2 missions/.test(p) || p.includes("1/2 missions"))).toBe(true);
  });

  it("refuses 2 successes across 2 missions", () => {
    const entry = makeEntry({ entryId: "k-cmd" });
    const prior = [
      candidateRec(1, entry),
      observe(2, CMD, "m-1", "a-1", true),
      observe(3, CMD, "m-2", "a-2", true),
    ];
    const problems = problemsOf(prior, {
      event: "entry-promoted",
      actor: "camino:rule",
      payload: { entryId: "k-cmd", authority: { kind: "rule-command-success" } },
    });
    expect(problems.some((p) => p.includes("2/3 successes"))).toBe(true);
  });

  it("refuses rule-command-success for a note entry", () => {
    const entry = makeEntry({
      entryId: "k-note",
      entryClass: "note",
      subjectKey: null,
      claim: "useful context",
      text: "a free-form note",
    });
    const prior = [candidateRec(1, entry)];
    const problems = problemsOf(prior, {
      event: "entry-promoted",
      actor: "camino:rule",
      payload: { entryId: "k-note", authority: { kind: "rule-command-success" } },
    });
    expect(
      problems.some((p) => p.includes("applies only to command entries claiming succeeds")),
    ).toBe(true);
  });

  it("refuses rule-command-success for a command entry claiming fails", () => {
    const entry = makeEntry({ entryId: "k-fail", claim: "fails", text: "npm test fails" });
    const prior = [
      candidateRec(1, entry),
      observe(2, CMD, "m-1", "a-1", true),
      observe(3, CMD, "m-1", "a-2", true),
      observe(4, CMD, "m-2", "a-3", true),
    ];
    const problems = problemsOf(prior, {
      event: "entry-promoted",
      actor: "camino:rule",
      payload: { entryId: "k-fail", authority: { kind: "rule-command-success" } },
    });
    expect(problems.some((p) => p.includes("claiming fails"))).toBe(true);
  });
});

describe("promotion rules — rule-quarantine-flaky", () => {
  const flakyEntry = (): KnowledgeEntryInput =>
    makeEntry({
      entryId: "k-flaky",
      entryClass: "flaky-test",
      subjectKey: "suite::test-id",
      claim: "flaky",
      text: "suite::test-id is flaky",
    });

  it("refuses promotion without a quarantine confirmation", () => {
    const prior = [candidateRec(1, flakyEntry())];
    const problems = problemsOf(prior, {
      event: "entry-promoted",
      actor: "camino:rule",
      payload: { entryId: "k-flaky", authority: { kind: "rule-quarantine-flaky" } },
    });
    expect(problems.some((p) => p.includes("no quarantine confirmation"))).toBe(true);
  });

  it("succeeds after quarantine-confirmation for the same testId", () => {
    const view = foldKnowledge([
      candidateRec(1, flakyEntry()),
      quarantine(2, "suite::test-id", "m-1", "q-ref-1"),
      promote(3, "k-flaky", { kind: "rule-quarantine-flaky" }, "camino:rule", T1),
    ]);
    expect(view.entries.get("k-flaky")?.state).toBe("approved");
    expect(view.entries.get("k-flaky")?.promotion?.authority).toEqual({
      kind: "rule-quarantine-flaky",
    });
  });

  it("refuses claim stable even with confirmation on record", () => {
    const entry = makeEntry({
      entryId: "k-stable",
      entryClass: "flaky-test",
      subjectKey: "suite::test-id",
      claim: "stable",
      text: "suite::test-id is stable",
    });
    const prior = [candidateRec(1, entry), quarantine(2, "suite::test-id", "m-1", "q-ref-1")];
    const problems = problemsOf(prior, {
      event: "entry-promoted",
      actor: "camino:rule",
      payload: { entryId: "k-stable", authority: { kind: "rule-quarantine-flaky" } },
    });
    expect(
      problems.some((p) => p.includes("applies only to flaky-test entries claiming flaky")),
    ).toBe(true);
  });
});

describe("promotion rules — human-batch", () => {
  it("refuses actor other than david", () => {
    const prior = [candidateRec(1, makeEntry())];
    const problems = problemsOf(prior, {
      event: "entry-promoted",
      actor: "camino:bot",
      payload: { entryId: "k-1", authority: { kind: "human-batch", batchId: "batch-1" } },
    });
    expect(problems.some((p) => p.includes(`requires actor ${DAVID_ACTOR}`))).toBe(true);
  });

  it("david succeeds with a human-batch authority", () => {
    const view = foldKnowledge([
      candidateRec(1, makeEntry()),
      promote(2, "k-1", { kind: "human-batch", batchId: "batch-1" }, DAVID_ACTOR, T1),
    ]);
    expect(view.entries.get("k-1")?.state).toBe("approved");
    expect(view.entries.get("k-1")?.promotion).toMatchObject({
      authority: { kind: "human-batch", batchId: "batch-1" },
      actor: DAVID_ACTOR,
      seq: 2,
    });
  });

  it("refuses missing or empty batchId", () => {
    const prior = [candidateRec(1, makeEntry())];
    const emptyBatch = problemsOf(prior, {
      event: "entry-promoted",
      actor: DAVID_ACTOR,
      payload: { entryId: "k-1", authority: { kind: "human-batch", batchId: "" } },
    });
    expect(emptyBatch.some((p) => p.includes("authority.batchId"))).toBe(true);

    const missingBatch = problemsOf(prior, {
      event: "entry-promoted",
      actor: DAVID_ACTOR,
      payload: { entryId: "k-1", authority: { kind: "human-batch" } },
    });
    expect(missingBatch.some((p) => p.includes("authority.batchId"))).toBe(true);
  });
});

describe("promotion rules — state and expiry gates", () => {
  it("refuses promoting a non-candidate (already approved; rejected)", () => {
    const approved = foldKnowledge([
      candidateRec(1, makeEntry()),
      promote(2, "k-1", { kind: "human-batch", batchId: "b1" }),
    ]);
    const rePromote: KnowledgeAppendInput = {
      event: "entry-promoted",
      actor: DAVID_ACTOR,
      payload: { entryId: "k-1", authority: { kind: "human-batch", batchId: "b2" } },
    };
    expect(
      knowledgeAppendProblems(approved, rePromote, T1).some((p) =>
        p.includes("is approved, not a candidate"),
      ),
    ).toBe(true);

    const rejected = foldKnowledge([
      candidateRec(1, makeEntry({ entryId: "k-2" })),
      rec(2, "entry-rejected", { entryId: "k-2", reason: "noise" }, DAVID_ACTOR, T1),
    ]);
    expect(
      knowledgeAppendProblems(
        rejected,
        {
          event: "entry-promoted",
          actor: DAVID_ACTOR,
          payload: { entryId: "k-2", authority: { kind: "human-batch", batchId: "b3" } },
        },
        T2,
      ).some((p) => p.includes("is rejected, not a candidate")),
    ).toBe(true);
  });

  it("refuses promoting an entry whose expiresAt <= promotion recordedAt", () => {
    const entry = makeEntry({ expiresAt: EXPIRES_NEAR });
    const prior = [candidateRec(1, entry, T0)];
    const problems = problemsOf(
      prior,
      {
        event: "entry-promoted",
        actor: DAVID_ACTOR,
        payload: { entryId: "k-1", authority: { kind: "human-batch", batchId: "b1" } },
      },
      EXPIRES_NEAR,
    );
    expect(problems.some((p) => p.includes("expired") && p.includes("promoting"))).toBe(true);
  });
});

describe("contradiction escalation", () => {
  function approvedAndConflictingCandidate(): KnowledgeEventRecord[] {
    const approved = makeEntry({
      entryId: "k-approved",
      claim: "succeeds",
      text: "approved claim",
    });
    const candidate = makeEntry({
      entryId: "k-cand",
      claim: "fails",
      text: "conflicting claim",
      provenance: {
        missionId: "m-2",
        issueId: "m-2.i-1",
        attemptId: "a-9",
        context: "sibling observation",
      },
    });
    return [
      candidateRec(1, approved),
      promote(2, "k-approved", { kind: "human-batch", batchId: "b1" }),
      candidateRec(3, candidate, T1),
    ];
  }

  it("blocks promotion under every authority while a standing approved conflict exists", () => {
    const prior = approvedAndConflictingCandidate();
    const humanProblems = problemsOf(prior, {
      event: "entry-promoted",
      actor: DAVID_ACTOR,
      payload: { entryId: "k-cand", authority: { kind: "human-batch", batchId: "b2" } },
    });
    expect(humanProblems.some((p) => p.includes("contradicts standing approved"))).toBe(true);

    const ruleProblems = problemsOf(
      [
        ...prior,
        observe(4, CMD, "m-1", "a-1", true, T1),
        observe(5, CMD, "m-1", "a-2", true, T1),
        observe(6, CMD, "m-2", "a-3", true, T1),
      ],
      {
        event: "entry-promoted",
        actor: "camino:rule",
        payload: { entryId: "k-cand", authority: { kind: "rule-command-success" } },
      },
      T2,
    );
    // claim is "fails" so rule also refuses class/claim — force a succeeds candidate
    // against standing fails approved to hit contradiction under the rule path.
    const standingFails = [
      candidateRec(1, makeEntry({ entryId: "k-approved", claim: "fails", text: "fails" })),
      promote(2, "k-approved", { kind: "human-batch", batchId: "b1" }),
      candidateRec(3, makeEntry({ entryId: "k-cand", claim: "succeeds", text: "succeeds" }), T1),
      observe(4, CMD, "m-1", "a-1", true, T1),
      observe(5, CMD, "m-1", "a-2", true, T1),
      observe(6, CMD, "m-2", "a-3", true, T1),
    ];
    const ruleContra = problemsOf(
      standingFails,
      {
        event: "entry-promoted",
        actor: "camino:rule",
        payload: { entryId: "k-cand", authority: { kind: "rule-command-success" } },
      },
      T2,
    );
    expect(ruleContra.some((p) => p.includes("contradicts standing approved"))).toBe(true);
    expect(ruleProblems.some((p) => p.includes("contradicts standing approved"))).toBe(true);
  });

  it("knowledgeCurationQueue and standingApprovedConflicts surface the conflict pair", () => {
    const view = foldKnowledge(approvedAndConflictingCandidate());
    expect(knowledgeCurationQueue(view, T2)).toEqual([
      { candidateId: "k-cand", approvedEntryId: "k-approved" },
    ]);
    const cand = view.entries.get("k-cand")?.entry;
    expect(cand).toBeDefined();
    if (cand !== undefined) {
      expect(standingApprovedConflicts(view, cand, T2)).toEqual(["k-approved"]);
    }
  });

  it("knowledgeClaimsConflict is false for different subjectKeys, classes, null subjects, same claim", () => {
    const base = makeEntry();
    expect(
      knowledgeClaimsConflict(base, makeEntry({ subjectKey: "other-cmd", claim: "fails" })),
    ).toBe(false);
    expect(
      knowledgeClaimsConflict(
        base,
        makeEntry({
          entryClass: "flaky-test",
          subjectKey: CMD,
          claim: "flaky",
          text: "not a command",
        }),
      ),
    ).toBe(false);
    expect(
      knowledgeClaimsConflict(
        makeEntry({ entryClass: "note", subjectKey: null, claim: "a", text: "a" }),
        makeEntry({ entryClass: "note", subjectKey: null, claim: "b", text: "b" }),
      ),
    ).toBe(false);
    expect(knowledgeClaimsConflict(base, makeEntry({ claim: "succeeds", text: "same" }))).toBe(
      false,
    );
    expect(knowledgeClaimsConflict(base, makeEntry({ claim: "fails", text: "diff" }))).toBe(true);
  });
});

describe("invalidation and unblocking after retirement/revert", () => {
  it("after entry-retired retires the approved entry, the same promotion succeeds and the queue is empty", () => {
    const records = [
      candidateRec(1, makeEntry({ entryId: "k-approved", claim: "succeeds" })),
      promote(2, "k-approved", { kind: "human-batch", batchId: "b1" }),
      candidateRec(3, makeEntry({ entryId: "k-cand", claim: "fails", text: "fails instead" }), T1),
      rec(4, "entry-retired", { entryId: "k-approved", reason: "superseded" }, DAVID_ACTOR, T1),
      promote(5, "k-cand", { kind: "human-batch", batchId: "b2" }, DAVID_ACTOR, T2),
    ];
    const view = foldKnowledge(records);
    expect(view.entries.get("k-approved")?.state).toBe("retired");
    expect(view.entries.get("k-cand")?.state).toBe("approved");
    expect(knowledgeCurationQueue(view, T2)).toEqual([]);
  });

  it("validity-base-reverted invalidating the approved entry also unblocks promotion", () => {
    const records = [
      candidateRec(
        1,
        makeEntry({
          entryId: "k-approved",
          claim: "succeeds",
          validity: { commitSha: SHA_A, baseSha: SHA_B },
        }),
      ),
      promote(2, "k-approved", { kind: "human-batch", batchId: "b1" }),
      candidateRec(
        3,
        makeEntry({
          entryId: "k-cand",
          claim: "fails",
          text: "fails",
          validity: { commitSha: SHA_C, baseSha: SHA_C },
        }),
        T1,
      ),
      rec(4, "validity-base-reverted", { revertedSha: SHA_A }, "camino:git", T1),
      promote(5, "k-cand", { kind: "human-batch", batchId: "b2" }, DAVID_ACTOR, T2),
    ];
    const view = foldKnowledge(records);
    expect(view.entries.get("k-approved")?.state).toBe("invalidated");
    expect(view.entries.get("k-cand")?.state).toBe("approved");
    expect(knowledgeCurationQueue(view, T2)).toEqual([]);
  });
});

describe("entry-rejected and entry-retired", () => {
  it("entry-rejected moves candidate to rejected with resolution recorded", () => {
    const view = foldKnowledge([
      candidateRec(1, makeEntry()),
      rec(2, "entry-rejected", { entryId: "k-1", reason: "not general" }, DAVID_ACTOR, T1),
    ]);
    const snap = view.entries.get("k-1");
    expect(snap?.state).toBe("rejected");
    expect(snap?.resolution).toEqual({
      kind: "rejected",
      reason: "not general",
      actor: DAVID_ACTOR,
      seq: 2,
    });
  });

  it("entry-rejected is refused for approved entries and for actor != david", () => {
    const approved = [
      candidateRec(1, makeEntry()),
      promote(2, "k-1", { kind: "human-batch", batchId: "b1" }),
    ];
    expect(
      problemsOf(approved, {
        event: "entry-rejected",
        actor: DAVID_ACTOR,
        payload: { entryId: "k-1", reason: "nope" },
      }).some((p) => p.includes("not a candidate")),
    ).toBe(true);

    const cand = [candidateRec(1, makeEntry({ entryId: "k-2" }))];
    expect(
      problemsOf(cand, {
        event: "entry-rejected",
        actor: "camino:bot",
        payload: { entryId: "k-2", reason: "nope" },
      }).some((p) => p.includes("curation act") && p.includes(DAVID_ACTOR)),
    ).toBe(true);
  });

  it("entry-retired moves approved to retired; refused for candidates and non-david actors", () => {
    const view = foldKnowledge([
      candidateRec(1, makeEntry()),
      promote(2, "k-1", { kind: "human-batch", batchId: "b1" }),
      rec(3, "entry-retired", { entryId: "k-1", reason: "outdated" }, DAVID_ACTOR, T1),
    ]);
    expect(view.entries.get("k-1")?.state).toBe("retired");
    expect(view.entries.get("k-1")?.resolution).toMatchObject({
      kind: "retired",
      reason: "outdated",
      actor: DAVID_ACTOR,
      seq: 3,
    });

    const candOnly = [candidateRec(1, makeEntry({ entryId: "k-c" }))];
    expect(
      problemsOf(candOnly, {
        event: "entry-retired",
        actor: DAVID_ACTOR,
        payload: { entryId: "k-c", reason: "x" },
      }).some((p) => p.includes("not approved")),
    ).toBe(true);

    const approved = [
      candidateRec(1, makeEntry({ entryId: "k-a" })),
      promote(2, "k-a", { kind: "human-batch", batchId: "b1" }),
    ];
    expect(
      problemsOf(approved, {
        event: "entry-retired",
        actor: "other",
        payload: { entryId: "k-a", reason: "x" },
      }).some((p) => p.includes("curation act") && p.includes(DAVID_ACTOR)),
    ).toBe(true);
  });
});

describe("validity-base-reverted", () => {
  it("invalidates candidates and approved matching commitSha or baseSha; leaves others untouched", () => {
    const view = foldKnowledge([
      candidateRec(
        1,
        makeEntry({
          entryId: "k-commit",
          validity: { commitSha: SHA_A, baseSha: SHA_C },
        }),
      ),
      candidateRec(
        2,
        makeEntry({
          entryId: "k-base",
          subjectKey: "other",
          text: "base match",
          validity: { commitSha: SHA_C, baseSha: SHA_A },
        }),
        T0,
      ),
      candidateRec(
        3,
        makeEntry({
          entryId: "k-safe",
          subjectKey: "safe",
          text: "safe",
          validity: { commitSha: SHA_B, baseSha: SHA_B },
        }),
        T0,
      ),
      promote(4, "k-base", { kind: "human-batch", batchId: "b1" }),
      candidateRec(
        5,
        makeEntry({
          entryId: "k-reject-me",
          subjectKey: "rej",
          text: "will reject",
          validity: { commitSha: SHA_A, baseSha: SHA_B },
        }),
        T0,
      ),
      rec(6, "entry-rejected", { entryId: "k-reject-me", reason: "noise" }, DAVID_ACTOR, T1),
      rec(7, "validity-base-reverted", { revertedSha: SHA_A }, "camino:git", T2),
    ]);

    expect(view.entries.get("k-commit")?.state).toBe("invalidated");
    expect(view.entries.get("k-commit")?.invalidation).toEqual({
      revertedSha: SHA_A,
      seq: 7,
    });
    expect(view.entries.get("k-base")?.state).toBe("invalidated");
    expect(view.entries.get("k-base")?.invalidation).toEqual({
      revertedSha: SHA_A,
      seq: 7,
    });
    expect(view.entries.get("k-safe")?.state).toBe("candidate");
    expect(view.entries.get("k-safe")?.invalidation).toBeNull();
    expect(view.entries.get("k-reject-me")?.state).toBe("rejected");
    expect(view.entries.get("k-reject-me")?.invalidation).toBeNull();
  });
});

describe("visibility", () => {
  it("approved is visible to a reader from another mission/issue; candidates are same-issue only", () => {
    const view = foldKnowledge([
      candidateRec(
        1,
        makeEntry({
          entryId: "k-appr",
          provenance: {
            missionId: "m-A",
            issueId: "m-A.i-1",
            attemptId: "a-1",
            context: "from A",
          },
        }),
      ),
      promote(2, "k-appr", { kind: "human-batch", batchId: "b1" }),
      candidateRec(
        3,
        makeEntry({
          entryId: "k-cand-A",
          subjectKey: "cmd-a",
          text: "cand A",
          provenance: {
            missionId: "m-A",
            issueId: "m-A.i-1",
            attemptId: "a-2",
            context: "cand A",
          },
        }),
        T1,
      ),
      candidateRec(
        4,
        makeEntry({
          entryId: "k-cand-B",
          subjectKey: "cmd-b",
          text: "cand B",
          provenance: {
            missionId: "m-B",
            issueId: "m-B.i-1",
            attemptId: "a-3",
            context: "cand B",
          },
        }),
        T1,
      ),
    ]);

    const readerB = { missionId: "m-B", issueId: "m-B.i-1" };
    const visibleB = visibleKnowledgeFor(view, readerB, T2);
    expect(visibleB.map((v) => [v.snapshot.entry.entryId, v.visibility])).toEqual([
      ["k-appr", "approved"],
      ["k-cand-B", "same-issue-candidate"],
    ]);
    expect(visibleB.some((v) => v.snapshot.entry.entryId === "k-cand-A")).toBe(false);

    const readerA = { missionId: "m-A", issueId: "m-A.i-1" };
    const visibleA = visibleKnowledgeFor(view, readerA, T2);
    expect(visibleA.map((v) => v.snapshot.entry.entryId)).toEqual(["k-appr", "k-cand-A"]);
    expect(visibleA[1]?.visibility).toBe("same-issue-candidate");
  });

  it("rejected, retired, and invalidated entries are never visible; expired approved is omitted", () => {
    const view = foldKnowledge([
      candidateRec(1, makeEntry({ entryId: "k-rej", subjectKey: "c1", text: "rej" })),
      rec(2, "entry-rejected", { entryId: "k-rej", reason: "x" }, DAVID_ACTOR, T0),
      candidateRec(3, makeEntry({ entryId: "k-ret", subjectKey: "c2", text: "ret" }), T0),
      promote(4, "k-ret", { kind: "human-batch", batchId: "b1" }),
      rec(5, "entry-retired", { entryId: "k-ret", reason: "old" }, DAVID_ACTOR, T1),
      candidateRec(
        6,
        makeEntry({
          entryId: "k-inv",
          subjectKey: "c3",
          text: "inv",
          validity: { commitSha: SHA_A, baseSha: SHA_B },
        }),
        T0,
      ),
      promote(7, "k-inv", { kind: "human-batch", batchId: "b2" }, DAVID_ACTOR, T0),
      rec(8, "validity-base-reverted", { revertedSha: SHA_A }, "camino:git", T1),
      candidateRec(
        9,
        makeEntry({
          entryId: "k-exp",
          subjectKey: "c4",
          text: "exp",
          expiresAt: EXPIRES_NEAR,
          // Distinct base: SHA_A was reverted at seq 8, and a candidate on a
          // reverted base is now refused at append (r1 finding 8). This entry
          // exercises EXPIRY, not revert, so it carries an unreverted base.
          validity: { commitSha: SHA_C, baseSha: SHA_B },
        }),
        T0,
      ),
      promote(10, "k-exp", { kind: "human-batch", batchId: "b3" }, DAVID_ACTOR, T0),
    ]);
    const visible = visibleKnowledgeFor(
      view,
      { missionId: "m-1", issueId: "m-1.i-1" },
      "2026-07-02T00:00:00.000Z",
    );
    const ids = visible.map((v) => v.snapshot.entry.entryId);
    expect(ids).not.toContain("k-rej");
    expect(ids).not.toContain("k-ret");
    expect(ids).not.toContain("k-inv");
    expect(ids).not.toContain("k-exp");
  });

  it("orders approved then candidates by recordedSeq; malformed nowIso throws", () => {
    const view = foldKnowledge([
      candidateRec(1, makeEntry({ entryId: "k-a2", subjectKey: "s2", text: "second appr" })),
      candidateRec(2, makeEntry({ entryId: "k-a1", subjectKey: "s1", text: "first appr" })),
      promote(3, "k-a1", { kind: "human-batch", batchId: "b1" }),
      promote(4, "k-a2", { kind: "human-batch", batchId: "b2" }),
      candidateRec(5, makeEntry({ entryId: "k-c2", subjectKey: "s4", text: "cand late" }), T1),
      candidateRec(6, makeEntry({ entryId: "k-c1", subjectKey: "s3", text: "cand early" }), T1),
    ]);
    // recordedSeq order: k-a2 (1) then k-a1 (2) for approved; k-c2 (5) then k-c1 (6) for cands
    const visible = visibleKnowledgeFor(view, { missionId: "m-1", issueId: "m-1.i-1" }, T2);
    expect(visible.map((v) => v.snapshot.entry.entryId)).toEqual(["k-a2", "k-a1", "k-c2", "k-c1"]);
    expect(visible.map((v) => v.visibility)).toEqual([
      "approved",
      "approved",
      "same-issue-candidate",
      "same-issue-candidate",
    ]);

    expect(() =>
      visibleKnowledgeFor(view, { missionId: "m-1", issueId: "m-1.i-1" }, "not-a-time"),
    ).toThrow(/ISO-8601/);
  });
});

describe("foldKnowledge — malformed log", () => {
  it("throws on non-increasing seq and on an unknown event name", () => {
    expect(() =>
      foldKnowledge([
        candidateRec(1, makeEntry()),
        candidateRec(1, makeEntry({ entryId: "k-2", subjectKey: "x", text: "x" }), T1),
      ]),
    ).toThrow(/strictly increasing/);

    expect(() =>
      foldKnowledge([
        candidateRec(2, makeEntry()),
        candidateRec(1, makeEntry({ entryId: "k-2", subjectKey: "x", text: "x" }), T1),
      ]),
    ).toThrow(/strictly increasing/);

    const bad = {
      seq: 1,
      recordedAt: T0,
      event: "not-a-real-event",
      actor: DAVID_ACTOR,
      payload: {},
    } as unknown as KnowledgeEventRecord;
    expect(() => foldKnowledge([bad])).toThrow(/unknown event/);
  });
});

describe("round-1 review hardening", () => {
  it("replaying one attempt's success is not independent evidence (r1 finding 6)", () => {
    const entry = makeEntry({ entryId: "k-cmd" });
    // Two rows for the SAME (mission, attempt) success + one other mission:
    // raw-count logic would see 3 successes across 2 missions; distinct-attempt
    // counting sees 2 (m-1/a-1 once, m-2/a-2 once).
    const view = foldKnowledge([
      candidateRec(1, entry),
      observe(2, CMD, "m-1", "a-1", true),
      observe(3, CMD, "m-1", "a-1", true),
      observe(4, CMD, "m-2", "a-2", true),
    ]);
    expect(view.commandTallies.get(CMD)?.successes).toBe(2);
    const problems = knowledgeAppendProblems(
      view,
      {
        event: "entry-promoted",
        actor: "camino:rule",
        payload: { entryId: "k-cmd", authority: { kind: "rule-command-success" } },
      },
      T1,
    );
    expect(problems.some((p) => p.includes("evidence not met"))).toBe(true);
  });

  it("a candidate recorded on an already-reverted base is refused (r1 finding 8)", () => {
    const prior = [rec(1, "validity-base-reverted", { revertedSha: SHA_A }, "camino:git")];
    const problems = knowledgeAppendProblems(
      foldKnowledge(prior),
      {
        event: "candidate-recorded",
        actor: "camino:attempt",
        payload: {
          entry: makeEntry({ entryId: "k-late", validity: { commitSha: SHA_A, baseSha: SHA_B } }),
        },
      },
      T1,
    );
    expect(problems.some((p) => p.includes("was reverted"))).toBe(true);
    // The same base-reverted SHA appearing as the baseSha is caught too.
    const viaBase = knowledgeAppendProblems(
      foldKnowledge(prior),
      {
        event: "candidate-recorded",
        actor: "camino:attempt",
        payload: {
          entry: makeEntry({ entryId: "k-late2", validity: { commitSha: SHA_C, baseSha: SHA_A } }),
        },
      },
      T1,
    );
    expect(viaBase.some((p) => p.includes("was reverted"))).toBe(true);
  });

  it("provenance.issueId must be namespaced under provenance.missionId (r1 finding 3)", () => {
    const problems = knowledgeAppendProblems(
      emptyKnowledgeView(),
      {
        event: "candidate-recorded",
        actor: "camino:attempt",
        payload: {
          entry: makeEntry({
            provenance: {
              missionId: "m-1",
              issueId: "m-2.i-1", // under m-2, not m-1
              attemptId: "a-1",
              context: "x",
            },
          }),
        },
      },
      T0,
    );
    expect(problems.some((p) => p.includes("namespaced under provenance.missionId"))).toBe(true);
  });

  it("a prototype-based entry object is refused, closing fold-vs-store divergence (r1 f13, r2 f13)", () => {
    // The validator canonicalizes (JSON round-trip) first, so what it checks
    // is what the store serializes. Object.create(valid) reads its fields
    // through the prototype and serializes to {}, so canonicalization reduces
    // it to an empty object — refused for its now-missing required fields.
    const refuse = (entry: unknown): string[] =>
      knowledgeAppendProblems(
        emptyKnowledgeView(),
        { event: "candidate-recorded", actor: "camino:attempt", payload: { entry } },
        T0,
      );

    const prototyped = Object.create(makeEntry()) as Record<string, unknown>;
    expect(refuse(prototyped).some((p) => p.includes("entryId"))).toBe(true);

    // A root object with a NON-ENUMERABLE required field serializes to {} too.
    const nonEnum = { ...makeEntry() } as Record<string, unknown>;
    Object.defineProperty(nonEnum, "entryId", { value: "k-hidden", enumerable: false });
    expect(refuse(nonEnum).length).toBeGreaterThan(0);

    // A PROTOTYPE-BACKED NESTED object (provenance) is caught the same way.
    const badNested = { ...makeEntry(), provenance: Object.create(makeEntry().provenance) };
    expect(refuse(badNested).length).toBeGreaterThan(0);

    // A throwing accessor makes the validator return a problem, never throw.
    const throwing = {} as Record<string, unknown>;
    Object.defineProperty(throwing, "entryId", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(refuse(throwing).some((p) => p.includes("canonical JSON"))).toBe(true);
  });
});

describe("round-2 review hardening", () => {
  it("a revert prunes rule-class evidence from the reverted world (r2 finding 3)", () => {
    // Three distinct successes across two missions, all on base SHA_A, then a
    // revert of SHA_A. The evidence is gone, so a fresh candidate on a
    // DIFFERENT base (SHA_C) cannot ride the vanished successes to promotion.
    const onA = { commitSha: SHA_C, baseSha: SHA_A };
    const view = foldKnowledge([
      observe(1, CMD, "m-1", "a-1", true, T0, onA),
      observe(2, CMD, "m-1", "a-2", true, T0, onA),
      observe(3, CMD, "m-2", "a-3", true, T0, onA),
      rec(4, "validity-base-reverted", { revertedSha: SHA_A }, "camino:git"),
    ]);
    expect(view.commandTallies.get(CMD)?.successes ?? 0).toBe(0);
    const fresh = makeEntry({ entryId: "k-fresh", validity: { commitSha: SHA_C, baseSha: SHA_B } });
    const problems = knowledgeAppendProblems(
      foldKnowledge([
        observe(1, CMD, "m-1", "a-1", true, T0, onA),
        observe(2, CMD, "m-1", "a-2", true, T0, onA),
        observe(3, CMD, "m-2", "a-3", true, T0, onA),
        rec(4, "validity-base-reverted", { revertedSha: SHA_A }, "camino:git"),
        candidateRec(5, fresh, T1),
      ]),
      {
        event: "entry-promoted",
        actor: "camino:rule",
        payload: { entryId: "k-fresh", authority: { kind: "rule-command-success" } },
      },
      T1,
    );
    expect(problems.some((p) => p.includes("evidence not met"))).toBe(true);
  });

  it("a revert prunes a quarantine confirmation from the reverted world (r2 finding 3)", () => {
    // The candidate carries an UNREVERTED base so the revert prunes only the
    // confirmation, not the entry itself.
    const flaky = makeEntry({
      entryId: "k-flaky",
      entryClass: "flaky-test",
      subjectKey: "suite::t",
      claim: "flaky",
      text: "suite::t is flaky",
      validity: { commitSha: SHA_C, baseSha: SHA_C },
    });
    const problems = knowledgeAppendProblems(
      foldKnowledge([
        candidateRec(1, flaky),
        quarantine(2, "suite::t", "m-1", "q-ref", { commitSha: SHA_A, baseSha: SHA_B }),
        rec(3, "validity-base-reverted", { revertedSha: SHA_A }, "camino:git"),
      ]),
      {
        event: "entry-promoted",
        actor: "camino:rule",
        payload: { entryId: "k-flaky", authority: { kind: "rule-quarantine-flaky" } },
      },
      T1,
    );
    expect(problems.some((p) => p.includes("no quarantine confirmation"))).toBe(true);
  });

  it("an EXPIRED approved entry no longer blocks a fresh contradictory candidate (r2 finding 4)", () => {
    const approvedShortLived = makeEntry({
      entryId: "k-old",
      subjectKey: "cmd-x",
      claim: "succeeds",
      expiresAt: EXPIRES_NEAR,
    });
    const candidate = makeEntry({
      entryId: "k-new",
      subjectKey: "cmd-x",
      claim: "fails",
      text: "cmd-x fails now",
    });
    const view = foldKnowledge([
      candidateRec(1, approvedShortLived),
      promote(2, "k-old", { kind: "human-batch", batchId: "b1" }),
      candidateRec(3, candidate, T1),
    ]);
    // Before expiry, the approved entry stands and blocks (T0 < EXPIRES_NEAR).
    expect(standingApprovedConflicts(view, candidate, T0)).toEqual(["k-old"]);
    // After expiry (T2), it no longer stands: no conflict, empty curation queue,
    // and the contradictory candidate is promotable.
    expect(standingApprovedConflicts(view, candidate, T2)).toEqual([]);
    expect(knowledgeCurationQueue(view, T2)).toEqual([]);
    const problems = knowledgeAppendProblems(
      view,
      {
        event: "entry-promoted",
        actor: DAVID_ACTOR,
        payload: { entryId: "k-new", authority: { kind: "human-batch", batchId: "b2" } },
      },
      T2,
    );
    expect(problems.filter((p) => p.includes("contradicts standing approved"))).toEqual([]);
  });
});
