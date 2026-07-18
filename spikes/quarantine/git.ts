// Git plumbing helpers for the WP-003 quarantine spike.
//
// Every case fixture is constructed with PLUMBING (hash-object / a temp-index
// write-tree / commit-tree), never by writing working-tree files: the host is a
// case-insensitive, Unicode-normalizing macOS filesystem, so `File.txt` +
// `file.txt`, trailing-dot aliases, symlinks, and gitlinks simply cannot exist
// as committed files here. Plumbing builds the exact trees under test anyway.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run git in `dir`, returning trimmed stdout. Throws on non-zero exit. */
export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString()
    .trim();
}

/** Run git in `dir`, returning raw stdout bytes (for blob contents). */
export function gitBuf(dir: string, ...args: string[]): Buffer {
  return execFileSync("git", ["-C", dir, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** True iff object `sha` exists in `dir`'s object store. */
export function objectExists(dir: string, sha: string): boolean {
  try {
    execFileSync("git", ["-C", dir, "cat-file", "-e", sha], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const tmpDirs: string[] = [];

/** A throwaway git repo with a deterministic identity and hooks disabled. */
export function initRepo(prefix = "camino-quarantine-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  execFileSync("git", ["-C", dir, "init", "--quiet", "--initial-branch=main"], { stdio: "ignore" });
  git(dir, "config", "user.email", "fixture@camino.invalid");
  git(dir, "config", "user.name", "Camino Fixture");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.hooksPath", "/dev/null"); // no hooks ever run
  // Let the intake fetch a bare commit sha (fixtures hand out shas, not refs).
  git(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  git(dir, "config", "uploadpack.allowReachableSHA1InWant", "true");
  // Keep the raw path bytes intact so the POLICY layer catches them, not git's
  // host-specific munging: macOS would otherwise precompose NFD names (hiding
  // the Unicode-collision fixture) and HFS/NTFS guards could pre-reject the
  // trailing-dot / reserved-name fixtures. The real repos we operate on could
  // carry any of these bytes, so the intake — not the fixture host — must reject.
  git(dir, "config", "core.precomposeunicode", "false");
  git(dir, "config", "core.protectHFS", "false");
  git(dir, "config", "core.protectNTFS", "false");
  return dir;
}

/** Remove every temp repo created this run (call from afterAll). */
export function cleanupRepos(): void {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Hash `content` into a blob object and return its sha. */
export function hashBlob(dir: string, content: string | Buffer): string {
  const tmp = join(dir, `.blob-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, content);
  try {
    return execFileSync("git", ["-C", dir, "hash-object", "-w", tmp], {
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** One entry for {@link buildTree}: a git index cacheinfo triple. */
export interface CacheEntry {
  /** "100644" | "100755" | "120000" (symlink) | "160000" (gitlink). */
  mode: string;
  /** blob sha, or (for a gitlink) the referenced commit sha. */
  sha: string;
  /** repo-root-relative POSIX path. */
  path: string;
}

/**
 * Build a tree from exact (mode, sha, path) entries via a scratch index, so the
 * tree can contain things the working filesystem cannot represent: case- and
 * Unicode-colliding siblings, trailing-dot names, symlinks, and gitlinks.
 */
export function buildTree(dir: string, entries: CacheEntry[]): string {
  const indexFile = join(dir, `.idx-${Math.random().toString(36).slice(2)}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  const run = (...args: string[]): string =>
    execFileSync("git", ["-C", dir, ...args], { env, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  try {
    for (const e of entries)
      run("update-index", "--add", "--cacheinfo", `${e.mode},${e.sha},${e.path}`);
    return run("write-tree");
  } finally {
    rmSync(indexFile, { force: true });
  }
}

/**
 * Run git's own hardened object/path checker over `treeSha`. Returns the first
 * error line, or null if clean. This delegates the whole malformed-object class
 * — `.git` path equivalents (incl. HFS-ignorable characters), mode/type
 * mismatches, broken links — to git's fsck, which is far more complete than any
 * hand-rolled path parser (review r3 #1/#6). We fsck the TREE (not the commit)
 * to avoid the shallow-fetch parent boundary.
 */
export function fsckTree(dir: string, treeSha: string): string | null {
  try {
    execFileSync("git", ["-C", dir, "fsck", "--strict", "--no-dangling", treeSha], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return null;
  } catch (e) {
    const err = e as { stderr?: Buffer; stdout?: Buffer };
    const lines = ((err.stderr?.toString() ?? "") + (err.stdout?.toString() ?? ""))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return (
      lines.find((l) => /error|fatal|missing|broken|corrupt/i.test(l)) ?? lines[0] ?? "fsck failed"
    );
  }
}

/** Author a commit object over `tree` with the given parents; returns its sha. */
export function commitTree(
  dir: string,
  tree: string,
  parents: string[],
  message: string,
  opts: { name?: string; email?: string; date?: string } = {},
): string {
  const name = opts.name ?? "Camino Fixture";
  const email = opts.email ?? "fixture@camino.invalid";
  const date = opts.date ?? "2026-01-01T00:00:00Z";
  const args = ["-C", dir, "commit-tree", tree];
  for (const p of parents) args.push("-p", p);
  args.push("-m", message);
  return execFileSync("git", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      GIT_COMMITTER_DATE: date,
    },
  })
    .toString()
    .trim();
}
