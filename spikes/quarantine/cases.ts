// WP-003 rejection-case fixtures. Each builds an untrusted "worker repo" with a base
// and a final head via git PLUMBING, so the exact tree under test exists regardless
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

// --- 1. reachable-history carry-in ---

/** base → C1 (adds a 2 MB secret blob) → C2 (deletes it; clean in-scope head). */
export function reachableHistoryCarryIn(): WorkerFixture & { carriedSha: string } {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const secret = "SECRET-KEY=" + "A".repeat(2 * 1024 * 1024); // 2 MB, > maxBlobBytes
  const carriedSha = hashBlob(repo, secret);
  const c1Tree = buildTree(repo, [
    ...entries,
    { mode: "100644", sha: carriedSha, path: "src/leak.bin" },
  ]);
  const c1 = commitTree(repo, c1Tree, [base], "add secret (intermediate)");
  const app = hashBlob(repo, "console.log('clean');\n");
  const c2Tree = buildTree(repo, [
    { mode: "100644", sha: app, path: "src/app.js" },
    ...entries.filter((e) => e.path !== "src/app.js"),
  ]);
  const c2 = commitTree(repo, c2Tree, [c1], "clean up");
  return { repo, head: c2, contract: contract(base), carriedSha };
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

// --- 7. .gitattributes edit ---

export function gitattributesEdit(): WorkerFixture {
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
    { mode: "100644", sha: blob, path: ".github/workflows/added.yml" },
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

// --- 11b/c. `.git` directory entry via aliases + symlink into .git ---
//
// A LITERAL `.git` tree entry is refused by git's own object layer at both write
// (hash-object) and transfer (index-pack, per CVE-2019-1349), so it cannot be
// constructed with git tooling — git already blocks that case, and a policy unit
// test proves checkDotGitPaths would also reject it. The cases git PERMITS are
// the Windows 8.3 short-name alias (`GIT~1`, which resolves to `.git` on Windows)
// and a symlink whose TARGET dives into `.git`; those are what our check adds.

export function dotGitAlias(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const cfg = hashBlob(repo, "[core]\n\thooksPath = .\n");
  // 8.3 short-name alias of ".git" that Windows resolves to the real dir.
  const head = headWith(repo, base, entries, [{ mode: "100644", sha: cfg, path: "GIT~1/config" }]);
  return { repo, head, contract: contract(base, ["**"]) };
}

export function symlinkIntoDotGit(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const target = hashBlob(repo, ".git/hooks"); // in-root by depth, but dives into .git
  const head = headWith(repo, base, entries, [
    { mode: "120000", sha: target, path: "src/hooklink" },
  ]);
  return { repo, head, contract: contract(base) };
}

// --- review r1 folds: case-spelled protected path, deep-nesting budget breach,
//     drive-relative symlink, superscript device name, full-fold collision ---

export function protectedPathCaseVariant(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const blob = hashBlob(repo, "* -diff\n");
  // `.GITATTRIBUTES` resolves to `.gitattributes` on a case-insensitive host.
  const head = headWith(repo, base, entries, [
    { mode: "100644", sha: blob, path: ".GITATTRIBUTES" },
  ]);
  return { repo, head, contract: contract(base, ["**"]) };
}

export function deepNestingBudgetBreach(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const blob = hashBlob(repo, "x\n");
  // One leaf, but ~26 intermediate tree objects — invisible to a leaf-only count.
  const deepPath = "src/" + Array(25).fill("d").join("/") + "/leaf.txt";
  const head = headWith(repo, base, entries, [{ mode: "100644", sha: blob, path: deepPath }]);
  return { repo, head, contract: { base, allowedPaths: ["**"], budgets: { maxEntries: 10 } } };
}

export function symlinkDriveRelative(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const target = hashBlob(repo, "C:Windows/System32/config/SAM"); // drive-relative
  const head = headWith(repo, base, entries, [{ mode: "120000", sha: target, path: "src/dr" }]);
  return { repo, head, contract: contract(base) };
}

export function reservedSuperscript(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const blob = hashBlob(repo, "device\n");
  const head = headWith(repo, base, entries, [{ mode: "100644", sha: blob, path: "src/COM².txt" }]);
  return { repo, head, contract: contract(base) };
}

export function unicodeFoldCollision(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const a = hashBlob(repo, "sharp-s\n");
  const b = hashBlob(repo, "double-s\n");
  // "straße" and "STRASSE" collide under full Unicode case-folding (ß ⇄ SS).
  const head = headWith(repo, base, entries, [
    { mode: "100644", sha: a, path: "src/straße.txt" },
    { mode: "100644", sha: b, path: "src/STRASSE.txt" },
  ]);
  return { repo, head, contract: contract(base) };
}

// --- review r2 folds ---

/** Rename `.gitattributes` → `src/attrs.txt`: the SOURCE deletion is protected. */
export function renameHidesProtected(): WorkerFixture {
  const repo = initRepo();
  const app = hashBlob(repo, "console.log('app');\n");
  const attrs = hashBlob(repo, "* text\n");
  const baseTree = buildTree(repo, [
    { mode: "100644", sha: app, path: "src/app.js" },
    { mode: "100644", sha: attrs, path: ".gitattributes" },
  ]);
  const base = commitTree(repo, baseTree, [], "base");
  const headTree = buildTree(repo, [
    { mode: "100644", sha: app, path: "src/app.js" },
    { mode: "100644", sha: attrs, path: "src/attrs.txt" }, // moved out of root
  ]);
  const head = commitTree(repo, headTree, [base], "rename .gitattributes");
  return { repo, head, contract: contract(base, ["src/**"]) };
}

/** `.git::$INDEX_ALLOCATION/config` — NTFS alternate-stream spelling of `.git`. */
export function ntfsDotGitAds(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const cfg = hashBlob(repo, "[core]\n\thooksPath = .\n");
  const head = headWith(repo, base, entries, [
    { mode: "100644", sha: cfg, path: ".git::$INDEX_ALLOCATION/config" },
  ]);
  return { repo, head, contract: contract(base, ["**"]) };
}

/** `docs\note` (backslash segment) collides with `docs/note` on Windows. */
export function backslashCollision(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const a = hashBlob(repo, "fwd\n");
  const b = hashBlob(repo, "bwd\n");
  const head = headWith(repo, base, entries, [
    { mode: "100644", sha: a, path: "docs/note" },
    { mode: "100644", sha: b, path: "docs\\note" },
  ]);
  return { repo, head, contract: contract(base, ["**"]) };
}

/** A symlink whose target carries a NUL byte cannot materialize faithfully. */
export function nulSymlinkTarget(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const target = hashBlob(repo, "safe\0../../../../etc/passwd");
  const head = headWith(repo, base, entries, [{ mode: "120000", sha: target, path: "src/nul" }]);
  return { repo, head, contract: contract(base) };
}

/** A gitlink already present + unchanged in the base must NOT be rejected. */
export function unchangedGitlinkAllowed(): WorkerFixture {
  const repo = initRepo();
  const app = hashBlob(repo, "console.log('app');\n");
  const readme = hashBlob(repo, "# sample\n");
  // A real commit sha to point the gitlink at.
  const pointer = commitTree(
    repo,
    buildTree(repo, [{ mode: "100644", sha: app, path: "x" }]),
    [],
    "ptr",
  );
  const baseEntries: CacheEntry[] = [
    { mode: "100644", sha: app, path: "src/app.js" },
    { mode: "100644", sha: readme, path: "README.md" },
    { mode: "160000", sha: pointer, path: "vendor/lib" },
  ];
  const base = commitTree(repo, buildTree(repo, baseEntries), [], "base with submodule");
  const app2 = hashBlob(repo, "console.log('v2');\n");
  const headEntries = baseEntries.map((e) => (e.path === "src/app.js" ? { ...e, sha: app2 } : e));
  const head = commitTree(repo, buildTree(repo, headEntries), [base], "change app only");
  return { repo, head, contract: contract(base, ["src/**", "README.md", "vendor/**"]) };
}

// --- review r3 folds ---

/** `.git<U+200C>/config` — HFS-ignorable char makes it `.git` on HFS+; git fsck catches it. */
export function hfsDotGit(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const cfg = hashBlob(repo, "[core]\n\thooksPath = .\n");
  const head = headWith(repo, base, entries, [{ mode: "100644", sha: cfg, path: ".git‌/config" }]);
  return { repo, head, contract: contract(base, ["**"]) };
}

/** A "symlink" whose target blob is far larger than PATH_MAX — reject on size. */
export function oversizeSymlink(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const target = hashBlob(repo, "x".repeat(64 * 1024)); // 64 KiB > 4 KiB PATH_MAX
  const head = headWith(repo, base, entries, [{ mode: "120000", sha: target, path: "src/fat" }]);
  return { repo, head, contract: contract(base) };
}

/** Root file `A` collides with directory component `a/` on a case-insensitive FS. */
export function ancestorComponentCollision(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const a = hashBlob(repo, "file A\n");
  const b = hashBlob(repo, "under a\n");
  const head = headWith(repo, base, entries, [
    { mode: "100644", sha: a, path: "A" },
    { mode: "100644", sha: b, path: "a/file" },
  ]);
  return { repo, head, contract: contract(base, ["**"]) };
}

// --- 12. size-budget breach ---

export function oversizeBlob(): WorkerFixture {
  const repo = initRepo();
  const { base, entries } = makeBase(repo);
  const big = hashBlob(repo, "X".repeat(2 * 1024 * 1024)); // 2 MB > maxBlobBytes (1 MB)
  const head = headWith(repo, base, entries, [{ mode: "100644", sha: big, path: "src/big.bin" }]);
  return { repo, head, contract: contract(base) };
}
