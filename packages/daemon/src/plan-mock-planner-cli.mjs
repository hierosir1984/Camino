// Mock planner CLI (WP-110 tests): a fake worker exercising the planner
// runner's file-tail protocol with a deterministic handshake — no timing
// assumptions, no real model.
//
// Behavior (cwd = the runner-created workspace):
//   1. Read plan-input/segments.json.
//   2. Append the first issue record to plan-stream.jsonl, then create
//      "waiting-for-ack" and BLOCK until the test creates "ack" in the
//      workspace — this is the window in which the test proves the issue is
//      already visible in the plan view while the dispatch is still running
//      (streaming as constructed).
//   3. Append the rest of the plan: a clarification, one checklist row per
//      segment (first mapped to I1, others unmapped), construction-complete.
//   4. MOCK_PLANNER_MODE=malformed additionally emits a non-JSON line and a
//      structurally invalid record, which the runner must refuse by name
//      without crashing.
//   5. Exit 0.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const STREAM = "plan-stream.jsonl";
const emit = (record) => appendFileSync(STREAM, JSON.stringify(record) + "\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const segments = JSON.parse(readFileSync("plan-input/segments.json", "utf8"));
if (!Array.isArray(segments) || segments.length === 0) {
  console.error("segments.json missing or empty");
  process.exit(1);
}

emit({
  kind: "issue",
  issue: {
    planIssueId: "I1",
    title: "Implement the requested change",
    goal: "The PRD's requested behavior works end to end.",
    acceptanceCriteria: ["The described behavior is observable in the running app."],
    dependsOn: [],
    interfaces: [{ name: "change-surface", kind: "module", description: "the changed module" }],
  },
});

writeFileSync("waiting-for-ack", "");
const deadline = Date.now() + 30_000;
while (!existsSync("ack")) {
  if (Date.now() > deadline) {
    console.error("ack never arrived");
    process.exit(1);
  }
  await sleep(25);
}

if (process.env.MOCK_PLANNER_MODE === "malformed") {
  appendFileSync(STREAM, "this line is not JSON\n");
  emit({ kind: "issue", issue: { planIssueId: "bogus id" } });
}

if (process.env.MOCK_PLANNER_MODE === "rewrite-history") {
  // Same-length in-place rewrite of already-consumed content (r2 finding
  // 11): the runner's consumed-prefix hash must refuse everything after.
  const current = readFileSync(STREAM, "utf8");
  writeFileSync(STREAM, current.replace('"I1"', '"I7"'));
}

const first = segments[0].segmentId;
emit({
  kind: "clarification",
  clarification: {
    clarificationId: "Q1",
    question: "Is the first segment's behavior scoped to all users?",
    whyItMatters: "The PRD does not bound the audience.",
    assumptionIfUnanswered: "All users.",
    relatedSegmentIds: [first],
    relatedPlanIssueIds: ["I1"],
  },
});
emit({
  kind: "checklist-row",
  row: {
    segmentId: first,
    disposition: "mapped",
    proposedStatement: "The first stated behavior is implemented.",
    proposedArea: "APP",
    mappedPlanIssueIds: ["I1"],
  },
});
for (const segment of segments.slice(1)) {
  emit({
    kind: "checklist-row",
    row: { segmentId: segment.segmentId, disposition: "unmapped", reason: "context" },
  });
}
if (process.env.MOCK_PLANNER_MODE === "no-trailing-newline") {
  // The final record ends at EOF with no newline — the runner's final
  // drain must still ingest it (r1 finding 10).
  appendFileSync(STREAM, JSON.stringify({ kind: "construction-complete" }));
} else {
  emit({ kind: "construction-complete" });
}
process.exit(0);
