// WP-108 quarantine — PRODUCT-grade behavior beyond the WP-003 corpus
// (CAM-EXEC-04): the emitted quarantined diff, WP-110 contract binding, the
// registry-item-11 fetch budget, the credentialed-git / worker-touched-dir
// boundary, and a production-shape smoke test of the real intake entry.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  contractHash,
  contractRefProblems,
  quarantinedDiffProblems,
  REGISTRY_ITEM_11_QUOTAS,
  type ContractRef,
  type ContractTerms,
} from "@camino/shared";
import {
  buildTree,
  buildTreeBulk,
  cleanupRepos,
  commitTree,
  git,
  hashBlob,
  hashManyDistinctBlobs,
  initRepo,
  type CacheEntry,
} from "./corpus-git.js";
import { assertSelfContainedObjectStore, objectFormatOfRepo, storeSizeBytes } from "./git.js";
import { cleanupPristineRepos, runIntake } from "./intake.js";
import {
  checkFetchBudget,
  checkPathCollisions,
  isProtectedPath,
  REGISTRY_ITEM_11_FETCH_BUDGET,
} from "./policy.js";
import { MAX_STORED_PATH_LENGTH } from "./types.js";
import type { QuarantineAssignment, TreeEntry } from "./types.js";

const testDirs: string[] = [];
afterAll(() => {
  cleanupRepos();
  cleanupPristineRepos();
  for (const d of testDirs) rmSync(d, { recursive: true, force: true });
});

/** A trusted base with two in-scope files, plus a clean in-scope worker head. */
function acceptedFixture(): {
  repo: string;
  base: string;
  head: string;
  assignment: QuarantineAssignment;
} {
  const repo = initRepo();
  const app = hashBlob(repo, "console.log('app');\n");
  const readme = hashBlob(repo, "# repo\n");
  const baseEntries: CacheEntry[] = [
    { mode: "100644", sha: app, path: "src/app.js" },
    { mode: "100644", sha: readme, path: "README.md" },
  ];
  const base = commitTree(repo, buildTree(repo, baseEntries), [], "base");
  const app2 = hashBlob(repo, "console.log('app v2');\n");
  const doc = hashBlob(repo, "# repo\n\nnow documented\n");
  const headEntries: CacheEntry[] = [
    { mode: "100644", sha: app2, path: "src/app.js" }, // modified
    { mode: "100644", sha: readme, path: "README.md" }, // unchanged
    { mode: "100644", sha: hashBlob(repo, "new\n"), path: "src/new.js" }, // added
    { mode: "100644", sha: doc, path: "docs/guide.md" }, // added (in scope via **)
  ];
  const head = commitTree(repo, buildTree(repo, headEntries), [base], "feat: v2");
  const assignment: QuarantineAssignment = { base, allowedPaths: ["**"] };
  return { repo, base, head, assignment };
}

describe("emitted quarantined diff (WP-111 / WP-116 input)", () => {
  it("emits a well-formed diff with candidate identity and typed changed paths", () => {
    const fx = acceptedFixture();
    const r = runIntake(fx.repo, fx.head, fx.assignment);
    expect(r.accepted).toBe(true);
    expect(r.diff).not.toBeNull();
    const diff = r.diff!;
    // Identity: candidate is the Camino-authored commit; base_sha is the assigned
    // base; workerHeadSha is what it was rebuilt from; none coincide.
    expect(diff.candidateSha).toBe(r.rebuilt!.sha);
    expect(diff.baseSha).toBe(fx.base);
    expect(diff.workerHeadSha).toBe(r.workerHead);
    expect(diff.candidateSha).not.toBe(diff.workerHeadSha);
    expect(diff.attributionTrailer).toBe(`Camino-Worker-Attribution: ${r.workerHead}`);
    // Changed paths: sorted, typed, and complete against the base.
    expect(diff.changedPaths).toEqual([
      { path: "docs/guide.md", change: "added" },
      { path: "src/app.js", change: "modified" },
      { path: "src/new.js", change: "added" },
    ]);
    // The artifact validates against the shared schema (a consumer would adopt it).
    expect(quarantinedDiffProblems(diff)).toEqual([]);
  });

  it("records a deletion as a typed changed path", () => {
    const repo = initRepo();
    const a = hashBlob(repo, "a\n");
    const b = hashBlob(repo, "b\n");
    const base = commitTree(
      repo,
      buildTree(repo, [
        { mode: "100644", sha: a, path: "src/a.js" },
        { mode: "100644", sha: b, path: "src/b.js" },
      ]),
      [],
      "base",
    );
    const head = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: a, path: "src/a.js" }]),
      [base],
      "drop b",
    );
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(true);
    expect(r.diff!.changedPaths).toEqual([{ path: "src/b.js", change: "deleted" }]);
  });
});

describe("WP-110 contract binding", () => {
  function contractRef(): ContractRef {
    const terms: ContractTerms = {
      schemaVersion: 1,
      missionId: "M1",
      issueId: "M1.108",
      version: 1,
      template: "feature",
      title: "Quarantine module",
      goal: "Squash-and-rebuild intake",
      acceptanceCriteria: ["the corpus passes"],
      requirementIds: ["CAM-EXEC-04"],
      dependsOn: [],
      interfaces: [],
    };
    return {
      issueId: terms.issueId,
      contractVersion: terms.version,
      contractHash: contractHash(terms),
    };
  }

  it("stamps the ContractRef onto the emitted diff and validates it", () => {
    const ref = contractRef();
    expect(contractRefProblems(ref)).toEqual([]);
    const fx = acceptedFixture();
    const r = runIntake(fx.repo, fx.head, { ...fx.assignment, contractRef: ref });
    expect(r.diff!.contractRef).toEqual(ref);
    expect(quarantinedDiffProblems(r.diff)).toEqual([]);
  });

  it("emits a null contractRef when the assignment supplies none", () => {
    const fx = acceptedFixture();
    const r = runIntake(fx.repo, fx.head, fx.assignment);
    expect(r.diff!.contractRef).toBeNull();
    expect(quarantinedDiffProblems(r.diff)).toEqual([]);
  });
});

describe("registry-item-11 fetch budget (CAM-EXEC-04)", () => {
  it("wires the exact registry-item-11 numbers (one source, no drift)", () => {
    expect(REGISTRY_ITEM_11_FETCH_BUDGET.maxObjects).toBe(5_000);
    expect(REGISTRY_ITEM_11_FETCH_BUDGET.maxBytes).toBe(500_000_000);
    expect(REGISTRY_ITEM_11_FETCH_BUDGET.maxObjects).toBe(REGISTRY_ITEM_11_QUOTAS.fetch.maxObjects);
    expect(REGISTRY_ITEM_11_FETCH_BUDGET.maxBytes).toBe(REGISTRY_ITEM_11_QUOTAS.fetch.maxBytes);
  });

  it("checkFetchBudget flags an over-object and over-size footprint; a within-budget one passes", () => {
    expect(checkFetchBudget(6_000, 0).map((r) => r.code)).toEqual(["fetch-object-budget"]);
    expect(checkFetchBudget(1, 600_000_000).map((r) => r.code)).toEqual(["fetch-size-budget"]);
    expect(checkFetchBudget(5_000, 500_000_000)).toEqual([]);
  });

  it("counts DISTINCT objects: 5,001 paths sharing ONE blob do NOT trip the fetch-object budget", () => {
    // The fetch budget measures the TRANSFER footprint — distinct objects — so a
    // single blob referenced at 5,001 paths is one object, not 5,001 (review r1
    // finding 8: the old measure counted repeated paths and would have tripped
    // fetch-object-budget here). The tree is still huge by ENTRY count, so it is
    // rejected — but by the policy entry-budget, NOT the distinct-object fetch cap.
    const repo = initRepo();
    const readme = hashBlob(repo, "# base\n");
    const base = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: readme, path: "README.md" }]),
      [],
      "base",
    );
    const blob = hashBlob(repo, "x\n");
    const entries: CacheEntry[] = [{ mode: "100644", sha: readme, path: "README.md" }];
    for (let i = 0; i < 5001; i++) {
      entries.push({ mode: "100644", sha: blob, path: `many/f${String(i).padStart(5, "0")}` });
    }
    const head = commitTree(repo, buildTreeBulk(repo, entries), [base], "many files");
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(false);
    const codes = r.rejections.map((x) => x.code);
    expect(codes).toContain("entry-budget"); // too many tree ENTRIES
    expect(codes).not.toContain("fetch-object-budget"); // but only ONE distinct blob object
  });

  it("rejects end-to-end when the DISTINCT-object footprint exceeds 5,000", () => {
    // 5,001 DISTINCT blobs in a flat directory → >5,000 distinct objects, a
    // genuine over-budget transfer. Distinct objects must go WIDE, not deep: git's
    // upload-pack refuses to serve a tree past its max depth, so a deep chain
    // cannot even be fetched. Trips the registry-item-11 fetch-object budget (the
    // entry-budget also fires — collect-all — which is fine).
    const repo = initRepo();
    const readme = hashBlob(repo, "# base\n");
    const base = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: readme, path: "README.md" }]),
      [],
      "base",
    );
    const shas = hashManyDistinctBlobs(repo, 5001);
    const entries: CacheEntry[] = [{ mode: "100644", sha: readme, path: "README.md" }];
    shas.forEach((sha, i) => {
      entries.push({ mode: "100644", sha, path: `many/f${String(i).padStart(5, "0")}` });
    });
    const head = commitTree(repo, buildTreeBulk(repo, entries), [base], "many distinct");
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain("fetch-object-budget");
  });

  it("clamps a widened budget to stricter-only (a per-issue override cannot loosen the cap)", () => {
    // review r1 finding 7: a contract override may only TIGHTEN the tree-size
    // budget. A caller asking for a 10 MB per-blob cap does not get to admit a
    // 2 MB blob that the 1 MB default rejects.
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const base = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: app, path: "src/app.js" }]),
      [],
      "base",
    );
    const big = hashBlob(repo, "X".repeat(2 * 1024 * 1024)); // 2 MB > 1 MB default
    const head = commitTree(
      repo,
      buildTree(repo, [
        { mode: "100644", sha: app, path: "src/app.js" },
        { mode: "100644", sha: big, path: "src/big.bin" },
      ]),
      [base],
      "add big",
    );
    const widened = runIntake(repo, head, {
      base,
      allowedPaths: ["**"],
      budgets: { maxBlobBytes: 10 * 1024 * 1024 }, // attempt to widen — must be ignored
    });
    expect(widened.accepted).toBe(false);
    expect(widened.rejections.map((x) => x.code)).toContain("blob-size-budget");
  });
});

describe("credentialed-git / worker-touched-directory boundary (CAM-EXEC-04, CAM-SEC-01)", () => {
  it("runs git only in a hooks-disabled, credential-free pristine repo", () => {
    const fx = acceptedFixture();
    const r = runIntake(fx.repo, fx.head, fx.assignment);
    // The pristine store the intake operates is hooks-disabled and carries no
    // credential helper — the design §5.1 "pristine, hooks-disabled clone".
    expect(git(r.pristineDir, "config", "--get", "core.hooksPath")).toBe("/dev/null");
    // credential.helper is reset to empty (a --get on an empty value exits 0 with
    // a blank line, or is simply absent); either way no helper is configured.
    const helper = readConfigOrEmpty(r.pristineDir, "credential.helper");
    expect(helper).toBe("");
  });

  it("never writes into the worker-touched directory (git executes only in the pristine repo)", () => {
    const fx = acceptedFixture();
    const before = snapshotGitDir(fx.repo);
    runIntake(fx.repo, fx.head, fx.assignment);
    const after = snapshotGitDir(fx.repo);
    // The control plane reads the worker repo solely as a fetch source (its
    // upload-pack serves objects); it must not mutate the worker's refs or write
    // a FETCH_HEAD there — so the worker `.git` ref/HEAD surface is unchanged.
    expect(after.refs).toEqual(before.refs);
    expect(after.hasFetchHead).toBe(before.hasFetchHead);
    expect(existsSync(join(fx.repo, ".git", "FETCH_HEAD"))).toBe(false);
  });

  it("ignores a hooksPath planted in the worker repo (no hook fires during intake)", () => {
    // A worker could point its OWN clone's hooksPath at an executable and rely on
    // a control-plane git op in that dir triggering it. The intake runs no git in
    // the worker dir, so the sentinel the hook would write never appears.
    const fx = acceptedFixture();
    const hooksDir = join(fx.repo, "planted-hooks");
    mkdirSync(hooksDir, { recursive: true });
    const sentinel = join(fx.repo, "HOOK_FIRED");
    for (const name of ["post-checkout", "pre-receive", "post-receive", "post-update"]) {
      const hook = join(hooksDir, name);
      writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\n`, { mode: 0o755 });
    }
    git(fx.repo, "config", "core.hooksPath", hooksDir);
    const r = runIntake(fx.repo, fx.head, fx.assignment);
    expect(r.accepted).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
  });
});

describe("production-shape smoke: trusted base source distinct from the worker clone", () => {
  it("rebuilds the worker head onto a base fetched from a SEPARATE trusted repo", () => {
    // Production shape: the assigned base comes from the control-plane origin, not
    // the worker clone (IntakeOptions.baseRepo). Deterministic commit dates make
    // the identical base commit share one sha across both repos.
    const app = "console.log('app');\n";
    const trusted = initRepo();
    const worker = initRepo();
    const baseInTrusted = buildBase(trusted, app);
    const baseInWorker = buildBase(worker, app);
    expect(baseInWorker).toBe(baseInTrusted); // same content + date ⇒ same sha

    const app2 = hashBlob(worker, "console.log('app v2');\n");
    const head = commitTree(
      worker,
      buildTree(worker, [{ mode: "100644", sha: app2, path: "src/app.js" }]),
      [baseInWorker],
      "fix: v2",
    );

    const r = runIntake(
      worker,
      head,
      { base: baseInTrusted, allowedPaths: ["src/**"] },
      { baseRepo: trusted },
    );
    expect(r.accepted).toBe(true);
    expect(r.rebuilt!.parents).toEqual([baseInTrusted]);
    expect(r.diff!.baseSha).toBe(baseInTrusted);
    expect(r.diff!.changedPaths).toEqual([{ path: "src/app.js", change: "modified" }]);
  });

  it("re-authors deterministically: identical inputs yield the identical candidate sha", () => {
    const fx = acceptedFixture();
    const a = runIntake(fx.repo, fx.head, fx.assignment);
    const b = runIntake(fx.repo, fx.head, fx.assignment);
    expect(a.rebuilt!.sha).toBe(b.rebuilt!.sha);
  });
});

describe("round-1 falsification fixes", () => {
  const leaf = (path: string): TreeEntry => ({
    mode: "100644",
    type: "blob",
    sha: "x",
    size: 1,
    path,
  });

  it("refuses a ref-string (refspec) as the worker head — only a bare OID is accepted", () => {
    const fx = acceptedFixture();
    // The refspec-injection vector: a `<src>:<dst>` string that git would write to
    // refs/replace/*. isOid rejects it before any fetch (review r1 findings 1, 2).
    expect(() => runIntake(fx.repo, `${fx.head}:refs/replace/${fx.base}`, fx.assignment)).toThrow(
      /bare git object id/,
    );
    expect(() => runIntake(fx.repo, "refs/heads/*", fx.assignment)).toThrow(/bare git object id/);
  });

  it("strengthened fold catches same-script APFS aliases missed before (review r1 finding 6)", () => {
    // ẞ (capital sharp S) ⇄ SS, and combining ypogegrammeni ⇄ iota: same-inode on
    // a case-insensitive APFS/HFS+ volume, missed by the pre-fix fold.
    expect(checkPathCollisions([leaf("ẞ.txt"), leaf("SS.txt")]).length).toBe(1);
    expect(
      checkPathCollisions([
        leaf(String.fromCodePoint(0x0345) + ".txt"),
        leaf(String.fromCodePoint(0x03b9) + ".txt"),
      ]).length,
    ).toBe(1);
    // …while an accent difference is NOT a collision (no over-reject of café/cafe).
    expect(
      checkPathCollisions([leaf("caf" + String.fromCodePoint(0x00e9) + ".txt"), leaf("cafe.txt")]),
    ).toEqual([]);
  });

  it("protects local actions and rejects a .gitmodules retarget (review r1 findings 3, 5)", () => {
    expect(isProtectedPath(".github/actions/local/action.yml")).toBe(true);
    expect(isProtectedPath(".github/workflows/ci.yml")).toBe(true);
    expect(isProtectedPath(".github/CODEOWNERS")).toBe(false); // non-executing policy file

    // A worker that leaves an existing gitlink OID untouched but retargets it via
    // .gitmodules is rejected.
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const gm = hashBlob(
      repo,
      '[submodule "lib"]\n  path = lib\n  url = https://safe.example/lib\n',
    );
    const base = commitTree(
      repo,
      buildTree(repo, [
        { mode: "100644", sha: app, path: "src/app.js" },
        { mode: "100644", sha: gm, path: ".gitmodules" },
      ]),
      [],
      "base",
    );
    const gm2 = hashBlob(
      repo,
      '[submodule "lib"]\n  path = lib\n  url = https://attacker.example/lib\n',
    );
    const head = commitTree(
      repo,
      buildTree(repo, [
        { mode: "100644", sha: app, path: "src/app.js" },
        { mode: "100644", sha: gm2, path: ".gitmodules" },
      ]),
      [base],
      "retarget submodule url",
    );
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain("submodule-gitlink");
  });

  it("rejects an over-long path as a policy result, never a thrown emitter (review r1 finding 10)", () => {
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const base = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: app, path: "src/app.js" }]),
      [],
      "base",
    );
    const blob = hashBlob(repo, "x\n");
    // A single long FILENAME (one directory level) past MAX_STORED_PATH_LENGTH —
    // shallow, so git's upload-pack serves it (a deep path would be refused by
    // git before any policy runs); valid to git, over the policy cap.
    const longPath = "many/" + "a".repeat(MAX_STORED_PATH_LENGTH + 200) + ".txt";
    expect(longPath.length).toBeGreaterThan(MAX_STORED_PATH_LENGTH);
    const head = commitTree(
      repo,
      buildTree(repo, [
        { mode: "100644", sha: app, path: "src/app.js" },
        { mode: "100644", sha: blob, path: longPath },
      ]),
      [base],
      "long path",
    );
    // No throw: a rejection result, not a QuarantineGitError from the emitter.
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain("path-too-long");
    expect(r.diff).toBeNull();
  });

  it("refuses a worker repo that borrows objects via alternates (review r1 finding 4)", () => {
    const fx = acceptedFixture();
    // Plant an alternates file: the worker store would borrow from an external
    // store, letting its upload-pack serve objects it does not itself contain.
    writeFileSync(join(fx.repo, ".git", "objects", "info", "alternates"), "/some/other/objects\n");
    expect(() => runIntake(fx.repo, fx.head, fx.assignment)).toThrow(
      /borrows from an external store/,
    );
  });
});

describe("round-2 falsification fixes", () => {
  /** Head = base + one added file at `path`, rebuilt on base. */
  function headAdding(repo: string, base: string, baseFile: CacheEntry, path: string): string {
    const blob = hashBlob(repo, "x\n");
    return commitTree(
      repo,
      buildTree(repo, [baseFile, { mode: "100644", sha: blob, path }]),
      [base],
      "add",
    );
  }

  it("protects a canonical ALIAS of a protected path (.gitattributeſ → .gitattributes) — r2 #1", () => {
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const baseFile: CacheEntry = { mode: "100644", sha: app, path: "src/app.js" };
    const base = commitTree(repo, buildTree(repo, [baseFile]), [], "base");
    // long-s ⇄ s under NFKC: a case-insensitive/normalizing FS resolves this to
    // `.gitattributes`, so it must be rejected as protected.
    const head = headAdding(repo, base, baseFile, ".gitattribute" + String.fromCodePoint(0x017f));
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain("protected-path");
  });

  it("rejects a case-alias .gitmodules retarget (.GitModules) — r2 #4", () => {
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const baseFile: CacheEntry = { mode: "100644", sha: app, path: "src/app.js" };
    const base = commitTree(repo, buildTree(repo, [baseFile]), [], "base");
    const head = headAdding(repo, base, baseFile, ".GitModules");
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain("submodule-gitlink");
  });

  it("a NaN budget override cannot widen the cap — r2 #5", () => {
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const base = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: app, path: "src/app.js" }]),
      [],
      "base",
    );
    const big = hashBlob(repo, "X".repeat(2 * 1024 * 1024)); // 2 MB > 1 MB default
    const head = commitTree(
      repo,
      buildTree(repo, [
        { mode: "100644", sha: app, path: "src/app.js" },
        { mode: "100644", sha: big, path: "src/big.bin" },
      ]),
      [base],
      "add big",
    );
    const r = runIntake(repo, head, {
      base,
      allowedPaths: ["**"],
      budgets: { maxBlobBytes: Number.NaN }, // NaN must NOT disable the size check
    });
    expect(r.accepted).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain("blob-size-budget");
  });

  it("rejects an unbounded commit message as a policy result, not a thrown emitter — r2 #6", () => {
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const base = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: app, path: "src/app.js" }]),
      [],
      "base",
    );
    const app2 = hashBlob(repo, "console.log('v2');\n");
    // A commit message well over MAX_COMMIT_OBJECT_BYTES (built via stdin).
    const head = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: app2, path: "src/app.js" }]),
      [base],
      "x".repeat(2 * 1024 * 1024),
    );
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain("commit-metadata-budget");
    expect(r.diff).toBeNull();
  });

  it("validates a DELETED path (over the cap) as a rejection, not a thrown emitter — r2 #7", () => {
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const longName = "many/" + "a".repeat(MAX_STORED_PATH_LENGTH + 200) + ".txt";
    const longBlob = hashBlob(repo, "y\n");
    const base = commitTree(
      repo,
      buildTree(repo, [
        { mode: "100644", sha: app, path: "src/app.js" },
        { mode: "100644", sha: longBlob, path: longName },
      ]),
      [],
      "base",
    );
    // Head DELETES the long path (it is not in the final tree, so entry-level
    // checks never see it — only the changed-path check does).
    const head = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: app, path: "src/app.js" }]),
      [base],
      "delete long",
    );
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain("path-too-long");
    expect(r.diff).toBeNull();
  });

  it("refuses a gitfile `.git` (linked-worktree) worker repo — r2 #3", () => {
    // assertSelfContainedObjectStore refuses a `.git` that is a FILE, not a dir,
    // since a commondir redirect could hide a borrowing store.
    const dir = mkdtempTestDir();
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/w\n");
    expect(() => assertSelfContainedObjectStore(dir)).toThrow(/gitfile\/symlink|real `\.git`/);
  });
});

describe("round-3 falsification fixes", () => {
  /** Base = app.js + `extra`; head = app.js only (deletes `extra`). Returns {repo, base, head}. */
  function deletingFixture(extraPath: string): { repo: string; base: string; head: string } {
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const extra = hashBlob(repo, "x\n");
    const base = commitTree(
      repo,
      buildTree(repo, [
        { mode: "100644", sha: app, path: "src/app.js" },
        { mode: "100644", sha: extra, path: extraPath },
      ]),
      [],
      "base",
    );
    const head = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: app, path: "src/app.js" }]),
      [base],
      "delete extra",
    );
    return { repo, base, head };
  }

  it("protects a Windows-alias DELETION of a protected path (.gitattributes.) — r3 #1", () => {
    const fx = deletingFixture(".gitattributes."); // trailing dot resolves to .gitattributes
    const r = runIntake(fx.repo, fx.head, { base: fx.base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain("protected-path");
  });

  it("rejects a backslash DELETION as a policy result, not a thrown emitter — r3 #3", () => {
    const fx = deletingFixture("docs\\note"); // backslash path, only seen via the changed set
    const r = runIntake(fx.repo, fx.head, { base: fx.base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain("windows-alias");
    expect(r.diff).toBeNull();
  });

  it("refuses a commondir redirect and a symlinked objects store — r3 #2", () => {
    // commondir file (real .git dir but external common store)
    const a = mkdtempTestDir();
    mkdirSync(join(a, ".git"), { recursive: true });
    writeFileSync(join(a, ".git", "commondir"), "/elsewhere/.git\n");
    expect(() => assertSelfContainedObjectStore(a)).toThrow(/commondir/);

    // symlinked objects dir
    const b = mkdtempTestDir();
    mkdirSync(join(b, ".git"), { recursive: true });
    symlinkSync("/elsewhere/objects", join(b, ".git", "objects"));
    expect(() => assertSelfContainedObjectStore(b)).toThrow(/symlink/);
  });
});

describe("round-4 falsification fixes", () => {
  it("rejects an added NTFS 8.3 short-name alias of a protected path (GITATT~1) — r4 #1", () => {
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const base = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: app, path: "src/app.js" }]),
      [],
      "base",
    );
    const blob = hashBlob(repo, "x\n");
    const head = commitTree(
      repo,
      buildTree(repo, [
        { mode: "100644", sha: app, path: "src/app.js" },
        { mode: "100644", sha: blob, path: "GITATT~1" }, // 8.3 alias of .gitattributes
      ]),
      [base],
      "add 8.3 alias",
    );
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain("windows-alias");
  });

  it("refuses a bare repo and a symlinked objects/pack store — r4 #2", () => {
    // A bare repo (no .git) is refused outright.
    const bare = mkdtempTestDir();
    mkdirSync(join(bare, "objects", "pack"), { recursive: true });
    expect(() => assertSelfContainedObjectStore(bare)).toThrow(/real `\.git` directory/);

    // A symlinked objects/pack (below the previously-checked levels) is refused.
    const c = mkdtempTestDir();
    mkdirSync(join(c, ".git", "objects"), { recursive: true });
    symlinkSync("/elsewhere/pack", join(c, ".git", "objects", "pack"));
    expect(() => assertSelfContainedObjectStore(c)).toThrow(/symlink/);
  });

  it("rejects a huge-object-count tree on its count, without reading leaves or throwing — r4 #3", () => {
    // >5,000 DISTINCT objects ⇒ rejected on the PATH-FREE count before the leaves
    // are read (the ENOBUFS route). 5,001 distinct blobs suffices to exercise it.
    const repo = initRepo();
    const readme = hashBlob(repo, "# base\n");
    const base = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: readme, path: "README.md" }]),
      [],
      "base",
    );
    const shas = hashManyDistinctBlobs(repo, 5001);
    const entries: CacheEntry[] = [{ mode: "100644", sha: readme, path: "README.md" }];
    shas.forEach((sha, i) => {
      entries.push({ mode: "100644", sha, path: `many/f${String(i).padStart(5, "0")}` });
    });
    const head = commitTree(repo, buildTreeBulk(repo, entries), [base], "many distinct");
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain("fetch-object-budget");
    expect(r.diff).toBeNull();
  });
});

describe("round-5 falsification fixes", () => {
  it("rejects Git's HASH-based 8.3 fallback alias of a protected path (GI7D29~1) — r5 #1", () => {
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const base = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: app, path: "src/app.js" }]),
      [],
      "base",
    );
    const blob = hashBlob(repo, "x\n");
    // `.gitattributes` real NTFS short name is GI7D29~1 (hash-based, not GITATT~1).
    const head = commitTree(
      repo,
      buildTree(repo, [
        { mode: "100644", sha: app, path: "src/app.js" },
        { mode: "100644", sha: blob, path: "GI7D29~1" },
      ]),
      [base],
      "add git hash 8.3 alias",
    );
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain("windows-alias");
  });

  it("refuses a NESTED symlinked pack file — r5 #2", () => {
    // symlinked objects/pack/*.pack (two levels deep — below the r4 checks)
    const a = mkdtempTestDir();
    mkdirSync(join(a, ".git", "objects", "pack"), { recursive: true });
    symlinkSync("/elsewhere/pack-x.pack", join(a, ".git", "objects", "pack", "pack-x.pack"));
    expect(() => assertSelfContainedObjectStore(a)).toThrow(/non-local/);
  });

  it("refuses a hardlinked object file (nlink>1 — external mutation channel) — r7 #3", () => {
    // A hardlinked pack shares its inode with another directory entry, so a write
    // through the OTHER link mutates this store's object (the concrete r7 attack:
    // a donor-side write corrupting the worker's admitted object). WP-107
    // provisions worker clones WITHOUT such links; mirror that authoritative
    // refusal. (My r6 "hardlinks are normal" carve-out was a regression.)
    const donor = mkdtempTestDir();
    mkdirSync(join(donor, "shared.pack.d"), { recursive: true });
    const real = join(donor, "real.pack");
    writeFileSync(real, "PACK");
    const b = mkdtempTestDir();
    mkdirSync(join(b, ".git", "objects", "pack"), { recursive: true });
    linkSync(real, join(b, ".git", "objects", "pack", "pack-shared.pack")); // nlink=2, shared with donor
    expect(() => assertSelfContainedObjectStore(b)).toThrow(/non-local\/unexpected/);
  });

  it("refuses a FIFO (or other non-file/dir node) in the object store — r6 #5", () => {
    // A FIFO is neither symlink, dir, nor regular file: it must fail closed, not
    // fall through as "safe" (and reading through it would hang the intake).
    const c = mkdtempTestDir();
    mkdirSync(join(c, ".git", "objects", "pack"), { recursive: true });
    const fifo = join(c, ".git", "objects", "pack", "pack-fifo.pack");
    execFileSync("mkfifo", [fifo]);
    expect(() => assertSelfContainedObjectStore(c)).toThrow(/non-local\/unexpected/);
  });
});

describe("round-6 falsification fixes", () => {
  it("rejects an HFS-ignorable-char alias of a protected path (.git<U+200C>attributes) — r6 #2", () => {
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const base = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: app, path: "src/app.js" }]),
      [],
      "base",
    );
    const blob = hashBlob(repo, "x\n");
    // HFS+ ignores U+200C in name comparison, so this is `.gitattributes` there.
    const alias = ".git" + String.fromCodePoint(0x200c) + "attributes";
    const head = commitTree(
      repo,
      buildTree(repo, [
        { mode: "100644", sha: app, path: "src/app.js" },
        { mode: "100644", sha: blob, path: alias },
      ]),
      [base],
      "add hfs-ignorable alias",
    );
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain("protected-path");
  });

  it("rejects a zero-prefix 8.3 fallback alias (~1000000) — r6 #3", () => {
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const base = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: app, path: "src/app.js" }]),
      [],
      "base",
    );
    const blob = hashBlob(repo, "x\n");
    // Git tests `~1000000`/`~9999999` (0-char prefix, 7 digits) as NTFS aliases.
    const head = commitTree(
      repo,
      buildTree(repo, [
        { mode: "100644", sha: app, path: "src/app.js" },
        { mode: "100644", sha: blob, path: "~1000000" },
      ]),
      [base],
      "add zero-prefix 8.3 alias",
    );
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain("windows-alias");
  });

  it("does NOT flag an impossible-as-8.3 long name (report~2024.txt, 11-char base) — r6 #9", () => {
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const base = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: app, path: "src/app.js" }]),
      [],
      "base",
    );
    const blob = hashBlob(repo, "y\n");
    const head = commitTree(
      repo,
      buildTree(repo, [
        { mode: "100644", sha: app, path: "src/app.js" },
        { mode: "100644", sha: blob, path: "reports/report~2024.txt" }, // 11-char base — not 8.3
      ]),
      [base],
      "add legit tilde name",
    );
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(true);
    expect(r.rejections).toEqual([]);
  });

  it("rejects a Windows console device name (CONIN$) — r6 #4", () => {
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const base = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: app, path: "src/app.js" }]),
      [],
      "base",
    );
    const blob = hashBlob(repo, "z\n");
    const head = commitTree(
      repo,
      buildTree(repo, [
        { mode: "100644", sha: app, path: "src/app.js" },
        { mode: "100644", sha: blob, path: "CONIN$" },
      ]),
      [base],
      "add console device name",
    );
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain("reserved-name");
  });

  it("snapshots the assignment: a stateful base getter cannot split diff from rebuild — r6 #6", () => {
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const base1 = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: app, path: "src/app.js" }]),
      [],
      "base1",
    );
    const other = hashBlob(repo, "other\n");
    const base2 = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: other, path: "src/other.js" }]),
      [],
      "base2",
    );
    const app2 = hashBlob(repo, "console.log('app v2');\n");
    const head = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: app2, path: "src/app.js" }]),
      [base1],
      "feat",
    );
    // A getter that returns base1 first, then base2 on every later read.
    let reads = 0;
    const assignment = { allowedPaths: ["**"] } as unknown as QuarantineAssignment;
    Object.defineProperty(assignment, "base", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? base1 : base2;
      },
    });
    const r = runIntake(repo, head, assignment);
    // The snapshot fixes base = base1 for EVERY use — the diff and the rebuild
    // parent are consistent, matching a plain base1 assignment.
    const plain = runIntake(repo, head, { base: base1, allowedPaths: ["**"] });
    expect(r.accepted).toBe(plain.accepted);
    expect(r.diff?.baseSha).toBe(base1);
    expect(r.rebuilt?.parents).toEqual([base1]);
    expect(r.diff?.changedPaths).toEqual(plain.diff?.changedPaths);
  });

  it("reports a type-confused symlink (mode 120000 → tree) as fsck-violation, not path-too-long — r6 #7", () => {
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const base = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: app, path: "src/app.js" }]),
      [],
      "base",
    );
    // A subtree object id used as a 120000 (symlink) entry's target — a broken
    // link git fsck flags ("is a tree, not a blob").
    const someTree = buildTree(repo, [{ mode: "100644", sha: app, path: "inner.js" }]);
    const head = commitTree(
      repo,
      buildTree(repo, [
        { mode: "100644", sha: app, path: "src/app.js" },
        { mode: "120000", sha: someTree, path: "badlink" },
      ]),
      [base],
      "type-confused symlink",
    );
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(false);
    const codes = r.rejections.map((x) => x.code);
    expect(codes).toContain("fsck-violation");
    expect(codes).not.toContain("path-too-long");
  });
});

describe("round-7 falsification fixes", () => {
  it("does NOT flag non-ASCII or spaced tilde names as 8.3 aliases (café~1, foo ~1) — r7 #10", () => {
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const base = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: app, path: "src/app.js" }]),
      [],
      "base",
    );
    const b1 = hashBlob(repo, "1\n");
    const b2 = hashBlob(repo, "2\n");
    // An 8.3 name is ASCII below 0x80 with no space, so neither of these can be
    // an 8.3 alias — they must not be over-rejected.
    const head = commitTree(
      repo,
      buildTree(repo, [
        { mode: "100644", sha: app, path: "src/app.js" },
        { mode: "100644", sha: b1, path: "docs/café~1.md" },
        { mode: "100644", sha: b2, path: "docs/foo ~1.txt" },
      ]),
      [base],
      "legit tilde names",
    );
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(true);
    expect(r.rejections).toEqual([]);
  });

  it("deep-snapshots contractRef: the emitted diff holds stable plain data, not a live getter — r7 #7", () => {
    const fx = acceptedFixture();
    let vReads = 0;
    const liveRef = {
      issueId: "m1.I1",
      get contractVersion(): number {
        vReads += 1;
        return vReads <= 4 ? 1 : 9007199254740992; // valid during validation, unsafe afterward
      },
      contractHash: "a".repeat(64),
    };
    const assignment = { ...fx.assignment, contractRef: liveRef as unknown as ContractRef };
    const r = runIntake(fx.repo, fx.head, assignment);
    expect(r.accepted).toBe(true);
    const ref = r.diff!.contractRef!;
    // Captured as plain data (version 1), not the live getter.
    expect(ref.contractVersion).toBe(1);
    expect(Object.getOwnPropertyDescriptor(ref, "contractVersion")?.get).toBeUndefined();
    // The returned artifact re-validates cleanly and cannot mutate to malformed.
    expect(quarantinedDiffProblems(r.diff)).toEqual([]);
    void liveRef.contractVersion;
    void liveRef.contractVersion;
    expect(r.diff!.contractRef!.contractVersion).toBe(1);
  });
});

describe("round-8 falsification fixes", () => {
  it("refuses a worker `.git/config` that is a FIFO or uses an include directive — r8 #1", () => {
    // A `[include] path = <fifo>` makes the serving upload-pack block on the FIFO,
    // orphaning it — even for a fully stopped worker (persistent state).
    const a = mkdtempTestDir();
    mkdirSync(join(a, ".git", "objects"), { recursive: true });
    writeFileSync(join(a, ".git", "config"), "[include]\n\tpath = config.fifo\n");
    execFileSync("mkfifo", [join(a, ".git", "config.fifo")]);
    expect(() => assertSelfContainedObjectStore(a)).toThrow(/include/);

    // A `.git/config` that is itself a FIFO is refused before it is read.
    const b = mkdtempTestDir();
    mkdirSync(join(b, ".git", "objects"), { recursive: true });
    execFileSync("mkfifo", [join(b, ".git", "config")]);
    expect(() => assertSelfContainedObjectStore(b)).toThrow(/not a regular file/);
  });

  it("snapshots a toJSON/object-backed contractRef field as an owned primitive — r8 #3", () => {
    const fx = acceptedFixture();
    const liveIssueId = {
      value: "m1.I1",
      toJSON(): string {
        return this.value;
      },
    };
    const liveRef = {
      issueId: liveIssueId as unknown as string,
      contractVersion: 1,
      contractHash: "a".repeat(64),
    };
    const r = runIntake(fx.repo, fx.head, { ...fx.assignment, contractRef: liveRef });
    expect(r.accepted).toBe(true);
    // Emitted as a primitive string, detached from the live object.
    expect(typeof r.diff!.contractRef!.issueId).toBe("string");
    expect(r.diff!.contractRef!.issueId).toBe("m1.I1");
    liveIssueId.value = ""; // mutate the original after return
    expect(r.diff!.contractRef!.issueId).toBe("m1.I1"); // unchanged
    expect(quarantinedDiffProblems(r.diff)).toEqual([]); // still valid
  });

  it("refuses an unbound candidate when requireContractRef is set (production provenance) — r8 #4", () => {
    const fx = acceptedFixture();
    // Corpus default (no requirement) accepts the null-binding form.
    expect(runIntake(fx.repo, fx.head, fx.assignment).accepted).toBe(true);
    // Production mode refuses a missing binding.
    expect(() => runIntake(fx.repo, fx.head, fx.assignment, { requireContractRef: true })).toThrow(
      /contract binding/,
    );
  });

  it("does NOT flag a tilde name containing 8.3-forbidden punctuation (FOO+~1) — r8 #8", () => {
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const base = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: app, path: "src/app.js" }]),
      [],
      "base",
    );
    const blob = hashBlob(repo, "x\n");
    const head = commitTree(
      repo,
      buildTree(repo, [
        { mode: "100644", sha: app, path: "src/app.js" },
        { mode: "100644", sha: blob, path: "docs/FOO+~1.txt" }, // '+' is forbidden in 8.3
      ]),
      [base],
      "legit punctuation tilde name",
    );
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(true);
    expect(r.rejections).toEqual([]);
  });
});

describe("round-9 falsification fixes", () => {
  it("rejects a symlink whose target aliases `.git` via an HFS-ignorable char — r9 #1", () => {
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const base = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: app, path: "src/app.js" }]),
      [],
      "base",
    );
    // Symlink target `.g<U+200C>it/config` — an HFS+ volume opens it as .git/config.
    const target = ".g" + String.fromCodePoint(0x200c) + "it/config";
    const linkBlob = hashBlob(repo, target);
    const head = commitTree(
      repo,
      buildTree(repo, [
        { mode: "100644", sha: app, path: "src/app.js" },
        { mode: "120000", sha: linkBlob, path: "link" },
      ]),
      [base],
      "hfs-ignorable dotgit symlink",
    );
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain("symlink-escape");
  });

  it("bounds an oversized `.git/config` before reading it — r9 #2", () => {
    const a = mkdtempTestDir();
    mkdirSync(join(a, ".git", "objects"), { recursive: true });
    writeFileSync(join(a, ".git", "config"), "x".repeat((1 << 20) + 1)); // > 1 MiB
    expect(() => assertSelfContainedObjectStore(a)).toThrow(/bytes/);
  });

  it("refuses ANY include-family config section (blanket rule) — r9 #7 / r11 #1", () => {
    // A `git clone`-provisioned worker config has NO include of any form, so we
    // refuse every `[include…]` section rather than hand-parse git's grammar —
    // incl. the escaped-quote conditional git actually honors (r11 #1).
    for (const header of [
      "[include]",
      '[includeIf "gitdir:/x"]',
      "[include.custom]",
      "[include-x]",
      "[includeIf.custom]",
      "[includeIf]",
      '[includeIf "onbranch:main\\"x"]', // escaped quote in condition — git honors
      String.fromCodePoint(0xfeff) + "[include]", // leading BOM — git honors (r12 #1)
      "\f[include]", // form-feed lead-in — git's isspace (r12 #1)
    ]) {
      const bad = mkdtempTestDir();
      mkdirSync(join(bad, ".git", "objects"), { recursive: true });
      writeFileSync(join(bad, ".git", "config"), `${header}\n\tpath = /etc/x\n`);
      expect(() => assertSelfContainedObjectStore(bad)).toThrow(/include/);
    }
    // A clean config (no include section) is accepted.
    const ok = mkdtempTestDir();
    mkdirSync(join(ok, ".git", "objects"), { recursive: true });
    writeFileSync(join(ok, ".git", "config"), '[core]\n\tbare = false\n[remote "origin"]\n');
    expect(() => assertSelfContainedObjectStore(ok)).not.toThrow();
  });

  it("does NOT classify a multi-dot long name as an 8.3 alias (FOO~1.T.X) — r9 #8", () => {
    const repo = initRepo();
    const app = hashBlob(repo, "console.log('app');\n");
    const base = commitTree(
      repo,
      buildTree(repo, [{ mode: "100644", sha: app, path: "src/app.js" }]),
      [],
      "base",
    );
    const blob = hashBlob(repo, "x\n");
    const head = commitTree(
      repo,
      buildTree(repo, [
        { mode: "100644", sha: app, path: "src/app.js" },
        { mode: "100644", sha: blob, path: "docs/FOO~1.T.X" }, // two dots — not 8.3
      ]),
      [base],
      "multi-dot tilde name",
    );
    const r = runIntake(repo, head, { base, allowedPaths: ["**"] });
    expect(r.accepted).toBe(true);
    expect(r.rejections).toEqual([]);
  });

  it("detects a repo's object format from its config file, no git-exec — r9 #4", () => {
    const sha256 = mkdtempTestDir();
    mkdirSync(join(sha256, ".git"), { recursive: true });
    writeFileSync(
      join(sha256, ".git", "config"),
      "[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectformat = sha256\n",
    );
    expect(objectFormatOfRepo(sha256)).toBe("sha256");

    const sha1 = mkdtempTestDir();
    mkdirSync(join(sha1, ".git"), { recursive: true });
    writeFileSync(join(sha1, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
    expect(objectFormatOfRepo(sha1)).toBe("sha1");
  });

  it("parses object format section-aware and quote-tolerant — r10 #5", () => {
    // A QUOTED value is honored...
    const quoted = mkdtempTestDir();
    mkdirSync(join(quoted, ".git"), { recursive: true });
    writeFileSync(join(quoted, ".git", "config"), '[extensions]\n\tobjectformat = "sha256"\n');
    expect(objectFormatOfRepo(quoted)).toBe("sha256");

    // ...but an `objectformat` key in an UNRELATED section is NOT.
    const unrelated = mkdtempTestDir();
    mkdirSync(join(unrelated, ".git"), { recursive: true });
    writeFileSync(join(unrelated, ".git", "config"), "[user]\n\tobjectformat = sha256\n");
    expect(objectFormatOfRepo(unrelated)).toBe("sha1");
  });

  it("object-format parse ignores a subsectioned [extensions] and takes the LAST value — r11 #3", () => {
    // `[extensions "spoof"]` is a DIFFERENT key git ignores for the object format.
    const spoof = mkdtempTestDir();
    mkdirSync(join(spoof, ".git"), { recursive: true });
    writeFileSync(join(spoof, ".git", "config"), '[extensions "spoof"]\n\tobjectformat = sha256\n');
    expect(objectFormatOfRepo(spoof)).toBe("sha1");

    // A repeated key takes git's LAST value.
    const repeated = mkdtempTestDir();
    mkdirSync(join(repeated, ".git"), { recursive: true });
    writeFileSync(
      join(repeated, ".git", "config"),
      "[extensions]\n\tobjectformat = sha256\n\tobjectformat = sha1\n",
    );
    expect(objectFormatOfRepo(repeated)).toBe("sha1");
  });

  it("storeSizeBytes returns 0 for an absent store but THROWS on an inaccessible one — r10 #4", () => {
    // ENOENT (no objects dir yet) is a legitimately empty 0-byte store.
    const empty = mkdtempTestDir();
    mkdirSync(join(empty, ".git"), { recursive: true });
    expect(storeSizeBytes(empty)).toBe(0);

    // An UNREADABLE `.git` must fail closed (throw), not read as empty.
    const locked = mkdtempTestDir();
    mkdirSync(join(locked, ".git", "objects", "pack"), { recursive: true });
    writeFileSync(join(locked, ".git", "objects", "pack", "p.pack"), "PACK");
    chmodSync(join(locked, ".git"), 0o000);
    try {
      expect(() => storeSizeBytes(locked)).toThrow(/inaccessible|fail-closed/);
    } finally {
      chmodSync(join(locked, ".git"), 0o755); // restore so afterAll cleanup can remove it
    }
  });
});

// --- helpers ---

function mkdtempTestDir(): string {
  const d = mkdtempSync(join(tmpdir(), "camino-gitfile-"));
  testDirs.push(d);
  return d;
}

function buildBase(repo: string, appContent: string): string {
  const app = hashBlob(repo, appContent);
  return commitTree(
    repo,
    buildTree(repo, [{ mode: "100644", sha: app, path: "src/app.js" }]),
    [],
    "base",
  );
}

function readConfigOrEmpty(dir: string, key: string): string {
  try {
    return git(dir, "config", "--get", key);
  } catch {
    return ""; // an unset key exits non-zero — no helper configured
  }
}

function snapshotGitDir(repo: string): { refs: string[]; hasFetchHead: boolean } {
  const refsDir = join(repo, ".git", "refs");
  const refs: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix.length > 0 ? `${prefix}/${name.name}` : name.name;
      if (name.isDirectory()) walk(join(dir, name.name), rel);
      else refs.push(`${rel}=${readFileSync(join(dir, name.name), "utf8").trim()}`);
    }
  };
  walk(refsDir, "");
  refs.sort();
  return { refs, hasFetchHead: existsSync(join(repo, ".git", "FETCH_HEAD")) };
}
