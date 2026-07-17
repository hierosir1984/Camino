// Flat ESLint config. The load-bearing rule is the packages/core purity fence
// (build-plan §1.1 boundary rule, enforced per WP-000/WP-101 acceptance).
//
// The fence is an ALLOWLIST by construction over packages/core/src: a specifier
// is permitted only if it is core-internal-relative or @camino/shared (tests may
// also import vitest). Everything else — Node builtins in any spelling, npm
// packages, other Camino packages — is banned, in any module syntax (static
// import, dynamic import(), require/createRequire/getBuiltinModule) and any file
// extension. Residual risk (computed global access, eval) is lint-invisible by
// nature; WP-101 may add deeper enforcement.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Matches (= restricts) any specifier that does NOT start with ./ or ../ and is
// NOT @camino/shared (or a subpath). Negative lookahead = allowlist.
const CORE_ALLOWLIST_REGEX = "^(?!(\\.{1,2}(/|$)|@camino/shared(/|$))).*";
// Test files may additionally import vitest.
const CORE_TEST_ALLOWLIST_REGEX = "^(?!(\\.{1,2}(/|$)|@camino/shared(/|$)|vitest(/|$))).*";

// Relative-path escapes out of packages/core (e.g. "../../daemon/src/x.js")
// are caught by path segment, depth-independently.
const CAMINO_PACKAGE_ESCAPES = ["**/daemon/**", "**/gui/**", "**/node_modules/**"];

const CORE_SYNTAX_BANS = [
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
    message: "import-require syntax is banned in packages/core (purity fence, build plan §1.1).",
  },
  {
    selector: "MemberExpression[property.name='getBuiltinModule']",
    message:
      "process.getBuiltinModule() is banned in packages/core (purity fence, build plan §1.1).",
  },
  {
    selector: "MemberExpression[object.name='globalThis'][property.name='process']",
    message: "globalThis.process is banned in packages/core (purity fence, build plan §1.1).",
  },
];

function coreFence({ files, allowRegex }) {
  return {
    files,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: allowRegex,
              message:
                "packages/core may import only its own modules and @camino/shared (boundary rule, build plan §1.1).",
            },
            {
              group: CAMINO_PACKAGE_ESCAPES,
              message:
                "packages/core may not reach other Camino packages, by any path (boundary rule, build plan §1.1).",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "process",
          message: "packages/core is pure — no process access (purity fence, build plan §1.1).",
        },
      ],
      "no-restricted-syntax": ["error", ...CORE_SYNTAX_BANS],
    },
  };
}

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/*.d.ts", "fixtures/sample-repo-src/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  coreFence({
    files: ["packages/core/src/**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}"],
    allowRegex: CORE_ALLOWLIST_REGEX,
  }),
  // Test files inside core keep the full fence but may import vitest.
  coreFence({
    files: ["packages/core/src/**/*.test.{ts,mts,cts,tsx}"],
    allowRegex: CORE_TEST_ALLOWLIST_REGEX,
  }),
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
