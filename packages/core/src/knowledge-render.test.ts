/**
 * Knowledge render tests (WP-113, CAM-CANON-09): the repo projection shows
 * only unexpired approved entries, carries a parseable freshness marker,
 * refuses caller-bug clocks/seqs, and formats fragments deterministically.
 */
import { describe, expect, it } from "vitest";
import type {
  KnowledgeEntryInput,
  KnowledgeEventName,
  KnowledgeEventRecord,
  KnowledgePromotionAuthority,
} from "@camino/shared";
import { foldKnowledge, type KnowledgeEntrySnapshot, type KnowledgeView } from "./knowledge.js";
import { knowledgeFragment, renderKnowledge } from "./knowledge-render.js";
import { DAVID_ACTOR } from "./intent-lifecycle.js";

const T0 = "2026-07-01T00:00:00.000Z";
const T1 = "2026-07-02T00:00:00.000Z";
const T2 = "2026-07-03T00:00:00.000Z";
const EXPIRES_FAR = "2026-12-31T00:00:00.000Z";
const EXPIRES_MID = "2026-07-02T00:00:00.000Z";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function makeEntry(overrides: Partial<KnowledgeEntryInput> = {}): KnowledgeEntryInput {
  return {
    entryId: "k-1",
    entryClass: "command",
    subjectKey: "npm test",
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

function candidateRec(
  seq: number,
  entry: KnowledgeEntryInput,
  recordedAt: string = T0,
): KnowledgeEventRecord {
  return rec(seq, "candidate-recorded", { entry }, "camino:attempt", recordedAt);
}

function promote(
  seq: number,
  entryId: string,
  authority: KnowledgePromotionAuthority = {
    kind: "human-batch",
    batchId: "batch-1",
  },
  actor: string = DAVID_ACTOR,
  recordedAt: string = T0,
): KnowledgeEventRecord {
  return rec(seq, "entry-promoted", { entryId, authority }, actor, recordedAt);
}

function approve(
  startSeq: number,
  entry: KnowledgeEntryInput,
  authority?: KnowledgePromotionAuthority,
): KnowledgeEventRecord[] {
  return [
    candidateRec(startSeq, entry),
    promote(startSeq + 1, entry.entryId, authority ?? { kind: "human-batch", batchId: "batch-1" }),
  ];
}

function approvedSnapshot(
  entry: KnowledgeEntryInput,
  authority: KnowledgePromotionAuthority,
  seq = 2,
): KnowledgeEntrySnapshot {
  return {
    entry,
    state: "approved",
    recordedSeq: seq - 1,
    recordedAt: T0,
    promotion: {
      authority,
      actor: DAVID_ACTOR,
      seq,
      recordedAt: T0,
    },
    resolution: null,
    invalidation: null,
  };
}

describe("renderKnowledge (CAM-CANON-09: approved-only repo projection)", () => {
  it("renders only approved entries (candidate and rejected do not appear)", () => {
    const view = foldKnowledge([
      ...approve(1, makeEntry({ entryId: "k-ok", text: "approved text" })),
      candidateRec(
        3,
        makeEntry({ entryId: "k-cand", subjectKey: "other", text: "candidate text" }),
        T1,
      ),
      candidateRec(
        4,
        makeEntry({ entryId: "k-rej", subjectKey: "rej", text: "rejected text" }),
        T1,
      ),
      rec(5, "entry-rejected", { entryId: "k-rej", reason: "noise" }, DAVID_ACTOR, T1),
    ]);
    const text = renderKnowledge(view, { renderedAt: T2 });
    expect(text).toContain("k-ok");
    expect(text).toContain("approved text");
    expect(text).not.toContain("k-cand");
    expect(text).not.toContain("candidate text");
    expect(text).not.toContain("k-rej");
    expect(text).not.toContain("rejected text");
  });

  it("omits an approved entry expired at renderedAt; empty list yields the placeholder body", () => {
    const view = foldKnowledge([
      ...approve(
        1,
        makeEntry({
          entryId: "k-exp",
          text: "will expire",
          expiresAt: EXPIRES_MID,
        }),
      ),
    ]);
    const text = renderKnowledge(view, { renderedAt: EXPIRES_MID });
    expect(text).not.toContain("k-exp");
    expect(text).toContain("_No approved entries yet._");
  });

  it("marker line binds the seq to the view's own lastSeq (r1 finding 12), not a caller value", () => {
    const empty = foldKnowledge([]);
    const renderedAt = "2026-07-15T12:34:56.789Z";
    // An empty view has lastSeq 0 and renders seq 0 — it cannot claim a
    // sequence it was not rendered from.
    expect(renderKnowledge(empty, { renderedAt })).toContain(
      `<!-- camino:knowledge rendered-at=${renderedAt} knowledge-seq=0 -->`,
    );
    // A view folded through seq 2 renders seq 2.
    const view = foldKnowledge(approve(1, makeEntry({ entryId: "k-ok" })));
    expect(view.lastSeq).toBe(2);
    expect(renderKnowledge(view, { renderedAt })).toContain(
      `<!-- camino:knowledge rendered-at=${renderedAt} knowledge-seq=2 -->`,
    );
  });

  it("throws on malformed renderedAt", () => {
    const view = foldKnowledge([]);
    expect(() => renderKnowledge(view, { renderedAt: "yesterday" })).toThrow(/ISO-8601/);
    expect(() => renderKnowledge(view, { renderedAt: "2026-02-30T00:00:00.000Z" })).toThrow(
      /ISO-8601/,
    );
  });

  it("sorts entries by entryId regardless of insertion order; output is deterministic", () => {
    const a = foldKnowledge([
      ...approve(1, makeEntry({ entryId: "k-z", text: "zee" })),
      ...approve(3, makeEntry({ entryId: "k-a", subjectKey: "other", text: "aye" })),
    ]);
    const b = foldKnowledge([
      ...approve(1, makeEntry({ entryId: "k-a", subjectKey: "other", text: "aye" })),
      ...approve(3, makeEntry({ entryId: "k-z", text: "zee" })),
    ]);
    const opts = { renderedAt: T1 };
    const textA = renderKnowledge(a, opts);
    const textB = renderKnowledge(b, opts);
    expect(textA).toBe(textB);
    expect(textA.indexOf("k-a")).toBeLessThan(textA.indexOf("k-z"));
    expect(renderKnowledge(a, opts)).toBe(textA);
  });
});

describe("knowledgeFragment", () => {
  it("includes subject line for command entry; omits it for a subjectless note", () => {
    const command = approvedSnapshot(makeEntry(), { kind: "human-batch", batchId: "batch-9" });
    const cmdFrag = knowledgeFragment(command);
    expect(cmdFrag).toContain("npm test succeeds in CI");
    expect(cmdFrag).toContain("subject: `npm test` — claim: succeeds");

    const note = approvedSnapshot(
      makeEntry({
        entryId: "k-note",
        entryClass: "note",
        subjectKey: null,
        claim: "context",
        text: "free-form operational note",
      }),
      { kind: "human-batch", batchId: "batch-9" },
    );
    const noteFrag = knowledgeFragment(note);
    expect(noteFrag).toContain("free-form operational note");
    expect(noteFrag).not.toContain("subject:");
  });

  it("labels global and repo-area scopes", () => {
    const globalFrag = knowledgeFragment(
      approvedSnapshot(makeEntry({ scope: { kind: "global" } }), {
        kind: "human-batch",
        batchId: "b",
      }),
    );
    expect(globalFrag).toContain("scope: global");

    const areaFrag = knowledgeFragment(
      approvedSnapshot(makeEntry({ scope: { kind: "repo-area", area: "packages/core" } }), {
        kind: "human-batch",
        batchId: "b",
      }),
    );
    expect(areaFrag).toContain("scope: area: packages/core");
  });

  it("labels all three promotion authority kinds", () => {
    const human = knowledgeFragment(
      approvedSnapshot(makeEntry({ entryId: "k-h" }), {
        kind: "human-batch",
        batchId: "batch-42",
      }),
    );
    expect(human).toContain("approved via human curation batch batch-42");

    const cmdRule = knowledgeFragment(
      approvedSnapshot(makeEntry({ entryId: "k-r1" }), { kind: "rule-command-success" }),
    );
    expect(cmdRule).toContain("approved via deterministic rule: command succeeded across missions");

    const flakyRule = knowledgeFragment(
      approvedSnapshot(
        makeEntry({
          entryId: "k-r2",
          entryClass: "flaky-test",
          subjectKey: "t1",
          claim: "flaky",
          text: "t1 is flaky",
        }),
        { kind: "rule-quarantine-flaky" },
      ),
    );
    expect(flakyRule).toContain("approved via deterministic rule: quarantine-confirmed flaky test");
  });

  it("includes provenance, validity, and expiry lines", () => {
    const frag = knowledgeFragment(
      approvedSnapshot(
        makeEntry({
          expiresAt: EXPIRES_FAR,
          provenance: {
            missionId: "m-9",
            issueId: "m-9.i-2",
            attemptId: "a-77",
            context: "ctx",
          },
          validity: { commitSha: SHA_A, baseSha: SHA_B },
        }),
        { kind: "human-batch", batchId: "b" },
      ),
    );
    expect(frag).toContain(`expires: ${EXPIRES_FAR}`);
    expect(frag).toContain("provenance: attempt a-77 (issue m-9.i-2, mission m-9)");
    expect(frag).toContain(`validity: commit ${SHA_A} on base ${SHA_B}`);
  });
});

describe("renderKnowledge via foldKnowledge helpers", () => {
  it("builds a multi-authority view through the fold and renders approved fragments only", () => {
    const view: KnowledgeView = foldKnowledge([
      candidateRec(1, makeEntry({ entryId: "k-human", text: "from human" })),
      promote(2, "k-human", { kind: "human-batch", batchId: "batch-1" }),
      candidateRec(
        3,
        makeEntry({ entryId: "k-rule", subjectKey: "npm test", text: "from rule" }),
        T0,
      ),
      rec(
        4,
        "command-observation",
        {
          commandKey: "npm test",
          missionId: "m-1",
          attemptId: "a-1",
          succeeded: true,
          commitSha: SHA_A,
          baseSha: SHA_B,
        },
        "camino:dispatcher",
      ),
      rec(
        5,
        "command-observation",
        {
          commandKey: "npm test",
          missionId: "m-1",
          attemptId: "a-2",
          succeeded: true,
          commitSha: SHA_A,
          baseSha: SHA_B,
        },
        "camino:dispatcher",
      ),
      rec(
        6,
        "command-observation",
        {
          commandKey: "npm test",
          missionId: "m-2",
          attemptId: "a-3",
          succeeded: true,
          commitSha: SHA_A,
          baseSha: SHA_B,
        },
        "camino:dispatcher",
      ),
      promote(7, "k-rule", { kind: "rule-command-success" }, "camino:rule", T1),
    ]);
    const text = renderKnowledge(view, { renderedAt: T2 });
    expect(text).toContain("k-human");
    expect(text).toContain("k-rule");
    expect(text).toContain("approved via human curation batch batch-1");
    expect(text).toContain("approved via deterministic rule: command succeeded across missions");
  });
});
