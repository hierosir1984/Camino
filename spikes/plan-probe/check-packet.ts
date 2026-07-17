// Verify a (filled) rating packet: every question rated + acknowledged,
// checklist usability answered, review time recorded — then compute the
// ≥70%-good score (PRD §7 Phase-0 item 2 exit). Exit 0 only when the packet
// is complete; the score itself is reported, not enforced (the number is
// David's verdict to act on, not the harness's to gate).
//
//   node --run spike:plan-probe:check
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
  let expected: string[] | undefined;
  try {
    const plan = JSON.parse(extractJson(readFileSync(planPath, "utf8"))) as PlanDocument;
    expected = plan.clarifyingQuestions.map((q) => q.id);
  } catch {
    expected = undefined; // packet is still checkable standalone
  }

  const check = checkPacket(markdown, expected);
  console.log(describeCheck(check));
  process.exitCode = check.approvable ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
