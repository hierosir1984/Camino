// WP-105: the API-key adapter interface — a compiled, documented typed
// contract with a conformance-check skeleton and NO implementation
// (CAM-EXEC-01 interface clause, marked [F] in the PRD).
//
// Scope, stated precisely (CAM-ROUTE-08): the API-key FALLBACK for the
// critical subscription providers needs NO adapter from this file — it is the
// same official CLIs re-authenticated with API keys through each vendor's own
// auth flow, executed as a configuration runbook (docs/runbooks/
// api-key-fallback.md). This interface exists for ADDITIONAL providers
// (registry item 14: GLM-range post-v1) that will authenticate with an API
// key behind the same dispatch interface and enablement gate.
//
// Credential custody (CAM-SEC-06 discipline extended to API keys):
//
//   - An API-key adapter DECLARES the env var NAMES its CLI reads
//     (`credentialEnvVars`). The interface has no PARAMETER through which a
//     credential value reaches adapter code.
//   - The future composer (the [F] implementation) copies the declared names
//     from HOST env state into the worker env at spawn time: composition
//     references host credential state; Camino never persists, logs, records,
//     or proxies the values. Posture records carry key NAMES only.
//   - Values must never appear in argv (process listings are world-readable
//     on shared systems), in stdin prompts, in SpawnPlan env values, or in
//     any Camino store or evidence artifact.
//
// SCOPE OF THE GUARANTEE (round-1 review finding 5 — do not overstate it):
// "no credential parameter" bounds the INTERFACE, not adapter behavior.
// `plan()`/`parseLine()` are arbitrary functions; adapter code can read
// process.env or a global and transform a value (e.g. base64) beyond any
// substring screen. The static + plan-level checks below are therefore a
// NECESSARY screen, not a sufficient proof of custody. Sufficiency comes from
// the dispatch-level obligations (run against a fake, zero quota) that the
// [F] implementation's own conformance suite MUST add — see
// API_KEY_ADAPTER_DISPATCH_OBLIGATIONS. The checks are pure, framework-free
// (they return violations rather than asserting), executable TODAY against any
// ApiKeyAdapterSpec — which is how packages/shared/src/api-key-adapter.test.ts
// proves they discriminate — while no product ApiKeyAdapterSpec ships in WP-105.

import type { AdapterContext, AdapterSpec, SpawnPlan } from "./adapter.js";
import {
  isGithubCredentialShapedKey,
  isGitOrSshChannelEnvKey,
  isWorkerEnvAllowlistKey,
} from "./adapter.js";

/**
 * POSIX-portable env var name grammar. Uppercase-only by policy: every real
 * provider key var is uppercase, and a lowercase declaration is far more
 * likely a mistake than a real CLI contract.
 */
export const CREDENTIAL_ENV_VAR_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * An adapter for a provider that authenticates with an API key (implementation
 * [F]). It is an AdapterSpec — the same dispatch lifecycle drives it, so
 * kill-confirm, stream parsing, quota classification, and outcome semantics
 * are identical to the subscription adapters (registry item 14: "behind the
 * same interface and gate") — plus a credential DECLARATION (names only).
 */
export interface ApiKeyAdapterSpec extends AdapterSpec {
  /** Discriminates API-key adapters from subscription adapters. */
  readonly kind: "api-key";
  /** Provider identity for the capability registry (e.g. "glm"). */
  readonly provider: string;
  /**
   * The env var NAMES the provider CLI reads its API key from (values are
   * resolved from host env state by the composer at spawn time, never by the
   * adapter). Non-empty; each name must match CREDENTIAL_ENV_VAR_PATTERN and
   * must not be GitHub-credential-shaped.
   */
  readonly credentialEnvVars: readonly string[];
}

/** One conformance violation: which check failed and why. */
export interface ConformanceViolation {
  check: string;
  detail: string;
}

/**
 * Static spec conformance: the declaration itself is well-formed. Runs with no
 * dispatch and no credentials.
 */
export function checkApiKeyAdapterSpec(spec: ApiKeyAdapterSpec): ConformanceViolation[] {
  const violations: ConformanceViolation[] = [];
  if (spec.kind !== "api-key") {
    violations.push({ check: "kind", detail: `kind must be "api-key", got ${String(spec.kind)}` });
  }
  if (typeof spec.name !== "string" || spec.name.length === 0) {
    violations.push({ check: "name", detail: "adapter name must be a non-empty string" });
  }
  if (typeof spec.provider !== "string" || spec.provider.length === 0) {
    violations.push({ check: "provider", detail: "provider id must be a non-empty string" });
  }
  if (!Array.isArray(spec.credentialEnvVars) || spec.credentialEnvVars.length === 0) {
    violations.push({
      check: "credential-env-vars",
      detail: "credentialEnvVars must declare at least one env var name",
    });
    return violations; // the per-name checks below need the array
  }
  const seen = new Set<string>();
  for (const name of spec.credentialEnvVars) {
    if (typeof name !== "string" || !CREDENTIAL_ENV_VAR_PATTERN.test(name)) {
      violations.push({
        check: "credential-env-vars",
        detail: `"${String(name)}" is not a valid env var name (${CREDENTIAL_ENV_VAR_PATTERN.source})`,
      });
      continue;
    }
    if (seen.has(name)) {
      violations.push({
        check: "credential-env-vars",
        detail: `"${name}" is declared more than once`,
      });
    }
    seen.add(name);
    if (isGithubCredentialShapedKey(name)) {
      violations.push({
        check: "credential-env-vars",
        detail: `"${name}" is GitHub-credential-shaped — the GitHub credential channel is closed to workers (CAM-SEC-06/CAM-EXEC-02) and may not be re-opened via a credential declaration`,
      });
    }
    // A credential declaration must not alias a host-inherited allowlist key
    // (round-1 review finding 5): declaring HOME/PATH/… as your "credential
    // var" would have the composer overwrite the sanctioned host value.
    if (isWorkerEnvAllowlistKey(name)) {
      violations.push({
        check: "credential-env-vars",
        detail: `"${name}" is a host-inherited allowlist key — it may not be declared as a credential var (it would clobber the sanctioned host value, CAM-SEC-06)`,
      });
    }
    // …nor may it re-open a git config/redirect or SSH-agent CAPABILITY
    // channel the composer strips: an API-key adapter must not smuggle
    // SSH_AUTH_SOCK or a GIT_CONFIG override past the composer by calling it a
    // "credential var" (round-1 review finding 5). This is deliberately the
    // capability-channel predicate, NOT the credential-shaped one — a genuine
    // credential var (GLM_API_KEY) is credential-shaped and must be allowed.
    if (isGitOrSshChannelEnvKey(name)) {
      violations.push({
        check: "credential-env-vars",
        detail: `"${name}" is a git config/redirect or SSH-agent channel the worker-env composer strips — it may not be re-opened via a credential declaration (CAM-SEC-06/CAM-EXEC-02)`,
      });
    }
  }
  return violations;
}

/**
 * Plan-level credential custody: given the SpawnPlan an adapter produced and
 * the credential VALUES the test planted in the (test-controlled) host env,
 * assert none of them leaked into the plan. Because the interface passes no
 * values to adapter code, any appearance means the adapter reached outside its
 * contract to fetch a value — a custody violation regardless of how it got it.
 * Also rejects a plan that sets the declared credential vars itself: injecting
 * host values is the composer's job; an adapter-supplied value is by
 * definition not host credential state.
 */
export function checkPlanCredentialCustody(
  spec: ApiKeyAdapterSpec,
  plan: SpawnPlan,
  plantedValues: readonly string[],
): ConformanceViolation[] {
  const violations: ConformanceViolation[] = [];
  const leaks = (where: string, text: string) => {
    for (const value of plantedValues) {
      if (value.length > 0 && text.includes(value)) {
        violations.push({
          check: "plan-custody",
          detail: `a planted credential value appears in ${where} — values must never reach the plan`,
        });
      }
    }
  };
  leaks("plan.file", plan.file);
  plan.args.forEach((arg, i) => leaks(`plan.args[${i}]`, arg));
  if (plan.stdin != null) leaks("plan.stdin", plan.stdin);
  for (const [key, value] of Object.entries(plan.env ?? {})) {
    leaks(`plan.env["${key}"]`, value);
    if (spec.credentialEnvVars.includes(key)) {
      violations.push({
        check: "plan-custody",
        detail: `plan.env sets declared credential var "${key}" — passthrough of host values is the composer's job, never the adapter's`,
      });
    }
  }
  return violations;
}

/**
 * Convenience wrapper: run plan() under the spec's own contract and apply the
 * custody check. Callers plant synthetic values in their test env BEFORE
 * calling (so an adapter that reads the environment gets caught) and pass the
 * same values here.
 */
export function checkAdapterPlanCustody(
  spec: ApiKeyAdapterSpec,
  ctx: AdapterContext,
  plantedValues: readonly string[],
): ConformanceViolation[] {
  return checkPlanCredentialCustody(spec, spec.plan(ctx), plantedValues);
}

/**
 * The obligations a future implementation's OWN conformance suite must add on
 * top of the pure checks above — mechanics that need a running dispatch and
 * are therefore proven the way the subscription adapters prove them: against
 * the fake CLI, zero quota (packages/daemon/src/dispatch/lifecycle.test.ts is
 * the template).
 */
export const API_KEY_ADAPTER_DISPATCH_OBLIGATIONS: readonly string[] = [
  "kill-confirm sequence on the shared lifecycle: SIGTERM → grace → SIGKILL → group-gone → lease release (PRD §5 registry item 4)",
  "rate-limit classification through the shared quota classifier: quota-blocked, never requirement-failed (CAM-EXEC-06)",
  "worker env composed by the shared composer with the declared credential vars passed through by NAME from host env state only (CAM-SEC-06 discipline)",
  "credential values absent from every posture record, transcript, evidence artifact, and log the dispatch produces",
  "enablement gated on the provider's recorded sanctioned-path attribute and on the declared credential vars being present in host env state (CAM-EXEC-01)",
];
