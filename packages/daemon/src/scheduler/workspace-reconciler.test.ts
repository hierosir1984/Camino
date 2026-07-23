/**
 * Retained-workspace reconciliation tests (WP-114; the WP-107 handoff):
 * the reconciler queries the DURABLE ledger, resumes/completes/escalates,
 * honors lease generations, and never destroys on a pathname alone.
 */
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "../event-store.js";
import { TransitionRecorder } from "../transition-recorder.js";
import { ArchiveLedgerStore } from "./archive-ledger.js";
import { SqliteLeaseStore } from "./lease-store.js";
import { reconcileRetainedWorkspace } from "./workspace-reconciler.js";
import type { RetainedWorkspaceRef } from "./workspace-reconciler.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const ISSUE = "m1.I1";
const ATTEMPT = "m1.I1.a1";
const ENV = "validation:r1";

interface World {
  dir: string;
  workspaceDir: string;
  archiveRoot: string;
  events: SqliteEventStore;
  recorder: TransitionRecorder;
  leases: SqliteLeaseStore;
  ledger: ArchiveLedgerStore;
  ref: RetainedWorkspaceRef;
}

function newWorld(): World {
  const dir = mkdtempSync(join(tmpdir(), "camino-reconcile-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const workspaceDir = join(dir, "workspace");
  mkdirSync(workspaceDir);
  writeFileSync(join(workspaceDir, "artifact.txt"), "worker output\n");
  const archiveRoot = join(dir, "archives");
  mkdirSync(archiveRoot);
  const events = new SqliteEventStore(join(dir, "events.sqlite"));
  const leases = new SqliteLeaseStore(join(dir, "leases.sqlite"), { writerLock: null });
  const ledger = new ArchiveLedgerStore(join(dir, "archive-ledger.sqlite"), { writerLock: null });
  cleanups.push(() => {
    ledger.close();
    leases.close();
    events.close();
  });
  const recorder = new TransitionRecorder(events);
  return {
    dir,
    workspaceDir,
    archiveRoot,
    events,
    recorder,
    leases,
    ledger,
    ref: {
      issueId: ISSUE,
      attemptId: ATTEMPT,
      workspaceDir,
      environmentId: ENV,
      attemptSeq: 1,
    },
  };
}

function record(w: World, event: string, payload: Record<string, unknown>): void {
  const outcome = w.recorder.record({
    entityKind: "attempt",
    entityId: ATTEMPT,
    event,
    actor: "camino:test",
    cause: `fixture ${event}`,
    payload,
  });
  if (!outcome.ok) throw new Error(`fixture ${event} refused: ${outcome.code}`);
}

function driveAttemptTo(w: World, terminal: "failed" | "running" | "archived-mismatch"): void {
  record(w, "attempt-dispatched", {
    leaseGranted: true,
    leaseGeneration: 1,
    contractRef: { issueId: ISSUE, contractVersion: 1, contractHash: "a".repeat(64) },
  });
  if (terminal === "running") return;
  record(w, "worker-completed", { finalHeadFetched: true });
  record(w, "verdict-recorded", {
    quarantineAndValidationComplete: true,
    verdict: "fail",
    failureClass: "requirement-failed",
  });
}

function deps(w: World) {
  return {
    recorder: w.recorder,
    leases: w.leases,
    ledger: w.ledger,
    archiveRoot: w.archiveRoot,
  };
}

describe("reconcileRetainedWorkspace", () => {
  it("defers while the environment lease is HELD (the janitor honors generations)", async () => {
    const w = newWorld();
    driveAttemptTo(w, "failed");
    w.leases.grant(ENV, "someone.else.a1");
    const outcome = await reconcileRetainedWorkspace(w.ref, deps(w));
    expect(outcome).toMatchObject({
      kind: "deferred-lease-held",
      holderAttemptId: "someone.else.a1",
    });
    expect(existsSync(w.workspaceDir)).toBe(true);
  });

  it("defers while the attempt is still ACTIVE (a live workspace is not retained)", async () => {
    const w = newWorld();
    driveAttemptTo(w, "running");
    const outcome = await reconcileRetainedWorkspace(w.ref, deps(w));
    expect(outcome).toMatchObject({ kind: "deferred-attempt-active", attemptState: "running" });
  });

  it("escalates a workspace with NO durable attempt record (foreign state)", async () => {
    const w = newWorld();
    const outcome = await reconcileRetainedWorkspace(w.ref, deps(w));
    expect(outcome).toMatchObject({ kind: "escalated" });
    expect(existsSync(w.workspaceDir)).toBe(true);
  });

  it("COMPLETES a terminal attempt's retained archival: ledger row + A.3#8 + destroy", async () => {
    const w = newWorld();
    driveAttemptTo(w, "failed");
    // A released lease (settled dispatch): reconciliation may proceed.
    w.leases.grant(ENV, ATTEMPT);
    w.leases.release(ENV, 1, { groupGone: true, outcome: "requirement-failed" });
    const outcome = await reconcileRetainedWorkspace(w.ref, deps(w));
    expect(outcome.kind).toBe("archived");
    if (outcome.kind !== "archived") return;
    expect(existsSync(outcome.archivePath)).toBe(true);
    expect(existsSync(w.workspaceDir)).toBe(false);
    expect(w.ledger.get(ISSUE, ATTEMPT)?.archivePath).toBe(outcome.archivePath);
    expect(w.recorder.currentState("attempt", ATTEMPT)).toBe("archived");
    // Exactly once: a second pass finds the durable record disagreeing
    // with a missing workspace only if someone recreates it — with the
    // workspace gone the caller has nothing to hand the reconciler.
  });

  it("escalates (never destroys) an over-quota workspace, with the staged reason", async () => {
    const w = newWorld();
    driveAttemptTo(w, "failed");
    writeFileSync(join(w.workspaceDir, "big.bin"), Buffer.alloc(64 * 1024, 7));
    const outcome = await reconcileRetainedWorkspace(w.ref, {
      ...deps(w),
      quotas: {
        workspaceMaxBytes: 1024,
        archiveMaxCompressedBytes: 1024 * 1024,
      },
    });
    expect(outcome).toMatchObject({ kind: "escalated", stage: "workspace-quota" });
    expect(existsSync(w.workspaceDir)).toBe(true);
    expect(w.recorder.currentState("attempt", ATTEMPT)).toBe("failed");
  });

  it("escalates an archived-but-present inconsistency instead of cleaning it up", async () => {
    const w = newWorld();
    driveAttemptTo(w, "failed");
    // Complete a real archival (destroys the workspace), then recreate a
    // directory at the same path — durable record now says archived while
    // the filesystem holds something again.
    const first = await reconcileRetainedWorkspace(w.ref, deps(w));
    expect(first.kind).toBe("archived");
    mkdirSync(w.workspaceDir);
    writeFileSync(join(w.workspaceDir, "impostor.txt"), "not the workspace\n");
    const outcome = await reconcileRetainedWorkspace(w.ref, deps(w));
    expect(outcome).toMatchObject({ kind: "escalated" });
    expect(existsSync(w.workspaceDir)).toBe(true);
  });
});
