// WP-108 quarantine — the WP-003 rejection corpus, run against the PRODUCT
// module (CAM-EXEC-04; PRD §7, Phase-0 item 3).
//
// The acceptance gate the WP-003 spike declared for the product module: "this
// exact rejection corpus is the acceptance gate for that module." Every case
// and assertion is carried forward UNCHANGED from the spike; only the imports
// point at the product intake / policy / workflow-posture module instead of the
// prototype. It rides the standard vitest CI glob, so it runs on every PR.
import { afterAll, describe, expect, it } from "vitest";
import { git } from "./corpus-git.js";
import { cleanupRepos } from "./corpus-git.js";
import { cleanupPristineRepos, objectExists, runIntake } from "./intake.js";
import type { QuarantineResult, RejectionCode } from "./types.js";
import {
  isProtectedPath,
  matchesAnyGlob,
  symlinkEscapes,
  checkPathCollisions,
  checkNameAliases,
  checkDotGitPaths,
} from "./policy.js";
import { analyzeWorkflow, CANDIDATE_REFS, scanWorkflowPosture } from "./workflow-posture.js";
import * as cases from "./corpus-fixtures.js";

afterAll(() => {
  cleanupRepos();
  cleanupPristineRepos();
});

const codes = (r: QuarantineResult): RejectionCode[] => r.rejections.map((x) => x.code);

describe("positive control — a clean in-scope change is accepted and re-authored", () => {
  it("accepts, rebuilds onto base with a single parent and a worker-attribution trailer", () => {
    const fx = cases.legitChange();
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

describe("false-reject controls — legitimate trees are accepted", () => {
  it("r2#9 — a gitlink already present + unchanged in the base is NOT rejected", () => {
    const fx = cases.unchangedGitlinkAllowed();
    const r = runIntake(fx.repo, fx.head, fx.contract);
    expect(r.rejections.map((x) => x.code)).not.toContain("submodule-gitlink");
    expect(r.accepted).toBe(true);
  });
});

describe("case 1 — reachable-history carry-in is excluded structurally", () => {
  it("accepts the clean head but the carried object never entered the pristine store", () => {
    const fx = cases.reachableHistoryCarryIn();
    const r = runIntake(fx.repo, fx.head, fx.contract);
    // The final tree is clean and in scope, so the head itself is accepted…
    expect(r.accepted).toBe(true);
    // …and crucially the 2 MB secret from the intermediate commit is ABSENT:
    // the shallow fetch never pulled it, so it can never reach main.
    expect(objectExists(r.pristineDir, fx.carriedSha)).toBe(false);
    // The rebuilt candidate descends only from the assigned base.
    expect(r.rebuilt!.parents).toEqual([fx.contract.base]);
    expect(objectExists(fx.repo, fx.carriedSha)).toBe(true); // it did exist in worker history
  });
});

interface Case {
  name: string;
  fixture: () => cases.WorkerFixture;
  expect: RejectionCode;
}

const REJECTION_CASES: Case[] = [
  {
    name: "2 — path collision (case-fold)",
    fixture: cases.caseCollision,
    expect: "path-collision-case",
  },
  {
    name: "3 — path collision (Unicode normalization)",
    fixture: cases.unicodeCollision,
    expect: "path-collision-unicode",
  },
  { name: "4 — reserved device name", fixture: cases.reservedName, expect: "reserved-name" },
  { name: "5 — trailing-dot alias", fixture: cases.trailingDot, expect: "trailing-dot-or-space" },
  {
    name: "6 — symlink target escape (../)",
    fixture: cases.symlinkEscape,
    expect: "symlink-escape",
  },
  {
    name: "6b — symlink target escape (absolute)",
    fixture: cases.symlinkAbsolute,
    expect: "symlink-escape",
  },
  {
    name: "7 — .gitattributes edit",
    fixture: cases.gitattributesEdit,
    expect: "protected-path",
  },
  { name: "8 — CI-definition edit", fixture: cases.ciDefinitionEdit, expect: "protected-path" },
  { name: "9 — out-of-scope diff", fixture: cases.outOfScope, expect: "out-of-scope" },
  {
    name: "10 — worker merge commit",
    fixture: cases.workerMergeCommit,
    expect: "worker-merge-commit",
  },
  {
    name: "11 — submodule/gitlink introduction",
    fixture: cases.submoduleGitlink,
    expect: "submodule-gitlink",
  },
  {
    name: "11b — .git 8.3 alias (GIT~1)",
    fixture: cases.dotGitAlias,
    expect: "dotgit-path",
  },
  { name: "11c — symlink into .git", fixture: cases.symlinkIntoDotGit, expect: "symlink-escape" },
  { name: "12 — size-budget breach", fixture: cases.oversizeBlob, expect: "blob-size-budget" },
  // review r1 folds:
  {
    name: "r1#1 — case-spelled protected path (.GITATTRIBUTES)",
    fixture: cases.protectedPathCaseVariant,
    expect: "protected-path",
  },
  {
    name: "r1#5 — deep-nesting object-count breach",
    fixture: cases.deepNestingBudgetBreach,
    expect: "entry-budget",
  },
  {
    name: "r1#6 — drive-relative symlink target (C:foo)",
    fixture: cases.symlinkDriveRelative,
    expect: "symlink-escape",
  },
  {
    name: "r1#7 — superscript device alias (COM²)",
    fixture: cases.reservedSuperscript,
    expect: "reserved-name",
  },
  {
    name: "r1#8 — full-fold path collision (straße ⇄ STRASSE)",
    fixture: cases.unicodeFoldCollision,
    expect: "path-collision-unicode",
  },
  // review r2 folds:
  {
    name: "r2#1 — rename hides a protected-path source deletion",
    fixture: cases.renameHidesProtected,
    expect: "protected-path",
  },
  {
    name: "r2#2 — NTFS .git ADS alias (.git::$INDEX_ALLOCATION)",
    fixture: cases.ntfsDotGitAds,
    expect: "dotgit-path",
  },
  {
    name: "r2#7 — backslash-separator collision (docs\\note)",
    fixture: cases.backslashCollision,
    expect: "windows-alias",
  },
  {
    name: "r2#11 — NUL-bearing symlink target",
    fixture: cases.nulSymlinkTarget,
    expect: "symlink-escape",
  },
  // review r3 folds:
  {
    name: "r3#1 — HFS-ignorable .git equivalent (git fsck gate)",
    fixture: cases.hfsDotGit,
    expect: "fsck-violation",
  },
  {
    name: "r3#7 — oversized symlink target (rejected on size, no crash)",
    fixture: cases.oversizeSymlink,
    expect: "symlink-escape",
  },
  {
    name: "r3#8 — ancestor-component collision (A ⇄ a/)",
    fixture: cases.ancestorComponentCollision,
    expect: "path-collision-case",
  },
];

describe("cases 2–12 — each is rejected with the expected reason and produces no candidate", () => {
  for (const c of REJECTION_CASES) {
    it(`case ${c.name}`, () => {
      const fx = c.fixture();
      const r = runIntake(fx.repo, fx.head, fx.contract);
      expect(r.accepted).toBe(false);
      expect(codes(r)).toContain(c.expect);
      expect(r.rebuilt).toBeNull(); // a rejected intake never authors a candidate
      expect(r.diff).toBeNull(); // …and emits no quarantined diff
    });
  }
});

describe("case 13 — privileged workflow firing on candidate refs is flagged", () => {
  const PRIVILEGED = `name: deploy
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
  const PRIVILEGED_WRITE = `name: release
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
    const finding = analyzeWorkflow(".github/workflows/deploy.yml", PRIVILEGED, CANDIDATE_REFS);
    expect(finding).not.toBeNull();
    expect(finding!.file).toBe(".github/workflows/deploy.yml");
    expect(finding!.fires.length).toBeGreaterThan(0);
    expect(finding!.privileged.join(" ")).toMatch(/secret/i);
  });

  it("flags on: push (no filter) with write-all permissions", () => {
    const finding = analyzeWorkflow(
      ".github/workflows/release.yml",
      PRIVILEGED_WRITE,
      CANDIDATE_REFS,
    );
    expect(finding).not.toBeNull();
    expect(finding!.privileged.join(" ")).toMatch(/write-all/);
  });

  it("does NOT flag a narrow main-only read-only workflow", () => {
    expect(analyzeWorkflow(".github/workflows/ci.yml", SAFE_NARROW, CANDIDATE_REFS)).toBeNull();
  });

  it("does NOT flag a broad trigger that is read-only and secret-free (fires ≠ privileged)", () => {
    expect(
      analyzeWorkflow(".github/workflows/lint.yml", BROAD_BUT_HARMLESS, CANDIDATE_REFS),
    ).toBeNull();
  });

  it("scan returns one finding per privileged-on-candidate workflow", () => {
    const findings = scanWorkflowPosture(
      [
        { path: ".github/workflows/deploy.yml", content: PRIVILEGED },
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

  it("r2#3 — ordinary pull_request with secrets is flagged (same-repo candidate refs)", () => {
    const wf = `name: pr
on:
  pull_request:
    branches: [main]
jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{ run: use, env: { K: "\${{ secrets.DEPLOY_KEY }}" } }]
`;
    const f = analyzeWorkflow(".github/workflows/pr.yml", wf, CANDIDATE_REFS);
    expect(f).not.toBeNull();
    expect(f!.fires.join(" ")).toMatch(/pull_request/);
  });

  it("r2#10 — a tags-only push workflow does NOT fire on candidate branch refs", () => {
    const wf = `name: tag
on:
  push:
    tags: ['v*']
permissions: write-all
jobs:
  a: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`;
    expect(analyzeWorkflow(".github/workflows/tag.yml", wf, CANDIDATE_REFS)).toBeNull();
  });

  it("r2#4 — an exact sub-namespace branch pattern not in the samples is still flagged", () => {
    const wf = `name: ns
on:
  push:
    branches: ['camino/candidate/issue-99/**']
permissions: write-all
jobs:
  a: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`;
    const f = analyzeWorkflow(".github/workflows/ns.yml", wf, CANDIDATE_REFS);
    expect(f).not.toBeNull();
    expect(f!.fires.length).toBeGreaterThan(0); // an unseen sub-namespace still fires
  });

  it("r2#5 — secrets: inherit into a reusable workflow is flagged", () => {
    const wf = `name: reuse
on:
  push:
    branches: ['camino/**']
permissions: read-all
jobs:
  deploy:
    uses: ./.github/workflows/deploy.yml
    secrets: inherit
`;
    const f = analyzeWorkflow(".github/workflows/reuse.yml", wf, CANDIDATE_REFS);
    expect(f).not.toBeNull();
    expect(f!.privileged.join(" ")).toMatch(/secrets: inherit/);
  });

  it("r3#2 — privileged workflow_run on a candidate namespace is flagged", () => {
    const wf = `name: wr
on:
  workflow_run:
    workflows: [ci]
    branches: ['camino/**']
permissions: write-all
jobs:
  a: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`;
    const f = analyzeWorkflow(".github/workflows/wr.yml", wf, CANDIDATE_REFS);
    expect(f).not.toBeNull();
    expect(f!.fires.join(" ")).toMatch(/workflow_run/);
  });

  it("r3#3 — scalar `on: pull_request` with secrets is flagged", () => {
    const wf = `name: pr2
on: pull_request
permissions: read-all
jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{ run: use, env: { K: "\${{ secrets.DEPLOY_KEY }}" } }]
`;
    const f = analyzeWorkflow(".github/workflows/pr2.yml", wf, CANDIDATE_REFS);
    expect(f).not.toBeNull();
    expect(f!.fires.join(" ")).toMatch(/pull_request/);
  });

  it("r3#5 — whole-object toJSON(secrets) is flagged", () => {
    const wf = `name: dump
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{ run: use, env: { ALL: "\${{ toJSON(secrets) }}" } }]
`;
    const f = analyzeWorkflow(".github/workflows/dump.yml", wf, CANDIDATE_REFS);
    expect(f).not.toBeNull();
    expect(f!.privileged.join(" ")).toMatch(/whole `secrets` object/);
  });

  it("r3#11 — a fully-excluded candidate namespace is NOT flagged", () => {
    const wf = `name: exc
on:
  push:
    branches: ['camino/**', '!camino/**', main]
permissions: write-all
jobs:
  a: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`;
    // camino/** re-excluded by !camino/**, only main remains ⇒ no candidate fires.
    expect(analyzeWorkflow(".github/workflows/exc.yml", wf, CANDIDATE_REFS)).toBeNull();
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
    expect(
      checkPathCollisions([
        e("caf" + String.fromCodePoint(0x00e9)),
        e("cafe" + String.fromCodePoint(0x0301)),
      ]).map((r) => r.code),
    ).toEqual(["path-collision-unicode"]);
    expect(checkPathCollisions([e("a"), e("b")])).toEqual([]);
    // ß ⇄ SS full-fold (r1#8/r2#6) and long-s ſ via NFKC (r2#6) both collide.
    expect(checkPathCollisions([e("straße"), e("STRASSE")]).length).toBe(1);
    expect(checkPathCollisions([e("ſafe"), e("safe")]).length).toBe(1);
  });
});
