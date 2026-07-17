# Security posture (summary)

Camino executes model-written code. Its security design is stated honestly as a
three-tier threat model (design record §5.3; documented in-product from WP-115):

- **T1 — accidental leakage** (the common case): validation runs in a no-egress
  environment except allowlisted test endpoints; retained artifacts pass literal
  secret-pattern scrubbing; workers never hold secrets or GitHub credentials.
  **Defended.**
- **T2 — prompt-injected worker with observable misbehavior:** provenance-tagged
  context, deterministic reclassification triggers, validation-config diff review,
  cross-family review, and a standing injection red-team suite. **Defended
  proportionately to what the red-team finds.**
- **T3 — a determined, covert adversarial model: accepted residual risk, priced
  in full.** Pre-merge damage is bounded (test-scoped secrets, isolated tenants,
  disposability, audit logging). **Beyond the merge the bound honestly ends** —
  code that passes every gate lands like any accepted contribution: the standard
  supply-chain risk of accepting code from any source, human or AI.

Key invariants: workers hold zero repository credentials; only Camino-authored
commits are pushed; subscription credentials are never read, stored, or proxied;
evidence binds to exact commit SHAs.

## The `packages/core` purity fence (lint-grade, with a stated residual)

The `core` package is pure by rule: an ESLint allowlist permits only
core-relative imports and `@camino/shared`, and bans Node builtins (any
spelling), other packages, dynamic `import()`/`require`/`createRequire`,
`process`/`getBuiltinModule` (dot and computed-literal forms), and
`eval`. A regression suite proves each bypass class trips.

**Stated residual:** static lint cannot see fully dynamic access —
a specifier assembled by string concatenation (`"no" + "de:fs"`) or
reflection through a computed, non-literal key evades any AST rule. The
fence raises the cost of an I/O leak in pure code and catches the honest
mistakes and the obvious evasions; it is not a sandbox. Defense in depth
against a _determined_ leak is the layer above it — quarantine scope
checks on the worker diff, cross-family review, and (optionally, WP-101)
runtime or dependency-graph enforcement. This matches the T3 honesty
above: the fence is a pre-merge guardrail, not a containment guarantee.

Reporting: this is a personal-use project (pre-release). Please open a GitHub
issue for non-sensitive reports, or contact the repository owner directly for
anything sensitive.
