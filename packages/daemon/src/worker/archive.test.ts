// WP-107 · CAM-EXEC-05 fixtures: the single archival step's strict order
// (archive → ledger row → destroy; any failure retains the workspace), the
// registry-item-11 quotas (workspace 2 GB / archive 500 MB compressed —
// injected tiny here, the real values pinned via DEFAULT_ARCHIVE_QUOTAS),
// and the union retention rule ("90 days or last 10, whichever MORE").
// Large fixtures are generated in-script (the E2BIG CI lesson).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REGISTRY_ITEM_11_QUOTAS } from "@camino/shared";
import { attemptMachine, transition } from "@camino/core";
import {
  ArchivalError,
  DEFAULT_ARCHIVE_QUOTAS,
  archiveAttempt,
  effectiveArchiveQuotas,
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

  it("archival YIELDS to the event loop, so a slow archival cannot starve a concurrent timer (round-13 finding 1)", async () => {
    const ws = makeWorkspace();
    // Many entries make the walk/tar/hash/rm take real time; a SYNCHRONOUS
    // archival would monopolize the loop and a concurrent timer would not fire.
    for (let i = 0; i < 6_000; i++) writeFileSync(join(ws, `f${i}.txt`), "x");
    const root = tempDir();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);
    try {
      await archiveAttempt({
        workspaceDir: ws,
        archiveRoot: root,
        issueId: "i",
        attemptId: "a",
        recordLedgerRow: () => {},
      });
    } finally {
      clearInterval(timer);
    }
    // Async archival yields between chunks/entries, so the 10ms timer fired
    // repeatedly DURING it. A fully synchronous archival would leave ticks at 0.
    expect(ticks).toBeGreaterThan(3);
    expect(existsSync(ws)).toBe(false); // still archived + destroyed correctly
  }, 30_000);

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

  it("a NON-Error ledger rejection is still a staged ArchivalError, not a raw TypeError (round-8 finding 2)", async () => {
    const ws = makeWorkspace();
    const root = tempDir();
    // `throw "string"` is legal JavaScript: `(err as Error).message` is
    // undefined and `.slice()` on it threw a TypeError that ESCAPED the staged
    // contract — losing the cleanup-stage routing and the fail-closed retention.
    // describeError() must stringify ANY thrown value and keep the staging.
    const err = await archiveAttempt({
      workspaceDir: ws,
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      recordLedgerRow: () => {
        throw "ledger unavailable";
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchivalError);
    expect((err as ArchivalError).stage).toBe("ledger-row");
    expect((err as ArchivalError).workspaceRetained).toBe(true);
    // The non-Error value was captured into the staged message, not swallowed.
    expect((err as Error).message).toContain("ledger unavailable");
    expect(existsSync(ws)).toBe(true); // fail-closed: workspace retained
    expect(existsSync(join(root, "i", "a.tar.gz"))).toBe(true); // archive retained
  });

  it("resolves a RELATIVE archiveRoot to an ABSOLUTE path so the ledger reference is cwd-independent (round-8 finding 3)", async () => {
    const ws = makeWorkspace();
    const runFrom = tempDir(); // an isolated 'install dir' to run the relative root from
    const prevCwd = process.cwd();
    let ledgerPath = "";
    try {
      process.chdir(runFrom);
      const record = await archiveAttempt({
        workspaceDir: ws,
        archiveRoot: "vault", // RELATIVE — a bare join would record "vault/i/a.tar.gz"
        issueId: "i",
        attemptId: "a",
        recordLedgerRow: (row) => {
          ledgerPath = row.archivePath;
        },
      });
      // Both the returned record AND the ledger row reference an ABSOLUTE path,
      // resolved under the archive root — never the cwd-relative "vault/...".
      expect(isAbsolute(record.archivePath)).toBe(true);
      expect(isAbsolute(ledgerPath)).toBe(true);
      expect(ledgerPath).toBe(record.archivePath);
      expect(record.archivePath.endsWith(join("vault", "i", "a.tar.gz"))).toBe(true);
      expect(existsSync(record.archivePath)).toBe(true);
    } finally {
      process.chdir(prevCwd); // restore before any other test runs
    }
  });

  it("canonicalizes the workspace up-front, so a cwd change inside recordLedgerRow cannot misdirect the destroy (round-9 finding 1)", async () => {
    const runA = tempDir();
    const runB = tempDir();
    // The real workspace to archive+destroy, addressed RELATIVELY from runA.
    mkdirSync(join(runA, "ws"), { recursive: true });
    writeFileSync(join(runA, "ws", "work.txt"), "attempt output\n");
    // An UNRELATED workspace at the same relative path under a different cwd.
    mkdirSync(join(runB, "ws"), { recursive: true });
    writeFileSync(join(runB, "ws", "victim.txt"), "must-not-be-touched\n");
    const root = tempDir();
    const prevCwd = process.cwd();
    try {
      process.chdir(runA);
      await archiveAttempt({
        workspaceDir: "ws", // RELATIVE — resolved once, up-front
        archiveRoot: root,
        issueId: "i",
        attemptId: "a",
        recordLedgerRow: () => {
          // A buggy/hostile ledger callback changes cwd mid-archival. The
          // destroy must still target the ORIGINAL workspace (resolved before
          // this ran), never "ws" re-resolved against the new cwd.
          process.chdir(runB);
        },
      });
    } finally {
      process.chdir(prevCwd);
    }
    expect(existsSync(join(runA, "ws"))).toBe(false); // the intended workspace destroyed
    expect(existsSync(join(runB, "ws", "victim.txt"))).toBe(true); // the unrelated one untouched
  });

  it("compares REAL workspace identity, so a rebound symlink parent cannot redirect a resume-destroy onto a victim (round-9 finding 1)", async () => {
    const realA = tempDir();
    const realB = tempDir();
    mkdirSync(join(realA, "ws"));
    writeFileSync(join(realA, "ws", "a.txt"), "A\n");
    mkdirSync(join(realB, "ws"));
    writeFileSync(join(realB, "ws", "victim.txt"), "victim\n");
    const linkParent = join(tempDir(), "link");
    symlinkSync(realA, linkParent); // link -> realA
    const root = tempDir();
    // First archival via the symlinked parent records the REAL path (realA/ws),
    // archives, and destroys realA/ws.
    await archiveAttempt({
      workspaceDir: join(linkParent, "ws"),
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      recordLedgerRow: () => {},
    });
    // Model a FAILED destroy (workspace present again) AND rebind the symlink
    // parent to realB, so link/ws now resolves to the VICTIM.
    mkdirSync(join(realA, "ws"), { recursive: true });
    writeFileSync(join(realA, "ws", "a.txt"), "A\n");
    rmSync(linkParent);
    symlinkSync(realB, linkParent);
    // Re-invoke: the supplied link/ws now really points at realB/ws (≠ the
    // recorded realA/ws) → refuse, touch NEITHER.
    await expect(
      archiveAttempt({
        workspaceDir: join(linkParent, "ws"),
        archiveRoot: root,
        issueId: "i",
        attemptId: "a",
        recordLedgerRow: () => {},
      }),
    ).rejects.toMatchObject({ name: "ArchivalError", stage: "archive-write" });
    expect(existsSync(join(realA, "ws"))).toBe(true); // recorded workspace untouched
    expect(existsSync(join(realB, "ws", "victim.txt"))).toBe(true); // victim untouched
  });

  it("a resume REFUSES to destroy the workspace when the referenced archive is MISSING (round-9 finding 3)", async () => {
    const ws = makeWorkspace();
    const root = tempDir();
    await archiveAttempt({
      workspaceDir: ws,
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      recordLedgerRow: () => {},
    });
    // Model a failed destroy (workspace present again) AND a since-vanished
    // archive (e.g. a prune interrupted between deleting the .tar.gz and its
    // sidecar) — a valid sidecar now references a missing archive.
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "recovered.txt"), "still here\n");
    rmSync(join(root, "i", "a.tar.gz"), { force: true });
    const err = await archiveAttempt({
      workspaceDir: ws,
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      recordLedgerRow: () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchivalError);
    expect((err as ArchivalError).stage).toBe("archive-write");
    expect((err as Error).message).toMatch(/missing/i);
    expect(existsSync(ws)).toBe(true); // the workspace — the LAST copy — is retained
  });

  it("a resume REFUSES to destroy the workspace when the referenced archive fails its CHECKSUM (round-9 finding 3)", async () => {
    const ws = makeWorkspace();
    const root = tempDir();
    await archiveAttempt({
      workspaceDir: ws,
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      recordLedgerRow: () => {},
    });
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "recovered.txt"), "still here\n");
    // Corrupt the archive in place → its sha256 no longer matches the sidecar.
    writeFileSync(join(root, "i", "a.tar.gz"), "corrupted-not-the-original-bytes");
    const err = await archiveAttempt({
      workspaceDir: ws,
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      recordLedgerRow: () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchivalError);
    expect((err as ArchivalError).stage).toBe("archive-write");
    expect((err as Error).message).toMatch(/sha256|match/i);
    expect(existsSync(ws)).toBe(true);
  });

  it("an Error whose `message` is a NON-string is still a staged ArchivalError, not a raw TypeError (round-9 finding 5)", async () => {
    const ws = makeWorkspace();
    const root = tempDir();
    const err = await archiveAttempt({
      workspaceDir: ws,
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      recordLedgerRow: () => {
        const e = new Error("orig");
        // A legal-but-hostile Error whose message is a Symbol — `.slice()` on it
        // previously threw a raw TypeError that escaped the staged contract.
        Object.defineProperty(e, "message", { value: Symbol("boom"), configurable: true });
        throw e;
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchivalError);
    expect((err as ArchivalError).stage).toBe("ledger-row");
    expect((err as Error).message).toContain("Symbol(boom)");
    expect(existsSync(ws)).toBe(true); // fail-closed: workspace retained
    expect(existsSync(join(root, "i", "a.tar.gz"))).toBe(true); // archive retained
  });

  it("the pruner treats a sidecar whose identity does not match its archive as UNDATABLE, never deleting it (round-9 finding 6)", () => {
    const root = tempDir();
    const issueDir = join(root, "issueX");
    mkdirSync(issueDir, { recursive: true });
    // A victim archive whose sidecar CLAIMS a different issue/attempt, spoofed to
    // look old — a pruner trusting it under retainLast:0 would delete it.
    writeFileSync(join(issueDir, "victim.tar.gz"), "audit-material");
    const spoofed: ArchiveSidecar = {
      issueId: "somewhere-else",
      attemptId: "somewhere-else",
      workspacePath: "/gone",
      archiveWrittenAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
      seq: 0,
      sha256: "x",
      compressedBytes: 1,
      workspaceBytes: 1,
    };
    writeFileSync(join(issueDir, "victim.json"), JSON.stringify(spoofed));
    const report = pruneArchives({
      archiveRoot: root,
      retainLastAttemptsPerIssue: 0,
      retainDays: 90,
    });
    const victim = join(issueDir, "victim.tar.gz");
    expect(report.deleted).not.toContain(victim);
    expect(report.undatable).toContain(victim);
    expect(existsSync(victim)).toBe(true); // audit material preserved (fail-closed)
  });

  it("effectiveArchiveQuotas clamps an override to the registry ceiling — an override can only TIGHTEN (round-9 finding 7)", () => {
    const loosened = effectiveArchiveQuotas({
      workspaceMaxBytes: Number.POSITIVE_INFINITY,
      archiveMaxCompressedBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(loosened.workspaceMaxBytes).toBe(REGISTRY_ITEM_11_QUOTAS.workspace.maxBytes);
    expect(loosened.archiveMaxCompressedBytes).toBe(
      REGISTRY_ITEM_11_QUOTAS.archive.maxCompressedBytes,
    );
    // A stricter override is preserved (the suite's tiny quotas keep working);
    // maxWorkspaceEntries defaults to the module ceiling when not overridden.
    expect(
      effectiveArchiveQuotas({ workspaceMaxBytes: 10, archiveMaxCompressedBytes: 20 }),
    ).toEqual({
      workspaceMaxBytes: 10,
      archiveMaxCompressedBytes: 20,
      maxWorkspaceEntries: DEFAULT_ARCHIVE_QUOTAS.maxWorkspaceEntries,
    });
    // Mixed: only the loosened field is clamped.
    const mixed = effectiveArchiveQuotas({
      workspaceMaxBytes: 5,
      archiveMaxCompressedBytes: Number.POSITIVE_INFINITY,
    });
    expect(mixed.workspaceMaxBytes).toBe(5);
    expect(mixed.archiveMaxCompressedBytes).toBe(
      REGISTRY_ITEM_11_QUOTAS.archive.maxCompressedBytes,
    );
  });

  it("pruneArchives resolves a RELATIVE archiveRoot to absolute report paths (round-9 finding 8)", () => {
    const runFrom = tempDir();
    const prevCwd = process.cwd();
    try {
      process.chdir(runFrom);
      mkdirSync(join("vault", "i"), { recursive: true });
      writeFileSync(join("vault", "i", "a.tar.gz"), "keep-me");
      const sidecar: ArchiveSidecar = {
        issueId: "i",
        attemptId: "a",
        workspacePath: "/gone",
        archiveWrittenAt: new Date().toISOString(),
        seq: 0,
        sha256: "x",
        compressedBytes: 1,
        workspaceBytes: 1,
      };
      writeFileSync(join("vault", "i", "a.json"), JSON.stringify(sidecar));
      const report = pruneArchives({ archiveRoot: "vault" });
      expect(report.kept).toHaveLength(1);
      const keptPath = report.kept[0] ?? "";
      expect(isAbsolute(keptPath)).toBe(true);
      expect(keptPath.endsWith(join("vault", "i", "a.tar.gz"))).toBe(true);
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("a recordLedgerRow that DELETES the archive does NOT let the initial destroy proceed (round-10 finding 2)", async () => {
    const ws = makeWorkspace();
    const root = tempDir();
    const err = await archiveAttempt({
      workspaceDir: ws,
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      recordLedgerRow: (row) => {
        // A hostile/buggy callback deletes the archive it was handed and returns.
        rmSync(row.archivePath, { force: true });
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchivalError);
    // The re-validate-before-destroy guard catches the missing archive.
    expect((err as Error).message).toMatch(/missing|not a regular file/i);
    expect(existsSync(ws)).toBe(true); // the workspace — the last copy — is retained
  });

  it("a recordLedgerRow that REPLACES the workspace dir at the same pathname does not destroy the victim (round-10 finding 3)", async () => {
    const ws = makeWorkspace();
    const root = tempDir();
    let victimContent = "";
    const err = await archiveAttempt({
      workspaceDir: ws,
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      recordLedgerRow: () => {
        // rm the archived workspace and recreate an UNRELATED dir at the same path.
        rmSync(ws, { recursive: true, force: true });
        mkdirSync(ws, { recursive: true });
        writeFileSync(join(ws, "victim.txt"), "must-not-be-deleted\n");
        victimContent = readFileSync(join(ws, "victim.txt"), "utf8");
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchivalError);
    expect((err as Error).message).toMatch(/replaced|inode changed/i);
    // The victim (different inode at the same pathname) is untouched.
    expect(existsSync(join(ws, "victim.txt"))).toBe(true);
    expect(victimContent).toBe("must-not-be-deleted\n");
  });

  it("a resume with an OVER-CAP archive (sidecar under-reports its size) refuses — size is re-derived from the file (round-10 finding 5)", async () => {
    const ws = makeWorkspace();
    const root = tempDir();
    // Full archival then a modelled destroy-failure (workspace present again).
    await archiveAttempt({
      workspaceDir: ws,
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      recordLedgerRow: () => {},
    });
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "recovered.txt"), "still here\n");
    // Replace the archive with an over-cap blob AND rewrite the sidecar to claim a
    // matching hash + a tiny size — a resume that trusted sidecar bytes would pass.
    const overCap = incompressible(1024);
    const bigPath = join(root, "i", "a.tar.gz");
    writeFileSync(bigPath, overCap);
    const sha = createHash("sha256").update(overCap).digest("hex");
    const sidecarPath = join(root, "i", "a.json");
    const sc = JSON.parse(readFileSync(sidecarPath, "utf8")) as ArchiveSidecar;
    sc.sha256 = sha;
    sc.compressedBytes = 1; // lie: tiny
    writeFileSync(sidecarPath, JSON.stringify(sc));
    const err = await archiveAttempt({
      workspaceDir: ws,
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      quotas: { workspaceMaxBytes: 1_000_000, archiveMaxCompressedBytes: 512 }, // cap < 1024
      recordLedgerRow: () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchivalError);
    expect((err as ArchivalError).stage).toBe("archive-quota");
    expect(existsSync(ws)).toBe(true); // workspace retained
  });

  it("effectiveArchiveQuotas does NOT let a NaN override disable the cap (round-10 finding 13)", () => {
    const q = effectiveArchiveQuotas({
      workspaceMaxBytes: Number.NaN,
      archiveMaxCompressedBytes: Number.NaN,
    });
    // NaN falls back to the registry ceiling, never a disabled (NaN) cap.
    expect(q.workspaceMaxBytes).toBe(REGISTRY_ITEM_11_QUOTAS.workspace.maxBytes);
    expect(q.archiveMaxCompressedBytes).toBe(REGISTRY_ITEM_11_QUOTAS.archive.maxCompressedBytes);
    expect(Number.isFinite(q.workspaceMaxBytes)).toBe(true);
    expect(Number.isFinite(q.archiveMaxCompressedBytes)).toBe(true);
  });

  it("a sidecar with a max-date timestamp is treated as invalid, never crashing nextStamp with a RangeError (round-10 finding 15)", async () => {
    const ws = makeWorkspace();
    const root = tempDir();
    const issueDir = join(root, "i");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, "a.tar.gz"), "archive-bytes");
    // A shape-valid sidecar whose archiveWrittenAt is the maximum finite JS date.
    writeFileSync(
      join(issueDir, "a.json"),
      JSON.stringify({
        issueId: "i",
        attemptId: "a",
        workspacePath: ws,
        archiveWrittenAt: new Date(8_640_000_000_000_000).toISOString(),
        seq: 0,
        sha256: "x",
        compressedBytes: 1,
        workspaceBytes: 1,
      }),
    );
    // The extreme timestamp makes the sidecar INVALID → indeterminate → staged
    // reconciliation refusal, never a raw RangeError from nextStamp/toISOString.
    const err = await archiveAttempt({
      workspaceDir: ws,
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      recordLedgerRow: () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchivalError);
    expect((err as Error).name).toBe("ArchivalError"); // not a raw RangeError
  });

  it("retention keeps a FRESH archive whose sidecar spoofs an old timestamp — age is floored by the file mtime (round-10 finding 11)", () => {
    const root = tempDir();
    const issueDir = join(root, "issueY");
    mkdirSync(issueDir, { recursive: true });
    // A FRESH archive (recent mtime) whose VALID-identity sidecar lies: old
    // timestamp + low seq, so a metadata-trusting pruner would drop it.
    writeFileSync(join(issueDir, "fresh.tar.gz"), "fresh-audit-material"); // mtime = now
    writeFileSync(
      join(issueDir, "fresh.json"),
      JSON.stringify({
        issueId: "issueY",
        attemptId: "fresh",
        workspacePath: "/gone",
        archiveWrittenAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
        seq: 0,
        sha256: "x",
        compressedBytes: 1,
        workspaceBytes: 1,
      }),
    );
    const report = pruneArchives({
      archiveRoot: root,
      retainLastAttemptsPerIssue: 0,
      retainDays: 90,
    });
    const fresh = join(issueDir, "fresh.tar.gz");
    expect(report.deleted).not.toContain(fresh);
    expect(report.kept).toContain(fresh);
    expect(existsSync(fresh)).toBe(true);
  });

  it("a resume REFUSES a legacy sidecar with no recorded inode identity — reconcile, not destroy (round-12 finding 4)", async () => {
    const ws = makeWorkspace();
    const root = tempDir();
    const issueDir = join(root, "i");
    mkdirSync(issueDir, { recursive: true });
    // Build a valid archive + a LEGACY sidecar (pre-round-11: no workspaceDev/Ino),
    // with the workspace still present.
    execFileSync("tar", ["-czf", join(issueDir, "a.tar.gz"), "-C", ws, "."]);
    const buf = readFileSync(join(issueDir, "a.tar.gz"));
    const legacy = {
      issueId: "i",
      attemptId: "a",
      workspacePath: realpathSync(ws), // real path so the pathname check passes and reaches the inode check
      archiveWrittenAt: new Date().toISOString(),
      seq: 0,
      sha256: createHash("sha256").update(buf).digest("hex"),
      compressedBytes: buf.length,
      workspaceBytes: 10,
    };
    writeFileSync(join(issueDir, "a.json"), JSON.stringify(legacy));
    const err = await archiveAttempt({
      workspaceDir: ws,
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      recordLedgerRow: () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchivalError);
    expect((err as Error).message).toMatch(/\(dev,ino,birthtime\) identity/i);
    expect(existsSync(ws)).toBe(true); // not destroyed on the pathname alone
  });

  it("retention overrides cannot delete below the registry floor (round-12 finding 5)", () => {
    const root = tempDir();
    const issueDir = join(root, "issueZ");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, "only.tar.gz"), "recent-archive"); // mtime = now
    writeFileSync(
      join(issueDir, "only.json"),
      JSON.stringify({
        issueId: "issueZ",
        attemptId: "only",
        workspacePath: "/gone",
        archiveWrittenAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        seq: 0,
        sha256: "x",
        compressedBytes: 1,
        workspaceBytes: 1,
      }),
    );
    // A caller passing retainDays:0 + retainLast:0 must NOT delete a 1-day-old,
    // within-registry archive — the registry values are a floor.
    const report = pruneArchives({
      archiveRoot: root,
      retainDays: 0,
      retainLastAttemptsPerIssue: 0,
    });
    const only = join(issueDir, "only.tar.gz");
    expect(report.deleted).not.toContain(only);
    expect(existsSync(only)).toBe(true);
  });

  it("an INDETERMINATE prior archive (no valid sidecar) is NEVER deleted — routes to reconciliation (round-6 finding 1)", async () => {
    const root = tempDir();
    const issueDir = join(root, "i");
    mkdirSync(issueDir, { recursive: true });
    // A prior run wrote the archive but has no valid sidecar — its LEDGER state
    // is unknown, so it must NOT be auto-deleted or redone (it may be
    // ledger-referenced): route to reconciliation, archive preserved.
    writeFileSync(join(issueDir, "a.tar.gz"), "possibly-ledger-referenced");
    const before = readFileSync(join(issueDir, "a.tar.gz"), "utf8");
    let ledgerCalls = 0;
    await expect(
      archiveAttempt({
        workspaceDir: makeWorkspace(),
        archiveRoot: root,
        issueId: "i",
        attemptId: "a",
        recordLedgerRow: () => {
          ledgerCalls += 1;
        },
      }),
    ).rejects.toMatchObject({ stage: "archive-write" });
    expect(readFileSync(join(issueDir, "a.tar.gz"), "utf8")).toBe(before); // untouched — never deleted
    expect(ledgerCalls).toBe(0); // never re-recorded a possibly-existing row
  });

  it("a ledger-row failure leaves NO valid sidecar, so a re-invocation routes to reconciliation, never a blind redo (round-6 finding 1)", async () => {
    const root = tempDir();
    // First call: ledger fails AFTER the archive is written.
    await expect(
      archiveAttempt({
        workspaceDir: makeWorkspace(),
        archiveRoot: root,
        issueId: "i",
        attemptId: "a",
        recordLedgerRow: () => {
          throw new Error("ledger store down");
        },
      }),
    ).rejects.toMatchObject({ stage: "ledger-row" });
    expect(existsSync(join(root, "i", "a.tar.gz"))).toBe(true);
    expect(existsSync(join(root, "i", "a.json"))).toBe(false);
    const shaBefore = readFileSync(join(root, "i", "a.tar.gz"));
    // Re-invocation: it does NOT delete/redo the possibly-referenced archive —
    // it routes to reconciliation (the janitor can query the ledger).
    let calls = 0;
    await expect(
      archiveAttempt({
        workspaceDir: makeWorkspace(),
        archiveRoot: root,
        issueId: "i",
        attemptId: "a",
        recordLedgerRow: () => {
          calls += 1;
        },
      }),
    ).rejects.toMatchObject({ stage: "archive-write" });
    expect(readFileSync(join(root, "i", "a.tar.gz"))).toEqual(shaBefore); // untouched
    expect(calls).toBe(0);
  });

  it("RESUMES a destroy when the sidecar is valid and the SAME-inode workspace still exists (round-6 finding 1; round-11 finding 3)", async () => {
    const root = tempDir();
    const ws = makeWorkspace();
    // Model a GENUINE destroy failure (not a rm+recreate, which would be a
    // different inode): make the workspace un-deletable so the first archival
    // writes the archive + valid sidecar but the destroy throws, leaving the
    // SAME-inode workspace in place — the real resume state.
    chmodSync(ws, 0o500); // r-x, no write → cannot unlink contents
    await expect(
      archiveAttempt({
        workspaceDir: ws,
        archiveRoot: root,
        issueId: "i",
        attemptId: "a",
        recordLedgerRow: () => {},
      }),
    ).rejects.toMatchObject({ name: "ArchivalError", stage: "workspace-destroy" });
    expect(existsSync(ws)).toBe(true); // destroy failed; the SAME inode remains
    chmodSync(ws, 0o700); // restore so the resume can delete
    let calls = 0;
    const record = await archiveAttempt({
      workspaceDir: ws,
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      recordLedgerRow: () => {
        calls += 1;
      },
    });
    expect(existsSync(ws)).toBe(false); // resume destroyed the SAME-inode workspace
    expect(record.archivePath).toBe(join(root, "i", "a.tar.gz"));
    expect(calls).toBe(0); // ledger NOT re-recorded on resume
  });

  it("archives a workspace of sockets — tar WARNS (nonzero stderr) but exits 0, and stderr volume must not fail a valid archive (round-14 finding 5)", async () => {
    const ws = makeWorkspace();
    const root = tempDir();
    // Plant UNIX-domain sockets: tar cannot pack them, so it emits a warning per
    // entry to stderr yet still EXITS 0 with a valid archive. The old execFile path
    // aborted tar once that stderr passed maxBuffer, refusing a good archive; spawn
    // + exit-code success (never stderr volume) must archive normally. (30 keeps the
    // test within any fd limit; the >1 MiB stderr case is covered by the review
    // receipt — the point here is that exit-0-with-warnings is a SUCCESS.)
    const servers: ReturnType<typeof createServer>[] = [];
    for (let i = 0; i < 30; i++) {
      const s = createServer();
      await new Promise<void>((res) => s.listen(join(ws, `sock-${i}.sock`), () => res()));
      servers.push(s);
    }
    try {
      let recorded = false;
      const record = await archiveAttempt({
        workspaceDir: ws,
        archiveRoot: root,
        issueId: "i",
        attemptId: "a",
        recordLedgerRow: () => {
          recorded = true;
        },
      });
      expect(recorded).toBe(true); // ledger row written — the archive succeeded
      expect(existsSync(record.archivePath)).toBe(true);
      expect(existsSync(ws)).toBe(false); // archived AND destroyed, not refused
    } finally {
      for (const s of servers) s.close();
    }
  });

  it("refuses archival of a workspace whose ENTRY count exceeds the cap — empty files evade the byte quota (round-17 finding 1)", async () => {
    const ws = tempDir();
    // 200 EMPTY files: ~0 quota bytes, but 200 entries > the injected 50-entry cap.
    // The byte quota (huge here) would let this through; the cardinality bound must
    // refuse it so a worker cannot impose unbounded post-worker archival work.
    for (let i = 0; i < 200; i++) writeFileSync(join(ws, `f${i}.txt`), "");
    const root = tempDir();
    const err = await archiveAttempt({
      workspaceDir: ws,
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      quotas: {
        workspaceMaxBytes: 1_000_000_000,
        archiveMaxCompressedBytes: 1_000_000_000,
        maxWorkspaceEntries: 50,
      },
      recordLedgerRow: () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchivalError);
    expect((err as ArchivalError).stage).toBe("workspace-quota");
    expect((err as Error).message).toMatch(/exceeds 50 entries/i);
    expect(existsSync(ws)).toBe(true); // retained for escalation, never archived/destroyed
  });

  it("refuses an over-cap archive DURING the write, not after, and cleans the partial (round-15 finding 6)", async () => {
    const ws = makeWorkspace();
    // Incompressible content larger than a tiny cap: tar's gzip output crosses the
    // cap mid-stream, so it must be aborted then — not written whole and refused
    // after (which let a worker balloon the on-disk archive toward the 2 GB ceiling).
    writeFileSync(join(ws, "big.bin"), incompressible(2 * 1024 * 1024));
    const root = tempDir();
    const err = await archiveAttempt({
      workspaceDir: ws,
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      quotas: { workspaceMaxBytes: 1_000_000_000, archiveMaxCompressedBytes: 64 * 1024 }, // 64 KiB
      recordLedgerRow: () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchivalError);
    expect((err as ArchivalError).stage).toBe("archive-quota");
    expect((err as Error).message).toMatch(/during write/i);
    expect(existsSync(ws)).toBe(true); // workspace retained for escalation
    // No orphan .partial left behind.
    const leftover = readdirSync(join(root, "i")).filter((f) => f.includes("partial"));
    expect(leftover).toEqual([]);
  });

  it("a resume REFUSES a workspace RECREATED at the same pathname (different inode) — round-11 finding 3", async () => {
    const root = tempDir();
    const ws = makeWorkspace();
    await archiveAttempt({
      workspaceDir: ws,
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      recordLedgerRow: () => {},
    });
    expect(existsSync(ws)).toBe(false); // normal destroy
    // Recreate an UNRELATED directory at the same pathname (a DIFFERENT inode).
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "victim.txt"), "must-not-be-deleted\n");
    const err = await archiveAttempt({
      workspaceDir: ws,
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      recordLedgerRow: () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchivalError);
    expect((err as Error).message).toMatch(/replaced|inode changed/i);
    expect(existsSync(join(ws, "victim.txt"))).toBe(true); // the recreated dir is untouched
  });

  it("a re-invocation with a DIFFERENT workspace does NOT destroy the recorded one (round-7 finding 1)", async () => {
    const root = tempDir();
    const wsA = makeWorkspace();
    await archiveAttempt({
      workspaceDir: wsA,
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      recordLedgerRow: () => {},
    });
    // Recreate A to model a failed destroy of the RECORDED workspace.
    mkdirSync(wsA, { recursive: true });
    writeFileSync(join(wsA, "recorded-leftover"), "keep-me");
    // Re-invoke the SAME attempt but with a DIFFERENT workspace B.
    const wsB = makeWorkspace();
    let calls = 0;
    await expect(
      archiveAttempt({
        workspaceDir: wsB,
        archiveRoot: root,
        issueId: "i",
        attemptId: "a",
        recordLedgerRow: () => {
          calls += 1;
        },
      }),
    ).rejects.toMatchObject({ stage: "archive-write" });
    // NEITHER workspace was touched (the recorded A is not destroyed; B is not either).
    expect(existsSync(wsA)).toBe(true);
    expect(existsSync(join(wsA, "recorded-leftover"))).toBe(true);
    expect(existsSync(wsB)).toBe(true);
    expect(calls).toBe(0);
    rmSync(wsA, { recursive: true, force: true });
    rmSync(wsB, { recursive: true, force: true });
  });

  it("stages an initial issue-dir mkdir failure, not a raw error (round-6 finding 3)", async () => {
    const root = tempDir();
    chmodSync(root, 0o555); // non-writable: the issue-dir mkdir will EACCES
    try {
      const err = await archiveAttempt({
        workspaceDir: makeWorkspace(),
        archiveRoot: root,
        issueId: "i",
        attemptId: "a",
        recordLedgerRow: () => {},
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ArchivalError);
      expect((err as ArchivalError).stage).toBe("archive-write");
    } finally {
      chmodSync(root, 0o755);
    }
  });

  it("a COMPLETE prior archive (valid sidecar, workspace gone) still refuses a second call", async () => {
    const root = tempDir();
    await archiveAttempt({
      workspaceDir: makeWorkspace(),
      archiveRoot: root,
      issueId: "i",
      attemptId: "a",
      recordLedgerRow: () => {},
    });
    await expect(
      archiveAttempt({
        workspaceDir: makeWorkspace(),
        archiveRoot: root,
        issueId: "i",
        attemptId: "a",
        recordLedgerRow: () => {},
      }),
    ).rejects.toMatchObject({ stage: "archive-write" });
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

  it("refuses a SYMLINK archiveRoot that resolves into the workspace (round-2 finding 3)", async () => {
    const ws = makeWorkspace();
    const base = tempDir();
    const inside = join(ws, "archives");
    mkdirSync(inside, { recursive: true });
    const linkedRoot = join(base, "root-link");
    symlinkSync(inside, linkedRoot); // symlink whose target is inside the workspace
    await expect(
      archiveAttempt({
        workspaceDir: ws,
        archiveRoot: linkedRoot,
        issueId: "i",
        attemptId: "a",
        recordLedgerRow: () => {},
      }),
    ).rejects.toMatchObject({ stage: "id-validation" });
    expect(existsSync(ws)).toBe(true);
  });

  it("uses the caller's AUTHORITATIVE attemptSeq when provided (round-2 finding 6)", async () => {
    const root = tempDir();
    await archiveAttempt({
      workspaceDir: makeWorkspace(),
      archiveRoot: root,
      issueId: "iss",
      attemptId: "att",
      attemptSeq: 42,
      recordLedgerRow: () => {},
    });
    const sidecar = JSON.parse(
      readFileSync(join(root, "iss", "att.json"), "utf8"),
    ) as ArchiveSidecar;
    expect(sidecar.seq).toBe(42);
    // A non-safe-integer / negative attemptSeq is refused.
    await expect(
      archiveAttempt({
        workspaceDir: makeWorkspace(),
        archiveRoot: root,
        issueId: "iss",
        attemptId: "att2",
        attemptSeq: -1,
        recordLedgerRow: () => {},
      }),
    ).rejects.toMatchObject({ stage: "id-validation" });
  });

  it("validates attemptSeq BEFORE writing — no orphan archive on refusal (round-3 finding 8)", async () => {
    const root = tempDir();
    await expect(
      archiveAttempt({
        workspaceDir: makeWorkspace(),
        archiveRoot: root,
        issueId: "iss",
        attemptId: "att",
        attemptSeq: 1.5, // invalid
        recordLedgerRow: () => {},
      }),
    ).rejects.toMatchObject({ stage: "id-validation" });
    // No orphan archive was left, so a corrected retry succeeds.
    expect(existsSync(join(root, "iss", "att.tar.gz"))).toBe(false);
    await expect(
      archiveAttempt({
        workspaceDir: makeWorkspace(),
        archiveRoot: root,
        issueId: "iss",
        attemptId: "att",
        attemptSeq: 3,
        recordLedgerRow: () => {},
      }),
    ).resolves.toBeDefined();
  });

  it("refuses a DUPLICATE authoritative attemptSeq for one issue (round-3 finding 8)", async () => {
    const root = tempDir();
    await archiveAttempt({
      workspaceDir: makeWorkspace(),
      archiveRoot: root,
      issueId: "iss",
      attemptId: "a1",
      attemptSeq: 5,
      recordLedgerRow: () => {},
    });
    await expect(
      archiveAttempt({
        workspaceDir: makeWorkspace(),
        archiveRoot: root,
        issueId: "iss",
        attemptId: "a2",
        attemptSeq: 5, // duplicate ordinal
        recordLedgerRow: () => {},
      }),
    ).rejects.toMatchObject({ stage: "id-validation" });
    expect(existsSync(join(root, "iss", "a2.tar.gz"))).toBe(false); // no orphan
  });

  it("rejects an archive OUTPUT dir (archiveRoot/issueId) that symlinks into the workspace (round-3 finding 2)", async () => {
    const ws = makeWorkspace();
    const root = tempDir();
    // Pre-create archiveRoot/issueId as a symlink INTO the workspace.
    mkdirSync(join(ws, "sink"), { recursive: true });
    symlinkSync(join(ws, "sink"), join(root, "iss"));
    await expect(
      archiveAttempt({
        workspaceDir: ws,
        archiveRoot: root,
        issueId: "iss",
        attemptId: "a",
        recordLedgerRow: () => {},
      }),
    ).rejects.toMatchObject({ stage: "id-validation" });
    expect(existsSync(ws)).toBe(true);
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
    const agedAt = new Date(NOW - ageDays * DAY);
    // A REAL old archive has an old FILE mtime, not just an old sidecar claim.
    // The pruner floors age with the file mtime (round-10 finding 11), so the
    // fixture must set it too — else a "200-day-old" archive written just now
    // would read as fresh and never prune.
    utimesSync(archivePath, agedAt, agedAt);
    const sidecar: ArchiveSidecar = {
      issueId,
      attemptId,
      workspacePath: `/tmp/seeded-ws/${attemptId}`,
      archiveWrittenAt: agedAt.toISOString(),
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

  it("treats a corrupt/overflowed seq as undatable — never deletes it (round-2 finding 6)", () => {
    const root = tempDir();
    const issueDir = join(root, "issue-corrupt");
    mkdirSync(issueDir, { recursive: true });
    // A sidecar with a non-safe-integer seq cannot be ordered → undatable.
    writeFileSync(join(issueDir, "bad.tar.gz"), "bytes");
    writeFileSync(
      join(issueDir, "bad.json"),
      // A seq beyond MAX_SAFE_INTEGER, written as raw JSON so no JS number
      // literal loses precision at parse-authoring time.
      '{"issueId":"issue-corrupt","attemptId":"bad","archiveWrittenAt":"' +
        new Date(NOW - 200 * DAY).toISOString() +
        '","seq":9007199254740993}',
    );
    for (let i = 0; i < 11; i++) seedArchive(root, "issue-corrupt", `a-${i}`, 95 + i, 100 + i);
    const report = pruneArchives({ archiveRoot: root, now: nowFn });
    expect(report.undatable).toContain(join(issueDir, "bad.tar.gz"));
    expect(existsSync(join(issueDir, "bad.tar.gz"))).toBe(true);
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
