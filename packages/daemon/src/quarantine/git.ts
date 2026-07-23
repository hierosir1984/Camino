// WP-108 quarantine — git plumbing (CAM-EXEC-04, design §5.1).
//
// Every git invocation here runs with a CREDENTIAL-FREE, hooks-disabled env
// (the WP-107 clone.ts pattern): no GitHub PAT, host global/system config
// neutralized to /dev/null, no interactive credential prompt, LC_ALL=C for
// stable parsing. The intake spawns git with cwd ONLY in the Camino-owned
// pristine repo; it reads the worker's objects solely by FETCHING from the
// worker repo, which spawns `git upload-pack` as a HOST process whose cwd is the
// worker repo — but that server inherits the same credential-free, config-
// neutralized env, and git does not honour a repo-local `uploadpack.
// packObjectsHook` (read only from protected config). Together these discharge
// the AC "credentialed git never executes in worker-touched directories" (see
// the README boundary note on the residual serving-side config-exec surface,
// which is structural, not an exhaustive denylist).
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

/** The credential-free env (+ the ambient PATH so `git` resolves, nothing else). */
function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...GIT_ENV_BASE, ...extra };
  const path = process.env["PATH"];
  if (typeof path === "string") env["PATH"] = path;
  return env;
}

function runGit(cwd: string | null, args: string[], maxBuffer: number): Buffer {
  return execFileSync("git", cwd === null ? args : ["-C", cwd, ...args], {
    env: gitEnv(),
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
  // Replacement refs (refs/replace/<oid>) transparently substitute one object
  // for another in EVERY later git command, so a fetched replace ref would let a
  // worker swap the assigned base out from under the diff/rebuild. Disable them
  // in the pristine store (defence in depth behind the OID validation in
  // fetchOid, which is what stops such a ref being written in the first place).
  git(dir, "config", "core.useReplaceRefs", "false");
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
 * Refuse a fetch source whose object store BORROWS from another via an
 * `objects/info/alternates` (or `http-alternates`) file. Such a store makes its
 * `upload-pack` serve objects it does not itself contain, so a worker could put
 * an object from an external/shared store into its final tree and have it
 * admitted into the candidate (review r1 finding 4). WP-107 provisions worker
 * clones alternate-free (`assertWorkerCloneIsolation`'s `noAlternates`); this is
 * the intake's own re-attestation — a filesystem check only, no git executed in
 * the worker-touched directory. Covers non-bare (`.git/…`) and bare (`…`)
 * layouts.
 */
export function assertSelfContainedObjectStore(repo: string): void {
  // A GITFILE `.git` (a FILE, or a symlink, not a directory) redirects to a
  // `commondir` whose object store — and its alternates — live elsewhere, so a
  // linked-worktree worker repo could hide a borrowing store the direct file
  // check below never sees (review r2 finding 3). Refuse it outright: a WP-107
  // worker clone is a full clone with a REAL `.git` directory (its
  // `gitIsRealDirectory` attestation), or a bare repo (no `.git` at all). This
  // is an lstat, not a follow — no TOCTOU on the target.
  const dotGit = join(repo, ".git");
  let dotGitStat;
  try {
    dotGitStat = lstatSync(dotGit);
  } catch {
    dotGitStat = null; // absent ⇒ bare layout, checked below
  }
  if (dotGitStat !== null && !dotGitStat.isDirectory()) {
    throw new QuarantineGitError(
      "fetch source `.git` is a gitfile/symlink (linked worktree) — refused; a worker clone must " +
        "have a real `.git` directory so its object store cannot borrow via commondir (CAM-EXEC-02 / review r2 finding 3)",
    );
  }
  const candidates = [
    join(repo, ".git", "objects", "info", "alternates"),
    join(repo, ".git", "objects", "info", "http-alternates"),
    join(repo, "objects", "info", "alternates"),
    join(repo, "objects", "info", "http-alternates"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      throw new QuarantineGitError(
        `fetch source object store borrows from an external store (${basename(p)}) — refused; ` +
          "a worker clone must be self-contained (CAM-EXEC-02 / review r1 finding 4)",
      );
    }
  }
}

/** A git object name: 40-hex (sha-1) or 64-hex (sha-256), lower-case. */
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Lower-case-hex git object name — the ONLY accepted fetch source (see fetchOid). */
export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

/**
 * Fetch a single commit BY EXACT OBJECT ID from `sourceRepo` into `pristineDir`.
 *
 * The source MUST be a bare 40/64-hex OID, never a ref string. A ref string is a
 * refspec surface: `git fetch <repo> <src>:<dst>` writes `<dst>` (e.g. a
 * `refs/replace/<oid>` that would substitute the assigned base), and `--` ends
 * OPTION parsing but does NOT stop `src:dst` / wildcard interpretation. An OID
 * cannot carry a `:` or `*`, so passing one closes refspec injection and the
 * multi-head/over-budget wildcard fetch outright (review r1 findings 1, 2); the
 * fetch writes only FETCH_HEAD. `--depth=1` pulls ONLY the commit's own tree
 * (commit + trees + blobs), never intermediate history — the structural basis
 * of reachable-history exclusion. Returns the fetched OID (verified to equal the
 * requested one), so the intake never runs `rev-parse` inside the worker source.
 */
export function fetchOid(
  pristineDir: string,
  sourceRepo: string,
  oid: string,
  shallow: boolean,
): string {
  if (!isOid(oid)) {
    throw new QuarantineGitError(
      `fetch source must be a bare git object id, not a ref string (refspec injection guard): ${JSON.stringify(oid)}`,
    );
  }
  const args = ["fetch", "--no-tags", "--quiet"];
  if (shallow) args.push("--depth=1");
  // `oid` is validated hex — no option/refspec shape can survive isOid — so it
  // reaches upload-pack as a single want with no destination. The default
  // FETCH_HEAD write is harmless (it can only name the validated oid) and keeps
  // the fetched object referenced.
  args.push("--", sourceRepo, oid);
  try {
    git(pristineDir, ...args);
  } catch (err) {
    throw new QuarantineGitError(
      `shallow-fetch of ${oid.slice(0, 12)} from source failed: ${describe(err)}`,
    );
  }
  // The requested OID is now an object in the pristine store; confirm it parses
  // to itself as a commit (FETCH_HEAD can only point at the validated oid).
  let resolved: string;
  try {
    resolved = git(pristineDir, "rev-parse", "--verify", `${oid}^{commit}`);
  } catch (err) {
    throw new QuarantineGitError(
      `fetched object ${oid.slice(0, 12)} is not a commit: ${describe(err)}`,
    );
  }
  if (resolved !== oid) {
    throw new QuarantineGitError(
      `fetched object id ${resolved.slice(0, 12)} does not match requested ${oid.slice(0, 12)}`,
    );
  }
  return oid;
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

/** The DISTINCT-object transfer footprint of the shallow fetch of `commit`. */
export interface FetchFootprint {
  /** Distinct objects: every subtree + leaf + the root tree + the commit. */
  objects: number;
  /** Summed size of ALL those distinct objects — blobs, trees, AND the commit. */
  bytes: number;
}

/**
 * Measure the shallow-fetch footprint of `commit`: the count AND total byte size
 * of the DISTINCT objects reachable from its tree, plus the root tree and the
 * commit object itself. `-t` includes intermediate trees (a deep tree is counted
 * honestly); DISTINCT ids are counted, so a blob at 5,000 paths is one object,
 * not 5,000 (review r1 finding 8). Bytes are the sizes of ALL distinct objects —
 * blobs, trees, and the commit — not just blob payload (review r2 finding 6),
 * read in ONE `cat-file --batch-check` pass so a worker's object metadata cannot
 * hide from the transfer budget.
 */
export function fetchFootprint(dir: string, commit: string, treeSha: string): FetchFootprint {
  const raw = gitBuf(dir, "ls-tree", "-r", "-t", "-l", "-z", treeSha).toString("utf8");
  const ids = new Set<string>();
  for (const e of parseTree(raw)) ids.add(e.sha);
  ids.add(treeSha); // the root tree ls-tree omits
  ids.add(commit); // the fetched commit object itself
  let out: string;
  try {
    out = execFileSync("git", ["-C", dir, "cat-file", "--batch-check=%(objectsize)"], {
      env: gitEnv(),
      input: [...ids].join("\n") + "\n",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
  } catch (err) {
    throw new QuarantineGitError(`fetch-footprint measurement failed: ${describe(err)}`);
  }
  let bytes = 0;
  for (const line of out.split("\n")) {
    const n = Number.parseInt(line.trim(), 10);
    if (Number.isFinite(n)) bytes += n;
  }
  return { objects: ids.size, bytes };
}

/** Byte size of one object (`cat-file -s`); 0 if unreadable. */
export function objectSize(dir: string, oid: string): number {
  try {
    const n = Number.parseInt(git(dir, "cat-file", "-s", oid), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Count of ALL tree objects + leaves in `treeSha` (with repetition), plus 1 for
 * the queried root. This is the per-issue tree-policy "entry-budget" measure — a
 * deep-nesting resource proxy, distinct from the registry-item-11 fetch object
 * count above (which deduplicates and adds the commit).
 */
export function treeEntryCount(dir: string, treeSha: string): number {
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
  const env = gitEnv({
    GIT_AUTHOR_NAME: "Camino",
    GIT_AUTHOR_EMAIL: "camino@camino.invalid",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Camino",
    GIT_COMMITTER_EMAIL: "camino@camino.invalid",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  });
  try {
    // Message on STDIN, never `-m <message>`: a long worker-derived subject as an
    // argv element blows the argv limit (E2BIG). commit-tree reads the message
    // from stdin when `-m` is omitted (review r2 finding 6).
    return execFileSync("git", ["-C", dir, "commit-tree", treeSha, "-p", base], {
      env,
      input: message,
      stdio: ["pipe", "pipe", "pipe"],
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

/**
 * True iff object `sha` exists in `dir`'s object store. Runs through the same
 * credential-free, config-neutralized env as every other quarantine git call
 * (review r1 finding 11): the earlier raw `execFileSync` here inherited the
 * ambient process env — a GITHUB_TOKEN, host HOME, and credential helper — which
 * contradicted the module's credential-free guarantee for this exported helper.
 */
export function objectExists(dir: string, sha: string): boolean {
  try {
    runGit(dir, ["cat-file", "-e", sha], 1 << 20);
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
