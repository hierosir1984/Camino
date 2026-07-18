// WP-003 quarantine attack suite — CAM-EXEC-04 (Phase-0), PRD §7 item 3.
//
// Every enumerated attack is a fixture that the squash-and-rebuild intake must
// defeat: rejected outright, or (for reachable-history) structurally neutralized
// so the smuggled object never enters the pristine store. A positive control
// proves a clean in-scope change is accepted and correctly re-authored. This
// file rides the standard vitest CI glob, so it runs on every PR from here on.
import { afterAll, describe, expect, it } from "vitest";
import { git } from "./git.js";
import { cleanupRepos, objectExists, runIntake } from "./intake.js";
import type { QuarantineResult, RejectionCode } from "./types.js";
import {
  isProtectedPath,
  matchesAnyGlob,
  symlinkEscapes,
  checkPathCollisions,
  checkNameAliases,
  checkDotGitPaths,
} from "./policy.js";
import { analyzeWorkflow, CANDIDATE_REFS, scanWorkflowPosture } from "./workflow.js";
import * as attacks from "./attacks.js";

afterAll(() => cleanupRepos());

const codes = (r: QuarantineResult): RejectionCode[] => r.rejections.map((x) => x.code);

describe("positive control — a clean in-scope change is accepted and re-authored", () => {
  it("accepts, rebuilds onto base with a single parent and a worker-attribution trailer", () => {
    const fx = attacks.legitChange();
    const r = runIntake(fx.repo, fx.head, fx.contract);
    expect(r.accepted).toBe(true);
    expect(r.rejections).toEqual([]);
    expect(r.rebuilt).not.toBeNull();
    expect(r.rebuilt!.parents).toEqual([fx.contract.base]); // squash ⇒ single assigned parent
    expect(r.rebuilt!.attributionTrailer).toBe(`Camino-Worker-Attribution: ${r.workerHead}`);
    // The rebuilt candidate carries the worker's final tree, bit-for-bit.
    const workerHeadTree = git(fx.repo, "rev-parse", `${fx.head}^{tree}`);
    expect(r.rebuilt!.treeSha).toBe(workerHeadTree);
    // …but it is a NEW commit (Camino-authored), distinct from the worker head.
    expect(r.rebuilt!.sha).not.toBe(r.workerHead);
  });
});

describe("attack 1 — reachable-history smuggling is neutralized structurally", () => {
  it("accepts the clean head but the smuggled object never entered the pristine store", () => {
    const fx = attacks.reachableHistorySmuggling();
    const r = runIntake(fx.repo, fx.head, fx.contract);
    // The final tree is clean and in scope, so the head itself is accepted…
    expect(r.accepted).toBe(true);
    // …and crucially the 2 MB secret from the intermediate commit is ABSENT:
    // the shallow fetch never pulled it, so it cannot be smuggled onto main.
    expect(objectExists(r.pristineDir, fx.smuggledSha)).toBe(false);
    // The rebuilt candidate descends only from the assigned base.
    expect(r.rebuilt!.parents).toEqual([fx.contract.base]);
    expect(objectExists(fx.repo, fx.smuggledSha)).toBe(true); // it did exist in worker history
  });
});

interface Case {
  name: string;
  fixture: () => attacks.WorkerFixture;
  expect: RejectionCode;
}

const REJECTION_CASES: Case[] = [
  {
    name: "2 — path collision (case-fold)",
    fixture: attacks.caseCollision,
    expect: "path-collision-case",
  },
  {
    name: "3 — path collision (Unicode normalization)",
    fixture: attacks.unicodeCollision,
    expect: "path-collision-unicode",
  },
  { name: "4 — reserved device name", fixture: attacks.reservedName, expect: "reserved-name" },
  { name: "5 — trailing-dot alias", fixture: attacks.trailingDot, expect: "trailing-dot-or-space" },
  {
    name: "6 — symlink target escape (../)",
    fixture: attacks.symlinkEscape,
    expect: "symlink-escape",
  },
  {
    name: "6b — symlink target escape (absolute)",
    fixture: attacks.symlinkAbsolute,
    expect: "symlink-escape",
  },
  {
    name: "7 — .gitattributes tampering",
    fixture: attacks.gitattributesTamper,
    expect: "protected-path",
  },
  { name: "8 — CI-definition edit", fixture: attacks.ciDefinitionEdit, expect: "protected-path" },
  { name: "9 — out-of-scope diff", fixture: attacks.outOfScope, expect: "out-of-scope" },
  {
    name: "10 — worker merge commit",
    fixture: attacks.workerMergeCommit,
    expect: "worker-merge-commit",
  },
  {
    name: "11 — submodule/gitlink introduction",
    fixture: attacks.submoduleGitlink,
    expect: "submodule-gitlink",
  },
  {
    name: "11b — .git 8.3 alias (GIT~1) smuggling",
    fixture: attacks.dotGitAlias,
    expect: "dotgit-path",
  },
  { name: "11c — symlink into .git", fixture: attacks.symlinkIntoDotGit, expect: "symlink-escape" },
  { name: "12 — size bomb", fixture: attacks.sizeBomb, expect: "blob-size-budget" },
  // review r1 folds:
  {
    name: "r1#1 — case-spelled protected path (.GITATTRIBUTES)",
    fixture: attacks.protectedPathCaseVariant,
    expect: "protected-path",
  },
  {
    name: "r1#5 — deep-nesting object-count bomb",
    fixture: attacks.deepNestingBomb,
    expect: "entry-budget",
  },
  {
    name: "r1#6 — drive-relative symlink target (C:foo)",
    fixture: attacks.symlinkDriveRelative,
    expect: "symlink-escape",
  },
  {
    name: "r1#7 — superscript device alias (COM²)",
    fixture: attacks.reservedSuperscript,
    expect: "reserved-name",
  },
  {
    name: "r1#8 — full-fold path collision (straße ⇄ STRASSE)",
    fixture: attacks.unicodeFoldCollision,
    expect: "path-collision-unicode",
  },
];

describe("attacks 2–12 — each is rejected with the expected reason and produces no candidate", () => {
  for (const c of REJECTION_CASES) {
    it(`attack ${c.name}`, () => {
      const fx = c.fixture();
      const r = runIntake(fx.repo, fx.head, fx.contract);
      expect(r.accepted).toBe(false);
      expect(codes(r)).toContain(c.expect);
      expect(r.rebuilt).toBeNull(); // a rejected intake never authors a candidate
    });
  }
});

describe("attack 13 — hostile workflow firing on candidate refs is flagged", () => {
  const HOSTILE = `name: deploy
on:
  push:
    branches: ['**']
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
        env:
          KEY: \${{ secrets.DEPLOY_KEY }}
`;
  const HOSTILE_WRITE = `name: release
on: push
permissions: write-all
jobs:
  x: { runs-on: ubuntu-latest, steps: [{ run: "echo hi" }] }
`;
  const SAFE_NARROW = `name: ci
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  test: { runs-on: ubuntu-latest, steps: [{ run: "npm test" }] }
`;
  const BROAD_BUT_HARMLESS = `name: lint
on:
  push:
    branches: ['**']
permissions:
  contents: read
jobs:
  lint: { runs-on: ubuntu-latest, steps: [{ run: "npm run lint" }] }
`;

  it("flags a secret-bearing workflow with on: push branches ['**'], naming the file", () => {
    const finding = analyzeWorkflow(".github/workflows/deploy.yml", HOSTILE, CANDIDATE_REFS);
    expect(finding).not.toBeNull();
    expect(finding!.file).toBe(".github/workflows/deploy.yml");
    expect(finding!.fires.length).toBeGreaterThan(0);
    expect(finding!.privileged.join(" ")).toMatch(/secret/i);
  });

  it("flags on: push (no filter) with write-all permissions", () => {
    const finding = analyzeWorkflow(".github/workflows/release.yml", HOSTILE_WRITE, CANDIDATE_REFS);
    expect(finding).not.toBeNull();
    expect(finding!.privileged.join(" ")).toMatch(/write-all/);
  });

  it("does NOT flag a narrow main-only read-only workflow", () => {
    expect(analyzeWorkflow(".github/workflows/ci.yml", SAFE_NARROW, CANDIDATE_REFS)).toBeNull();
  });

  it("does NOT flag a broad trigger that is read-only and secret-free (fires ≠ hostile)", () => {
    expect(
      analyzeWorkflow(".github/workflows/lint.yml", BROAD_BUT_HARMLESS, CANDIDATE_REFS),
    ).toBeNull();
  });

  it("scan returns one finding per hostile workflow", () => {
    const findings = scanWorkflowPosture(
      [
        { path: ".github/workflows/deploy.yml", content: HOSTILE },
        { path: ".github/workflows/ci.yml", content: SAFE_NARROW },
      ],
      CANDIDATE_REFS,
    );
    expect(findings.map((f) => f.file)).toEqual([".github/workflows/deploy.yml"]);
  });

  // --- review r1 folds ---

  it("r1#4 — ordered branch re-inclusion fires (last matching pattern wins)", () => {
    const wf = `name: x
on:
  push:
    branches: ['camino/**', '!camino/**', 'camino/candidate/**']
permissions: write-all
jobs:
  a: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`;
    const finding = analyzeWorkflow(".github/workflows/x.yml", wf, CANDIDATE_REFS);
    expect(finding).not.toBeNull();
    expect(finding!.fires.join(" ")).toContain("camino/candidate/issue-42/1");
  });

  it("r1#2 — pull_request_target with write-all is flagged (privileged base context)", () => {
    const wf = `name: prt
on:
  pull_request_target:
    branches: [main]
permissions: write-all
jobs:
  a: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`;
    const finding = analyzeWorkflow(".github/workflows/prt.yml", wf, CANDIDATE_REFS);
    expect(finding).not.toBeNull();
    expect(finding!.fires.join(" ")).toMatch(/pull_request_target/);
  });

  it("r1#3 — bracket-index secret and job-level write permissions are seen", () => {
    const bracket = `name: b
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{ run: "use", env: { K: "\${{ secrets['DEPLOY_KEY'] }}" } }]
`;
    const bf = analyzeWorkflow(".github/workflows/b.yml", bracket, CANDIDATE_REFS);
    expect(bf).not.toBeNull();
    expect(bf!.privileged.join(" ")).toMatch(/DEPLOY_KEY/);

    const jobWrite = `name: j
on: push
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps: [{ run: echo }]
`;
    const jf = analyzeWorkflow(".github/workflows/j.yml", jobWrite, CANDIDATE_REFS);
    expect(jf).not.toBeNull();
    expect(jf!.privileged.join(" ")).toMatch(/job "a" permissions grant write/);
  });
});

describe("policy units — the security-relevant edge cases", () => {
  it("symlinkEscapes: absolute, drive, and ../ escapes are caught; in-tree links are not", () => {
    expect(symlinkEscapes("src/link", "/etc/passwd")).toBe(true);
    expect(symlinkEscapes("src/link", "C:\\Windows")).toBe(true);
    expect(symlinkEscapes("src/link", "../../../../etc/passwd")).toBe(true);
    expect(symlinkEscapes("a/b/link", "../../..")).toBe(true); // escapes above root
    expect(symlinkEscapes("a/b/link", "../c")).toBe(false); // resolves to a/c — in tree
    expect(symlinkEscapes("src/link", "./sibling")).toBe(false);
    expect(symlinkEscapes("src/link", "C:foo")).toBe(true); // drive-relative (r1#6)
    expect(symlinkEscapes("src/link", "\\\\host\\share")).toBe(true); // UNC
  });

  it("matchesAnyGlob: ** spans '/', * does not", () => {
    expect(matchesAnyGlob("src/a/b.ts", ["src/**"])).toBe(true);
    expect(matchesAnyGlob("src/b.ts", ["src/*"])).toBe(true);
    expect(matchesAnyGlob("src/a/b.ts", ["src/*"])).toBe(false); // * stops at '/'
    expect(matchesAnyGlob("README.md", ["README.md"])).toBe(true);
    expect(matchesAnyGlob("config/x", ["src/**", "README.md"])).toBe(false);
  });

  it("isProtectedPath: .gitattributes (any dir), .github/workflows, .camino", () => {
    expect(isProtectedPath(".gitattributes")).toBe(true);
    expect(isProtectedPath("src/.gitattributes")).toBe(true);
    expect(isProtectedPath(".github/workflows/ci.yml")).toBe(true);
    expect(isProtectedPath(".camino/config.yml")).toBe(true);
    expect(isProtectedPath("src/app.js")).toBe(false);
    expect(isProtectedPath(".github/CODEOWNERS")).toBe(false); // not a CI definition
    // Case-insensitive: a case-insensitive host resolves these to protected (r1#1).
    expect(isProtectedPath(".GITATTRIBUTES")).toBe(true);
    expect(isProtectedPath(".GitHub/Workflows/ci.yml")).toBe(true);
    expect(isProtectedPath(".Camino/config.yml")).toBe(true);
  });

  it("checkNameAliases: reserved stems match, real words do not", () => {
    const mk = (path: string) => [
      { mode: "100644", type: "blob" as const, sha: "x", size: 1, path },
    ];
    expect(checkNameAliases(mk("src/con.txt")).map((r) => r.code)).toContain("reserved-name");
    expect(checkNameAliases(mk("src/COM1")).map((r) => r.code)).toContain("reserved-name");
    expect(checkNameAliases(mk("src/console.txt"))).toEqual([]); // "console" ≠ "con"
    expect(checkNameAliases(mk("src/data.")).map((r) => r.code)).toContain("trailing-dot-or-space");
    expect(checkNameAliases(mk("src/note "))[0]?.code).toBe("trailing-dot-or-space");
  });

  it("checkDotGitPaths: literal .git (git itself blocks this), aliases, trailing forms", () => {
    const e = (path: string) => [
      { mode: "100644", type: "blob" as const, sha: "x", size: 1, path },
    ];
    // The literal `.git` object cannot be built via git tooling (git refuses it
    // at write + transfer), so this unit test is how we prove our own check
    // would catch it independently.
    expect(checkDotGitPaths(e(".git/config")).map((r) => r.code)).toEqual(["dotgit-path"]);
    expect(checkDotGitPaths(e("a/.GIT/x")).map((r) => r.code)).toEqual(["dotgit-path"]);
    expect(checkDotGitPaths(e("GIT~1/config")).map((r) => r.code)).toEqual(["dotgit-path"]);
    expect(checkDotGitPaths(e("a/.git./x")).map((r) => r.code)).toEqual(["dotgit-path"]);
    // Real dotfiles that are NOT the .git directory are left alone.
    expect(checkDotGitPaths(e(".gitignore"))).toEqual([]);
    expect(checkDotGitPaths(e(".gitmodules"))).toEqual([]);
    expect(checkDotGitPaths(e("src/app.js"))).toEqual([]);
  });

  it("checkPathCollisions labels case vs Unicode correctly", () => {
    const e = (path: string) => ({
      mode: "100644",
      type: "blob" as const,
      sha: "x",
      size: 1,
      path,
    });
    expect(checkPathCollisions([e("a/File"), e("a/file")]).map((r) => r.code)).toEqual([
      "path-collision-case",
    ]);
    expect(checkPathCollisions([e("café"), e("café")]).map((r) => r.code)).toEqual([
      "path-collision-unicode",
    ]);
    expect(checkPathCollisions([e("a"), e("b")])).toEqual([]);
  });
});
