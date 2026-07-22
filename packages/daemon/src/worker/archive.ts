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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import { join, resolve } from "node:path";
import { REGISTRY_ITEM_11_QUOTAS } from "@camino/shared";
import type { AttemptEvent } from "@camino/core";

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

function assertSafeId(kind: "issueId" | "attemptId", value: string): void {
  if (!ID_RE.test(value) || value.includes("..")) {
    throw new ArchivalError("id-validation", `${kind} ${JSON.stringify(value)} is not path-safe`);
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

/** Injectable quota subset (tests use tiny values; production the registry). */
export interface ArchiveQuotas {
  workspaceMaxBytes: number;
  archiveMaxCompressedBytes: number;
}

export const DEFAULT_ARCHIVE_QUOTAS: ArchiveQuotas = Object.freeze({
  workspaceMaxBytes: REGISTRY_ITEM_11_QUOTAS.workspace.maxBytes,
  archiveMaxCompressedBytes: REGISTRY_ITEM_11_QUOTAS.archive.maxCompressedBytes,
});

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
   * record before returning; a throw here retains BOTH the archive file and
   * the workspace (fail-closed — the destroy step is never reached).
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
 * genuinely ordered steps into an equal pair.
 */
function nextStamp(now: () => Date, prev: string | null): string {
  const t = now().getTime();
  const floor = prev === null ? t : Math.max(t, Date.parse(prev) + 1);
  return new Date(floor).toISOString();
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
 */
export async function archiveAttempt(opts: ArchiveAttemptOptions): Promise<ArchivalRecord> {
  const now = opts.now ?? (() => new Date());
  const quotas = opts.quotas ?? DEFAULT_ARCHIVE_QUOTAS;
  assertSafeId("issueId", opts.issueId);
  assertSafeId("attemptId", opts.attemptId);

  // The archive must NOT live inside the workspace (round-1 finding 4): the
  // final step destroys the workspace recursively, so an archiveRoot under it
  // would delete the very archive the ledger row references — reporting
  // success while the audit record is gone. Refuse before writing anything.
  // realpath BOTH so a SYMLINK archiveRoot pointing into the workspace is
  // caught (round-2 finding 3: `resolve()` normalized spelling but did not
  // follow symlinks). Resolve the deepest existing prefix when a path does not
  // fully exist yet.
  const wsResolved = realDirPath(opts.workspaceDir);
  const rootResolved = realDirPath(opts.archiveRoot);
  if (rootResolved === wsResolved || rootResolved.startsWith(`${wsResolved}/`)) {
    throw new ArchivalError(
      "id-validation",
      `archiveRoot ${JSON.stringify(opts.archiveRoot)} resolves inside the workspace ${JSON.stringify(opts.workspaceDir)} — workspace teardown would delete the archive (fail-closed)`,
    );
  }

  // Step 0 — workspace quota (registry item 11: workspace ≤ 2 GB). An
  // over-quota workspace is an abnormal condition: refusing here routes it to
  // the cleanup-failed/escalation path with the workspace intact, rather than
  // silently accepting the breach or blowing the archive cap below.
  const workspaceBytes = workspaceSizeBytes(opts.workspaceDir);
  if (workspaceBytes > quotas.workspaceMaxBytes) {
    throw new ArchivalError(
      "workspace-quota",
      `workspace is ${workspaceBytes} bytes, over the ${quotas.workspaceMaxBytes}-byte quota (registry item 11) — workspace retained for escalation`,
    );
  }

  // Step 1 — archive written under quota.
  const issueDir = join(opts.archiveRoot, opts.issueId);
  mkdirSync(issueDir, { recursive: true });
  const finalPath = join(issueDir, `${opts.attemptId}.tar.gz`);
  const tmpPath = join(issueDir, `.${opts.attemptId}.tar.gz.partial`);
  if (existsSync(finalPath)) {
    // A.4#5: archival happens exactly once — a second call for the same
    // attempt is a sequencing bug upstream, refused loudly.
    throw new ArchivalError("archive-write", `archive already exists at ${finalPath}`);
  }
  try {
    execFileSync("tar", ["-czf", tmpPath, "-C", opts.workspaceDir, "."], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw new ArchivalError(
      "archive-write",
      `tar failed: ${(err as Error).message.slice(0, 300)} — workspace retained`,
    );
  }
  const compressedBytes = statSync(tmpPath).size;
  if (compressedBytes > quotas.archiveMaxCompressedBytes) {
    rmSync(tmpPath, { force: true });
    throw new ArchivalError(
      "archive-quota",
      `archive is ${compressedBytes} bytes compressed, over the ${quotas.archiveMaxCompressedBytes}-byte cap (registry item 11) — workspace retained for escalation`,
    );
  }
  const sha256 = createHash("sha256").update(readFileSync(tmpPath)).digest("hex");
  renameSync(tmpPath, finalPath);
  const archiveWrittenAt = nextStamp(now, null);
  const sidecar: ArchiveSidecar = {
    issueId: opts.issueId,
    attemptId: opts.attemptId,
    archiveWrittenAt,
    seq: resolveSeq(opts.attemptSeq, issueDir, opts.attemptId),
    sha256,
    compressedBytes,
    workspaceBytes,
  };
  writeFileSync(join(issueDir, `${opts.attemptId}.json`), JSON.stringify(sidecar, null, 2) + "\n");

  // Step 2 — ledger row referencing the archive. A throw retains everything.
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
      `ledger row failed after the archive was written: ${(err as Error).message.slice(0, 300)} — archive and workspace retained`,
    );
  }
  const ledgerRowAt = nextStamp(now, archiveWrittenAt);

  // Step 3 — destroy the workspace, strictly last. A failure here is NOT
  // "retained" — recursive deletion is not transactional, so a mid-way failure
  // may have removed some files (round-1 finding 4, second part). The archive
  // and ledger row are already durable, so this is a cleanup-failed teardown
  // (A.2 "cleanup failure during teardown → blocked"), not a lost archive;
  // workspaceRetained:false says the workspace is in an indeterminate,
  // partially-removed state that the janitor must reconcile.
  try {
    rmSync(opts.workspaceDir, { recursive: true, force: true });
  } catch (err) {
    throw new ArchivalError(
      "workspace-destroy",
      `workspace destroy failed after archive + ledger row (workspace may be partially removed): ${(err as Error).message.slice(0, 300)}`,
      false,
    );
  }
  if (existsSync(opts.workspaceDir)) {
    // force:true can mask persistent trees; verify the deletion actually took.
    throw new ArchivalError(
      "workspace-destroy",
      "workspace still present after destroy (partially removed) — janitor must reconcile",
      false,
    );
  }
  const workspaceDestroyedAt = nextStamp(now, ledgerRowAt);

  return {
    archivePath: finalPath,
    sha256,
    compressedBytes,
    workspaceBytes,
    archiveWrittenAt,
    ledgerRowAt,
    workspaceDestroyedAt,
    attemptEvent: {
      type: "archival-completed",
      quotasEnforced: true,
      ledgerRowReferencesArchive: true,
      archiveWrittenAt,
      ledgerRowAt,
      workspaceDestroyedAt,
    },
  };
}

/**
 * The retention sequence for this archival (round-2 finding 6):
 *   - if the caller supplied the attempt's AUTHORITATIVE ordinal, use it — it
 *     is race-free and durable (the WP-114 scheduler owns it), rejected unless
 *     a non-negative safe integer;
 *   - otherwise assign a best-effort dir-scan ordinal (max existing safe seq +
 *     1). The dir-scan is safe under the single-writer-per-issue assumption
 *     documented on ArchiveAttemptOptions.archiveRoot; a corrupt/overflowing
 *     sibling seq is ignored (not treated as the max), so it cannot poison the
 *     next ordinal, and the result is clamped to a safe integer.
 */
function resolveSeq(
  attemptSeq: number | undefined,
  issueDir: string,
  currentAttemptId: string,
): number {
  if (attemptSeq !== undefined) {
    if (!Number.isSafeInteger(attemptSeq) || attemptSeq < 0) {
      throw new ArchivalError(
        "id-validation",
        `attemptSeq ${String(attemptSeq)} must be a non-negative safe integer`,
      );
    }
    return attemptSeq;
  }
  let max = -1;
  let names: string[];
  try {
    names = readdirSync(issueDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (name === `${currentAttemptId}.json`) continue; // not yet written
    try {
      const sidecar = JSON.parse(readFileSync(join(issueDir, name), "utf8")) as ArchiveSidecar;
      // Only a valid safe-integer seq counts toward the max — a corrupt or
      // overflowed sibling cannot drag the next ordinal into a tie.
      if (Number.isSafeInteger(sidecar.seq) && sidecar.seq > max) max = sidecar.seq;
    } catch {
      /* an unreadable sibling sidecar does not block sequencing */
    }
  }
  return max + 1 <= Number.MAX_SAFE_INTEGER ? max + 1 : Number.MAX_SAFE_INTEGER;
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
export function pruneArchives(opts: PruneOptions): PruneReport {
  const now = opts.now ?? (() => new Date());
  const retainDays = opts.retainDays ?? REGISTRY_ITEM_11_QUOTAS.archive.retainDays;
  const retainLast =
    opts.retainLastAttemptsPerIssue ?? REGISTRY_ITEM_11_QUOTAS.archive.retainLastAttemptsPerIssue;
  const cutoffMs = now().getTime() - retainDays * 24 * 60 * 60 * 1000;
  const report: PruneReport = { kept: [], deleted: [], undatable: [] };

  let issueDirs: string[];
  try {
    issueDirs = readdirSync(opts.archiveRoot);
  } catch {
    return report; // no archive root yet — nothing to prune
  }
  for (const issueId of issueDirs) {
    const issueDir = join(opts.archiveRoot, issueId);
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
      try {
        const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as ArchiveSidecar;
        const t = Date.parse(sidecar.archiveWrittenAt);
        if (Number.isFinite(t)) writtenMs = t;
        // Only a SAFE-INTEGER seq is orderable; a corrupt/overflowed seq is
        // treated as unsequenced → undatable (fail-closed), never deleted
        // (round-2 finding 6).
        if (Number.isSafeInteger(sidecar.seq)) seq = sidecar.seq;
      } catch {
        writtenMs = null;
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
