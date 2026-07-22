// WP-107: the single attempt-archival step + retention (CAM-EXEC-05,
// PRD §5 registry item 11, Appendix A.4#5).
//
// EXACTLY ONE code path archives and destroys workspaces, in the appendix's
// strict order:
//
//   1. archive written under quota   (tar.gz of the whole workspace incl.
//                                     .git history; refused over the 500 MB
//                                     compressed cap)
//   2. ledger row REFERENCING it     (through the recordLedgerRow seam — the
//                                     caller wires the WP-109 event store)
//   3. workspace destroyed           (never before 1 and 2 both succeeded)
//
// Every failure is FAIL-CLOSED toward retention: an over-quota workspace, an
// over-cap archive, a failed ledger write, or a failed destroy each throw a
// staged ArchivalError and LEAVE THE WORKSPACE IN PLACE (the A.2
// cleanup-failure row: recorded → `blocked` with cleanup-failed cause →
// janitor + escalation). Audit material is never silently lost to make
// cleanup succeed.
//
// The returned record carries the exact payload of the core machine's
// `archival-completed` event (A.3#8), with timestamps guaranteed strictly
// increasing, so the caller's transition cannot be guard-rejected for
// evidence reasons when the order genuinely held.
//
// Retention (registry item 11 verbatim): archives are retained "90 days or
// last 10 attempts per issue (whichever more)" — the UNION of the windows.
// pruneArchives deletes an archive only when it is BOTH older than 90 days
// AND outside the issue's newest 10.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  lstat as lstatAsync,
  open as openAsync,
  readdir as readdirAsync,
  rm as rmAsync,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { REGISTRY_ITEM_11_QUOTAS } from "@camino/shared";
import type { AttemptEvent } from "@camino/core";

// Archival runs on the daemon's SHARED event loop, concurrently with other
// attempts' dispatch/budget timers. Its heavy I/O (tar, hashing, recursive
// delete, the size walk) MUST be async and yield — a synchronous archival of a
// pathological workspace (a worker can create many files) would monopolize the
// loop and defeat ANOTHER attempt's wall-clock budget (round-13 finding 1,
// hardened round-14 findings 1/5: tar via spawn, hashing yields per chunk).

/** Which sub-step failed — drives the cleanup-failed record (A.2 row). */
export type ArchivalStage =
  | "id-validation"
  | "workspace-quota"
  | "archive-write"
  | "archive-quota"
  | "ledger-row"
  | "workspace-destroy";

export class ArchivalError extends Error {
  readonly stage: ArchivalStage;
  /** True when the workspace was left in place (every stage except a completed destroy). */
  readonly workspaceRetained: boolean;
  constructor(stage: ArchivalStage, message: string, workspaceRetained = true) {
    super(message);
    this.name = "ArchivalError";
    this.stage = stage;
    this.workspaceRetained = workspaceRetained;
  }
}

// Conservative id shape: path-safe, no traversal, no hidden files. Kept
// module-private; ids come from Camino's own stores, this is a fence.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// The maximum time value a JS Date can represent (±8.64e15 ms); beyond it
// `new Date(...).toISOString()` throws RangeError.
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

function assertSafeId(kind: "issueId" | "attemptId", value: string): void {
  if (!ID_RE.test(value) || value.includes("..")) {
    throw new ArchivalError("id-validation", `${kind} ${JSON.stringify(value)} is not path-safe`);
  }
}

/**
 * Stringify ANY thrown value safely (round-8 finding 2, hardened round-9 finding
 * 5). `(err as Error).message` is undefined for a non-Error rejection
 * (`throw "string"`, `throw {}`); worse, an Error whose `message` is a non-string
 * (`Object.defineProperty(err, "message", { value: Symbol() })`, a throwing
 * getter) made the `.slice()` throw a raw TypeError that escaped the staged
 * ArchivalError. EVERYTHING — the property read, the coercion, AND the slice —
 * is inside the guard, and the value is coerced with `String()` (the one
 * coercion that also handles Symbol/BigInt) before slicing, so this is TOTAL.
 */
function describeError(err: unknown, max = 300): string {
  try {
    const raw = err instanceof Error ? err.message : err;
    return String(raw).slice(0, max);
  } catch {
    return "unstringifiable error";
  }
}

/**
 * Total size in bytes of a workspace tree (files + symlink entries
 * themselves; targets are NOT followed — a symlink out of the workspace must
 * not bill someone else's bytes to this quota, nor loop the walk).
 */
export function workspaceSizeBytes(dir: string): number {
  let total = 0;
  const walk = (abs: string): void => {
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return; // unreadable dir contributes nothing; the tar step will surface real breakage
    }
    for (const name of names) {
      const child = join(abs, name);
      let stat;
      try {
        stat = lstatSync(child);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(child);
      else total += stat.size;
    }
  };
  walk(dir);
  return total;
}

/**
 * Async twin of workspaceSizeBytes used on the archival path (round-13 finding 1):
 * walks with async fs and YIELDS every YIELD_EVERY entries, so sizing a workspace
 * with a huge file count does not monopolize the daemon loop and defeat another
 * attempt's budget. Same accounting (lstat, symlinks not followed).
 */
async function workspaceSizeBytesAsync(dir: string): Promise<number> {
  const YIELD_EVERY = 2_000;
  let total = 0;
  let seen = 0;
  const walk = async (abs: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdirAsync(abs);
    } catch {
      return;
    }
    for (const name of names) {
      if (++seen % YIELD_EVERY === 0) await Promise.resolve(); // yield to the loop
      const child = join(abs, name);
      let stat;
      try {
        stat = await lstatAsync(child);
      } catch {
        continue;
      }
      if (stat.isDirectory()) await walk(child);
      else total += stat.size;
    }
  };
  await walk(dir);
  return total;
}

/** Injectable quota subset (tests use tiny values; production the registry). */
export interface ArchiveQuotas {
  workspaceMaxBytes: number;
  archiveMaxCompressedBytes: number;
}

export const DEFAULT_ARCHIVE_QUOTAS: ArchiveQuotas = Object.freeze({
  workspaceMaxBytes: REGISTRY_ITEM_11_QUOTAS.workspace.maxBytes,
  archiveMaxCompressedBytes: REGISTRY_ITEM_11_QUOTAS.archive.maxCompressedBytes,
});

/**
 * Clamp an injected quota override to the registry as a HARD CEILING (round-9
 * finding 7): an override may only TIGHTEN registry item 11, never loosen it.
 * `min` keeps the tiny test quotas (stricter) working while making the registry
 * an unconditional floor — so a caller (or a test) can never archive a
 * workspace/archive that exceeds the registry and still stamp
 * `quotasEnforced: true`.
 */
export function effectiveArchiveQuotas(override: ArchiveQuotas): ArchiveQuotas {
  // A NON-FINITE override (NaN, ±Infinity) must NOT weaken the registry: NaN
  // defeats `Math.min` (min(NaN, x) === NaN) and every later `size > NaN` test is
  // false — silently disabling the cap (round-10 finding 13). Non-finite → the
  // registry value (never weaker); a finite value clamps to the registry (a
  // negative one clamps to itself and fails closed, refusing everything).
  const clamp = (o: number, registry: number): number =>
    Number.isFinite(o) ? Math.min(o, registry) : registry;
  return {
    workspaceMaxBytes: clamp(override.workspaceMaxBytes, DEFAULT_ARCHIVE_QUOTAS.workspaceMaxBytes),
    archiveMaxCompressedBytes: clamp(
      override.archiveMaxCompressedBytes,
      DEFAULT_ARCHIVE_QUOTAS.archiveMaxCompressedBytes,
    ),
  };
}

/** The ledger-row payload; the caller persists it (WP-109 event store). */
export interface ArchiveLedgerRow {
  issueId: string;
  attemptId: string;
  /** Absolute path of the written archive the row REFERENCES (A.4#5). */
  archivePath: string;
  sha256: string;
  compressedBytes: number;
  workspaceBytes: number;
  archiveWrittenAt: string;
}

/** Sidecar metadata stored next to each archive; the pruner's data source. */
export interface ArchiveSidecar {
  issueId: string;
  attemptId: string;
  /**
   * Absolute path of the workspace this archival is for. Recorded so a
   * re-invocation can tell a genuine destroy-failure RESUME (this exact
   * workspace still exists) from a duplicate call with a different workspace
   * (round-6 finding 1).
   */
  workspacePath: string;
  /**
   * The workspace's stable identity at archive time. A resume-destroy compares
   * against this, not just the pathname (round-11 finding 3): a directory
   * rm+recreated at the same path must not be destroyed. `(dev,ino)` alone is
   * defeated by Linux inode reuse (round-14 finding 3), so `workspaceBirthtimeNs`
   * (the inode BIRTH time, decimal-string nanoseconds — JSON has no BigInt) is
   * REQUIRED for a resume-destroy: a fresh `mkdir` at a reused inode number still
   * has a new birth time, while a benign chmod on the genuine same directory leaves
   * it unchanged. A sidecar lacking any of the three cannot prove the directory
   * unchanged across a process restart → reconcile, never destroy on the pathname
   * alone.
   */
  workspaceDev?: number;
  workspaceIno?: number;
  workspaceBirthtimeNs?: string;
  archiveWrittenAt: string;
  /**
   * Durable per-issue monotonic ordinal, assigned at archive time (max
   * existing + 1). Retention orders by THIS, so "last 10 attempts" is precise
   * even when archive timestamps tie to the millisecond (round-1 finding 11) —
   * archival happens once per attempt, in attempt order, so the sequence is
   * the attempt order.
   */
  seq: number;
  sha256: string;
  compressedBytes: number;
  workspaceBytes: number;
}

export interface ArchiveAttemptOptions {
  workspaceDir: string;
  /**
   * Root under which per-issue archive directories live. A FIXED daemon
   * location (one root per install) — exactly-once and retention are scoped to
   * it; the caller does not vary it per attempt. Archival runs under the
   * WP-104 single-writer lock (WP-114 scheduler), so no two archivals race for
   * one issue.
   */
  archiveRoot: string;
  issueId: string;
  attemptId: string;
  /**
   * The attempt's AUTHORITATIVE ordinal from the attempt record (the WP-114
   * scheduler passes it), used as the retention sequence — race-free and
   * durable, unlike scanning the dir. Omit only in tests / standalone use,
   * where a best-effort dir-scan ordinal is assigned instead. Must be a
   * non-negative safe integer when provided.
   */
  attemptSeq?: number;
  /**
   * Persists the ledger row referencing the written archive. MUST durably
   * record before returning; a throw here retains the archive and the
   * workspace (fail-closed — the destroy step is never reached). MUST be
   * IDEMPOTENT per (issueId, attemptId) (round-5 finding 1): the archival step
   * is retriable, and a retry after a sidecar/destroy failure re-invokes it —
   * the WP-104 idempotency contract / WP-109 event store dedups the row.
   */
  recordLedgerRow: (row: ArchiveLedgerRow) => void | Promise<void>;
  quotas?: ArchiveQuotas;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export interface ArchivalRecord {
  archivePath: string;
  sha256: string;
  compressedBytes: number;
  workspaceBytes: number;
  archiveWrittenAt: string;
  ledgerRowAt: string;
  workspaceDestroyedAt: string;
  /** Ready-made A.3#8 event payload (guard-satisfying by construction). */
  attemptEvent: Extract<AttemptEvent, { type: "archival-completed" }>;
}

/**
 * Timestamps must be STRICTLY increasing for the A.3#8 guard; two sub-steps
 * completing within one millisecond would otherwise stamp equal ISO strings.
 * The ORDER is real (each stamp is taken after its step completes); this
 * helper only guarantees the millisecond evidence never collapses two
 * genuinely ordered steps into an equal pair. Takes the ONE clock value
 * validated at entry (round-12 finding 3) — it never re-reads the clock, so a
 * clock that drifts to the max Date between sub-steps cannot make a stamp AFTER
 * the destroy throw a raw RangeError.
 */
function nextStamp(baseMs: number, prev: string | null): string {
  const floor = prev === null ? baseMs : Math.max(baseMs, Date.parse(prev) + 1);
  return new Date(floor).toISOString();
}

/** Best-effort remove that NEVER throws — used where a cleanup failure must not mask the primary error. */
function safeRemove(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort; the caller's primary error stands */
  }
}

/**
 * fsync a single path (file OR directory); NEVER throws (platform quirks are
 * swallowed). ASYNC (round-15 finding 3): `fsyncSync` on a worker-sized archive
 * blocks the shared daemon loop for tens of ms (~92 ms observed on a 268 MB
 * archive) right before recordLedgerRow, defeating a concurrent attempt's budget.
 * The promisified `fh.sync()` runs the blocking fsync on the libuv threadpool, so
 * it is off the event loop.
 */
async function fsyncPathBestEffort(p: string): Promise<void> {
  let fh: FileHandle | undefined;
  try {
    fh = await openAsync(p, "r");
    await fh.sync();
  } catch {
    /* best-effort: durability hardening must never break an otherwise-good archival */
  } finally {
    if (fh !== undefined) {
      try {
        await fh.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Best-effort flush of a just-written file's data and its parent directory entry
 * (round-9 finding 9, scoped round-10 finding 14). `writeFileSync`/`renameSync`
 * return once the data reaches the page cache, so a crash could still lose it;
 * `fsync` pushes it toward stable storage. SCOPE, stated honestly: `fsync(2)`
 * guarantees the data left the OS cache, which survives a DAEMON-PROCESS crash;
 * it does NOT guarantee power-loss durability on macOS (that needs `F_FULLFSYNC`,
 * which Node's fs does not expose) or on drives that lie about flushing. Failures
 * are intentionally SWALLOWED (a platform that rejects a directory fsync must not
 * fail an otherwise-good archival). The WP-109 ledger row — not this file — is
 * the authoritative durable record; this only reduces the local-evidence loss
 * window, it does not make the archive crash-proof.
 */
async function syncFileAndParentDir(filePath: string): Promise<void> {
  await fsyncPathBestEffort(filePath);
  await fsyncPathBestEffort(join(filePath, ".."));
}

/**
 * Read `sidecarPath` and return it iff it is a VALID sidecar for this attempt
 * (round-5 finding 1) — parses, matches issueId/attemptId, and carries a safe
 * seq + finite bytes + a parseable archiveWrittenAt. Returns null for a
 * missing/truncated/malformed/one-byte sidecar. Because the sidecar is written
 * AFTER the ledger row, a VALID sidecar proves the ledger row was recorded
 * (round-6 finding 1); its ABSENCE means the ledger state is unknown.
 */
function readValidSidecar(
  sidecarPath: string,
  issueId: string,
  attemptId: string,
): ArchiveSidecar | null {
  let raw: string;
  try {
    raw = readFileSync(sidecarPath, "utf8");
  } catch {
    return null; // absent / unreadable
  }
  try {
    const s = JSON.parse(raw) as Partial<ArchiveSidecar>;
    const writtenMs = typeof s.archiveWrittenAt === "string" ? Date.parse(s.archiveWrittenAt) : NaN;
    if (
      s.issueId === issueId &&
      s.attemptId === attemptId &&
      typeof s.workspacePath === "string" &&
      Number.isSafeInteger(s.seq) &&
      typeof s.archiveWrittenAt === "string" &&
      Number.isFinite(writtenMs) &&
      // Bound the timestamp below the max valid JS Date (round-10 finding 15):
      // nextStamp() adds ~1ms per resume sub-step, and `new Date(8.64e15 + n)`
      // .toISOString() throws a raw RangeError. A sidecar at/near the max date is
      // corrupt → treat as no-valid-sidecar (reconciliation), never a crash.
      writtenMs < MAX_TIMESTAMP_MS - 1000 &&
      typeof s.sha256 === "string" &&
      Number.isFinite(s.compressedBytes) &&
      Number.isFinite(s.workspaceBytes)
    ) {
      return s as ArchiveSidecar;
    }
    return null;
  } catch {
    return null; // malformed
  }
}

/** The real (symlink-resolved) identity of a workspace dir, or null if it does not exist. */
function realWorkspaceIdentity(dir: string): string | null {
  try {
    return realpathSync(dir);
  } catch {
    return null;
  }
}

/**
 * A workspace directory's identity for the destroy re-check. `(dev, ino)` alone
 * is NOT sufficient (round-14 finding 3): on Linux an `rmdir`+`mkdir` at the same
 * pathname commonly REUSES the freed inode number, so a rm+recreated directory
 * presents the SAME (dev, ino) and defeats the check (the two archive-identity
 * tests failed on Linux CI for exactly this reason). `birthtimeNs` — the inode's
 * BIRTH (creation) time — closes it in practice: `mkdir` stamps the new inode's
 * birth time at creation, so a rm+recreate gives a DIFFERENT birthtimeNs — PROVIDED
 * the recreate is more than the filesystem's birth-time granularity after the
 * original (round-15 finding 7: on Linux overlay/ext4 that granularity is ~1 ms, so
 * a recreate WITHIN the same 1 ms tick can collide on the whole tuple). In the real
 * archival flow the only replacement window is between the up-front baseline capture
 * and the destroy, separated by tar + streaming hash + the ledger callback (>> 1 ms),
 * so a colliding recreate is not worker-reachable. Crucially birthtime is IMMUTABLE
 * after creation, so a benign `chmod`/`chown`/content change on the SAME directory
 * does NOT change it (ctime would, giving a false "replaced" on a genuine resume).
 * Any of the three differing means the directory was replaced.
 *
 * RESIDUAL, stated: a filesystem without birth-time (btime) support reports 0 for
 * both, so a rm+recreate that also REUSES the inode number degrades to the
 * (dev, ino)-only behavior there. ext4 (Linux CI), xfs, and APFS/HFS+ (dev)
 * populate btime, so the exercised platforms are covered.
 */
interface FsIdentity {
  dev: number;
  ino: number;
  birthtimeNs: bigint;
}

/**
 * sha256 of a file, STREAMED asynchronously — never buffers the whole file
 * (round-10 finding 5) and YIELDS the event loop between chunks so hashing a
 * large archive does not stall other attempts' budget timers (round-13 finding
 * 1, hardened round-14 finding 1). The stream is PAUSED after each chunk and
 * resumed on a `setImmediate`, so at most one 1 MiB chunk is hashed per loop
 * turn — a pending budget timer fires within a chunk's worth of CPU (~ms), well
 * under STALL_GRACE_MS, instead of being starved for tens of ms while `data`
 * events arrive back-to-back from the page cache.
 */
function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path, { highWaterMark: 1 << 20 });
    stream.on("data", (chunk) => {
      hash.update(chunk);
      stream.pause();
      setImmediate(() => stream.resume());
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** The (dev, ino, birthtimeNs) identity of a directory, or null if it cannot be statted. */
function readFsIdentity(dir: string): FsIdentity | null {
  try {
    const s = statSync(dir, { bigint: true });
    return { dev: Number(s.dev), ino: Number(s.ino), birthtimeNs: s.birthtimeNs };
  } catch {
    return null;
  }
}

/**
 * tar the workspace, streaming tar's STDOUT to `tmpPath`, OFF the daemon loop and
 * BOUNDED to `maxBytes` compressed. Streaming (not `tar -f`) lets us both ignore
 * stderr volume AND cap the write:
 *  - stderr VOLUME can never turn a SUCCESSFUL archive into a refusal (round-14
 *    finding 5): a worker filling its workspace with tar-WARNS-only entries (UNIX
 *    sockets — one "ignored" line each) emits megabytes of stderr while tar still
 *    exits 0 with a valid archive; execFile's `maxBuffer` would have aborted it.
 *    Success is the EXIT CODE alone.
 *  - the compressed size is bounded DURING the write (round-15 finding 6): the old
 *    post-tar size check let a worker balloon the on-disk archive toward the 2 GB
 *    workspace ceiling before refusing. Here the byte count is enforced as it
 *    streams — once it passes `maxBytes`, tar is killed and the partial abandoned,
 *    so at most one chunk is ever written past the cap.
 * Backpressure is respected (pause on a full write buffer, resume on drain), so
 * RSS stays ~one chunk regardless of archive size. stderr is drained into a
 * bounded TAIL — the LAST bytes, where a genuine failure's cause sits (round-15
 * finding 8) — used only to describe a non-zero exit.
 */
function runTarToFile(tmpPath: string, workspaceReal: string, maxBytes: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const STDERR_TAIL_CAP = 8 * 1024;
    let stderrTail = "";
    let written = 0;
    let settled = false;
    const out = createWriteStream(tmpPath);
    const child = spawn("tar", ["-cz", "-C", workspaceReal, "."], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const fail = (err: Error): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      out.destroy();
      settle(() => reject(err));
    };
    child.stderr?.on("data", (chunk: Buffer) => {
      // Bounded TAIL (last bytes): append then keep only the last cap. A stderr
      // chunk is itself pipe-buffer-bounded (~64 KiB), so the transient is small.
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CAP);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      written += chunk.length;
      if (written > maxBytes) {
        fail(
          new ArchivalError(
            "archive-quota",
            `archive exceeded the ${maxBytes}-byte compressed cap during write (registry item 11) — tar aborted, workspace retained for escalation`,
          ),
        );
        return;
      }
      if (!out.write(chunk)) child.stdout.pause();
    });
    out.on("drain", () => {
      if (!settled) child.stdout.resume();
    });
    child.stdout.on("end", () => out.end());
    child.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
    out.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
    child.on("close", (code) => {
      if (settled) return;
      if (code === 0) {
        // Resolve only once the file stream has flushed everything to disk.
        if (out.writableFinished) settle(() => resolve());
        else out.once("finish", () => settle(() => resolve()));
      } else {
        fail(
          new Error(
            `tar exited ${code ?? "null"}${stderrTail ? `: ${stderrTail.trim().slice(0, 300)}` : ""}`,
          ),
        );
      }
    });
  });
}

/**
 * Re-validate the archive IMMEDIATELY before a destroy, from the FILE itself —
 * never from sidecar byte-fields a caller/corruption could forge (round-10
 * findings 2/3/5). The recordLedgerRow callback ran between the archive write and
 * this point, so nothing about the archive is trusted from before it. Requires: a
 * present REGULAR, non-hardlinked file (no symlink/dir/fifo, nlink 1), an ACTUAL
 * size within the compressed cap (not the sidecar's claimed size — a 1-byte claim
 * over a 500 MB file must not pass), and a STREAMING sha256 that matches. Returns
 * the verified real size. Any doubt → staged refusal, workspace retained.
 *
 * BOUNDARY, stated (round-11 findings 2/11/13/14 — the WP-104 single-writer
 * precedent): the archiveRoot and workspace are DAEMON-OWNED, single-writer trees
 * (archival runs under the WP-104 lock; the worker is container-confined and
 * cannot reach them). A path→fd or inode swap performed by ANOTHER daemon-side
 * process DURING this verification (a check→use race) presupposes daemon-side
 * write access to Camino's own trees, which is outside the worker threat model
 * (if the daemon is compromised, all bets are off). These checks close the
 * REACHABLE misconfiguration/corruption (a wrong-type/oversized/mismatched or
 * hardlinked archive; a rm+recreated workspace); they are not, and do not claim
 * to be, a defense against a concurrent daemon-side mutator.
 */
async function verifyArchiveIntact(
  finalPath: string,
  attemptId: string,
  expectedSha256: string,
  archiveMaxCompressedBytes: number,
): Promise<number> {
  let st;
  try {
    st = lstatSync(finalPath);
  } catch {
    throw new ArchivalError(
      "archive-write",
      `attempt ${attemptId}: the archive ${finalPath} is missing before the workspace destroy — refusing to destroy the workspace (its last copy); janitor/escalation reconciles (fail-closed)`,
    );
  }
  if (!st.isFile()) {
    throw new ArchivalError(
      "archive-write",
      `attempt ${attemptId}: the archive ${finalPath} is not a regular file (${describeFileType(st)}) — refusing to destroy the workspace (fail-closed)`,
    );
  }
  if (st.nlink > 1) {
    // A hardlinked archive (round-11 finding 14): another name for the same inode
    // can mutate the bytes after this verification, invalidating the ledger hash.
    // A freshly written archive has nlink 1; refuse an aliased one.
    throw new ArchivalError(
      "archive-write",
      `attempt ${attemptId}: the archive ${finalPath} is hardlinked (nlink=${st.nlink}) — an external alias could mutate it after verification; refusing to destroy the workspace (fail-closed)`,
    );
  }
  if (st.size > archiveMaxCompressedBytes) {
    throw new ArchivalError(
      "archive-quota",
      `attempt ${attemptId}: the archive ${finalPath} is ${st.size} bytes, over the ${archiveMaxCompressedBytes}-byte cap (registry item 11) — refusing to destroy the workspace (fail-closed)`,
    );
  }
  let actual: string;
  try {
    actual = await sha256File(finalPath);
  } catch (err) {
    throw new ArchivalError(
      "archive-write",
      `attempt ${attemptId}: could not read the archive ${finalPath} to verify it: ${describeError(err, 200)} — refusing to destroy the workspace (fail-closed)`,
    );
  }
  if (actual !== expectedSha256) {
    throw new ArchivalError(
      "archive-write",
      `attempt ${attemptId}: the archive ${finalPath} does not match the recorded sha256 (recorded ${expectedSha256}, actual ${actual}) — refusing to destroy the workspace; janitor/escalation reconciles (fail-closed)`,
    );
  }
  return st.size;
}

/** A short human label for a non-regular-file stat, for the refusal message. */
function describeFileType(st: { isDirectory(): boolean; isSymbolicLink(): boolean }): string {
  if (st.isDirectory()) return "a directory";
  if (st.isSymbolicLink()) return "a symlink";
  return "not a regular file";
}

/**
 * Confirm the workspace to be destroyed is STILL the exact directory we archived,
 * by (dev, ino, birthtimeNs) — a pathname comparison is TOCTOU (round-10 finding
 * 3): a recordLedgerRow callback that `rm`s and recreates the path leaves an
 * unrelated victim at the same spelling. (dev, ino) alone is defeated by Linux
 * inode REUSE (round-14 finding 3); birthtimeNs distinguishes a freshly-created
 * directory even at the same inode number, while ignoring benign metadata changes
 * (a chmod on the genuine same directory during a resume). Refuses (workspace
 * retained) on any change.
 */
function assertWorkspaceUnchanged(
  workspaceReal: string,
  baseline: FsIdentity,
  attemptId: string,
): void {
  const st = readFsIdentity(workspaceReal);
  if (st === null) {
    throw new ArchivalError(
      "archive-write",
      `attempt ${attemptId}: the workspace ${workspaceReal} vanished before the destroy — refusing (janitor/escalation reconciles)`,
    );
  }
  if (
    st.dev !== baseline.dev ||
    st.ino !== baseline.ino ||
    st.birthtimeNs !== baseline.birthtimeNs
  ) {
    throw new ArchivalError(
      "archive-write",
      `attempt ${attemptId}: the directory at ${workspaceReal} was REPLACED (inode/birthtime changed) since archival — refusing to destroy it; it is no longer the workspace we archived (janitor/escalation reconciles)`,
    );
  }
}

/**
 * Destroy the workspace, strictly last (A.4#5). ASYNC so a recursive delete of a
 * large tree yields to the loop (round-13 finding 1). Throws a staged,
 * non-retained error on failure.
 */
async function destroyWorkspaceOrThrow(workspaceDir: string): Promise<void> {
  try {
    await rmAsync(workspaceDir, { recursive: true, force: true });
  } catch (err) {
    throw new ArchivalError(
      "workspace-destroy",
      `workspace destroy failed after archive + ledger row (workspace may be partially removed): ${describeError(err, 300)}`,
      false,
    );
  }
  if (existsSync(workspaceDir)) {
    // force:true can mask persistent trees; verify the deletion actually took.
    throw new ArchivalError(
      "workspace-destroy",
      "workspace still present after destroy (partially removed) — janitor must reconcile",
      false,
    );
  }
}

/** Assemble the A.3#8 archival-completed record from its (strictly-increasing) stamps. */
function buildArchivalRecord(args: {
  archivePath: string;
  sha256: string;
  compressedBytes: number;
  workspaceBytes: number;
  archiveWrittenAt: string;
  ledgerRowAt: string;
  workspaceDestroyedAt: string;
}): ArchivalRecord {
  return {
    ...args,
    attemptEvent: {
      type: "archival-completed",
      quotasEnforced: true,
      ledgerRowReferencesArchive: true,
      archiveWrittenAt: args.archiveWrittenAt,
      ledgerRowAt: args.ledgerRowAt,
      workspaceDestroyedAt: args.workspaceDestroyedAt,
    },
  };
}

/**
 * Resolve a directory path to its real location (following symlinks), falling
 * back to the deepest existing ancestor when the path does not fully exist yet
 * (archiveRoot is created later). Lexical `resolve()` alone misses a symlink
 * that redirects the tree (round-2 finding 3).
 */
function realDirPath(p: string): string {
  const lexical = resolve(p);
  try {
    return realpathSync(lexical);
  } catch {
    const parts = lexical.split("/").filter((s) => s.length > 0);
    for (let i = parts.length - 1; i >= 1; i--) {
      const prefix = "/" + parts.slice(0, i).join("/");
      try {
        const realPrefix = realpathSync(prefix);
        return resolve(realPrefix + "/" + parts.slice(i).join("/"));
      } catch {
        /* keep shrinking */
      }
    }
    return lexical;
  }
}

/**
 * The single archival step (A.4#5). See the module header for the order and
 * failure semantics. Returns only after the workspace is destroyed.
 *
 * CALLER PRECONDITION — WORKSPACE QUIESCENCE (round-12 finding 2): the caller MUST
 * have STOPPED the worker (its container/process group gone — the CAM-EXEC-06
 * teardown) BEFORE calling this. The workspace is mounted rw to the worker, so a
 * still-running worker could write to it AFTER the tar snapshot, and that content
 * would be archived neither here (the tar already ran) nor recoverable (the
 * workspace is then destroyed). This step archives a SNAPSHOT; it does not, and
 * cannot, freeze a live writer. The scheduler (WP-114) wires stop→archive under
 * the WP-104 single-writer lock; until then no production caller archives a live
 * worker.
 */
export async function archiveAttempt(opts: ArchiveAttemptOptions): Promise<ArchivalRecord> {
  const now = opts.now ?? (() => new Date());
  // Validate the clock BEFORE any destructive step (round-11 finding 15): the
  // strictly-increasing stamps add ~1ms per sub-step, and `new Date(t).toISOString()`
  // throws a raw RangeError past the max valid Date. A clock at/near the ceiling
  // (an injected/corrupt clock) would let `nextStamp` throw AFTER the workspace was
  // destroyed. Refuse up-front so the failure is staged and the workspace retained.
  // A clock that THROWS (an injected `now: () => { throw }`) is staged too (round-15
  // finding 10), so EVERY archival failure — including the clock read — is staged.
  let nowMs: number;
  try {
    nowMs = now().getTime();
  } catch (err) {
    throw new ArchivalError(
      "id-validation",
      `clock threw (${describeError(err, 120)}) — refusing before any destructive step (fail-closed)`,
    );
  }
  if (!Number.isFinite(nowMs) || nowMs > MAX_TIMESTAMP_MS - 100_000) {
    throw new ArchivalError(
      "id-validation",
      `clock is out of range (${String(nowMs)}) — refusing before any destructive step (fail-closed)`,
    );
  }
  // Registry item 11 is a HARD CEILING (round-9 finding 7): an injected `quotas`
  // override may only TIGHTEN the registry limits, never loosen them, so a
  // caller (or a test) can never archive a workspace/archive that exceeds the
  // registry and still stamp `quotasEnforced: true`. `min` keeps the tiny test
  // quotas (which are stricter) working while making the registry an
  // unconditional floor for the truthful evidence claim.
  const quotas = effectiveArchiveQuotas(opts.quotas ?? DEFAULT_ARCHIVE_QUOTAS);
  assertSafeId("issueId", opts.issueId);
  assertSafeId("attemptId", opts.attemptId);
  // Validate attemptSeq EARLY — BEFORE any archive is written (round-3 finding
  // 8): validating it only at sidecar time left an orphan .tar.gz that then
  // failed the retry with "already exists".
  if (
    opts.attemptSeq !== undefined &&
    (!Number.isSafeInteger(opts.attemptSeq) || opts.attemptSeq < 0)
  ) {
    throw new ArchivalError(
      "id-validation",
      `attemptSeq ${String(opts.attemptSeq)} must be a non-negative safe integer`,
    );
  }

  // Canonicalize the workspace to an ABSOLUTE, REAL path ONCE (round-9 finding
  // 1). Every later step — size, tar, sidecar identity, the resume comparison,
  // and the destroy — uses this single value, so none is fooled by a
  // cwd-relative `workspaceDir` (a `recordLedgerRow` that changes cwd mid-call)
  // or by a symlinked parent rebound between attempts: identity is the REAL
  // directory, not a lexical spelling. Falls back to the lexical absolute only
  // when the workspace does not exist yet, where the size/tar step below raises
  // the real, clearer error.
  const workspaceDir = resolve(opts.workspaceDir);
  // Reject a workspace whose own final component is a symlink (round-10 finding
  // 3): the workspace is a real directory Camino created; a symlink would let the
  // destroy delete its target and leave a dangling link. (A symlinked PARENT —
  // e.g. macOS /var → /private/var — is fine; realpath resolves it.)
  try {
    if (lstatSync(workspaceDir).isSymbolicLink()) {
      throw new ArchivalError(
        "id-validation",
        `workspaceDir ${JSON.stringify(workspaceDir)} is a symlink — the workspace must be a real directory (fail-closed)`,
      );
    }
  } catch (err) {
    if (err instanceof ArchivalError) throw err;
    // not-exist / unreadable: the size/tar step below raises the clearer error
  }
  const workspaceReal = ((): string => {
    try {
      return realpathSync(workspaceDir);
    } catch {
      return workspaceDir;
    }
  })();
  // Capture the workspace's STABLE identity (dev, ino, ctimeNs) up-front, BEFORE
  // the recordLedgerRow callback can run — the destroy re-confirms against this so
  // a callback that rm+recreates the pathname cannot redirect it (round-10 finding
  // 3; ctimeNs added round-14 finding 3 for Linux inode reuse). A sentinel when
  // absent; the size/tar step raises the real error.
  const workspaceIdentity: FsIdentity = readFsIdentity(workspaceReal) ?? {
    dev: -1,
    ino: -1,
    birthtimeNs: -1n,
  };

  // Step 0 — workspace quota (registry item 11: workspace ≤ 2 GB). An
  // over-quota workspace is an abnormal condition: refusing here routes it to
  // the cleanup-failed/escalation path with the workspace intact. Checked
  // FIRST — before creating the issue dir — so a refusal writes nothing at all.
  const workspaceBytes = await workspaceSizeBytesAsync(workspaceReal);
  if (workspaceBytes > quotas.workspaceMaxBytes) {
    throw new ArchivalError(
      "workspace-quota",
      `workspace is ${workspaceBytes} bytes, over the ${quotas.workspaceMaxBytes}-byte quota (registry item 11) — workspace retained for escalation`,
    );
  }

  // Resolve archiveRoot to an ABSOLUTE path (round-8 finding 3): a relative
  // archiveRoot would make the recorded ledger `archivePath` cwd-dependent,
  // though it is documented absolute.
  const archiveRoot = resolve(opts.archiveRoot);

  // Step 1 — archive written under quota. Create the issue dir so its REAL path
  // can be resolved (round-3 finding 2): the containment check must resolve the
  // ACTUAL output directory (archiveRoot/issueId), not just the root — a
  // symlinked issue dir, or workspaceDir === archiveRoot/issueId, otherwise
  // still self-deletes.
  const issueDir = join(archiveRoot, opts.issueId);
  try {
    mkdirSync(issueDir, { recursive: true }); // STAGED (round-6 finding 3): a raw EACCES here must not escape.
  } catch (err) {
    throw new ArchivalError(
      "archive-write",
      `could not create archive dir ${issueDir}: ${describeError(err, 200)} — refused (fail-closed)`,
    );
  }
  const wsResolved = workspaceReal;
  const issueResolved = realDirPath(issueDir);
  if (
    issueResolved === wsResolved ||
    issueResolved.startsWith(`${wsResolved}/`) ||
    wsResolved.startsWith(`${issueResolved}/`)
  ) {
    throw new ArchivalError(
      "id-validation",
      `archive output dir ${JSON.stringify(issueDir)} resolves inside/over the workspace ${JSON.stringify(workspaceReal)} — workspace teardown would delete the archive (fail-closed)`,
    );
  }
  // BOUNDARY, stated (round-3 finding 2/3): archiveRoot is a FIXED,
  // DAEMON-OWNED location (not worker-writable). These realpath checks close
  // the reachable MISCONFIGURATION (a symlinked archiveRoot/issueDir); an
  // adversarial symlink SWAP racing between this check and the tar write
  // presupposes write access to the daemon's own archive tree, which is
  // outside the worker threat model.

  // Resolve the retention sequence BEFORE writing anything (round-3 finding 8):
  // a duplicate/overflow refusal must not leave an orphan .tar.gz that then
  // fails the retry with "already exists".
  const seq = resolveSeq(opts.attemptSeq, issueDir, opts.attemptId);

  const finalPath = join(issueDir, `${opts.attemptId}.tar.gz`);
  const sidecarPath = join(issueDir, `${opts.attemptId}.json`);
  const tmpPath = join(issueDir, `.${opts.attemptId}.tar.gz.partial`);

  // RE-INVOCATION classification (round-6 finding 1) — never infer the archival
  // PHASE from mere file presence, and NEVER auto-delete an archive that could
  // be ledger-referenced. The sidecar is written LAST (after the ledger row),
  // so a VALID sidecar proves the ledger row was recorded:
  //   - valid sidecar + workspace GONE  → fully complete → refuse (exactly-once).
  //   - valid sidecar + workspace PRESENT → only the destroy remains (a prior
  //     destroy failure) → RESUME the destroy and return; the archive + ledger
  //     row are durable, so nothing is redone.
  //   - anything else with an archive present (no/malformed/partial sidecar) →
  //     the ledger state is UNKNOWN (the ledger runs before the sidecar), so we
  //     must not delete (may be referenced) nor silently re-archive → route to
  //     RECONCILIATION (janitor/escalation, A.2 cleanup-failed → blocked).
  //
  // BOUNDARY, stated: a partial archival whose ledger state cannot be
  // determined from durable local files is reconciled by the janitor/scheduler
  // (which can QUERY the ledger — WP-114), not auto-recovered here. This is
  // fail-closed: audit material is never deleted to make a retry proceed.
  if (existsSync(finalPath) || existsSync(sidecarPath)) {
    const prior = readValidSidecar(sidecarPath, opts.issueId, opts.attemptId);
    if (prior) {
      // The sidecar's recorded workspacePath is a REAL (symlink-resolved) path
      // (round-9 finding 1). If the recorded workspace is GONE, the attempt is
      // fully complete → refuse (exactly-once). Checked FIRST, before the
      // identity comparison, so a post-completion re-invocation (whose supplied
      // workspace is also gone) is reported as complete, not as a mismatch.
      if (!existsSync(prior.workspacePath)) {
        throw new ArchivalError(
          "archive-write",
          `archive already complete for attempt ${opts.attemptId} (archive + ledger row + sidecar durable, workspace destroyed)`,
        );
      }
      // Recorded workspace PRESENT → only the destroy remains (a prior destroy
      // failure). A resume-destroy may run ONLY when the SUPPLIED workspace is
      // the EXACT SAME REAL directory the completed attempt recorded (round-7
      // finding 1, hardened round-9 finding 1 to real identity): compare the
      // supplied workspace's realpath to the recorded real path. A different
      // real dir — a cwd-relative spelling, a rebound symlink parent, or a stray
      // duplicate call with another workspace — must touch NEITHER.
      const suppliedReal = realWorkspaceIdentity(workspaceDir);
      if (suppliedReal !== prior.workspacePath) {
        throw new ArchivalError(
          "archive-write",
          `re-invocation for attempt ${opts.attemptId} supplies workspace ${JSON.stringify(suppliedReal ?? workspaceDir)} but the recorded one is ${JSON.stringify(prior.workspacePath)} — refusing to touch either (janitor/escalation reconciles)`,
        );
      }
      // Never trade the workspace (its last copy) for an archive that is not
      // verifiably present, a regular file, within cap, and hash-matching —
      // re-derived from the FILE, never sidecar byte-fields (round-9 finding 3,
      // hardened round-10 findings 2/3/5).
      const verifiedBytes = await verifyArchiveIntact(
        finalPath,
        opts.attemptId,
        prior.sha256,
        quotas.archiveMaxCompressedBytes,
      );
      // Beyond the pathname, the workspace at that path must still be the EXACT
      // SAME INODE the attempt archived (round-11 finding 3): a directory
      // rm+recreated at the same path is a different (dev,ino) and must NOT be
      // destroyed. The inode identity is REQUIRED for a resume-destroy (round-12
      // finding 4): a sidecar WITHOUT it (a legacy/pre-round-11 sidecar) cannot
      // prove the directory is unchanged, so it is INDETERMINATE → refuse and
      // reconcile rather than destroy on the pathname alone. Checked LAST,
      // immediately before the destroy.
      if (
        prior.workspaceDev === undefined ||
        prior.workspaceIno === undefined ||
        prior.workspaceBirthtimeNs === undefined
      ) {
        throw new ArchivalError(
          "archive-write",
          `resume for attempt ${opts.attemptId}: the sidecar has no recorded workspace (dev,ino,birthtime) identity — cannot prove the directory is unchanged; refusing to destroy (janitor/escalation reconciles, fail-closed)`,
        );
      }
      let priorBirthtimeNs: bigint;
      try {
        priorBirthtimeNs = BigInt(prior.workspaceBirthtimeNs);
      } catch {
        throw new ArchivalError(
          "archive-write",
          `resume for attempt ${opts.attemptId}: the sidecar's recorded workspace birthtime ${JSON.stringify(prior.workspaceBirthtimeNs)} is not a valid integer — cannot prove the directory is unchanged; refusing to destroy (janitor/escalation reconciles, fail-closed)`,
        );
      }
      assertWorkspaceUnchanged(
        workspaceReal,
        { dev: prior.workspaceDev, ino: prior.workspaceIno, birthtimeNs: priorBirthtimeNs },
        opts.attemptId,
      );
      // Stamps reconstructed from the sidecar; the ledger row is NOT re-recorded.
      const archiveWrittenAt = prior.archiveWrittenAt;
      const ledgerRowAt = nextStamp(nowMs, archiveWrittenAt);
      await destroyWorkspaceOrThrow(prior.workspacePath);
      const workspaceDestroyedAt = nextStamp(nowMs, ledgerRowAt);
      return buildArchivalRecord({
        archivePath: finalPath,
        sha256: prior.sha256,
        compressedBytes: verifiedBytes, // the REAL size, not the sidecar's claim
        workspaceBytes: prior.workspaceBytes,
        archiveWrittenAt,
        ledgerRowAt,
        workspaceDestroyedAt,
      });
    }
    throw new ArchivalError(
      "archive-write",
      `a prior PARTIAL archival for attempt ${opts.attemptId} exists (archive/sidecar present, no VALID sidecar) — its ledger state is unknown, so it is neither deleted nor redone; janitor/escalation must reconcile (fail-closed)`,
    );
  }
  try {
    // ASYNC tar (round-13 finding 1): execFileSync would BLOCK the daemon loop for
    // the whole tar of a pathological workspace; await lets other attempts' timers
    // run. spawn + exit-code success (round-14 finding 5) + write-time cap (round-15
    // finding 6): tar stderr volume never converts a successful archive into a
    // refusal, and the compressed size is bounded as it streams.
    await runTarToFile(tmpPath, workspaceReal, quotas.archiveMaxCompressedBytes);
  } catch (err) {
    safeRemove(tmpPath);
    // An over-cap-during-write refusal is already a staged ArchivalError
    // (archive-quota) — preserve its stage; only a tar/spawn failure is wrapped.
    if (err instanceof ArchivalError) throw err;
    throw new ArchivalError(
      "archive-write",
      `tar failed: ${describeError(err, 300)} — workspace retained`,
    );
  }
  // STAGE the size + hash reads (round-14 finding 6): sha256File streams the
  // just-written partial, so an EACCES/EIO there is a real failure mode — it must
  // throw a STAGED ArchivalError and clean up the partial, not escape as a raw
  // Error leaving an orphan .partial (the "every failure is staged" claim).
  let compressedBytes: number;
  let sha256: string;
  try {
    compressedBytes = statSync(tmpPath).size;
  } catch (err) {
    safeRemove(tmpPath);
    throw new ArchivalError(
      "archive-write",
      `could not stat the written archive ${tmpPath}: ${describeError(err, 200)} — workspace retained`,
    );
  }
  if (compressedBytes > quotas.archiveMaxCompressedBytes) {
    safeRemove(tmpPath);
    throw new ArchivalError(
      "archive-quota",
      `archive is ${compressedBytes} bytes compressed, over the ${quotas.archiveMaxCompressedBytes}-byte cap (registry item 11) — workspace retained for escalation`,
    );
  }
  try {
    sha256 = await sha256File(tmpPath); // streaming, async — never buffer/block on up to 500 MB
  } catch (err) {
    safeRemove(tmpPath);
    throw new ArchivalError(
      "archive-write",
      `could not hash the written archive ${tmpPath}: ${describeError(err, 200)} — workspace retained`,
    );
  }
  try {
    renameSync(tmpPath, finalPath);
  } catch (err) {
    safeRemove(tmpPath);
    throw new ArchivalError(
      "archive-write",
      `archive install failed: ${describeError(err, 300)} — workspace retained`,
    );
  }
  await syncFileAndParentDir(finalPath); // flush the archive to stable storage (round-9 finding 9)
  const archiveWrittenAt = nextStamp(nowMs, null);

  // Step 2 — ledger row referencing the archive, BEFORE the sidecar (A.4#5
  // order: archive → ledger → destroy). A throw here leaves the archive with
  // NO valid sidecar, so a re-invocation routes to reconciliation (round-6
  // finding 1), never a blind redo. recordLedgerRow MUST be idempotent per
  // (issueId, attemptId) — a reconciled retry re-invokes it and the WP-104
  // idempotency contract dedups the row.
  try {
    await opts.recordLedgerRow({
      issueId: opts.issueId,
      attemptId: opts.attemptId,
      archivePath: finalPath,
      sha256,
      compressedBytes,
      workspaceBytes,
      archiveWrittenAt,
    });
  } catch (err) {
    throw new ArchivalError(
      "ledger-row",
      `ledger row failed after the archive was written: ${describeError(err, 300)} — archive (no sidecar) and workspace retained; retry recovers`,
    );
  }
  const ledgerRowAt = nextStamp(nowMs, archiveWrittenAt);

  // Sidecar written AFTER the ledger row. On failure DON'T roll back the
  // archive — the ledger row already references it durably; removing it would
  // orphan that reference. Throw a staged error; the archive is kept and
  // retention treats a sidecar-less archive as UNDATABLE (never pruned,
  // fail-closed), and a retry recompletes it.
  const sidecar: ArchiveSidecar = {
    issueId: opts.issueId,
    attemptId: opts.attemptId,
    workspacePath: workspaceReal,
    workspaceDev: workspaceIdentity.dev,
    workspaceIno: workspaceIdentity.ino,
    workspaceBirthtimeNs: workspaceIdentity.birthtimeNs.toString(),
    archiveWrittenAt,
    seq,
    sha256,
    compressedBytes,
    workspaceBytes,
  };
  try {
    writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n");
  } catch (err) {
    throw new ArchivalError(
      "ledger-row",
      `sidecar write failed after the ledger row: ${describeError(err, 300)} — archive + ledger row durable, workspace retained (retention keeps the archive; retry recompletes)`,
    );
  }
  await syncFileAndParentDir(sidecarPath); // flush the sidecar to stable storage (round-9 finding 9)

  // IMMEDIATELY before the destroy, re-validate BOTH the archive and the
  // workspace identity from the filesystem (round-10 findings 2/3/5). The
  // recordLedgerRow callback ran above and is treated as capable of mutating the
  // tree — so a callback that deleted/replaced the archive, or rm+recreated the
  // workspace pathname, must NOT let the destroy proceed. verifyArchiveIntact
  // re-derives everything from the FILE (regular file, size ≤ cap, streaming
  // sha256), and assertWorkspaceUnchanged confirms the same (dev, ino) captured
  // up-front. Either failing retains the workspace → reconciliation.
  await verifyArchiveIntact(finalPath, opts.attemptId, sha256, quotas.archiveMaxCompressedBytes);
  assertWorkspaceUnchanged(workspaceReal, workspaceIdentity, opts.attemptId);

  // Step 3 — destroy the workspace, strictly last (a failure is a cleanup-failed
  // teardown, A.2 "cleanup failure during teardown → blocked"; workspaceRetained
  // :false because recursive deletion is not transactional — round-1 finding 4).
  // If this fails, a re-invocation RESUMES the destroy (valid sidecar +
  // workspace present — round-6 finding 1).
  await destroyWorkspaceOrThrow(workspaceReal);
  const workspaceDestroyedAt = nextStamp(nowMs, ledgerRowAt);

  return buildArchivalRecord({
    archivePath: finalPath,
    sha256,
    compressedBytes,
    workspaceBytes,
    archiveWrittenAt,
    ledgerRowAt,
    workspaceDestroyedAt,
  });
}

/**
 * The retention sequence for this archival (round-2 finding 6; round-3 finding
 * 8). `attemptSeq` is already validated as a non-negative safe integer by the
 * caller (archiveAttempt, early). Reads the issue dir's existing seqs ONCE:
 *   - authoritative attemptSeq: use it, but REFUSE if a sibling already holds
 *     that seq — a duplicate ordinal would make retention ambiguous;
 *   - dir-scan fallback: max existing safe seq + 1; a corrupt/overflowed
 *     sibling seq is ignored (cannot poison the next ordinal). If a strictly
 *     greater SAFE seq cannot be assigned (the absurd MAX_SAFE_INTEGER edge),
 *     REFUSE rather than clamp to a tie.
 */
function resolveSeq(
  attemptSeq: number | undefined,
  issueDir: string,
  currentAttemptId: string,
): number {
  let max = -1;
  const existingSeqs = new Set<number>();
  let names: string[] = [];
  try {
    names = readdirSync(issueDir);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (name === `${currentAttemptId}.json`) continue; // not yet written
    try {
      const sidecar = JSON.parse(readFileSync(join(issueDir, name), "utf8")) as ArchiveSidecar;
      if (Number.isSafeInteger(sidecar.seq)) {
        existingSeqs.add(sidecar.seq);
        if (sidecar.seq > max) max = sidecar.seq;
      }
    } catch {
      /* an unreadable sibling sidecar does not block sequencing */
    }
  }
  if (attemptSeq !== undefined) {
    if (existingSeqs.has(attemptSeq)) {
      throw new ArchivalError(
        "id-validation",
        `attemptSeq ${attemptSeq} already exists for this issue — a duplicate ordinal makes retention ambiguous (fail-closed)`,
      );
    }
    return attemptSeq;
  }
  const next = max + 1;
  if (!Number.isSafeInteger(next)) {
    throw new ArchivalError(
      "id-validation",
      "cannot assign a strictly greater safe-integer archival sequence (max reached) — refused (fail-closed)",
    );
  }
  return next;
}

export interface PruneReport {
  kept: string[]; // archive paths retained
  deleted: string[]; // archive paths deleted (age AND count windows both exceeded)
  /** Archives with a missing/unreadable/unsequenced sidecar — KEPT fail-closed, reported. */
  undatable: string[];
}

export interface PruneOptions {
  archiveRoot: string;
  now?: () => Date;
  retainDays?: number;
  retainLastAttemptsPerIssue?: number;
}

/**
 * Registry item 11 retention: "retained 90 days or last 10 attempts per
 * issue (whichever more)" — the UNION. An archive is deleted only when it is
 * BOTH older than retainDays AND outside its issue's newest
 * retainLastAttemptsPerIssue. An archive whose sidecar is missing or
 * unreadable cannot be dated and is NEVER deleted (fail-closed), only
 * reported.
 */
/** Retention override → at least the registry floor; non-finite/negative → the floor. */
function clampRetentionFloor(override: number | undefined, floor: number): number {
  if (override === undefined || !Number.isFinite(override) || override < 0) return floor;
  return Math.max(override, floor);
}

export function pruneArchives(opts: PruneOptions): PruneReport {
  const now = opts.now ?? (() => new Date());
  // Registry item 11 is a retention FLOOR (round-12 finding 5): an override may
  // only make retention MORE generous, never delete below the registry minimum.
  // A non-finite/negative override falls back to the registry (never weaker), and
  // `max` keeps a larger override. So `retainDays:0`/`retainLast:0` cannot delete
  // a within-registry archive.
  const retainDays = clampRetentionFloor(
    opts.retainDays,
    REGISTRY_ITEM_11_QUOTAS.archive.retainDays,
  );
  const retainLast = clampRetentionFloor(
    opts.retainLastAttemptsPerIssue,
    REGISTRY_ITEM_11_QUOTAS.archive.retainLastAttemptsPerIssue,
  );
  // A non-finite clock (round-13 finding 6) would make every age comparison false
  // and delete FRESH archives (a NaN cutoff → `writtenMs >= NaN` is false). Fail
  // SAFE: an invalid clock cannot date anything, so nothing is old enough to prune
  // — cutoff of -Infinity keeps every archive within the age window.
  const nowMs = now().getTime();
  const cutoffMs = Number.isFinite(nowMs)
    ? nowMs - retainDays * 24 * 60 * 60 * 1000
    : Number.NEGATIVE_INFINITY;
  const report: PruneReport = { kept: [], deleted: [], undatable: [] };

  // Resolve to an ABSOLUTE root (round-9 finding 8) so the reported/deleted
  // paths are cwd-independent, matching archiveAttempt's ledger references.
  const archiveRoot = resolve(opts.archiveRoot);

  let issueDirs: string[];
  try {
    issueDirs = readdirSync(archiveRoot);
  } catch {
    return report; // no archive root yet — nothing to prune
  }
  for (const issueId of issueDirs) {
    const issueDir = join(archiveRoot, issueId);
    let stat;
    try {
      stat = lstatSync(issueDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const entries = readdirSync(issueDir).filter((n) => n.endsWith(".tar.gz"));
    const dated: {
      path: string;
      sidecarPath: string;
      writtenMs: number;
      seq: number;
      attemptId: string;
    }[] = [];
    for (const name of entries) {
      const archivePath = join(issueDir, name);
      const attemptId = name.slice(0, -".tar.gz".length);
      const sidecarPath = join(issueDir, `${attemptId}.json`);
      let writtenMs: number | null = null;
      let seq: number | null = null;
      // Validate the sidecar's OWN identity — issueId (this dir) and attemptId
      // (this archive's filename) — with the SAME check recovery uses (round-9
      // finding 6). A sidecar whose content names a different issue/attempt (a
      // mis-placed or corrupt file) must NOT lend its seq/timestamp to a
      // neighbour's retention decision; readValidSidecar returns null for it, so
      // the archive falls through to `undatable` and is never deleted.
      const sidecar = readValidSidecar(sidecarPath, issueId, attemptId);
      if (sidecar) {
        const claimed = Date.parse(sidecar.archiveWrittenAt); // finite (readValidSidecar checked)
        // AGE uses the MORE RECENT of the sidecar's claim and the archive FILE's
        // actual mtime (round-10 finding 11): a sidecar with a spoofed OLD
        // timestamp (and a low seq) must NOT make a FRESH archive look old enough
        // to prune — its real mtime keeps it inside the age window (retention is
        // the UNION, so within-age alone retains it).
        let fileMtime = Number.NaN;
        try {
          fileMtime = statSync(archivePath).mtimeMs;
        } catch {
          /* unreadable mtime → fall back to the (validated) sidecar claim */
        }
        writtenMs = Number.isFinite(fileMtime) ? Math.max(claimed, fileMtime) : claimed;
        // readValidSidecar already required a SAFE-INTEGER seq; a corrupt/
        // overflowed seq made it null → undatable (fail-closed, round-2 finding 6).
        seq = sidecar.seq;
      }
      // Undatable OR unsequenced → cannot be ordered for the count window;
      // never delete it (fail-closed), only report.
      if (writtenMs === null || seq === null) {
        report.undatable.push(archivePath);
        continue;
      }
      dated.push({ path: archivePath, sidecarPath, writtenMs, seq, attemptId });
    }
    // Newest first BY SEQUENCE (the attempt order), so "last 10 attempts" is
    // exact even when archive timestamps tie to the millisecond (round-1
    // finding 11). A tie on seq (should not happen under single-writer, but a
    // corrupt store might) breaks deterministically by attemptId so the choice
    // is stable, never arbitrary (round-2 finding 6). Timestamp is only the AGE
    // input, never the count ordering.
    dated.sort((a, b) =>
      b.seq - a.seq !== 0 ? b.seq - a.seq : a.attemptId < b.attemptId ? -1 : 1,
    );
    dated.forEach((entry, index) => {
      const withinAge = entry.writtenMs >= cutoffMs;
      const withinCount = index < retainLast;
      if (withinAge || withinCount) {
        report.kept.push(entry.path);
      } else {
        rmSync(entry.path, { force: true });
        rmSync(entry.sidecarPath, { force: true });
        report.deleted.push(entry.path);
      }
    });
  }
  report.kept.sort();
  report.deleted.sort();
  report.undatable.sort();
  return report;
}
