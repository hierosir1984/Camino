// Gate: FINDINGS.md must carry the EXACT expected set of findings — every corpus
// case id plus the structural findings — each present exactly once with a
// recorded disposition (hardened / accepted-risk). This is the CAM-EXEC-09
// acceptance in miniature. It rejects a file that is missing findings, has
// duplicates, has unknown ids, or leaves any disposition PENDING — so the gate
// cannot be passed by trimming the file to a single disposed block (review r1
// blocker 3).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadCorpus } from "./corpus.js";
import { parseFindingBlocks, STRUCTURAL_FINDING_IDS } from "./findings-doc.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..");
const FINDINGS_PATH = join(here, "FINDINGS.md");
const CORPUS_ROOT = join(REPO_ROOT, "fixtures", "untrusted-content");

export function checkFindingsFile(
  path: string,
  corpusRoot = CORPUS_ROOT,
): { ok: boolean; message: string } {
  if (!existsSync(path)) {
    return {
      ok: false,
      message: `no FINDINGS.md at ${relative(REPO_ROOT, path)} — run \`node --run spike:untrusted\` first.`,
    };
  }
  const expected = new Set<string>([
    ...loadCorpus(corpusRoot).manifest.items.map((i) => i.id),
    ...STRUCTURAL_FINDING_IDS,
  ]);
  const blocks = parseFindingBlocks(readFileSync(path, "utf8"));

  const seen = new Map<string, number>();
  for (const b of blocks) seen.set(b.id, (seen.get(b.id) ?? 0) + 1);

  const problems: string[] = [];
  for (const id of expected) if (!seen.has(id)) problems.push(`missing finding ${id}`);
  for (const [id, n] of seen) {
    if (!expected.has(id)) problems.push(`unknown finding ${id}`);
    else if (n > 1) problems.push(`duplicate finding ${id} (${n}×)`);
  }
  const pending = blocks.filter((b) => expected.has(b.id) && !b.valid).map((b) => b.id);
  for (const id of new Set(pending)) problems.push(`${id} disposition still PENDING`);

  if (problems.length === 0) {
    return {
      ok: true,
      message: `all ${expected.size} findings present and dispositioned ✓ (CAM-EXEC-09 baseline acceptance met).`,
    };
  }
  return {
    ok: false,
    message:
      `FINDINGS.md is not acceptance-complete (${problems.length} problem(s)):\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      `\nEach case id + ${STRUCTURAL_FINDING_IDS.join("/")} must appear once with "hardened — …" or "accepted-risk — …".`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const res = checkFindingsFile(FINDINGS_PATH);
  console.log(res.message);
  process.exit(res.ok ? 0 : 1);
}
