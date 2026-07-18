// WP-003 attack fixtures. Each builds an untrusted "worker repo" with a base
// and a final head via git PLUMBING, so the adversarial tree exists regardless
// of the host filesystem (case-insensitive/Unicode-normalizing macOS cannot
// hold most of these as real files). Every builder isolates ONE violation so
// the suite can assert the exact rejection code.
import { buildTree, commitTree, hashBlob, initRepo, type CacheEntry } from "./git.js";
import type { Contract } from "./types.js";

export interface WorkerFixture {
  repo: string;
  /** The worker's final head (a bare commit sha). */
  head: string;
  contract: Contract;
}

/** In-scope globs shared by fixtures whose violation is NOT a scope violation. */
export const SCOPE = ["src/**", "README.md"];

/** A clean base: `src/app.js` + `README.md`, both in scope. */
function makeBase(repo: string): { base: string; entries: CacheEntry[] } {
  const app = hashBlob(repo, "console.log('app');\n");
  const readme = hashBlob(repo, "# sample repo\n");
  const entries: CacheEntry[] = [
    { mode: "100644", sha: app, path: "src/app.js" },
    { mode: "100644", sha: readme, path: "README.md" },
  ];
  const tree = buildTree(repo, entries);
  const base = commitTree(repo, tree, [], "base");
  return { base, entries };
}

/** Head = base tree with `extra` entries added/overriding, committed on `base`. */
function headWith(
  repo: string,
  base: string,
  baseEntries: CacheEntry[],
  extra: CacheEntry[],
  subject = "worker change",
): string {
  const byPath = new Map(baseEntries.map((e) => [e.path, e]));
  for (const e of extra) byPath.set(e.path, e);
  const tree = buildTree(repo, [...byPath.values()]);
  return commitTree(repo, tree, [base], subject);
}

function contract(base: string, allowedPaths = SCOPE): Contract {
  return { base, allowedPaths };
}

// --- the positive control: a clean, in-scope change ---

export function legitChange(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const app = hashBlob(repo, "console.log('app v2');\n");
  const head = headWith(
    repo,
    base,
    entries,
    [{ mode: "100644", sha: app, path: "src/app.js" }],
    "fix: app v2",
  );
  return { repo, head, contract: contract(base) };
}

// --- 1. reachable-history smuggling ---

/** base → C1 (adds a 2 MB secret blob) → C2 (deletes it; clean in-scope head). */
export function reachableHistorySmuggling(): WorkerFixture & { smuggledSha: string } {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const secret = "SECRET-KEY=" + "A".repeat(2 * 1024 * 1024); // 2 MB, > maxBlobBytes
  const smuggledSha = hashBlob(repo, secret);
  const c1Tree = buildTree(repo, [
    ...entries,
    { mode: "100644", sha: smuggledSha, path: "src/leak.bin" },
  ]);
  const c1 = commitTree(repo, c1Tree, [base], "add secret (intermediate)");
  const app = hashBlob(repo, "console.log('clean');\n");
  const c2Tree = buildTree(repo, [
    { mode: "100644", sha: app, path: "src/app.js" },
    ...entries.filter((e) => e.path !== "src/app.js"),
  ]);
  const c2 = commitTree(repo, c2Tree, [c1], "clean up");
  return { repo, head: c2, contract: contract(base), smuggledSha };
}

// --- 2 & 3. path collisions ---

export function caseCollision(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const a = hashBlob(repo, "upper\n");
  const b = hashBlob(repo, "lower\n");
  const head = headWith(repo, base, entries, [
    { mode: "100644", sha: a, path: "src/Config.txt" },
    { mode: "100644", sha: b, path: "src/config.txt" },
  ]);
  return { repo, head, contract: contract(base) };
}

export function unicodeCollision(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const composed = "src/café.txt"; // é as U+00E9
  const decomposed = "src/café.txt"; // e + U+0301 combining acute
  const a = hashBlob(repo, "composed\n");
  const b = hashBlob(repo, "decomposed\n");
  const head = headWith(repo, base, entries, [
    { mode: "100644", sha: a, path: composed },
    { mode: "100644", sha: b, path: decomposed },
  ]);
  return { repo, head, contract: contract(base) };
}

// --- 4 & 5. reserved-name & trailing-dot/space aliases ---

export function reservedName(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const blob = hashBlob(repo, "device\n");
  const head = headWith(repo, base, entries, [{ mode: "100644", sha: blob, path: "src/CON.txt" }]);
  return { repo, head, contract: contract(base) };
}

export function trailingDot(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const blob = hashBlob(repo, "alias\n");
  const head = headWith(repo, base, entries, [{ mode: "100644", sha: blob, path: "src/report." }]);
  return { repo, head, contract: contract(base) };
}

// --- 6. symlink-target escape ---

export function symlinkEscape(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const target = hashBlob(repo, "../../../../etc/passwd"); // symlink content = target path
  const head = headWith(repo, base, entries, [{ mode: "120000", sha: target, path: "src/link" }]);
  return { repo, head, contract: contract(base) };
}

export function symlinkAbsolute(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const target = hashBlob(repo, "/etc/shadow");
  const head = headWith(repo, base, entries, [{ mode: "120000", sha: target, path: "src/abs" }]);
  return { repo, head, contract: contract(base) };
}

// --- 7. .gitattributes tampering ---

export function gitattributesTamper(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const blob = hashBlob(repo, "* -diff\n*.js binary\n");
  const head = headWith(repo, base, entries, [
    { mode: "100644", sha: blob, path: ".gitattributes" },
  ]);
  return { repo, head, contract: contract(base) };
}

// --- 8. CI-definition edits ---

export function ciDefinitionEdit(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const blob = hashBlob(repo, "on: push\njobs:\n  x:\n    runs-on: ubuntu-latest\n");
  const head = headWith(repo, base, entries, [
    { mode: "100644", sha: blob, path: ".github/workflows/evil.yml" },
  ]);
  // Widen scope so ONLY the protected-path rule (not out-of-scope) fires.
  return { repo, head, contract: contract(base, ["**"]) };
}

// --- 9. out-of-scope diff ---

export function outOfScope(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const blob = hashBlob(repo, "DB_PASSWORD=hunter2\n");
  const head = headWith(repo, base, entries, [
    { mode: "100644", sha: blob, path: "config/prod.env" },
  ]);
  return { repo, head, contract: contract(base) }; // scope is src/** + README.md
}

// --- 10. worker merge commit ---

export function workerMergeCommit(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const a = hashBlob(repo, "console.log('branch a');\n");
  const treeA = buildTree(repo, [
    { mode: "100644", sha: a, path: "src/app.js" },
    ...entries.filter((e) => e.path !== "src/app.js"),
  ]);
  const branchA = commitTree(repo, treeA, [base], "branch a");
  const rb = hashBlob(repo, "# readme b\n");
  const treeB = buildTree(repo, [
    rb ? { mode: "100644", sha: rb, path: "README.md" } : entries[1]!,
    entries[0]!,
  ]);
  const branchB = commitTree(repo, treeB, [base], "branch b");
  // Merge head with a clean, in-scope tree but two parents.
  const mergeTree = buildTree(repo, [
    { mode: "100644", sha: a, path: "src/app.js" },
    { mode: "100644", sha: rb, path: "README.md" },
  ]);
  const merge = commitTree(repo, mergeTree, [branchA, branchB], "merge branch b into a");
  return { repo, head: merge, contract: contract(base) };
}

// --- 11. submodule / gitlink introduction ---

export function submoduleGitlink(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  // A gitlink entry: mode 160000, sha = any commit (reuse base) at path src/vendor.
  const head = headWith(repo, base, entries, [{ mode: "160000", sha: base, path: "src/vendor" }]);
  return { repo, head, contract: contract(base) };
}

// --- 12. size bomb ---

export function sizeBomb(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const big = hashBlob(repo, "X".repeat(2 * 1024 * 1024)); // 2 MB > maxBlobBytes (1 MB)
  const head = headWith(repo, base, entries, [{ mode: "100644", sha: big, path: "src/big.bin" }]);
  return { repo, head, contract: contract(base) };
}
