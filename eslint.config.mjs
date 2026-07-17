// Flat ESLint config. The load-bearing rule is the packages/core purity fence
// (build-plan §1.1 boundary rule, enforced per WP-000/WP-101 acceptance):
// core may import only @camino/shared — no Node builtins, no persistence,
// no other Camino packages, in ANY module syntax (static import, dynamic
// import(), require/createRequire) and ANY file extension living under core.
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
  "module",
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

// Relative-path escapes out of packages/core (e.g. "../../daemon/src/x.js")
// are caught by path segment, depth-independently.
const CAMINO_PACKAGE_ESCAPES = [
  "better-sqlite3",
  "@camino/daemon",
  "@camino/gui",
  "**/daemon/**",
  "**/gui/**",
  "**/node_modules/**",
];

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/*.d.ts", "fixtures/sample-repo-src/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/core/**/*.{ts,mts,cts,tsx,js,mjs,cjs}"],
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
              group: CAMINO_PACKAGE_ESCAPES,
              message:
                "packages/core may import only @camino/shared (boundary rule, build plan §1.1).",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message:
            "Dynamic import() is banned in packages/core — the purity fence must be statically checkable (build plan §1.1).",
        },
        {
          selector: "CallExpression[callee.name='require']",
          message: "require() is banned in packages/core (purity fence, build plan §1.1).",
        },
        {
          selector: "CallExpression[callee.name='createRequire']",
          message: "createRequire() is banned in packages/core (purity fence, build plan §1.1).",
        },
        {
          selector: "TSExternalModuleReference",
          message:
            "import-require syntax is banned in packages/core (purity fence, build plan §1.1).",
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
