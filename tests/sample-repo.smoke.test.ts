import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Validatable-repo profile smoke test (WP-000): the committed seeded fixture
 * is materialized into a real git repository, then CLONED and inspected —
 * so `npm test` demonstrably exercises a fixture through a real git
 * clone-and-inspect path, not just unit code.
 */
describe("seeded sample-repo fixture", () => {
  it("materializes, clones, and inspects the seed commit", () => {
    const repoPath = execFileSync("node", ["scripts/make-sample-repo.mjs"]).toString().trim();
    const clonePath = mkdtempSync(join(tmpdir(), "camino-sample-clone-"));
    try {
      execFileSync("git", ["clone", "--quiet", repoPath, join(clonePath, "clone")]);
      const cloned = join(clonePath, "clone");

      const log = execFileSync("git", ["-C", cloned, "log", "--oneline"]).toString();
      expect(log).toMatch(/Seed sample repo \(WP-000 fixture\)/);

      const files = execFileSync("git", ["-C", cloned, "ls-files"]).toString().trim().split("\n");
      expect(files).toContain("README.md");
      expect(files).toContain("hello.js");

      const head = execFileSync("git", ["-C", cloned, "rev-parse", "HEAD"]).toString().trim();
      expect(head).toMatch(/^[0-9a-f]{40}$/);

      const originHead = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"])
        .toString()
        .trim();
      expect(head).toBe(originHead);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
      rmSync(clonePath, { recursive: true, force: true });
    }
  });

  it("refuses to materialize into a non-empty target directory", () => {
    const dirty = mkdtempSync(join(tmpdir(), "camino-dirty-target-"));
    writeFileSync(join(dirty, "preexisting.txt"), "do not touch\n");
    try {
      expect(() =>
        execFileSync("node", ["scripts/make-sample-repo.mjs", dirty], { stdio: "pipe" }),
      ).toThrowError();
    } finally {
      rmSync(dirty, { recursive: true, force: true });
    }
  });
});
