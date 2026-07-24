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
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  opendirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
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

/**
 * The git executable, resolved to an ABSOLUTE path ONCE at module load by
 * scanning the startup PATH for an executable `git` (review r6 finding 10, r7
 * finding 5). Every quarantine call invokes THIS pinned absolute binary, not a
 * bare `"git"` re-resolved through the ambient PATH on each exec — so a PATH
 * entry that becomes worker-writable mid-run cannot swap the binary out.
 *
 * Two fail-closed properties (review r7 finding 5):
 *  - Only ABSOLUTE PATH entries are considered. A relative entry (`relbin`, `.`)
 *    would resolve `join(dir, "git")` against the process cwd AT EXEC time, which
 *    varies and can be steered — so it is skipped, never pinned.
 *  - If NO absolute git is found at load, GIT_BIN is null and every call THROWS
 *    (`gitBin()`), rather than falling back to a bare `"git"` re-resolved from a
 *    possibly-attacker-extended ambient PATH later.
 *
 * NAMED BOUNDARY: the daemon's PATH AT STARTUP is a trusted deployment input (the
 * control plane owns its own process env; a WP-107 worker runs in a separate
 * mount namespace and cannot write the daemon host's PATH directories) — flagged
 * for David alongside the object-store custody precondition.
 */
function resolveGitBinary(): string | null {
  const raw = process.env["PATH"];
  if (typeof raw === "string") {
    for (const dir of raw.split(":")) {
      if (dir.length === 0 || !isAbsolute(dir)) continue;
      const candidate = join(dir, "git");
      try {
        // Require a regular FILE: `accessSync(X_OK)` also succeeds on a DIRECTORY
        // named `git`, which would stop the search then fail EACCES at exec
        // (review r8 finding 6). statSync follows a symlinked git (a legit
        // install); the resolved target must be a file.
        if (statSync(candidate).isFile()) {
          accessSync(candidate, constants.X_OK);
          return candidate;
        }
      } catch {
        // not here (or not a file); try the next PATH entry
      }
    }
  }
  return null;
}

const GIT_BIN = resolveGitBinary();

/** The pinned absolute git path, or fail closed if none was resolved at load. */
function gitBin(): string {
  if (GIT_BIN === null) {
    throw new QuarantineGitError(
      "no absolute `git` executable resolved on PATH at startup — refused; the daemon PATH must " +
        "contain an absolute directory holding git (review r7 finding 5; fail-closed, never bare `git`)",
    );
  }
  return GIT_BIN;
}

/**
 * Wall-clock ceiling on any single quarantine git invocation. Bounds a read that
 * would otherwise hang forever — e.g. a `cat-file`/`fetch` that touches a FIFO or
 * device node planted in the source object store (review r6 finding 5). On expiry
 * execFileSync throws (SIGKILL), which every caller turns into a fail-closed
 * QuarantineGitError. Generous so a legitimate large-but-bounded fetch completes.
 *
 * BOUNDARY (review r7 finding 4): the sync child-process timeout kills only the
 * DIRECT git process. A serving-side descendant (`git upload-pack`, spawned in a
 * local fetch) can briefly outlive it as an orphan — normally it exits at once on
 * its broken pipe, but a FIFO planted in the source AFTER the pre-scan can wedge
 * it. That planting requires a concurrently-mutated source, which the stopped-
 * worker custody precondition (see assertSelfContainedObjectStore) excludes; the
 * lingering orphan holds no credential, cannot affect the already-rejected
 * intake, and is reaped by the daemon/container lifecycle (WP-107 teardable).
 */
const GIT_TIMEOUT_MS = 120_000;

/** The credential-free env (+ the ambient PATH so `git` resolves, nothing else). */
function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...GIT_ENV_BASE, ...extra };
  const path = process.env["PATH"];
  if (typeof path === "string") env["PATH"] = path;
  return env;
}

function runGit(cwd: string | null, args: string[], maxBuffer: number): Buffer {
  return execFileSync(gitBin(), cwd === null ? args : ["-C", cwd, ...args], {
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer,
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
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
export function initPristineRepo(
  prefix = "camino-quarantine-pristine-",
  objectFormat: "sha1" | "sha256" = "sha1",
): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  pristineDirs.push(dir);
  try {
    // Init with the SOURCE repo's object format (review r9 finding 4): a fetch of
    // a sha-256 base/head into a default sha-1 store fails ("couldn't find remote
    // ref"), so the sha-256 grammar isOid accepts was non-functional. The intake
    // detects the format from the trusted base and passes it here.
    runGit(
      dir,
      ["init", "--quiet", "--initial-branch=main", `--object-format=${objectFormat}`],
      1 << 20,
    );
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
  // KEEP the received pack (never unpack to loose objects), so the fetch's
  // on-disk footprint IS the received pack — the transfer boundary the byte
  // budget must cap (review r8 finding 2). Unpacking to loose objects would let a
  // pack a few bytes OVER 500 MB shrink to a store delta UNDER the cap. With
  // unpackLimit=1, any fetch of ≥1 object is kept as a pack whose size (+ its
  // `.idx`) storeSizeBytes measures.
  git(dir, "config", "fetch.unpackLimit", "1");
  git(dir, "config", "transfer.unpackLimit", "1");
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
 * The object format ("sha1" | "sha256") of `repo`, read from its config FILE —
 * NOT via `git rev-parse` (review r9 finding 4). Running git in the repo would
 * honor the repo's own config (an alias, an include), the surface we guard for
 * the worker; a bounded file read does not. A sha-256 repo carries
 * `[extensions] objectformat = sha256`; anything else (or an unreadable/absent
 * config) is treated as sha-1. Checks `.git/config` (non-bare) then `config`
 * (bare).
 */
export function objectFormatOfRepo(repo: string): "sha1" | "sha256" {
  for (const p of [join(repo, ".git", "config"), join(repo, "config")]) {
    try {
      const st = lstatSync(p);
      if (!st.isFile() || st.size > MAX_CONFIG_BYTES) continue;
      return objectFormatFromConfig(readFileSync(p, "utf8"));
    } catch {
      // try the next candidate path
    }
  }
  return "sha1";
}

/**
 * Parse `extensions.objectformat` from git config text — SECTION-AWARE,
 * SUBSECTION-EXACT, quote-tolerant, and LAST-value (review r10 finding 5, r11
 * finding 3). Only an `objectformat` key inside a `[extensions]` section with NO
 * subsection counts (`[extensions "spoof"]` is a different key git ignores for
 * the object format); a repeated key takes git's LAST value, not the first.
 *
 * BEST-EFFORT / fail-closed boundary: this reproduces the common config forms,
 * NOT git's full grammar (line continuations, unusual quoting). We do NOT run git
 * in the source dir to ask — that would honor the untrusted repo config. A form
 * we don't reproduce mis-detects the format, which FAILS CLOSED: the fetch into a
 * mismatched-format pristine store errors and the intake refuses; it never admits
 * a candidate. (Camino repos are sha-1 for v1; sha-256 support is thus
 * best-effort.)
 */
function objectFormatFromConfig(text: string): "sha1" | "sha256" {
  let inExtensions = false;
  let format: "sha1" | "sha256" = "sha1";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[;#].*$/, "").trim(); // strip inline comments
    if (line.length === 0) continue;
    const section = /^\[\s*([A-Za-z0-9.-]+)(\s+"[^"]*")?\s*\]$/.exec(line);
    if (section) {
      inExtensions = section[1]!.toLowerCase() === "extensions" && section[2] === undefined;
      continue;
    }
    if (!inExtensions) continue;
    const kv = /^objectformat\s*=\s*(.*)$/i.exec(line);
    if (kv) {
      let v = kv[1]!.trim();
      if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      format = v.toLowerCase() === "sha256" ? "sha256" : "sha1"; // LAST value wins
    }
  }
  return format;
}

/**
 * Refuse a fetch source whose object store BORROWS from another via an
 * `objects/info/alternates` (or `http-alternates`) file. Such a store makes its
 * `upload-pack` serve objects it does not itself contain, so a worker could put
 * an object from an external/shared store into its final tree and have it
 * admitted into the candidate (review r1 finding 4). WP-107 provisions worker
 * clones alternate-free (`assertWorkerCloneIsolation` — the authoritative,
 * complete object-store isolation check); this is the intake's own bounded
 * re-attestation, a filesystem check only, no git executed in the worker-touched
 * directory. It requires a full non-bare clone (real `.git` dir) and refuses a
 * commondir redirect, a symlink, an unexpected node, or a hardlinked object file
 * anywhere in the object-store tree, and an alternates file (review r2/r3/r5/r6/r7).
 *
 * NAMED BOUNDARY — a stopped-worker CUSTODY PRECONDITION, not a live-attacker
 * proof (review r6 finding 1, r7 findings 1/4, r8 finding 10). This scan and the
 * fetch that follows it (intake.ts) are separate operations on the source
 * directory, so no pair of filesystem SCANS can be proof against an adversary who
 * mutates the source DURING the fetch — planting a transient
 * `objects/info/alternates` (so upload-pack serves a borrowed object) or swapping
 * the requested object for a FIFO (so a serving-side `upload-pack` orphan hangs)
 * only while `git fetch` runs, removing it before either scan sees it. A pair of
 * scans is the wrong tool for a live-mutated source; WP-108 is a LIBRARY that
 * receives a repo PATH and does not hold a lock over another process's directory.
 * What discharges the AC in v1 is therefore a PRECONDITION the CALLER owns:
 *   - WP-107 provisions the worker clone self-contained (its authoritative
 *     `assertWorkerCloneIsolation` — alternate-free, no hardlinks), and
 *   - the caller (WP-114 dispatch) invokes `runIntake` ONLY against a STOPPED
 *     worker whose git dir is quiescent — the container has exited, nothing
 *     writes it concurrently.
 * WP-108's pre- AND post-fetch scans are best-effort defense in depth (they
 * catch a persistent/non-adversarial borrowing store), and every git call has a
 * wall-clock timeout that bounds the DIRECT process; a serving-side descendant
 * is bounded by the daemon/container lifecycle (WP-107 teardown). A DIFFERENT
 * custody IMPLEMENTATION could close the race internally — a privileged
 * filesystem snapshot, or a daemon-owned fd-relative copy of the objects followed
 * by full object verification, converts the race into a stable closure (review r8
 * finding 10). That is a heavier design, out of v1 scope; whether to adopt it
 * instead of the caller precondition is a SCOPE DECISION flagged for David, with
 * the recommendation to keep the precondition (owned by WP-107 + WP-114).
 */
/** Entry cap for the object-store walk — a hostile store over it is itself refused. */
const OBJECT_STORE_SCAN_CAP = 300_000;

/**
 * Walk the `objects` subtree NO-FOLLOW; return the first NON-LOCAL/unexpected
 * path, or null if the whole store is ordinary local files + directories.
 * Bounded so a hostile store cannot drive an unbounded walk.
 *
 * Refuses (fail-closed):
 *  - a SYMLINK anywhere — the genuine borrowing channel: a `pack` (or a fanout
 *    dir) symlinked at a shared store makes upload-pack serve foreign objects
 *    (review r5 finding 2);
 *  - any node that is NOT a regular file or directory — a FIFO, socket, or device
 *    node is not a git object, and reading THROUGH it would hang the intake; it
 *    must be refused, not fall through as "safe" (review r6 finding 5);
 *  - a HARDLINKED object file (`nlink>1`) — it shares its inode with another
 *    directory entry, so an external write through the OTHER link mutates THIS
 *    store's object (a `git clone --local` hardlinks packs; the concrete attack
 *    is a donor-side write corrupting the worker's admitted object; review r7
 *    finding 3). This MIRRORS WP-107's authoritative `hasHardlinkedObject` — a
 *    WP-107 worker clone is provisioned WITHOUT such links, so refusing them is
 *    the correct re-attestation (the r6 "hardlinks are normal" reasoning applied
 *    to a `clone --local` layout WP-107 does not use).
 *
 * Directory entries are STREAMED (`opendirSync`) so a hostile directory of
 * millions of names is bounded by the scan cap as it is walked, never
 * materialized whole.
 */
function findBorrowedObjectPath(objectsDir: string): string | null {
  let seen = 0;
  const walk = (abs: string, rel: string): string | null => {
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return null; // absent (e.g. no objects dir on a just-init'd repo)
    }
    if (st.isSymbolicLink()) return `${rel} (symlink)`;
    if (st.isDirectory()) {
      let dir;
      try {
        dir = opendirSync(abs);
      } catch {
        return `${rel} (unreadable)`;
      }
      try {
        let ent = dir.readSync();
        while (ent !== null) {
          if (++seen > OBJECT_STORE_SCAN_CAP) return `${rel} (scan cap exceeded)`;
          const found = walk(join(abs, ent.name), rel.length > 0 ? `${rel}/${ent.name}` : ent.name);
          if (found !== null) return found;
          ent = dir.readSync();
        }
      } finally {
        dir.closeSync();
      }
      return null;
    }
    if (st.isFile()) {
      // A hardlinked object file shares its inode with another tree, so a write
      // through the other link mutates this store's object (review r7 finding 3).
      // WP-107 provisions worker clones without such links; mirror that check.
      if (st.nlink > 1) return `${rel} (hardlink nlink=${st.nlink})`;
      return null;
    }
    // FIFO, socket, block/char device: not a git object node — fail closed.
    return `${rel} (unexpected node type)`;
  };
  return walk(objectsDir, "objects");
}

export function assertSelfContainedObjectStore(repo: string): void {
  // A GITFILE `.git` (a FILE, or a symlink, not a directory) redirects to a
  // `commondir` whose object store — and its alternates — live elsewhere, so a
  // linked-worktree worker repo could hide a borrowing store the direct file
  // check below never sees (review r2 finding 3). Refuse it outright: a WP-107
  // worker clone is a full clone with a REAL `.git` directory (its
  // `gitIsRealDirectory` attestation), or a bare repo (no `.git` at all). This
  // is an lstat, not a follow — no TOCTOU on the target.
  // A WP-107 worker clone is a full clone with a REAL `.git` DIRECTORY. Require
  // it: refuse a gitfile/symlink `.git` (a linked worktree redirecting to a
  // `commondir`), and refuse a BARE repo (no `.git`) — a bare layout was the
  // route a symlinked `objects/pack` slipped through (review r2/r4). This is an
  // lstat, not a follow — no TOCTOU on the target.
  const gitDir = join(repo, ".git");
  let dotGitStat;
  try {
    dotGitStat = lstatSync(gitDir);
  } catch {
    dotGitStat = null;
  }
  if (dotGitStat === null || !dotGitStat.isDirectory()) {
    throw new QuarantineGitError(
      "fetch source has no real `.git` directory (bare, gitfile, or symlink) — refused; a worker " +
        "clone must be a full clone with a real `.git` so its object store cannot borrow via a " +
        "commondir or an external bare store (CAM-EXEC-02 / review r2 finding 3, r4 finding 2)",
    );
  }

  // A `commondir` file redirects the object store (and refs) to ANOTHER git dir;
  // git honours it and upload-pack then serves objects from that external common
  // store (review r3 finding 2). Refuse its presence.
  if (existsSync(join(gitDir, "commondir"))) {
    throw new QuarantineGitError(
      "fetch source has a `commondir` redirect — refused; its object store is external " +
        "(CAM-EXEC-02 / review r3 finding 2)",
    );
  }

  // A SYMLINK, an UNEXPECTED node (FIFO/socket/device), or a HARDLINKED object
  // file (`nlink>1`) anywhere in the object-store tree makes (part of) the store
  // non-local, non-serving, or externally mutable — a nested `objects/pack/*.pack`
  // symlink was the r5 escape (review r5 finding 2), a FIFO both fell through as
  // "safe" and hung the reader (review r6 finding 5), and a hardlinked pack
  // shares its inode with a donor a write can corrupt (review r7 finding 3).
  // Walk the WHOLE `objects` subtree, no-follow and STREAMED, and refuse any.
  // Bounded by an entry cap so a hostile store cannot drive an unbounded walk
  // (fail-closed: over-cap is itself a refusal). Mirrors WP-107's authoritative
  // `assertWorkerCloneIsolation` walk.
  const objectsDir = join(gitDir, "objects");
  const offender = findBorrowedObjectPath(objectsDir);
  if (offender !== null) {
    throw new QuarantineGitError(
      `fetch source object store is non-local/unexpected at "${offender}" — ` +
        "refused; the store must be ordinary local files (CAM-EXEC-02 / review r3/r5 #2, r6 #5, r7 #3)",
    );
  }

  const candidates = [
    join(gitDir, "objects", "info", "alternates"),
    join(gitDir, "objects", "info", "http-alternates"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      throw new QuarantineGitError(
        `fetch source object store borrows from an external store (${basename(p)}) — refused; ` +
          "a worker clone must be self-contained (CAM-EXEC-02 / review r1 finding 4)",
      );
    }
  }

  // The worker's repo-local `.git/config` is read by the `upload-pack` server we
  // spawn in the worker dir. A config `[include]`/`[includeIf]` whose `path` is a
  // FIFO makes upload-pack BLOCK on it, orphaning a server descendant the direct
  // timeout does not reap — even for a fully STOPPED worker (persistent state, not
  // a live TOCTOU; review r8 finding 1). Refuse the config indirection surface:
  // the config must be a regular file (not a FIFO/symlink) and must carry no
  // include directive (a WP-107-provisioned clone has none). NAMED BOUNDARY: the
  // broader repo-config surface (an include pointing at a FIFO OUTSIDE `.git`, or
  // other config-triggered blocking) is bounded by the daemon/container process
  // lifecycle (WP-107 teardown reaps descendants), the same in-process-best-
  // effort / out-of-process-authoritative split WP-107 states.
  const configPath = join(gitDir, "config");
  let configStat;
  try {
    configStat = lstatSync(configPath);
  } catch {
    configStat = null;
  }
  if (configStat !== null) {
    if (!configStat.isFile()) {
      throw new QuarantineGitError(
        "fetch source `.git/config` is not a regular file (FIFO/symlink/special) — refused; " +
          "it could block or redirect the serving `upload-pack` (CAM-EXEC-02 / review r8 finding 1)",
      );
    }
    // BOUND the read before it happens (review r9 finding 2): a worker-controlled
    // 128 MiB `.git/config` would balloon RSS if slurped whole. A real config is a
    // few KiB; refuse anything over the cap rather than read it.
    if (configStat.size > MAX_CONFIG_BYTES) {
      throw new QuarantineGitError(
        `fetch source \`.git/config\` is ${configStat.size} bytes (> ${MAX_CONFIG_BYTES}) — refused; ` +
          "an oversized config is not a normal clone (fail-closed; review r9 finding 2)",
      );
    }
    let configText = "";
    try {
      configText = readFileSync(configPath, "utf8");
    } catch {
      throw new QuarantineGitError(
        "fetch source `.git/config` is unreadable — refused (fail-closed; review r8 finding 1)",
      );
    }
    // Refuse ANY `include`-family section header — `[include]`, `[includeIf ...]`,
    // and every subsectioned/escaped/BOM-prefixed variant. NAMED BOUNDARY: rather
    // than hand-parse git's include grammar (four rounds of edge cases — a
    // differently-named `[include.custom]`, a subsection-less `[includeIf]`, an
    // escaped-quote condition, a leading BOM; review r9 #7, r10 #6, r11 #1, r12
    // #1), we make a BLANKET rule. A WP-107-provisioned worker clone carries NO
    // include (WP-107 does not pass `git clone --config include.path=…`), so this
    // over-rejects only a config that DELIBERATELY added one — not the controlled
    // provisioner — while closing the whole surface (an include `path` could be a
    // FIFO the serving `upload-pack` blocks on; CAM-EXEC-02 / review r8 finding 1).
    // `[^\S\r\n]` = any whitespace EXCEPT a line break — it also matches the
    // U+FEFF BOM (JS `\s` includes it) and git's `\f`/`\v`, so a header preceded
    // by a leading BOM or exotic whitespace git still honors as an include is
    // caught (review r12 finding 1); `[ \t]` alone missed the BOM.
    if (/^[^\S\r\n]*\[[^\S\r\n]*include/im.test(configText)) {
      throw new QuarantineGitError(
        "fetch source `.git/config` contains an `[include]`/`[includeIf]`-family section — refused; " +
          "a worker clone must not indirect its config (an include path could be a FIFO the serving " +
          "`upload-pack` blocks on; CAM-EXEC-02 / review r8 finding 1, r11 finding 1, r12 finding 1)",
      );
    }
  }
}

/** Cap on a worker `.git/config` size — a real clone's config is a few KiB. */
const MAX_CONFIG_BYTES = 1 << 20;

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

/**
 * The count of DISTINCT git objects the shallow fetch of `commit` transfers:
 * every distinct subtree + leaf reachable from its tree, plus the root tree and
 * the commit object. `-t` includes intermediate trees (a deep tree is counted
 * honestly); DISTINCT ids are counted, so a blob at 5,000 paths is one object,
 * not 5,000 (review r1 finding 8), and the fetched commit is included, closing
 * the off-by-one (r2 finding 6).
 */
export function fetchedObjectCount(dir: string, commit: string, treeSha: string): number {
  // Read OBJECT NAMES only (`--format=%(objectname)`), never paths: a
  // pathological tree of many very-long paths would overrun a path-bearing read
  // buffer BEFORE the budget check could reject it (review r4 finding 3). A
  // sha-only line is ~41 bytes; the 256 MiB buffer (gitBuf) holds millions of
  // entries so even a 420k-repetition tree counts cleanly rather than throwing
  // and reporting a misleading code (review r5 finding 6). An absurdly larger
  // count overruns even this and is caught + rejected by the intake.
  const raw = gitBuf(dir, "ls-tree", "-r", "-t", "--format=%(objectname)", treeSha).toString(
    "utf8",
  );
  const ids = new Set<string>();
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (s.length > 0) ids.add(s);
  }
  ids.add(treeSha); // the root tree ls-tree omits
  ids.add(commit); // the fetched commit object itself
  return ids.size;
}

/**
 * The EXACT on-disk byte size of `dir`'s object store — the summed `lstat` size
 * of every file under `.git/objects`. The intake takes this BEFORE and AFTER the
 * worker-head fetch; the delta bounds the fetch by its RECEIVED-PACK footprint.
 *
 * The pristine repo sets `fetch.unpackLimit=1` (initPristineRepo), so a fetch is
 * KEPT AS A PACK, never unpacked to loose objects — the delta is therefore the
 * received `.pack` (+ its `.idx`), the transfer boundary the cap must bound. A
 * pack a few bytes OVER 500 MB that unpacked to loose objects could otherwise
 * measure a store delta UNDER the cap (review r8 finding 2).
 *
 * Measured by a filesystem walk, NOT `count-objects -v`: that reports pack size
 * in KiB (rounds DOWN) and omits `.rev`, and because the intake SUBTRACTS a
 * before-measurement the fixed overhead cancels, leaving a real ~KiB UNDERcount
 * — so a fetch a hair over 500 MB could measure at/under the cap (review r7
 * finding 6). Summing actual byte sizes never under-bounds the pack (the safe
 * direction for an admission cap). The walk is bounded by the same scan cap;
 * more files than the cap, OR any read failure on an existing entry, THROWS (an
 * absent objects dir alone is a legitimately empty 0-byte store) — so the intake
 * fails CLOSED rather than letting a sentinel value cancel under the before/after
 * subtraction (review r8 finding 2, r9 finding 3).
 */
export function storeSizeBytes(dir: string): number {
  const objectsDir = join(dir, ".git", "objects");
  // An ABSENT objects dir is a legitimately empty store (0 bytes) — but ONLY
  // ENOENT. `existsSync` returns false on ANY error (incl. EACCES on an
  // unreadable `.git`), which would fail OPEN as "empty" (review r10 finding 4).
  // Distinguish ENOENT (→ 0) from an inaccessible root (→ throw). Any OTHER read
  // failure mid-walk also throws (review r8 finding 2, r9 finding 3): if the size
  // cannot be attested the byte budget must not silently pass, and a sentinel
  // return value would CANCEL under the intake's before/after delta.
  try {
    lstatSync(objectsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw new QuarantineGitError(
      "object-store root is inaccessible — refused (fail-closed; review r10 finding 4)",
    );
  }
  let total = 0;
  let seen = 0;
  const walk = (abs: string): boolean => {
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return false; // an existing entry we cannot stat — fail closed
    }
    if (st.isDirectory()) {
      let d;
      try {
        d = opendirSync(abs);
      } catch {
        return false; // an existing dir we cannot open — fail closed
      }
      try {
        let ent = d.readSync();
        while (ent !== null) {
          if (++seen > OBJECT_STORE_SCAN_CAP) return false; // too many files — fail closed
          if (!walk(join(abs, ent.name))) return false;
          ent = d.readSync();
        }
      } finally {
        d.closeSync();
      }
      return true;
    }
    if (st.isFile()) total += st.size;
    return true;
  };
  // THROW on any measurement failure rather than returning a sentinel: the intake
  // takes a delta (after − before), and a MAX_SAFE_INTEGER sentinel in BOTH
  // measurements cancels to 0 (or, in one, to a negative) and silently PASSES the
  // 500 MB cap (review r9 finding 3). A thrown error fails the whole intake closed.
  if (!walk(objectsDir)) {
    throw new QuarantineGitError(
      "object-store size could not be measured (an unreadable entry or scan-cap breach) — " +
        "refused (fail-closed; review r9 finding 3)",
    );
  }
  return total;
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
  // PATH-FREE (`--format=%(objectname)`) with the large buffer so a very-long-
  // path or high-repetition tree cannot overrun this count before the budget
  // rejects it (review r4 finding 3, r5 finding 6).
  const raw = gitBuf(dir, "ls-tree", "-r", "-t", "--format=%(objectname)", treeSha).toString(
    "utf8",
  );
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return lines.length + 1;
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
    return execFileSync(gitBin(), ["-C", dir, "commit-tree", treeSha, "-p", base], {
      env,
      input: message,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 1 << 20,
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
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
