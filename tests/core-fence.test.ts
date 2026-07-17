import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ESLINT = join("node_modules", ".bin", "eslint");
const TRIP_FILE = join("packages", "core", "src", "__fence_trip__.ts");

function eslintExitCode(file: string): number {
  try {
    execFileSync(ESLINT, [file], { stdio: "pipe" });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
}

/**
 * Boundary-rule fixture (WP-000 acceptance): prove the pure-core import fence
 * actually trips. A file inside packages/core importing a Node builtin must
 * fail lint; the fence is enforcement, not documentation.
 */
describe("packages/core import fence", () => {
  it("rejects a Node I/O import inside core", () => {
    writeFileSync(
      TRIP_FILE,
      'import { readFileSync } from "node:fs";\nexport const leak = readFileSync;\n',
    );
    try {
      expect(eslintExitCode(TRIP_FILE)).not.toBe(0);
    } finally {
      rmSync(TRIP_FILE, { force: true });
    }
  });

  it("accepts the real core sources", () => {
    expect(eslintExitCode(join("packages", "core", "src", "exhaustive.ts"))).toBe(0);
  });
});
