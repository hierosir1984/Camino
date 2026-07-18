#!/usr/bin/env node
// Fake planner/reviewer CLI for the plan-probe tests (zero quota). Reads
// ./PRD.md from cwd, derives the segment set exactly like the harness does,
// and writes plan.json / review.json per MOCK_PROBE_MODE:
//
//   plan               valid, checklist covers every segment
//   plan-coverage-gap  valid JSON but silently drops the last segment's row
//   plan-bad-schema    valid JSON missing required fields
//   plan-bad-json      not JSON at all
//   plan-fenced        valid plan wrapped in a ```json fence (tolerant-reader case)
//   plan-missing       writes nothing
//   review             valid review, 2 findings
//   review-bad-verdict invalid verdict enum
//   review-missing     writes nothing
import { readFileSync, writeFileSync } from "node:fs";

const mode = process.env.MOCK_PROBE_MODE ?? "plan";
const say = (type, text) => process.stdout.write(JSON.stringify({ type, text }) + "\n");

function segments() {
  const text = readFileSync("PRD.md", "utf8");
  const out = [];
  const seen = new Set();
  for (const m of text.matchAll(/^\[S(\d+)\]/gm)) {
    const tag = `S${m[1]}`;
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

function makePlan(segs) {
  const issues = [
    {
      id: "I1",
      title: "Packet data model + loader",
      goal: "Parse and expose evidence packets to the GUI.",
      acceptanceCriteria: [
        "Loader rejects packets missing per-item (sha, base_sha, class).",
        "Fixture packet round-trips.",
      ],
      mappedSegments: [segs[0]],
      dependsOn: [],
      riskTier: "medium",
    },
    {
      id: "I2",
      title: "Packet renderer",
      goal: "Render packet contents with the gating/advisory distinction.",
      acceptanceCriteria: ["Playwright: advisory and gating items are visually distinct."],
      mappedSegments: [segs[Math.min(1, segs.length - 1)]],
      dependsOn: ["I1"],
      riskTier: "medium",
    },
    {
      id: "I3",
      title: "Approval embed",
      goal: "Embed the packet in the merge-approval surface.",
      acceptanceCriteria: ["Approval control disabled while no packet is attached."],
      mappedSegments: [segs[Math.min(2, segs.length - 1)]],
      dependsOn: ["I2"],
      riskTier: "medium",
    },
  ];
  const clarifyingQuestions = [
    {
      id: "Q1",
      question: "Where does the viewer read packets from in v0?",
      whyItMatters: "Determines whether I1 builds a file loader or a daemon API client.",
      assumptionIfUnanswered: "Packets are JSON files on disk under .camino/packets/.",
      blocking: true,
      relatedSegments: [segs[0]],
      relatedIssues: ["I1"],
    },
    {
      id: "Q2",
      question: "Which artifact types must render inline in v0?",
      whyItMatters: "Scopes the renderer work.",
      assumptionIfUnanswered: "Logs and screenshots inline; traces open locally.",
      blocking: false,
      relatedSegments: [segs[Math.min(1, segs.length - 1)]],
      relatedIssues: ["I2"],
    },
  ];
  const checklist = segs.map((segment, i) => {
    const isRequirement = i % 2 === 0;
    return {
      segment,
      isRequirement,
      proposedLedgerEntry: isRequirement
        ? { id: `LED-${i + 1}`, statement: `Deliver the obligation stated in ${segment}.` }
        : null,
      mappedIssues: isRequirement ? [issues[i % issues.length].id] : [],
      note: isRequirement ? undefined : "Context/motivation — no obligation for this mission.",
    };
  });
  return { missionTitle: "Evidence viewer v0", issues, clarifyingQuestions, checklist };
}

const REVIEW = {
  verdict: "approve-with-findings",
  summary:
    "The plan is broadly faithful but bakes in one unstated assumption and one weak criterion.",
  findings: [
    {
      id: "F1",
      severity: "major",
      class: "unstated-assumption",
      claim: "Packet storage location is assumed without a surfaced question.",
      evidence: "Issue I1 presumes disk layout; no clarifyingQuestion covers retention.",
      suggestedFix: "Add a clarifying question about packet retention and source of truth.",
    },
    {
      id: "F2",
      severity: "minor",
      class: "criteria-defect",
      claim: "One acceptance criterion is passable by a stub.",
      evidence: "I3's criterion checks a disabled control but not that a real packet enables it.",
      suggestedFix:
        "Add the positive case: with a fixture packet attached, approval becomes enabled.",
    },
  ],
};

say("assistant", `mock ${mode}: working`);
switch (mode) {
  case "plan": {
    writeFileSync("plan.json", JSON.stringify(makePlan(segments()), null, 2) + "\n");
    break;
  }
  case "plan-coverage-gap": {
    const segs = segments();
    const plan = makePlan(segs);
    plan.checklist = plan.checklist.filter((row) => row.segment !== segs[segs.length - 1]);
    writeFileSync("plan.json", JSON.stringify(plan, null, 2) + "\n");
    break;
  }
  case "plan-bad-schema": {
    writeFileSync("plan.json", JSON.stringify({ missionTitle: "broken" }) + "\n");
    break;
  }
  case "plan-bad-json": {
    writeFileSync("plan.json", "{ this is not json\n");
    break;
  }
  case "plan-fenced": {
    const body = JSON.stringify(makePlan(segments()), null, 2);
    writeFileSync("plan.json", "```json\n" + body + "\n```\n");
    break;
  }
  case "plan-missing":
  case "review-missing":
    break;
  case "review": {
    writeFileSync("review.json", JSON.stringify(REVIEW, null, 2) + "\n");
    break;
  }
  case "review-bad-verdict": {
    writeFileSync("review.json", JSON.stringify({ ...REVIEW, verdict: "lgtm" }, null, 2) + "\n");
    break;
  }
  default:
    say("error", `unknown MOCK_PROBE_MODE ${mode}`);
    process.exit(2);
}
say("result", `mock ${mode}: done`);
