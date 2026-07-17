// Flat ESLint config. The load-bearing rule is the packages/core purity fence
// (build-plan §1.1 boundary rule, enforced per WP-000/WP-101 acceptance):
// core may import only @camino/shared — no Node I/O builtins, no persistence,
// no other Camino packages.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const NODE_BUILTIN_PATTERNS = [
  "node:*",
  "fs",
  "fs/*",
  "net",
  "http",
  "https",
  "http2",
  "dgram",
  "dns",
  "tls",
  "child_process",
  "worker_threads",
  "cluster",
  "os",
  "path",
  "crypto",
  "stream",
  "stream/*",
  "process",
  "readline",
  "repl",
  "v8",
  "vm",
  "zlib",
  "inspector",
  "perf_hooks",
  "async_hooks",
  "tty",
  "url",
  "util",
];

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/*.d.ts", "fixtures/sample-repo-src/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: NODE_BUILTIN_PATTERNS,
              message:
                "packages/core is pure — no Node builtins or I/O (boundary rule, build plan §1.1).",
            },
            {
              group: ["better-sqlite3", "@camino/daemon", "@camino/gui"],
              message:
                "packages/core may import only @camino/shared (boundary rule, build plan §1.1).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
