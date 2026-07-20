/**
 * The daemon's public barrel carries no runtime-mutable enforcement policy.
 *
 * Same threat model and the same two mechanisms as the @camino/shared twin
 * (see packages/shared/src/barrel-immutability.test.ts for the full statement,
 * including why freezing a RegExp is insufficient and what this does NOT
 * close). Two of the daemon's exports are load-bearing enough to get an
 * end-to-end regression rather than an `Object.isFrozen` assertion alone:
 *
 *   STATE_FILES.writerLock         selects the file whose kernel lock IS the
 *                                  single-writer guarantee (CAM-STATE-04).
 *                                  Retargeting it between two openRecoveredState
 *                                  calls produced TWO recovered-state owners
 *                                  over one state directory — each locking a
 *                                  different file, neither fencing the other.
 *   INTAKE_ACCEPTED_EXTENSIONS     the CAM-CORE-02 attachment allowlist;
 *                                  adding a key widened what intake accepts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as barrel from "./index.js";
import { INTAKE_ACCEPTED_EXTENSIONS, STATE_FILES, openRecoveredState } from "./index.js";
import type { QueryTransports } from "./recovery.js";

type Entry = readonly [string, unknown];
const entries: readonly Entry[] = Object.entries(barrel);

let dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-barrel-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** Reconciliation never runs in these tests (the journals open empty). */
const NO_QUERIES: QueryTransports = {
  github: {
    getRef: () => null,
    observeRef: () => ({ refSha: null, atOrPastAncestor: false }),
    findPullRequestsByHead: () => [],
    isLabelPresent: () => false,
    findCommentsByMarker: () => [],
    findWorkflowRunsByCorrelation: () => [],
  },
};

describe("@camino/daemon public barrel immutability", () => {
  it("exports enough to make the sweep non-vacuous", () => {
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.filter(([, v]) => typeof v === "object" && v !== null).length).toBeGreaterThan(
      1,
    );
  });

  it("exports no live RegExp (compile() would rewrite the grammar in place)", () => {
    expect(entries.filter(([, v]) => v instanceof RegExp).map(([k]) => k)).toEqual([]);
  });

  it("freezes every exported object and array", () => {
    const unfrozen = entries
      .filter(([, v]) => typeof v === "object" && v !== null && !Object.isFrozen(v))
      .map(([k]) => k);
    expect(unfrozen).toEqual([]);
  });

  it("refuses writes to STATE_FILES and the intake allowlist (ESM strict mode)", () => {
    expect(() => ((STATE_FILES as unknown as Record<string, string>)["writerLock"] = "x")).toThrow(
      TypeError,
    );
    expect(
      () => ((INTAKE_ACCEPTED_EXTENSIONS as unknown as Record<string, string>)[".exe"] = "text"),
    ).toThrow(TypeError);
    expect(STATE_FILES.writerLock).toBe("writer-lock.sqlite");
    expect(INTAKE_ACCEPTED_EXTENSIONS[".exe"]).toBeUndefined();
    expect(INTAKE_ACCEPTED_EXTENSIONS[".md"]).toBe("markdown");
  });

  it("keeps one writer per state directory even under an attempted lock retarget", () => {
    const dir = tempDir();
    const first = openRecoveredState(dir, NO_QUERIES);
    try {
      // The reproduced bypass: retarget the lock file through the barrel, then
      // open again. The write must throw, and the second open must still be
      // fenced by the lock the first holder owns.
      expect(
        () => ((STATE_FILES as unknown as Record<string, string>)["writerLock"] = "two"),
      ).toThrow(TypeError);
      expect(() => openRecoveredState(dir, NO_QUERIES)).toThrow();
    } finally {
      first.close();
    }
    // With the first holder closed, a fresh open succeeds — the lock fenced,
    // it did not wedge the directory.
    const second = openRecoveredState(dir, NO_QUERIES);
    second.close();
  });
});
