// Verify a (filled) rating packet: every question rated + acknowledged,
// checklist usability answered, review time recorded — then compute the
// ≥70%-good score (PRD §7 Phase-0 item 2 exit).
//
// Exit semantics (review r1c finding 4): default exit 0 = the packet is
// COMPLETE (everything recorded — David's "no" answers are valid data, not
// checker failures). Pass --strict to demand the full conjunctive Phase-0
// exit (≥70% good ∧ checklist usable=yes ∧ time recorded) — that is the mode
// the WP acceptance decision uses.
//
// plan.json is REQUIRED: it is the authoritative question list, without which
// packet text could mint questions and move the score (r1c finding 3).
//
//   node --run spike:plan-probe:check
//   node --run spike:plan-probe:check -- --strict
//   node --run spike:plan-probe:check -- --packet=path --plan=path
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { checkPacket, describeCheck } from "./packet.js";
import type { PlanDocument } from "./types.js";
import { extractJson } from "./validate.js";

const here = dirname(fileURLToPath(import.meta.url));

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const packetPath = flag("packet") ?? join(here, "RATING-PACKET.md");
  const planPath = flag("plan") ?? join(here, "transcripts", "plan.json");

  const markdown = readFileSync(packetPath, "utf8");
  let expected: string[];
  try {
    const plan = JSON.parse(extractJson(readFileSync(planPath, "utf8"))) as PlanDocument;
    expected = plan.clarifyingQuestions.map((q) => q.id);
  } catch (err) {
    console.error(`cannot read the plan's question list from ${planPath}: ${String(err)}`);
    process.exitCode = 2;
    return;
  }

  const check = checkPacket(markdown, expected);
  console.log(describeCheck(check));
  process.exitCode = argv.includes("--strict")
    ? check.phase0ExitPass
      ? 0
      : 1
    : check.approvable
      ? 0
      : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
