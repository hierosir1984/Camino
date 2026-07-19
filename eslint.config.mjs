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

// Relative-path escapes out of packages/core: core/src is FLAT by policy, so
// every legitimate internal import is "./x.js" — ANY parent traversal ("../")
// leaves the fenced directory (or would, transitively) and is banned outright,
// alongside the named package roots for defense in depth. If core/src ever
// grows subdirectories, this rule must be revisited deliberately.
const CAMINO_PACKAGE_ESCAPES = [
  "../**",
  "./../**", // "./.." spelling of the same traversal
  "**/../**", // any ".." segment anywhere in the specifier
  "**/..",
  "**/daemon/**",
  "**/gui/**",
  "**/shared/src/**",
  "**/packages/**",
  "**/node_modules/**",
];

// Ambient I/O globals reachable with zero imports (review round 1, WP-101):
// network and scheduling primitives have no place in pure domain logic.
const CORE_RESTRICTED_GLOBALS = [
  { name: "process", message: "packages/core is pure — no process access (purity fence)." },
  // globalThis itself (and its aliases) is banned outright: pure domain
  // logic has no use for the global object, and every alias/destructuring
  // escape starts with one reference to it (WP-101 review round 3).
  {
    name: "globalThis",
    message: "packages/core is pure — no global-object access (purity fence).",
  },
  { name: "global", message: "packages/core is pure — no global-object access (purity fence)." },
  { name: "window", message: "packages/core is pure — no global-object access (purity fence)." },
  { name: "self", message: "packages/core is pure — no global-object access (purity fence)." },
  { name: "fetch", message: "packages/core is pure — no network I/O (purity fence)." },
  { name: "WebSocket", message: "packages/core is pure — no network I/O (purity fence)." },
  { name: "XMLHttpRequest", message: "packages/core is pure — no network I/O (purity fence)." },
  { name: "EventSource", message: "packages/core is pure — no network I/O (purity fence)." },
  { name: "setTimeout", message: "packages/core is pure — no scheduling (purity fence)." },
  { name: "setInterval", message: "packages/core is pure — no scheduling (purity fence)." },
  { name: "setImmediate", message: "packages/core is pure — no scheduling (purity fence)." },
  { name: "clearTimeout", message: "packages/core is pure — no scheduling (purity fence)." },
  { name: "clearInterval", message: "packages/core is pure — no scheduling (purity fence)." },
  { name: "clearImmediate", message: "packages/core is pure — no scheduling (purity fence)." },
];

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
  // getBuiltinModule — dot and computed-string-literal forms both banned.
  {
    selector: "MemberExpression[property.name='getBuiltinModule']",
    message:
      "process.getBuiltinModule() is banned in packages/core (purity fence, build plan §1.1).",
  },
  {
    selector: "MemberExpression[computed=true][property.value='getBuiltinModule']",
    message:
      "computed getBuiltinModule access is banned in packages/core (purity fence, build plan §1.1).",
  },
  // globalThis.process / globalThis["process"] — both forms banned.
  {
    selector: "MemberExpression[object.name='globalThis'][property.name='process']",
    message: "globalThis.process is banned in packages/core (purity fence, build plan §1.1).",
  },
  {
    selector: "MemberExpression[object.name='globalThis'][computed=true][property.value='process']",
    message: 'globalThis["process"] is banned in packages/core (purity fence, build plan §1.1).',
  },
  // The ambient I/O globals, reached as globalThis properties (dot and
  // computed-string-literal forms) — no-restricted-globals only sees bare
  // identifiers (WP-101 review round 2). Reflected/concatenated computed
  // keys remain the documented lint-invisible residual.
  {
    selector:
      "MemberExpression[object.name='globalThis'][property.name=/^(fetch|WebSocket|XMLHttpRequest|EventSource|setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|clearImmediate)$/]",
    message:
      "globalThis I/O and scheduling access is banned in packages/core (purity fence, build plan §1.1).",
  },
  {
    selector:
      "MemberExpression[object.name='globalThis'][computed=true][property.value=/^(fetch|WebSocket|XMLHttpRequest|EventSource|setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|clearImmediate)$/]",
    message:
      'globalThis["…"] I/O and scheduling access is banned in packages/core (purity fence, build plan §1.1).',
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
      "no-restricted-globals": ["error", ...CORE_RESTRICTED_GLOBALS],
      // eval / implied-eval are runtime-string escape hatches into anything;
      // pure domain logic has no use for them (WP-000 audit follow-up).
      "no-eval": "error",
      "no-implied-eval": "error",
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
    files: ["scripts/**/*.mjs", "spikes/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
