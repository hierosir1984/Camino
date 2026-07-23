// WP-108 quarantine — git plumbing (CAM-EXEC-04, design §5.1).
//
// Every git invocation here runs with a CREDENTIAL-FREE, hooks-disabled env
// (the WP-107 clone.ts pattern): no GitHub PAT, host global/system config
// neutralized to /dev/null, no interactive credential prompt, LC_ALL=C for
// stable parsing. The intake executes git ONLY in the Camino-owned pristine
// repo and reads the worker's objects solely by FETCHING from the worker repo
// (upload-pack) — it never runs a git command inside a worker-touched working
// tree. Together these discharge the AC "credentialed git never executes in
// worker-touched directories" (see the README boundary note on the residual
// serving-side config-exec surface, which is structural, not an exhaustive
// denylist).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangedPath, ChangedPathKind } from "@camino/shared";
import type { TreeEntry } from "./types.js";

/** A quarantine git-operation failure. Always fail-closed (the intake refuses). */
export class QuarantineGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuarantineGitError";
  }
}

/**
 * The credential-free, hooks-neutralized environment every quarantine git call
 * runs under. GIT_CONFIG_GLOBAL/SYSTEM=/dev/null removes host config (and any
 * credential helper stored there); GIT_TERMINAL_PROMPT=0 forbids an interactive
 * credential prompt; LC_ALL=C keeps porcelain/plumbing output stable. NB: this
 * env carries no PATH by default — the caller-side helpers add the ambient PATH
 * so `git` resolves, and nothing else, so no attacker-planted env steers an
 * exec channel.
 */
const GIT_ENV_BASE = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
} as const;

function runGit(cwd: string | null, args: string[], maxBuffer: number): Buffer {
  const env: Record<string, string> = { ...GIT_ENV_BASE };
  const path = process.env["PATH"];
  if (typeof path === "string") env["PATH"] = path;
  return execFileSync("git", cwd === null ? args : ["-C", cwd, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer,
  });
}

/** Run git in `dir`, returning trimmed stdout text. Throws on non-zero exit. */
export function git(dir: string, ...args: string[]): string {
  return runGit(dir, args, 16 * 1024 * 1024)
    .toString()
    .trim();
}

/** Run git in `dir`, returning raw stdout bytes (for blob contents / -z output). */
export function gitBuf(dir: string, ...args: string[]): Buffer {
  return runGit(dir, args, 256 * 1024 * 1024);
}

const pristineDirs: string[] = [];

/**
 * A throwaway, hooks-disabled, credential-free control-plane repo. This is the
 * PRISTINE store the worker head is shallow-fetched into: worker history and
 * any object reachable only through it never cross the boundary. Unlike a
 * fixture repo, it needs no upload-pack allow flags — the pristine repo is the
 * FETCHER, never a server for untrusted refs.
 */
export function initPristineRepo(prefix = "camino-quarantine-pristine-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  pristineDirs.push(dir);
  try {
    runGit(dir, ["init", "--quiet", "--initial-branch=main"], 1 << 20);
  } catch (err) {
    throw new QuarantineGitError(`pristine repo init failed: ${describe(err)}`);
  }
  // Deterministic identity + no hooks, ever. credential.helper reset so no host
  // helper is consulted even if the env neutralization is incomplete on a host.
  git(dir, "config", "user.email", "camino@camino.invalid");
  git(dir, "config", "user.name", "Camino");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.hooksPath", "/dev/null");
  git(dir, "config", "credential.helper", "");
  // Keep raw path bytes intact so the POLICY layer sees exactly what the tree
  // stores (macOS would otherwise precompose NFD names, hiding a Unicode
  // collision; HFS/NTFS guards could pre-reject trailing-dot / reserved names).
  git(dir, "config", "core.precomposeunicode", "false");
  git(dir, "config", "core.protectHFS", "false");
  git(dir, "config", "core.protectNTFS", "false");
  return dir;
}

/** Remove every pristine repo created this run (call from a test afterAll or a caller's teardown). */
export function cleanupPristineRepos(): void {
  for (const d of pristineDirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Remove one pristine repo (the intake caller owns its result's pristineDir lifecycle). */
export function removePristineRepo(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  const idx = pristineDirs.indexOf(dir);
  if (idx >= 0) pristineDirs.splice(idx, 1);
}

/**
 * Fetch a single ref/sha from `sourceRepo` into `pristineDir`. `shallow` uses
 * `--depth=1`, which for the worker head pulls ONLY its final tree (commit +
 * trees + blobs), never intermediate history — the structural basis of
 * reachable-history exclusion. Returns the fetched tip sha (from FETCH_HEAD),
 * so the intake never runs `rev-parse` inside the worker-touched source.
 */
export function fetchTip(
  pristineDir: string,
  sourceRepo: string,
  ref: string,
  shallow: boolean,
): string {
  const args = ["fetch", "--no-tags", "--quiet"];
  if (shallow) args.push("--depth=1");
  args.push("--", sourceRepo, ref);
  try {
    git(pristineDir, ...args);
  } catch (err) {
    throw new QuarantineGitError(
      `shallow-fetch of ${JSON.stringify(ref)} from source failed: ${describe(err)}`,
    );
  }
  try {
    return git(pristineDir, "rev-parse", "FETCH_HEAD");
  } catch (err) {
    throw new QuarantineGitError(`could not resolve fetched tip: ${describe(err)}`);
  }
}

/** The tree sha of a commit present in `dir`. */
export function treeOf(dir: string, commit: string): string {
  return git(dir, "rev-parse", `${commit}^{tree}`);
}

const LS_TREE_RECORD = /^(\d{6}) (blob|tree|commit) ([0-9a-f]+)\s+(\S+)\t([\s\S]*)$/;

/** Parse `git ls-tree -r -l -z <tree>` output into typed entries. */
export function parseTree(raw: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (const record of raw.split("\0")) {
    if (record.length === 0) continue;
    const m = LS_TREE_RECORD.exec(record);
    if (!m) throw new QuarantineGitError(`unparseable ls-tree record: ${JSON.stringify(record)}`);
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

/** Leaf entries (blobs, symlinks, gitlinks) of `treeSha` for the path/content checks. */
export function treeLeaves(dir: string, treeSha: string): TreeEntry[] {
  return parseTree(gitBuf(dir, "ls-tree", "-r", "-l", "-z", treeSha).toString("utf8"));
}

/**
 * Count of ALL objects in `treeSha` — every subtree plus every leaf, plus 1 for
 * the queried root that ls-tree omits. `-t` includes intermediate trees, so a
 * pathologically DEEP tree (one leaf, many trees) is counted honestly. This is
 * the object-count both the registry-item-11 fetch budget and the final-tree
 * policy budget consult.
 */
export function treeObjectCount(dir: string, treeSha: string): number {
  const raw = gitBuf(dir, "ls-tree", "-r", "-t", "-l", "-z", treeSha).toString("utf8");
  return parseTree(raw).length + 1;
}

/**
 * Parent shas read from the RAW commit object, not `%P`: a `--depth=1` shallow
 * fetch writes a graft that makes traversal views report the fetched commit as
 * parentless, but the stored object still carries every `parent` line. Reading
 * the raw object is what detects a worker MERGE commit after a shallow fetch.
 */
export function parentShas(dir: string, commit: string): string[] {
  const raw = git(dir, "cat-file", "commit", commit);
  const parents: string[] = [];
  for (const line of raw.split("\n")) {
    if (line === "") break; // end of header
    if (line.startsWith("parent ")) parents.push(line.slice("parent ".length).trim());
  }
  return parents;
}

/** The subject line (`%s`) of a commit present in `dir`. */
export function subjectOf(dir: string, commit: string): string {
  return git(dir, "show", "-s", "--format=%s", commit);
}

/**
 * Raw target bytes of a symlink blob, decoded latin1 so the escape check sees
 * exactly what the OS would (every byte preserved, including NUL / control).
 */
export function symlinkTargetBytes(dir: string, sha: string): string {
  return gitBuf(dir, "cat-file", "blob", sha).toString("latin1");
}

/**
 * Run git's own hardened object/path checker over `treeSha`. Returns the first
 * error line, or null if clean. Delegates the whole malformed-object class —
 * `.git` path equivalents (incl. HFS-ignorable chars), mode/type mismatches,
 * broken links — to fsck, far more complete than any hand-rolled parser (the
 * WP-003 r3 lesson). We fsck the TREE (not the commit) to avoid the shallow
 * graft boundary.
 */
export function fsckTree(dir: string, treeSha: string): string | null {
  try {
    runGit(dir, ["fsck", "--strict", "--no-dangling", treeSha], 16 * 1024 * 1024);
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

/** The `--name-only --no-renames -z` changed-path set between two commits. */
export function changedPaths(dir: string, base: string, head: string): string[] {
  const raw = gitBuf(dir, "diff", "--name-only", "--no-renames", "-z", base, head).toString("utf8");
  return raw.split("\0").filter((s) => s.length > 0);
}

/**
 * The `--name-status --no-renames -z` changed paths, typed for the emitted diff.
 * `--no-renames`: a rename is a DELETE of the source + an ADD of the
 * destination, so the source deletion cannot be hidden (the WP-003 r2 lesson)
 * and every consumer sees both halves. `-z` output alternates STATUS\0PATH\0.
 */
export function changedPathsWithStatus(dir: string, base: string, head: string): ChangedPath[] {
  const raw = gitBuf(dir, "diff", "--name-status", "--no-renames", "-z", base, head).toString(
    "utf8",
  );
  const fields = raw.split("\0");
  const out: ChangedPath[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i]!;
    const path = fields[i + 1]!;
    if (status.length === 0 || path.length === 0) continue;
    const change = statusToChange(status);
    out.push({ path, change });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** Map a `--name-status` status letter to the total ChangedPathKind. */
function statusToChange(status: string): ChangedPathKind {
  const c = status[0];
  if (c === "A") return "added";
  if (c === "D") return "deleted";
  // M (modified), T (type change), and — under --no-renames — never R/C. Any
  // other same-path status is a content/mode change: "modified".
  return "modified";
}

/**
 * Author a fresh Camino commit applying `treeSha` onto `base` (the single
 * assigned parent) with `message`. Camino is author AND committer; the worker
 * is credited only in the message trailer. Deterministic dates so the same
 * inputs yield the same candidate sha (idempotent re-authoring).
 */
export function commitCandidate(
  dir: string,
  treeSha: string,
  base: string,
  message: string,
): string {
  const env: Record<string, string> = {
    ...GIT_ENV_BASE,
    GIT_AUTHOR_NAME: "Camino",
    GIT_AUTHOR_EMAIL: "camino@camino.invalid",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Camino",
    GIT_COMMITTER_EMAIL: "camino@camino.invalid",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  const path = process.env["PATH"];
  if (typeof path === "string") env["PATH"] = path;
  try {
    return execFileSync("git", ["-C", dir, "commit-tree", treeSha, "-p", base, "-m", message], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1 << 20,
    })
      .toString()
      .trim();
  } catch (err) {
    throw new QuarantineGitError(`candidate authoring (commit-tree) failed: ${describe(err)}`);
  }
}

/** Distinct object shas present in `dir`'s store (the shallow-fetch footprint). */
export function distinctObjectCount(dir: string): number {
  const raw = git(
    dir,
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objectname)",
    "--unordered",
  );
  return raw.length === 0 ? 0 : raw.split("\n").filter((l) => l.trim().length > 0).length;
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

/** Stringify any thrown value safely for a quarantine git-error message. */
function describe(err: unknown, max = 400): string {
  try {
    return String(err instanceof Error ? err.message : err).slice(0, max);
  } catch {
    return "unstringifiable error";
  }
}
