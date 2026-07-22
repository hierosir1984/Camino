// WP-107 · CAM-EXEC-02 workspace fixtures.
//
// The positive path proves a FULL isolated clone (object store stands alone
// after the source is deleted; hooks disabled from the first checkout). Each
// negative fixture is a real artifact of the forbidden construction — a
// linked worktree, a --shared clone, a credentialed remote, planted
// credential material — and each must TRIP the attestation, so the fence is
// proven to fire, not merely believed to.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkerCloneError,
  WORKER_CLONE_HOOKS_PATH,
  assertWorkerCloneIsolation,
  provisionWorkerClone,
  scanForGithubCredentialMaterial,
  urlCarriesUserinfo,
} from "./clone.js";

let dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-wp107-clone-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@camino.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@camino.invalid",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();
}

/** A small source repo, generated in-script (never a serialized fixture). */
function makeSourceRepo(): string {
  const dir = tempDir();
  git(dir, "init", "--initial-branch", "main", ".");
  writeFileSync(join(dir, "README.md"), "fixture repo\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "app.ts"), "export const answer = 42;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial");
  return dir;
}

function cloneDest(): string {
  // git clone wants a non-existent dest; hand it a child of a temp dir.
  return join(tempDir(), "workspace");
}

describe("provisionWorkerClone (CAM-EXEC-02 positive path)", () => {
  it("produces a full isolated clone whose attestation passes", () => {
    const source = makeSourceRepo();
    const dest = cloneDest();
    const record = provisionWorkerClone({ sourceRepo: source, destDir: dest });
    expect(record).toEqual({
      gitIsRealDirectory: true,
      noAlternates: true,
      noHardlinkedObjects: true,
      hooksDisabledByConfig: true,
      noCredentialHelper: true,
      remotesCredentialFree: true,
      noHttpExtraheader: true,
      noSshCommand: true,
      credentialMaterialPaths: [],
    });
  });

  it("object store stands alone: the clone fscks green after the source is destroyed", () => {
    const source = makeSourceRepo();
    const dest = cloneDest();
    provisionWorkerClone({ sourceRepo: source, destDir: dest });
    rmSync(source, { recursive: true, force: true });
    // A shared/alternates clone would fail fsck here — its objects lived in
    // the deleted source. A FULL clone carries every object itself.
    expect(() => git(dest, "fsck", "--strict")).not.toThrow();
    expect(git(dest, "rev-parse", "HEAD")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("hooks are disabled by config: a planted executable hook never fires", () => {
    const source = makeSourceRepo();
    const dest = cloneDest();
    provisionWorkerClone({ sourceRepo: source, destDir: dest });
    expect(git(dest, "config", "--local", "--get", "core.hooksPath")).toBe(WORKER_CLONE_HOOKS_PATH);
    // Plant a pre-commit hook that writes a marker if it ever executes, then
    // commit. Under core.hooksPath=/dev/null the marker must not appear.
    const marker = join(dest, "..", "hook-ran.marker");
    const hookDir = join(dest, ".git", "hooks");
    const hook = join(hookDir, "pre-commit");
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(hook, 0o755);
    writeFileSync(join(dest, "change.txt"), "worker change\n");
    git(dest, "add", "change.txt");
    git(dest, "commit", "-m", "change");
    expect(() => execFileSync("test", ["-e", marker])).toThrow(); // marker absent
  });

  it("refuses a source URL that carries userinfo, before cloning anything", () => {
    expect(() =>
      provisionWorkerClone({
        sourceRepo: "https://user:secret-token@github.invalid/org/repo.git",
        destDir: cloneDest(),
      }),
    ).toThrow(WorkerCloneError);
  });
});

describe("assertWorkerCloneIsolation (CAM-EXEC-02 negative fixtures)", () => {
  it("rejects a linked worktree (.git is a gitfile, not a directory)", () => {
    const source = makeSourceRepo();
    const worktree = join(tempDir(), "linked");
    git(source, "worktree", "add", worktree);
    expect(() => assertWorkerCloneIsolation(worktree)).toThrow(
      /linked worktree|not a real directory/,
    );
  });

  it("rejects a --shared clone (alternates present)", () => {
    const source = makeSourceRepo();
    const dest = cloneDest();
    execFileSync("git", ["clone", "--shared", "--", source, dest], { env: GIT_ENV });
    expect(() => assertWorkerCloneIsolation(dest)).toThrow(/alternates/);
  });

  it("rejects a --reference clone (alternates present)", () => {
    const source = makeSourceRepo();
    const dest = cloneDest();
    execFileSync("git", ["clone", "--reference", source, "--", source, dest], { env: GIT_ENV });
    expect(() => assertWorkerCloneIsolation(dest)).toThrow(/alternates/);
  });

  it("rejects a --local hardlink clone (shared LOOSE object store, no alternates) — round-1 finding 10", () => {
    const source = makeSourceRepo();
    const dest = cloneDest();
    // A plain --local clone HARDLINKS its loose objects to the source (no
    // alternates file), so the alternates check alone misses it.
    execFileSync("git", ["clone", "--local", "--", source, dest], { env: GIT_ENV });
    git(dest, "config", "--local", "core.hooksPath", "/dev/null");
    git(dest, "config", "--local", "credential.helper", "");
    expect(() => assertWorkerCloneIsolation(dest)).toThrow(/hardlink/);
  });

  it("rejects a --local hardlink clone of a PACKED source (shared pack) — round-2 finding 7", () => {
    const source = makeSourceRepo();
    // Pack the source so its objects live in objects/pack, then --local clone:
    // the .pack/.idx are hardlinked, which the loose-only check would miss.
    execFileSync("git", ["-C", source, "gc", "--prune=now"], { env: GIT_ENV });
    const dest = cloneDest();
    execFileSync("git", ["clone", "--local", "--", source, dest], { env: GIT_ENV });
    git(dest, "config", "--local", "core.hooksPath", "/dev/null");
    git(dest, "config", "--local", "credential.helper", "");
    expect(() => assertWorkerCloneIsolation(dest)).toThrow(/hardlink/);
  });

  it("rejects a clone whose objects dir is a SYMLINK to an external store — not self-contained (round-10 finding 6)", () => {
    const source = makeSourceRepo();
    const dest = cloneDest();
    provisionWorkerClone({ sourceRepo: source, destDir: dest });
    // Move .git/objects to an external location and replace it with a symlink:
    // the per-object-file checks pass (the target's files have nlink 1 and aren't
    // symlinks) but the clone depends on an EXTERNAL store — move it away and git
    // fsck fails. The attestation must reject a symlinked object DIRECTORY.
    const objects = join(dest, ".git", "objects");
    const external = join(tempDir(), "external-objects");
    renameSync(objects, external);
    symlinkSync(external, objects);
    expect(() => assertWorkerCloneIsolation(dest)).toThrow(
      /hardlink|shared|standalone|self-contained/i,
    );
  });

  it("rejects a PUSH url userinfo hidden behind an option-shaped remote name — round-2 finding 4", () => {
    const source = makeSourceRepo();
    const dest = cloneDest();
    provisionWorkerClone({ sourceRepo: source, destDir: dest });
    // A remote whose NAME looks like an option would have injected into
    // `git remote get-url <name>`; reading effective config avoids that AND
    // sees the pushurl.
    git(
      dest,
      "config",
      "--local",
      "remote.--upload-pack.pushurl",
      "https://x:tok@github.invalid/o/r",
    );
    expect(() => assertWorkerCloneIsolation(dest)).toThrow(/userinfo/);
  });

  it("rejects an http.extraheader reached through a git-config [include] — round-2 finding 4", () => {
    const source = makeSourceRepo();
    const dest = cloneDest();
    provisionWorkerClone({ sourceRepo: source, destDir: dest });
    // Put the Authorization channel in an INCLUDED file; the effective-config
    // read resolves the include, the raw-file scan of .git/config would not.
    const incPath = join(dest, ".git", "creds.inc");
    writeFileSync(
      incPath,
      '[http "https://github.invalid/"]\n\textraheader = AUTHORIZATION: basic SECRET\n',
    );
    git(dest, "config", "--local", "include.path", "creds.inc");
    expect(() => assertWorkerCloneIsolation(dest)).toThrow(/extraheader/);
  });

  it("rejects a credential-NAMED symlink (.npmrc → secrets.txt) — round-2 finding 4", () => {
    const source = makeSourceRepo();
    const dest = cloneDest();
    provisionWorkerClone({ sourceRepo: source, destDir: dest });
    writeFileSync(join(dest, "secrets.txt"), "//npm.pkg.github.com/:_authToken=ghp_SECRET\n");
    symlinkSync("secrets.txt", join(dest, ".npmrc"));
    expect(() => assertWorkerCloneIsolation(dest)).toThrow(/credential material/);
  });

  it("rejects a SCOPED credential.<url>.helper and url.insteadOf and sshCommand (round-3 finding 4)", () => {
    const source = makeSourceRepo();
    for (const [key, value] of [
      ["credential.https://github.invalid.helper", "!/tmp/helper.sh"],
      ["url.https://x-access-token:SECRET@github.invalid/.insteadOf", "https://github.invalid/"],
      ["core.sshCommand", "ssh -i /tmp/leak"],
    ] as const) {
      const dest = cloneDest();
      provisionWorkerClone({ sourceRepo: source, destDir: dest });
      git(dest, "config", "--local", key, value);
      expect(() => assertWorkerCloneIsolation(dest), key).toThrow(WorkerCloneError);
    }
  });

  it("rejects a SYMLINKED packed object (nlink 1 but not standalone) — round-3 finding 9", () => {
    const source = makeSourceRepo();
    execFileSync("git", ["-C", source, "gc", "--prune=now"], { env: GIT_ENV });
    const dest = cloneDest();
    provisionWorkerClone({ sourceRepo: source, destDir: dest });
    // Replace a real .pack in the clone with a symlink to the source's pack.
    const packDir = join(dest, ".git", "objects", "pack");
    const srcPackDir = join(source, ".git", "objects", "pack");
    const pack = readdirSync(packDir).find((n) => n.endsWith(".pack"))!;
    rmSync(join(packDir, pack));
    symlinkSync(join(srcPackDir, pack), join(packDir, pack));
    expect(() => assertWorkerCloneIsolation(dest)).toThrow(/hardlink|symlink|shares its object/);
  });

  it("case-folds credential filenames (.NPMRC with a token) — round-3 finding 6", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".NPMRC"), "//registry.npmjs.org/:_authToken=npm_SECRET\n");
    expect(scanForGithubCredentialMaterial(dir)).toEqual([".NPMRC"]);
  });

  it("rejects a plain clone without the hooks-disabling config", () => {
    const source = makeSourceRepo();
    const dest = cloneDest();
    execFileSync("git", ["clone", "--no-local", "--", source, dest], { env: GIT_ENV });
    expect(() => assertWorkerCloneIsolation(dest)).toThrow(/hooks/);
  });

  it("rejects a clone whose remote FETCH URL carries userinfo", () => {
    const source = makeSourceRepo();
    const dest = cloneDest();
    provisionWorkerClone({ sourceRepo: source, destDir: dest });
    git(dest, "remote", "set-url", "origin", "https://x-access-token:tok@github.invalid/o/r.git");
    expect(() => assertWorkerCloneIsolation(dest)).toThrow(/userinfo/);
  });

  it("rejects a clone whose remote PUSH URL carries userinfo (round-1 finding 2)", () => {
    const source = makeSourceRepo();
    const dest = cloneDest();
    provisionWorkerClone({ sourceRepo: source, destDir: dest });
    // Fetch url stays clean; the secret hides in pushurl, which `get-url`
    // (fetch-only) missed before the --push enumeration.
    git(
      dest,
      "remote",
      "set-url",
      "--push",
      "origin",
      "https://x-access-token:tok@github.invalid/o/r.git",
    );
    expect(() => assertWorkerCloneIsolation(dest)).toThrow(/userinfo/);
  });

  it("rejects a configured credential helper", () => {
    const source = makeSourceRepo();
    const dest = cloneDest();
    provisionWorkerClone({ sourceRepo: source, destDir: dest });
    git(dest, "config", "--local", "credential.helper", "store");
    expect(() => assertWorkerCloneIsolation(dest)).toThrow(/credential helper/);
  });

  it("rejects planted stored-credential files (filesystem assertion)", () => {
    const source = makeSourceRepo();
    const dest = cloneDest();
    provisionWorkerClone({ sourceRepo: source, destDir: dest });
    writeFileSync(join(dest, ".git-credentials"), "https://user:tok@github.invalid\n");
    expect(() => assertWorkerCloneIsolation(dest)).toThrow(/credential material/);
  });
});

describe("scanForGithubCredentialMaterial", () => {
  it("finds credential files and credential-channel git configs, by path only", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "nested", "deep"), { recursive: true });
    writeFileSync(join(dir, "nested", ".netrc"), "machine github.invalid login u password p\n");
    writeFileSync(join(dir, "nested", "deep", "config"), "[credential]\n\thelper = store\n");
    writeFileSync(join(dir, "clean.txt"), "no credentials here\n");
    const findings = scanForGithubCredentialMaterial(dir);
    expect(findings).toEqual(["nested/.netrc", "nested/deep/config"]);
    // Paths only — a finding never carries file content.
    for (const f of findings) expect(f).not.toContain("password");
  });

  it("flags an http extraheader and a userinfo url in git config content", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, ".gitconfig"),
      '[http "https://github.invalid/"]\n\textraheader = AUTHORIZATION: basic abc\n',
    );
    expect(scanForGithubCredentialMaterial(dir)).toEqual([".gitconfig"]);
    const dir2 = tempDir();
    writeFileSync(join(dir2, "config"), '[remote "origin"]\n\turl = https://u:t@host.invalid/r\n');
    expect(scanForGithubCredentialMaterial(dir2)).toEqual(["config"]);
  });

  it("flags a gh hosts.yml with an oauth_token but not a token-free one (round-1 finding 2)", () => {
    const withToken = tempDir();
    mkdirSync(join(withToken, ".config", "gh"), { recursive: true });
    writeFileSync(
      join(withToken, ".config", "gh", "hosts.yml"),
      "github.com:\n  oauth_token: gho_SECRET\n  user: someone\n",
    );
    expect(scanForGithubCredentialMaterial(withToken)).toEqual([".config/gh/hosts.yml"]);
    // A token-free hosts.yml (or an unrelated one) is NOT a false positive.
    const clean = tempDir();
    writeFileSync(join(clean, "hosts.yml"), "web1: 10.0.0.1\nweb2: 10.0.0.2\n");
    expect(scanForGithubCredentialMaterial(clean)).toEqual([]);
  });

  it("flags an .npmrc with an auth token but not a token-free one", () => {
    const withToken = tempDir();
    writeFileSync(join(withToken, ".npmrc"), "//registry.npmjs.org/:_authToken=npm_SECRET\n");
    expect(scanForGithubCredentialMaterial(withToken)).toEqual([".npmrc"]);
    const clean = tempDir();
    writeFileSync(join(clean, ".npmrc"), "registry=https://registry.npmjs.org/\n");
    expect(scanForGithubCredentialMaterial(clean)).toEqual([]);
  });

  it("does NOT flag comment-only or example credential lines (round-2 finding 11)", () => {
    const commented = tempDir();
    writeFileSync(
      join(commented, ".npmrc"),
      "# //registry.npmjs.org/:_authToken=put-your-token-here\nregistry=https://registry.npmjs.org/\n",
    );
    expect(scanForGithubCredentialMaterial(commented)).toEqual([]);
    const example = tempDir();
    writeFileSync(join(example, "hosts.yml"), "github.com:\n  oauth_token: example\n");
    expect(scanForGithubCredentialMaterial(example)).toEqual([]);
    // ...but a real value on a non-comment line IS flagged.
    const real = tempDir();
    writeFileSync(
      join(real, "hosts.yml"),
      "# example config\ngithub.com:\n  oauth_token: gho_real\n",
    );
    expect(scanForGithubCredentialMaterial(real)).toEqual(["hosts.yml"]);
  });

  it("does NOT flag an INLINE-comment credential mention (round-3 finding 12)", () => {
    const dir = tempDir();
    // The oauth_token is inside an inline `#` comment — not a real assignment.
    writeFileSync(join(dir, "hosts.yml"), "github.com:\n  user: someone # oauth_token: gho_X\n");
    expect(scanForGithubCredentialMaterial(dir)).toEqual([]);
  });

  it("flags a credential-named symlink without following it", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "target.txt"), "//npm.pkg.github.com/:_authToken=ghp_SECRET\n");
    symlinkSync("target.txt", join(dir, ".npmrc"));
    const findings = scanForGithubCredentialMaterial(dir);
    expect(findings).toContain(".npmrc (credential-named symlink)");
  });

  it("reports an empty result on a clean tree", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "app.ts"), "export {};\n");
    expect(scanForGithubCredentialMaterial(dir)).toEqual([]);
  });
});

describe("urlCarriesUserinfo", () => {
  it("classifies URL shapes", () => {
    expect(urlCarriesUserinfo("https://user:tok@github.invalid/o/r.git")).toBe(true);
    expect(urlCarriesUserinfo("https://token@github.invalid/o/r.git")).toBe(true);
    expect(urlCarriesUserinfo("https://github.invalid/o/r.git")).toBe(false);
    expect(urlCarriesUserinfo("/tmp/some/path")).toBe(false);
    // scp-like SSH user is a user NAME channel, not an embedded secret.
    expect(urlCarriesUserinfo("git@github.invalid:o/r.git")).toBe(false);
  });
});
