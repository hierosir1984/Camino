import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ESLINT = join("node_modules", ".bin", "eslint");
const CORE_SRC = join("packages", "core", "src");

function eslintExitCode(file: string): number {
  try {
    execFileSync(ESLINT, [file], { stdio: "pipe" });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
}

/**
 * Boundary-rule fixtures (WP-000 acceptance, hardened per the WP-000
 * cross-provider review): every known bypass class of the pure-core fence
 * must fail lint — static builtins, subpath builtins, dynamic import(),
 * createRequire via "module", relative cross-package escapes, and non-.ts
 * extensions under core. The fence is enforcement, not documentation.
 */
const BYPASS_PROBES: Array<{ name: string; file: string; source: string }> = [
  {
    name: "static node:fs import",
    file: "__fence_trip__static.ts",
    source: 'import { readFileSync } from "node:fs";\nexport const leak = readFileSync;\n',
  },
  {
    name: "static fs/promises subpath import",
    file: "__fence_trip__subpath.ts",
    source: 'import { readFile } from "fs/promises";\nexport const leak = readFile;\n',
  },
  {
    name: "dynamic import()",
    file: "__fence_trip__dynamic.ts",
    source: 'export async function leak() {\n  return import("node:fs");\n}\n',
  },
  {
    name: "createRequire via module",
    file: "__fence_trip__createrequire.ts",
    source:
      'import { createRequire } from "module";\nexport const leak = createRequire(import.meta.url)("fs");\n',
  },
  {
    name: "relative escape into daemon",
    file: "__fence_trip__relative.ts",
    source:
      'import { BIND_HOST } from "../../daemon/src/config.js";\nexport const leak = BIND_HOST;\n',
  },
  {
    name: "plain .mjs file under core",
    file: "__fence_trip__ext.mjs",
    source: 'import { readFileSync } from "node:fs";\nexport const leak = readFileSync;\n',
  },
  {
    name: "un-denylisted builtin (events) — allowlist catches it",
    file: "__fence_trip__events.ts",
    source: 'import { EventEmitter } from "events";\nexport const leak = EventEmitter;\n',
  },
  {
    name: "arbitrary npm package name",
    file: "__fence_trip__npm.ts",
    source: 'import anything from "left-pad";\nexport const leak = anything;\n',
  },
  {
    name: ".jsx file under core",
    file: "__fence_trip__ext2.jsx",
    source: 'import { readFileSync } from "node:fs";\nexport const leak = readFileSync;\n',
  },
  {
    name: "process.getBuiltinModule without any import",
    file: "__fence_trip__getbuiltin.ts",
    source: 'export const leak = globalThis.process.getBuiltinModule("fs");\n',
  },
  {
    name: "bare process global access",
    file: "__fence_trip__process.ts",
    source: "export const leak = process.env;\n",
  },
  {
    name: "require() call in .cjs under core",
    file: "__fence_trip__req.cjs",
    source: 'const fs = require("fs");\nmodule.exports = fs;\n',
  },
];

describe("packages/core import fence", () => {
  afterEach(() => {
    for (const probe of BYPASS_PROBES) {
      rmSync(join(CORE_SRC, probe.file), { force: true });
    }
  });

  for (const probe of BYPASS_PROBES) {
    it(`rejects: ${probe.name}`, () => {
      const path = join(CORE_SRC, probe.file);
      writeFileSync(path, probe.source);
      expect(eslintExitCode(path), `${probe.name} must fail lint`).not.toBe(0);
    });
  }

  it("accepts the real core sources", () => {
    expect(eslintExitCode(join(CORE_SRC, "exhaustive.ts"))).toBe(0);
    expect(eslintExitCode(join(CORE_SRC, "index.ts"))).toBe(0);
  });
});
