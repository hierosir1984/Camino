// WP-108 quarantine — PRODUCT-grade behavior beyond the WP-003 corpus
// (CAM-EXEC-04): the emitted quarantined diff, WP-110 contract binding, the
// registry-item-11 fetch budget, the credentialed-git / worker-touched-dir
// boundary, and a production-shape smoke test of the real intake entry.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  initRepo,
  type CacheEntry,
} from "./corpus-git.js";
import { cleanupPristineRepos, runIntake } from "./intake.js";
import { checkFetchBudget, REGISTRY_ITEM_11_FETCH_BUDGET } from "./policy.js";
import type { QuarantineAssignment } from "./types.js";

afterAll(() => {
  cleanupRepos();
  cleanupPristineRepos();
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

  it("rejects end-to-end when the shallow-fetch footprint exceeds 5,000 objects", () => {
    // 5,001 leaves under one dir → object count > the hard fetch cap, even though
    // the per-issue policy entry-budget is set high enough not to fire — so ONLY
    // the registry-item-11 fetch-object-budget is exercised. All share one blob
    // sha (distinct paths), generated in-script (no giant argv → no E2BIG).
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
    const r = runIntake(repo, head, {
      base,
      allowedPaths: ["**"],
      budgets: { maxEntries: 10_000, maxTreeBytes: 5_000_000_000, maxBlobBytes: 1_000_000 },
    });
    expect(r.accepted).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain("fetch-object-budget");
    // The policy entry-budget was NOT the trigger (it was raised above the count).
    expect(r.rejections.map((x) => x.code)).not.toContain("entry-budget");
    expect(r.rebuilt).toBeNull();
    expect(r.diff).toBeNull();
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

// --- helpers ---

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
