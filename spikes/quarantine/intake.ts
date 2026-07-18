// WP-003 quarantine intake — squash-and-rebuild (design §5.1, CAM-EXEC-04).
//
// Faithful-to-design model: the control plane owns a PRISTINE, hooks-disabled
// repo and pulls ONLY the worker's final head into it via a shallow fetch
// (--depth=1). Worker history — intermediate commits and any objects reachable
// only through them — never enters the pristine store, so reachable-history
// smuggling is defeated structurally, not by after-the-fact filtering. Policy
// checks then run on the final tree; a clean tree is re-authored as a fresh
// Camino commit onto the assigned base, with a worker-attribution trailer.
//
// This is a PROTOTYPE. WP-108 is the product module; this suite's attack corpus
// is meant to run against it unchanged.
import { buildTree, cleanupRepos, commitTree, git, gitBuf, initRepo, objectExists } from "./git.js";
import {
  checkBudgets,
  checkDotGitPaths,
  checkNameAliases,
  checkPathCollisions,
  checkScopeAndProtected,
  checkSubmodules,
  checkSymlinks,
} from "./policy.js";
import {
  DEFAULT_BUDGETS,
  type Contract,
  type QuarantineResult,
  type Rejection,
  type TreeEntry,
} from "./types.js";

export { cleanupRepos, objectExists };

const LS_TREE_RECORD = /^(\d{6}) (blob|tree|commit) ([0-9a-f]+)\s+(\S+)\t([\s\S]*)$/;

/** Parse `git ls-tree -r -l -z <tree>` output into typed entries. */
export function parseTree(raw: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (const record of raw.split("\0")) {
    if (record.length === 0) continue;
    const m = LS_TREE_RECORD.exec(record);
    if (!m) throw new Error(`unparseable ls-tree record: ${JSON.stringify(record)}`);
    const [, mode, type, sha, sizeStr, path] = m;
    out.push({
      mode: mode!,
      type: type as TreeEntry["type"],
      sha: sha!,
      size: sizeStr === "-" ? null : Number.parseInt(sizeStr!, 10),
      path: path!,
    });
  }
  return out;
}

/**
 * Parent shas read from the RAW commit object, not `%P`: a `--depth=1` shallow
 * fetch writes a graft that makes traversal-based views (`%P`, `git log`) report
 * the fetched commit as parentless, but the stored object still carries every
 * `parent` line. Reading the raw object is what lets us detect a worker merge
 * commit after a shallow fetch (the object is exactly what the server sent).
 */
function parentShas(dir: string, commit: string): string[] {
  const raw = git(dir, "cat-file", "commit", commit);
  const parents: string[] = [];
  for (const line of raw.split("\n")) {
    if (line === "") break; // end of header
    if (line.startsWith("parent ")) parents.push(line.slice("parent ".length).trim());
  }
  return parents;
}

function changedPaths(dir: string, base: string, head: string): string[] {
  const raw = gitBuf(dir, "diff", "--name-only", "-z", base, head).toString("utf8");
  return raw.split("\0").filter((s) => s.length > 0);
}

function symlinkTargets(dir: string, entries: readonly TreeEntry[]): Map<string, string> {
  const targets = new Map<string, string>();
  for (const e of entries) {
    if (e.mode === "120000")
      targets.set(e.path, gitBuf(dir, "cat-file", "blob", e.sha).toString("utf8"));
  }
  return targets;
}

function countObjects(dir: string): number {
  const raw = git(
    dir,
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objectname)",
    "--unordered",
  );
  return raw.length === 0 ? 0 : raw.split("\n").filter((l) => l.trim().length > 0).length;
}

/**
 * Run the quarantine intake for one worker head.
 *
 * @param workerRepo path to the worker's (untrusted) repo
 * @param workerRef  ref or sha of the worker's final head inside that repo
 * @param contract   assigned base + allowed-path scope + budgets
 */
export function runIntake(
  workerRepo: string,
  workerRef: string,
  contract: Contract,
): QuarantineResult {
  const budgets = { ...DEFAULT_BUDGETS, ...contract.budgets };
  const workerHead = git(workerRepo, "rev-parse", workerRef);

  // Pristine control-plane repo: trusted base first (full), then the worker's
  // final head shallow — nothing else crosses the boundary.
  const pristineDir = initRepo("camino-quarantine-pristine-");
  git(pristineDir, "fetch", "--no-tags", "--quiet", workerRepo, contract.base);
  git(pristineDir, "fetch", "--no-tags", "--depth=1", "--quiet", workerRepo, workerHead);

  const rejections: Rejection[] = [];

  // Worker merge commits are rejected outright (design §5.1).
  if (parentShas(pristineDir, workerHead).length > 1) {
    rejections.push({
      code: "worker-merge-commit",
      detail: `worker head ${workerHead.slice(0, 12)} is a merge commit`,
    });
  }

  const treeSha = git(pristineDir, "rev-parse", `${workerHead}^{tree}`);
  const entries = parseTree(
    gitBuf(pristineDir, "ls-tree", "-r", "-l", "-z", treeSha).toString("utf8"),
  );
  const targets = symlinkTargets(pristineDir, entries);
  const changed = changedPaths(pristineDir, contract.base, workerHead);

  rejections.push(
    ...checkScopeAndProtected(changed, contract.allowedPaths),
    ...checkPathCollisions(entries),
    ...checkNameAliases(entries),
    ...checkDotGitPaths(entries),
    ...checkSubmodules(entries),
    ...checkSymlinks(entries, targets),
    ...checkBudgets(entries, budgets),
  );

  const accepted = rejections.length === 0;
  let rebuilt: QuarantineResult["rebuilt"] = null;
  if (accepted) {
    const subject = git(pristineDir, "show", "-s", "--format=%s", workerHead);
    const attributionTrailer = `Camino-Worker-Attribution: ${workerHead}`;
    const message = `${subject}\n\n${attributionTrailer}\n`;
    const sha = commitTree(pristineDir, treeSha, [contract.base], message, {
      name: "Camino",
      email: "camino@camino.invalid",
    });
    rebuilt = {
      sha,
      parents: parentShas(pristineDir, sha),
      treeSha,
      attributionTrailer,
    };
  }

  return {
    accepted,
    rejections,
    rebuilt,
    workerHead,
    fetchedObjectCount: countObjects(pristineDir),
    pristineDir,
  };
}

/** Re-export the plumbing a fixture builder needs (single import surface). */
export { buildTree };
