import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Validatable-repo profile smoke test (WP-000): the committed seeded fixture
 * is materialized into a real git repository and inspected — so `npm test`
 * demonstrably exercises a fixture, not just unit code.
 */
describe("seeded sample-repo fixture", () => {
  it("materializes into a real git repo with the seed commit", () => {
    const repoPath = execFileSync("node", ["scripts/make-sample-repo.mjs"]).toString().trim();
    try {
      const log = execFileSync("git", ["-C", repoPath, "log", "--oneline"]).toString();
      expect(log).toMatch(/Seed sample repo \(WP-000 fixture\)/);

      const files = execFileSync("git", ["-C", repoPath, "ls-files"]).toString().trim().split("\n");
      expect(files).toContain("README.md");
      expect(files).toContain("hello.js");

      const head = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"]).toString().trim();
      expect(head).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
