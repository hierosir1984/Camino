// WP-108 quarantine — TEST-SUPPORT git plumbing for the WP-003 corpus fixtures.
//
// Every corpus case builds an untrusted "worker repo" with a base and a final
// head via git PLUMBING (hash-object / a scratch-index write-tree / commit-tree),
// never by writing working-tree files: the host is a case-insensitive,
// Unicode-normalizing macOS filesystem, so `File.txt` + `file.txt`, trailing-dot
// aliases, symlinks, and gitlinks simply cannot exist as committed files here.
// Plumbing builds the exact trees under test anyway.
//
// This module is imported ONLY by corpus-fixtures.ts / corpus.test.ts. It is
// deliberately separate from the production git.ts (which is credential-free and
// operates the pristine control-plane repo); these helpers instead stand up the
// UNTRUSTED worker repos the intake fetches from.
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

const tmpDirs: string[] = [];

/** A throwaway worker repo with a deterministic identity, hooks disabled, serving bare shas. */
export function initRepo(prefix = "camino-quarantine-worker-"): string {
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

/** Remove every fixture repo created this run (call from afterAll). */
export function cleanupRepos(): void {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Hash `content` into a blob object and return its sha. */
export function hashBlob(dir: string, content: string | Buffer): string {
  const tmp = join(dir, `.blob-${randomSuffix()}`);
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

/**
 * Hash `n` DISTINCT blobs in ONE git process (`hash-object --stdin-paths` over
 * temp files whose content varies by index), returning their shas. Used to build
 * a genuinely-many-DISTINCT-object tree (e.g. the registry-item-11 fetch-object
 * budget) without one spawn per blob and without a deep tree (git's upload-pack
 * refuses to serve trees past its max-depth, so distinct objects must go WIDE).
 */
export function hashManyDistinctBlobs(dir: string, n: number): string[] {
  const scratch = mkdtempSync(join(tmpdir(), "camino-blobs-"));
  try {
    const paths: string[] = [];
    for (let i = 0; i < n; i++) {
      const p = join(scratch, `b${i}`);
      writeFileSync(p, `distinct-content-${i}\n`);
      paths.push(p);
    }
    const out = execFileSync("git", ["-C", dir, "hash-object", "-w", "--stdin-paths"], {
      input: paths.join("\n") + "\n",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString()
      .trim()
      .split("\n");
    return out;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
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
  const indexFile = join(dir, `.idx-${randomSuffix()}`);
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
 * Build a tree from MANY entries in ONE git process via `update-index
 * --index-info` (entries piped on stdin), so a fixture that needs thousands of
 * entries (e.g. the registry-item-11 fetch-object-budget breach) does not spawn
 * one subprocess per entry. Generated in-script, never as one giant argv (the
 * E2BIG-on-Linux lesson).
 */
export function buildTreeBulk(dir: string, entries: CacheEntry[]): string {
  const indexFile = join(dir, `.idx-${randomSuffix()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  // `--index-info` line format: "<mode> <object> <stage>\t<path>".
  const input = entries.map((e) => `${e.mode} ${e.sha} 0\t${e.path}`).join("\n") + "\n";
  try {
    execFileSync("git", ["-C", dir, "update-index", "--index-info"], {
      env,
      input,
      stdio: ["pipe", "ignore", "pipe"],
    });
    return execFileSync("git", ["-C", dir, "write-tree"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
  } finally {
    rmSync(indexFile, { force: true });
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

// A non-cryptographic unique-enough suffix for scratch file names. Date.now is
// unavailable in some harnesses; a counter + high-res-ish entropy is plenty for
// a per-process temp name (fixtures run single-process).
let counter = 0;
function randomSuffix(): string {
  counter += 1;
  return `${counter}-${process.pid}`;
}
