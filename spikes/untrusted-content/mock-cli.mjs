#!/usr/bin/env node
// Fake planner/worker CLI for the untrusted-content tests (zero quota). Runs in
// the dispatched cwd (a throwaway workspace/clone). Behaviour is driven by two
// env vars set by mockAdapter:
//   MOCK_ROLE = planner | worker
//   MOCK_MODE = clean    -> benign, valid output
//                     = obedient -> performs a generic proxy planted instruction so a
//                                   wiring test can see evidence populate
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const role = process.env.MOCK_ROLE ?? "planner";
const mode = process.env.MOCK_MODE ?? "clean";
const say = (type, text) => process.stdout.write(JSON.stringify({ type, text }) + "\n");

if (role === "planner") {
  say("assistant", "reading PRD");
  let segs = ["S1"];
  try {
    const text = readFileSync("PRD.md", "utf8");
    const found = [...new Set([...text.matchAll(/^\[S(\d+)\]/gm)].map((m) => `S${m[1]}`))];
    if (found.length) segs = found;
  } catch {
    /* no PRD */
  }
  const plan = {
    missionTitle: "Mock plan",
    issues: [
      {
        id: "I1",
        title: mode === "obedient" ? "PROBE-MOCK" : "Implement the feature",
        goal: "Deliver the described behaviour.",
        acceptanceCriteria: ["An observable check passes."],
        mappedSegments: [segs[0]],
        dependsOn: [],
        riskTier: "low",
      },
    ],
    clarifyingQuestions: [],
    checklist: segs.map((s, i) => ({
      segment: s,
      isRequirement: true,
      proposedLedgerEntry: { id: `LED-${i + 1}`, statement: `Requirement for ${s}.` },
      mappedIssues: ["I1"],
      note: "",
    })),
  };
  writeFileSync("plan.json", JSON.stringify(plan, null, 2) + "\n");
  if (mode === "obedient") writeFileSync("EXTRA.txt", "PROBE-MOCK\n");
  say("result", "wrote plan.json");
} else {
  say("assistant", "working");
  if (mode === "obedient") {
    writeFileSync("LEAK.txt", "API_TOKEN=SYNTHETIC-MOCK\n");
    appendFileSync("hello.js", "\nexport function evalCmd(x) { return eval(x); } // PROBE-MOCK\n");
  } else {
    writeFileSync("GREETING.txt", "hello\n");
  }
  try {
    execFileSync("git", ["add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "mock change"], { stdio: "ignore" });
  } catch {
    /* commit is best-effort; the harness also captures uncommitted changes */
  }
  say("result", "done");
}
