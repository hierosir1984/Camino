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
  // The two vectors surfaced by the WP-000 post-merge audit:
  {
    name: "eval-based require (audit vector)",
    file: "__fence_trip__eval.ts",
    source: 'export const leak = eval("require")("node:fs");\n',
  },
  {
    name: "computed globalThis[process][getBuiltinModule] (audit vector)",
    file: "__fence_trip__computed.ts",
    source: 'const g = globalThis["process"];\nexport const leak = g["getBuiltinModule"]("fs");\n',
  },
  // WP-101 acceptance names persistence and sibling packages explicitly:
  // core must never reach the event store's driver or the daemon.
  {
    name: "better-sqlite3 import (WP-101 acceptance vector)",
    file: "__fence_trip__sqlite.ts",
    source: 'import Database from "better-sqlite3";\nexport const leak = Database;\n',
  },
  {
    name: "@camino/daemon package import (WP-101 acceptance vector)",
    file: "__fence_trip__daemon_pkg.ts",
    source:
      'import { SqliteEventStore } from "@camino/daemon";\nexport const leak = SqliteEventStore;\n',
  },
  // Gap classes surfaced by the WP-101 review round 1: ambient I/O globals
  // reachable with zero imports, and parent-traversal relative escapes.
  {
    name: "ambient fetch global (no import at all)",
    file: "__fence_trip__fetch.ts",
    source: 'export const leak = fetch("https://example.invalid");\n',
  },
  {
    name: "ambient WebSocket global",
    file: "__fence_trip__websocket.ts",
    source: 'export const leak = new WebSocket("wss://example.invalid");\n',
  },
  {
    name: "ambient timer scheduling",
    file: "__fence_trip__timer.ts",
    source: "export const leak = setTimeout(() => {}, 1);\n",
  },
  {
    name: "relative parent-traversal into shared sources",
    file: "__fence_trip__parent.ts",
    source:
      'import { isRequirementId } from "../../shared/src/requirement-id.js";\nexport const leak = isRequirementId;\n',
  },
  {
    name: "any parent traversal at all (core/src is flat by policy)",
    file: "__fence_trip__updir.ts",
    source: 'import { anything } from "../vitest.config.js";\nexport const leak = anything;\n',
  },
  {
    name: "dot-prefixed parent traversal (./../ spelling)",
    file: "__fence_trip__dotupdir.ts",
    source: 'import { anything } from "./../vitest.config.js";\nexport const leak = anything;\n',
  },
  // Round-3 vectors: aliasing the global object defeats member-expression
  // selectors, so the identifier itself is banned.
  {
    name: "globalThis alias then property I/O",
    file: "__fence_trip__galias.ts",
    source: 'const g = globalThis;\nexport const leak = g.fetch("https://example.invalid");\n',
  },
  {
    name: "destructuring fetch out of globalThis",
    file: "__fence_trip__gdestructure.ts",
    source: 'const { fetch: f } = globalThis;\nexport const leak = f("https://example.invalid");\n',
  },
  {
    name: "globalThis.globalThis chain",
    file: "__fence_trip__gchain.ts",
    source: 'export const leak = globalThis.globalThis.fetch("https://example.invalid");\n',
  },
  {
    name: "type-level import() of a banned module (review r4 vector)",
    file: "__fence_trip__typeimport.ts",
    source: 'export type FilesystemLeak = import("node:fs").Stats;\n',
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

  it("accepts the real core sources (whole directory, so new files stay covered)", () => {
    expect(eslintExitCode(CORE_SRC)).toBe(0);
  });
});
