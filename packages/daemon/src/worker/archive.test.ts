// WP-107 · CAM-EXEC-05 fixtures: the single archival step's strict order
// (archive → ledger row → destroy; any failure retains the workspace), the
// registry-item-11 quotas (workspace 2 GB / archive 500 MB compressed —
// injected tiny here, the real values pinned via DEFAULT_ARCHIVE_QUOTAS),
// and the union retention rule ("90 days or last 10, whichever MORE").
// Large fixtures are generated in-script (the E2BIG CI lesson).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REGISTRY_ITEM_11_QUOTAS } from "@camino/shared";
import { attemptMachine, transition } from "@camino/core";
import {
  DEFAULT_ARCHIVE_QUOTAS,
  archiveAttempt,
  pruneArchives,
  workspaceSizeBytes,
  type ArchiveLedgerRow,
  type ArchiveSidecar,
} from "./archive.js";

let dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-wp107-archive-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A small workspace with real git history (the audit object of CAM-EXEC-05). */
function makeWorkspace(): string {
  const dir = tempDir();
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "w",
    GIT_AUTHOR_EMAIL: "w@camino.invalid",
    GIT_COMMITTER_NAME: "w",
    GIT_COMMITTER_EMAIL: "w@camino.invalid",
  };
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { env, stdio: "ignore" });
  git("init", "--quiet");
  writeFileSync(join(dir, "work.txt"), "worker output\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "attempt work");
  return dir;
}

/** Deterministic INCOMPRESSIBLE bytes (xorshift32), generated in-script. */
function incompressible(bytes: number): Buffer {
  const buf = Buffer.alloc(bytes);
  let x = 0x9e3779b9;
  for (let i = 0; i < bytes; i += 4) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    buf.writeUInt32LE(x >>> 0, i > bytes - 4 ? bytes - 4 : i);
  }
  return buf;
}

describe("archiveAttempt (A.4#5 single archival step)", () => {
  it("archives, records the ledger row, destroys the workspace — strictly in that order, and the event satisfies A.3#8", async () => {
    const ws = makeWorkspace();
    const root = tempDir();
    const rows: ArchiveLedgerRow[] = [];
    let workspaceExistedAtLedgerTime = false;
    const record = await archiveAttempt({
      workspaceDir: ws,
      archiveRoot: root,
      issueId: "issue-9",
      attemptId: "attempt-1",
      recordLedgerRow: (row) => {
        // Order probe: the archive must already exist and the workspace must
        // still exist when the ledger row is recorded.
        expect(existsSync(row.archivePath)).toBe(true);
        workspaceExistedAtLedgerTime = existsSync(ws);
        rows.push(row);
      },
    });
    expect(rows).toHaveLength(1);
    expect(workspaceExistedAtLedgerTime).toBe(true);
    expect(existsSync(ws)).toBe(false); // destroyed last
    expect(existsSync(record.archivePath)).toBe(true);
    expect(record.archivePath).toBe(join(root, "issue-9", "attempt-1.tar.gz"));
    // The row REFERENCES the written archive (A.4#5), byte-identically.
    expect(rows[0]).toMatchObject({
      archivePath: record.archivePath,
      sha256: record.sha256,
      compressedBytes: record.compressedBytes,
    });
    // Sidecar metadata backs retention decisions.
    const sidecar = JSON.parse(
      readFileSync(join(root, "issue-9", "attempt-1.json"), "utf8"),
    ) as ArchiveSidecar;
    expect(sidecar.attemptId).toBe("attempt-1");
    expect(sidecar.sha256).toBe(record.sha256);
    expect(sidecar.seq).toBe(0); // first archive of this issue
    // Strict sub-step order, and the ready-made event passes the core guard
    // from every terminal state.
    expect(Date.parse(record.archiveWrittenAt)).toBeLessThan(Date.parse(record.ledgerRowAt));
    expect(Date.parse(record.ledgerRowAt)).toBeLessThan(Date.parse(record.workspaceDestroyedAt));
    const step = transition(attemptMachine, "killed-budget", record.attemptEvent);
    expect(step).toEqual({ ok: true, to: "archived", ref: "A.3#8" });
  });

  it("the archive is a faithful audit object: history survives extraction", async () => {
    const ws = makeWorkspace();
    const root = tempDir();
    const record = await archiveAttempt({
      workspaceDir: ws,
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      recordLedgerRow: () => {},
    });
    const out = tempDir();
    execFileSync("tar", ["-xzf", record.archivePath, "-C", out]);
    const log = execFileSync("git", ["-C", out, "log", "--format=%s"], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    })
      .toString()
      .trim();
    expect(log).toBe("attempt work"); // worker HISTORY, not just the tree
  });

  it("ledger-row failure retains BOTH the archive and the workspace (never destroy unreferenced)", async () => {
    const ws = makeWorkspace();
    const root = tempDir();
    await expect(
      archiveAttempt({
        workspaceDir: ws,
        archiveRoot: root,
        issueId: "i",
        attemptId: "a",
        recordLedgerRow: () => {
          throw new Error("ledger store down");
        },
      }),
    ).rejects.toMatchObject({ name: "ArchivalError", stage: "ledger-row" });
    expect(existsSync(ws)).toBe(true); // workspace retained
    expect(existsSync(join(root, "i", "a.tar.gz"))).toBe(true); // archive evidence retained
  });

  it("an over-cap compressed archive is refused and the workspace retained (registry item 11)", async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, "blob.bin"), incompressible(64 * 1024));
    const root = tempDir();
    await expect(
      archiveAttempt({
        workspaceDir: ws,
        archiveRoot: root,
        issueId: "i",
        attemptId: "a",
        recordLedgerRow: () => {},
        quotas: { workspaceMaxBytes: 10_000_000, archiveMaxCompressedBytes: 16 * 1024 },
      }),
    ).rejects.toMatchObject({ stage: "archive-quota" });
    expect(existsSync(ws)).toBe(true);
    expect(existsSync(join(root, "i", "a.tar.gz"))).toBe(false); // no partial left behind
    expect(existsSync(join(root, "i", ".a.tar.gz.partial"))).toBe(false);
  });

  it("an over-quota workspace is refused before anything is written (registry item 11)", async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, "big.bin"), incompressible(32 * 1024));
    const root = tempDir();
    await expect(
      archiveAttempt({
        workspaceDir: ws,
        archiveRoot: root,
        issueId: "i",
        attemptId: "a",
        recordLedgerRow: () => {},
        quotas: { workspaceMaxBytes: 8 * 1024, archiveMaxCompressedBytes: 1_000_000 },
      }),
    ).rejects.toMatchObject({ stage: "workspace-quota" });
    expect(existsSync(ws)).toBe(true);
    expect(existsSync(join(root, "i"))).toBe(false); // nothing written at all
  });

  it("refuses path-unsafe ids and double archival", async () => {
    const root = tempDir();
    await expect(
      archiveAttempt({
        workspaceDir: makeWorkspace(),
        archiveRoot: root,
        issueId: "../escape",
        attemptId: "a",
        recordLedgerRow: () => {},
      }),
    ).rejects.toMatchObject({ stage: "id-validation" });
    const ws = makeWorkspace();
    await archiveAttempt({
      workspaceDir: ws,
      archiveRoot: root,
      issueId: "i",
      attemptId: "once",
      recordLedgerRow: () => {},
    });
    await expect(
      archiveAttempt({
        workspaceDir: makeWorkspace(),
        archiveRoot: root,
        issueId: "i",
        attemptId: "once",
        recordLedgerRow: () => {},
      }),
    ).rejects.toMatchObject({ stage: "archive-write" });
  });

  it("refuses an archiveRoot inside the workspace — cleanup would delete the archive (round-1 finding 4)", async () => {
    const ws = makeWorkspace();
    await expect(
      archiveAttempt({
        workspaceDir: ws,
        archiveRoot: join(ws, "archives"),
        issueId: "i",
        attemptId: "a",
        recordLedgerRow: () => {},
      }),
    ).rejects.toMatchObject({ stage: "id-validation" });
    expect(existsSync(ws)).toBe(true); // nothing was destroyed
    // A `..` path that resolves back inside the workspace is also refused.
    await expect(
      archiveAttempt({
        workspaceDir: ws,
        archiveRoot: join(ws, "sub", ".."),
        issueId: "i",
        attemptId: "a",
        recordLedgerRow: () => {},
      }),
    ).rejects.toMatchObject({ stage: "id-validation" });
  });

  it("assigns a durable per-issue monotonic seq across attempts", async () => {
    const root = tempDir();
    for (const id of ["attempt-a", "attempt-b", "attempt-c"]) {
      await archiveAttempt({
        workspaceDir: makeWorkspace(),
        archiveRoot: root,
        issueId: "issue-x",
        attemptId: id,
        recordLedgerRow: () => {},
      });
    }
    const seqs = ["attempt-a", "attempt-b", "attempt-c"].map((id) => {
      const s = JSON.parse(
        readFileSync(join(root, "issue-x", `${id}.json`), "utf8"),
      ) as ArchiveSidecar;
      return s.seq;
    });
    expect(seqs).toEqual([0, 1, 2]);
  });

  it("production defaults are exactly the registry item 11 values", () => {
    expect(DEFAULT_ARCHIVE_QUOTAS.workspaceMaxBytes).toBe(
      REGISTRY_ITEM_11_QUOTAS.workspace.maxBytes,
    );
    expect(DEFAULT_ARCHIVE_QUOTAS.archiveMaxCompressedBytes).toBe(
      REGISTRY_ITEM_11_QUOTAS.archive.maxCompressedBytes,
    );
    expect(Object.isFrozen(DEFAULT_ARCHIVE_QUOTAS)).toBe(true);
  });
});

describe("workspaceSizeBytes", () => {
  it("sums file bytes without following symlinks", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "a.bin"), Buffer.alloc(1000));
    writeFileSync(join(dir, "sub", "b.bin"), Buffer.alloc(500));
    const size = workspaceSizeBytes(dir);
    expect(size).toBeGreaterThanOrEqual(1500);
    expect(size).toBeLessThan(1700); // symlink/self entries only add link-size noise
  });
});

describe("pruneArchives (retention: 90 days OR last 10 per issue — whichever MORE)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.parse("2026-07-22T00:00:00.000Z");

  function seedArchive(
    root: string,
    issueId: string,
    attemptId: string,
    ageDays: number,
    seq?: number,
  ): string {
    const issueDir = join(root, issueId);
    mkdirSync(issueDir, { recursive: true });
    const archivePath = join(issueDir, `${attemptId}.tar.gz`);
    writeFileSync(archivePath, `fake-archive-${attemptId}`);
    const sidecar: ArchiveSidecar = {
      issueId,
      attemptId,
      archiveWrittenAt: new Date(NOW - ageDays * DAY).toISOString(),
      // Default seq correlates with recency (younger age → higher seq), so
      // the age-based cases below order the same by seq. The tie-break test
      // passes an explicit seq to decouple order from timestamp.
      seq: seq ?? 1_000_000 - Math.round(ageDays),
      sha256: "0".repeat(64),
      compressedBytes: 10,
      workspaceBytes: 10,
    };
    writeFileSync(join(issueDir, `${attemptId}.json`), JSON.stringify(sidecar));
    return archivePath;
  }

  const nowFn = () => new Date(NOW);

  it("keeps young archives beyond the last-10 window (age keeps them)", () => {
    const root = tempDir();
    for (let i = 0; i < 15; i++) seedArchive(root, "issue-a", `attempt-${i}`, i); // all < 90d
    const report = pruneArchives({ archiveRoot: root, now: nowFn });
    expect(report.deleted).toEqual([]);
    expect(report.kept).toHaveLength(15);
  });

  it("keeps the newest 10 beyond the age window (count keeps them)", () => {
    const root = tempDir();
    for (let i = 0; i < 12; i++) seedArchive(root, "issue-b", `attempt-${i}`, 100 + i); // all > 90d
    const report = pruneArchives({ archiveRoot: root, now: nowFn });
    expect(report.kept).toHaveLength(10);
    expect(report.deleted).toHaveLength(2);
    // The two OLDEST (attempt-10, attempt-11 at ages 110/111 days) go.
    expect(report.deleted.map((p) => p.split("/").pop())).toEqual([
      "attempt-10.tar.gz",
      "attempt-11.tar.gz",
    ]);
    for (const p of report.deleted) expect(existsSync(p)).toBe(false);
    for (const p of report.kept) expect(existsSync(p)).toBe(true);
  });

  it("deletes only when BOTH windows are exceeded (mixed case, per issue)", () => {
    const root = tempDir();
    // issue-c: 11 old archives + 2 young. Newest-10 = the 2 young + 8 oldest-but-ranked;
    // young ones are also age-kept. Deleted = ranked ≥ 10 AND old.
    for (let i = 0; i < 11; i++)
      seedArchive(root, "issue-c", `old-${String(i).padStart(2, "0")}`, 95 + i);
    seedArchive(root, "issue-c", "young-a", 5);
    seedArchive(root, "issue-c", "young-b", 10);
    // Separate issue: its own count window (per issue, not global).
    seedArchive(root, "issue-d", "solo", 200);
    const report = pruneArchives({ archiveRoot: root, now: nowFn });
    // 13 in issue-c → newest 10 kept by count; the 3 oldest (old-08..old-10)
    // are outside the count window AND older than 90d → deleted.
    expect(report.deleted.map((p) => p.split("/").pop())).toEqual([
      "old-08.tar.gz",
      "old-09.tar.gz",
      "old-10.tar.gz",
    ]);
    // issue-d's single 200-day archive is within ITS newest-10 → kept.
    expect(report.kept.some((p) => p.endsWith("solo.tar.gz"))).toBe(true);
  });

  it("never deletes an archive it cannot date (missing sidecar) — fail-closed", () => {
    const root = tempDir();
    const issueDir = join(root, "issue-e");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, "mystery.tar.gz"), "bytes");
    // Plus 11 dated old ones so the count window is saturated.
    for (let i = 0; i < 11; i++)
      seedArchive(root, "issue-e", `a-${String(i).padStart(2, "0")}`, 95 + i);
    const report = pruneArchives({ archiveRoot: root, now: nowFn });
    expect(report.undatable).toEqual([join(issueDir, "mystery.tar.gz")]);
    expect(existsSync(join(issueDir, "mystery.tar.gz"))).toBe(true);
  });

  it("defaults to the registry item 11 retention values", () => {
    const root = tempDir();
    // 89-day-old vs 91-day-old, both outside a saturated count window of 10.
    for (let i = 0; i < 10; i++) seedArchive(root, "issue-f", `recent-${i}`, i);
    const keepByAge = seedArchive(root, "issue-f", "edge-89", 89);
    const dropBoth = seedArchive(root, "issue-f", "edge-91", 91);
    const report = pruneArchives({ archiveRoot: root, now: nowFn });
    expect(report.kept).toContain(keepByAge);
    expect(report.deleted).toContain(dropBoth);
  });

  it("orders the last-10 window by attempt SEQUENCE, not by tied timestamps (round-1 finding 11)", () => {
    const root = tempDir();
    // 11 attempts, ALL the same (old) timestamp — only the durable seq
    // distinguishes their order. The lowest seq (first attempt) is the one
    // outside the newest-10 window and must be the single deletion.
    for (let i = 0; i < 11; i++) {
      seedArchive(root, "issue-seq", `attempt-${String(i).padStart(2, "0")}`, 200, /* seq */ i);
    }
    const report = pruneArchives({ archiveRoot: root, now: nowFn });
    expect(report.deleted.map((p) => p.split("/").pop())).toEqual(["attempt-00.tar.gz"]);
    expect(report.kept).toHaveLength(10);
    // A truly ordinal-blind sort (by tied timestamp) could delete any of them;
    // seq pins it to the genuine first attempt.
  });

  it("keeps an archive whose sidecar lacks a seq (unsequenced = undatable, fail-closed)", () => {
    const root = tempDir();
    const issueDir = join(root, "issue-noseq");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, "legacy.tar.gz"), "bytes");
    // A sidecar with a timestamp but NO seq cannot be ordered → never deleted.
    writeFileSync(
      join(issueDir, "legacy.json"),
      JSON.stringify({
        issueId: "issue-noseq",
        attemptId: "legacy",
        archiveWrittenAt: new Date(NOW - 200 * DAY).toISOString(),
      }),
    );
    for (let i = 0; i < 11; i++) seedArchive(root, "issue-noseq", `a-${i}`, 95 + i, 100 + i);
    const report = pruneArchives({ archiveRoot: root, now: nowFn });
    expect(report.undatable).toContain(join(issueDir, "legacy.tar.gz"));
    expect(existsSync(join(issueDir, "legacy.tar.gz"))).toBe(true);
  });
});
