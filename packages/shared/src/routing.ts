/**
 * Routing foundation contract (WP-106): capability-registry schema and the
 * per-project policy table (CAM-ROUTE-01, CAM-ROUTE-02).
 *
 * This module is the cross-package CONTRACT half: types, closed constant
 * sets, and pure validators. The daemon owns the data half — the seeded
 * capability registry, the quota-window tracker, and the per-project policy
 * store (packages/daemon/src/routing/).
 *
 * Two design rules carried over from WP-104/105/109:
 *
 *   - Every value export is DEEP-frozen at module load. `as const` and
 *     `Readonly<...>` erase at runtime; a barrel importer must not be able
 *     to widen a role set or retarget a default assignment and thereby
 *     change a routing decision (see barrel-immutability.test.ts).
 *   - Closed sets are enumerated once and swept by validators — no
 *     hand-kept duplicate lists that go stale silently.
 *
 * The shipped default policy table is built BY CONSTRUCTION: the builder
 * derives every cell from a role→harness rotation and throws at module load
 * if any cross-family constraint fails, so a defaults edit that breaks the
 * CAM-ROUTE-02 geometry cannot compile into a running daemon — every test
 * run catches it on first import.
 */
import { OFFICIAL_ADAPTER_NAMES } from "./adapter.js";
import type { OfficialAdapterName } from "./adapter.js";

/* ------------------------------------------------------------------ */
/* Deep freeze (local twin of @camino/core's; shared cannot import core) */
/* ------------------------------------------------------------------ */

const ADMITTED_PROTOTYPES: ReadonlySet<unknown> = new Set([
  Object.prototype,
  Array.prototype,
  Function.prototype,
  null,
]);

/**
 * Freeze the whole reachable graph of a value this module authors, refusing
 * shapes freeze cannot make immutable (exotic built-ins, class instances,
 * accessor properties). Same contract as packages/core/src/deep-freeze.ts;
 * duplicated here because the dependency direction is core → shared.
 * Exported so the daemon's routing seed can pin its registry data the same
 * way; runs at module load over authored literals — a violation throws
 * deterministically on first import.
 */
export function deepFreeze<T>(value: T): T {
  freezeGraph(value, "value", new Set());
  return value;
}

function freezeGraph(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  const node: object = value;
  if (seen.has(node)) return;
  seen.add(node);
  if (!ADMITTED_PROTOTYPES.has(Object.getPrototypeOf(node))) {
    throw new Error(
      `deepFreeze(${path}): freeze cannot make this value immutable (exotic built-in or ` +
        `class instance); keep it module-private behind a function instead`,
    );
  }
  Object.freeze(node);
  for (const key of Reflect.ownKeys(node)) {
    const descriptor = Object.getOwnPropertyDescriptor(node, key);
    if (descriptor === undefined) continue;
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new Error(
        `deepFreeze(${path}.${String(key)}): accessor property where the table promises data`,
      );
    }
    freezeGraph(descriptor.value, `${path}.${String(key)}`, seen);
  }
}

/* ------------------------------------------------------------------ */
/* Provider families and harnesses                                     */
/* ------------------------------------------------------------------ */

/** The v1 provider families (one per official CLI harness — CAM-EXEC-01). */
export const PROVIDER_FAMILIES = deepFreeze(["anthropic", "openai", "xai"] as const);
export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number];

/**
 * Which provider family each official harness draws on. Cross-family
 * constraints (CAM-PLAN-03, CAM-VAL-06a/b, CAM-ROUTE-02) compare FAMILIES,
 * not harness names: two harnesses of one family are not independent
 * reviewers of each other.
 */
export const HARNESS_FAMILY: Readonly<Record<OfficialAdapterName, ProviderFamily>> = deepFreeze({
  "claude-code": "anthropic",
  "codex-cli": "openai",
  "grok-build": "xai",
});

/** Family of a harness; throws on a name outside the official set. */
export function harnessFamily(harness: string): ProviderFamily {
  const family = (HARNESS_FAMILY as Record<string, ProviderFamily | undefined>)[harness];
  if (family === undefined) {
    throw new TypeError(`Unknown harness: ${JSON.stringify(harness)}`);
  }
  return family;
}

/* ------------------------------------------------------------------ */
/* Roles, tiers, task features                                         */
/* ------------------------------------------------------------------ */

/**
 * The routing roles the policy table assigns (CAM-ROUTE-02 "role × task
 * features"). Vocabulary pinned to the PRD:
 *   planner     — produces the mission plan (CAM-PLAN-01/02)
 *   challenger  — falsification review of the plan, different provider than
 *                 the planner (CAM-PLAN-03)
 *   implementer — works an issue in a worker environment (CAM-EXEC-*)
 *   reviewer    — issue-level cross-family review (CAM-VAL-06b; the
 *                 proto-Camino method's reviewer.provider ≠
 *                 implementer.provider rule)
 *   verifier    — mission-level semantic review before the merge gate,
 *                 different provider than the primary implementer
 *                 (CAM-VAL-06a)
 */
export const ROUTING_ROLES = deepFreeze([
  "planner",
  "challenger",
  "implementer",
  "reviewer",
  "verifier",
] as const);
export type RoutingRole = (typeof ROUTING_ROLES)[number];

/**
 * Reasoning tiers, harness-agnostic. Each adapter maps a tier onto its own
 * native control (reasoning-effort configuration, thinking depth); the
 * table only records intent. Ordered weakest → strongest.
 */
export const REASONING_TIERS = deepFreeze(["low", "medium", "high", "xhigh"] as const);
export type ReasoningTier = (typeof REASONING_TIERS)[number];

/** Mission templates the v1 policy table distinguishes (PRD §7 Phase 2). */
export const TASK_TEMPLATES = deepFreeze(["feature", "quick-task"] as const);
export type TaskTemplate = (typeof TASK_TEMPLATES)[number];

/** Risk tiers per PRD §5 registry item 18 (deterministic floor rules apply). */
export const RISK_TIERS = deepFreeze(["low", "medium", "high"] as const);
export type RiskTier = (typeof RISK_TIERS)[number];

/** The task-feature coordinates a policy lookup supplies (CAM-ROUTE-02). */
export interface TaskFeatures {
  readonly template: TaskTemplate;
  readonly riskTier: RiskTier;
}

/* ------------------------------------------------------------------ */
/* Policy table                                                        */
/* ------------------------------------------------------------------ */

/**
 * One routing decision: (harness, model, reasoning tier) — CAM-ROUTE-02's
 * output tuple. `model: null` means the harness's own current default model
 * (what that resolves to is a capability-registry observation, not policy);
 * a string pins a provider model identifier the harness accepts.
 */
export interface PolicyAssignment {
  readonly harness: OfficialAdapterName;
  readonly model: string | null;
  readonly reasoningTier: ReasoningTier;
}

/** Full enumeration: template × risk tier × role → assignment. */
export type PolicyCells = Readonly<
  Record<TaskTemplate, Readonly<Record<RiskTier, Readonly<Record<RoutingRole, PolicyAssignment>>>>>
>;

/**
 * A per-project policy table (CAM-ROUTE-02): user-editable, validated on
 * write by the daemon's RoutingPolicyStore. The allowlist names provider
 * FAMILIES the project permits; every assignment's harness must belong to
 * an allowlisted family.
 */
export interface PolicyTable {
  readonly providerAllowlist: readonly ProviderFamily[];
  readonly cells: PolicyCells;
}

/**
 * Dispatch pauses at this fraction of estimated window consumption per
 * provider (PRD §5 registry item 13; enforced by the WP-114 scheduler under
 * CAM-ROUTE-06 — recorded here so scheduler and registry share one value).
 */
export const QUOTA_PAUSE_THRESHOLD = 0.85;

/** One structural defect found in a candidate policy table. */
export interface PolicyViolation {
  /** Dotted path into the table, e.g. "cells.feature.high.reviewer.harness". */
  readonly path: string;
  readonly reason: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Structural validation for a candidate policy table (user-edited JSON).
 * Returns every defect found — unknown or missing keys, bad tier or harness
 * names, empty or unknown allowlist entries, assignments outside the
 * allowlist. An empty result means the table is structurally sound; the
 * cross-family geometry is a SEPARATE, named check (crossFamilyViolations)
 * because per-project allowlists can make it unsatisfiable — see the
 * RoutingPolicyStore doc for how the two results are treated.
 */
export function validatePolicyTable(candidate: unknown): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  if (!isPlainObject(candidate)) {
    return [{ path: "", reason: "policy table must be a plain object" }];
  }

  const allowlist = candidate["providerAllowlist"];
  const allowedFamilies = new Set<ProviderFamily>();
  if (!Array.isArray(allowlist)) {
    violations.push({ path: "providerAllowlist", reason: "must be an array of provider families" });
  } else {
    if (allowlist.length === 0) {
      violations.push({
        path: "providerAllowlist",
        reason: "must allow at least one provider family",
      });
    }
    for (const [i, entry] of allowlist.entries()) {
      if (!(PROVIDER_FAMILIES as readonly unknown[]).includes(entry)) {
        violations.push({
          path: `providerAllowlist[${i}]`,
          reason: `unknown provider family: ${JSON.stringify(entry)}`,
        });
      } else if (allowedFamilies.has(entry as ProviderFamily)) {
        violations.push({
          path: `providerAllowlist[${i}]`,
          reason: `duplicate provider family: ${JSON.stringify(entry)}`,
        });
      } else {
        allowedFamilies.add(entry as ProviderFamily);
      }
    }
  }

  const cells = candidate["cells"];
  if (!isPlainObject(cells)) {
    violations.push({ path: "cells", reason: "must enumerate every template × risk tier × role" });
    return violations;
  }
  for (const key of Object.keys(cells)) {
    if (!(TASK_TEMPLATES as readonly string[]).includes(key)) {
      violations.push({ path: `cells.${key}`, reason: `unknown task template: ${key}` });
    }
  }
  for (const template of TASK_TEMPLATES) {
    const byRisk = cells[template];
    if (!isPlainObject(byRisk)) {
      violations.push({ path: `cells.${template}`, reason: "missing template enumeration" });
      continue;
    }
    for (const key of Object.keys(byRisk)) {
      if (!(RISK_TIERS as readonly string[]).includes(key)) {
        violations.push({ path: `cells.${template}.${key}`, reason: `unknown risk tier: ${key}` });
      }
    }
    for (const risk of RISK_TIERS) {
      const byRole = byRisk[risk];
      if (!isPlainObject(byRole)) {
        violations.push({ path: `cells.${template}.${risk}`, reason: "missing risk enumeration" });
        continue;
      }
      for (const key of Object.keys(byRole)) {
        if (!(ROUTING_ROLES as readonly string[]).includes(key)) {
          violations.push({
            path: `cells.${template}.${risk}.${key}`,
            reason: `unknown routing role: ${key}`,
          });
        }
      }
      for (const role of ROUTING_ROLES) {
        const cellPath = `cells.${template}.${risk}.${role}`;
        const assignment = byRole[role];
        if (!isPlainObject(assignment)) {
          violations.push({ path: cellPath, reason: "missing assignment" });
          continue;
        }
        for (const key of Object.keys(assignment)) {
          if (key !== "harness" && key !== "model" && key !== "reasoningTier") {
            violations.push({ path: `${cellPath}.${key}`, reason: `unknown assignment field` });
          }
        }
        const harness = assignment["harness"];
        if (!(OFFICIAL_ADAPTER_NAMES as readonly unknown[]).includes(harness)) {
          // The API-key adapter interface ([F], CAM-EXEC-01 interface clause)
          // will widen this set when an implementation ships; v1 routes only
          // to the official harnesses.
          violations.push({
            path: `${cellPath}.harness`,
            reason: `unknown harness: ${JSON.stringify(harness)}`,
          });
        } else if (
          allowedFamilies.size > 0 &&
          !allowedFamilies.has(HARNESS_FAMILY[harness as OfficialAdapterName])
        ) {
          violations.push({
            path: `${cellPath}.harness`,
            reason: `harness family "${HARNESS_FAMILY[harness as OfficialAdapterName]}" is not in the project's provider allowlist`,
          });
        }
        const model = assignment["model"];
        if (model !== null && (typeof model !== "string" || model.length === 0)) {
          violations.push({
            path: `${cellPath}.model`,
            reason: "model must be null (harness default) or a non-empty string",
          });
        }
        if (!(REASONING_TIERS as readonly unknown[]).includes(assignment["reasoningTier"])) {
          violations.push({
            path: `${cellPath}.reasoningTier`,
            reason: `unknown reasoning tier: ${JSON.stringify(assignment["reasoningTier"])}`,
          });
        }
      }
    }
  }
  return violations;
}

/* ------------------------------------------------------------------ */
/* Cross-family constraints (the CAM-ROUTE-02 geometry)                */
/* ------------------------------------------------------------------ */

/**
 * The named cross-family constraints. Within one feature cell, the listed
 * roles must be PAIRWISE assigned to distinct provider families. Each
 * carries the requirement that makes it load-bearing; the run-time gates
 * (plan approval, merge gate) are where those requirements are ENFORCED —
 * this module names and measures the geometry so defaults satisfy it by
 * construction and edited tables report exactly what they trade away.
 */
export const CROSS_FAMILY_CONSTRAINTS = deepFreeze([
  { name: "plan-challenge", roles: ["planner", "challenger"], requirement: "CAM-PLAN-03" },
  { name: "implement-review", roles: ["implementer", "reviewer"], requirement: "CAM-VAL-06b" },
  { name: "mission-verify", roles: ["implementer", "verifier"], requirement: "CAM-VAL-06a" },
  {
    name: "plan-verify-triad",
    roles: ["planner", "challenger", "verifier"],
    requirement: "CAM-ROUTE-02",
  },
] as const);

/** One cross-family constraint failure in one feature cell. */
export interface CrossFamilyViolation {
  readonly template: TaskTemplate;
  readonly riskTier: RiskTier;
  /** Which named constraint failed (CROSS_FAMILY_CONSTRAINTS entry). */
  readonly constraint: string;
  readonly requirement: string;
  /** The two roles sharing a family. */
  readonly roles: readonly [RoutingRole, RoutingRole];
  readonly family: ProviderFamily;
}

/**
 * Measure the cross-family geometry of a STRUCTURALLY VALID table. Returns
 * one violation per (cell, constraint, role pair) whose roles share a
 * provider family. Empty result = the table preserves every named
 * cross-family property.
 */
export function crossFamilyViolations(table: PolicyTable): CrossFamilyViolation[] {
  const violations: CrossFamilyViolation[] = [];
  for (const template of TASK_TEMPLATES) {
    for (const riskTier of RISK_TIERS) {
      const cell = table.cells[template][riskTier];
      for (const constraint of CROSS_FAMILY_CONSTRAINTS) {
        for (let i = 0; i < constraint.roles.length; i++) {
          for (let j = i + 1; j < constraint.roles.length; j++) {
            const a = constraint.roles[i]!;
            const b = constraint.roles[j]!;
            const familyA = HARNESS_FAMILY[cell[a].harness];
            const familyB = HARNESS_FAMILY[cell[b].harness];
            if (familyA === familyB) {
              violations.push({
                template,
                riskTier,
                constraint: constraint.name,
                requirement: constraint.requirement,
                roles: [a, b],
                family: familyA,
              });
            }
          }
        }
      }
    }
  }
  return violations;
}

/**
 * Pure policy lookup: role × task features → (harness, model, tier). The
 * WP-114 scheduler dispatches from this. Throws on coordinates outside the
 * closed sets — a caller with an unvalidated role/feature does not get a
 * silent default.
 */
export function resolveAssignment(
  table: PolicyTable,
  role: RoutingRole,
  features: TaskFeatures,
): PolicyAssignment {
  if (!(ROUTING_ROLES as readonly string[]).includes(role)) {
    throw new TypeError(`Unknown routing role: ${JSON.stringify(role)}`);
  }
  if (!(TASK_TEMPLATES as readonly string[]).includes(features.template)) {
    throw new TypeError(`Unknown task template: ${JSON.stringify(features.template)}`);
  }
  if (!(RISK_TIERS as readonly string[]).includes(features.riskTier)) {
    throw new TypeError(`Unknown risk tier: ${JSON.stringify(features.riskTier)}`);
  }
  return table.cells[features.template][features.riskTier][role];
}

/* ------------------------------------------------------------------ */
/* Shipped defaults — cross-family BY CONSTRUCTION                     */
/* ------------------------------------------------------------------ */

/** Role → harness rotation the default table derives every cell from. */
export type RoleRotation = Readonly<Record<RoutingRole, OfficialAdapterName>>;

/**
 * Build a full policy table from a role→harness rotation, then REFUSE it if
 * any structural or cross-family check fails. This is what "cross-family by
 * construction" means concretely (CAM-ROUTE-02): the defaults below cannot
 * load with a same-family challenger/planner, reviewer/implementer,
 * verifier/implementer, or a non-distinct planner/challenger/verifier triad
 * — a bad edit throws on first import instead of shipping.
 *
 * Reasoning tiers per cell: review-class roles scale with risk tier
 * (registry item 18 drives review depth); planner/challenger/implementer
 * scale with template (quick tasks get the proportionate mini-review depth
 * per CAM-PLAN-03). Models are `null` — each harness's own default model,
 * tracked as a capability-registry observation.
 */
export function makeCrossFamilyDefaults(rotation: RoleRotation): PolicyTable {
  const reviewTier: Record<RiskTier, ReasoningTier> = {
    low: "high",
    medium: "high",
    high: "xhigh",
  };
  const verifyTier: Record<RiskTier, ReasoningTier> = {
    low: "high",
    medium: "xhigh",
    high: "xhigh",
  };
  const byTemplate = (template: TaskTemplate, risk: RiskTier) => ({
    planner: {
      harness: rotation.planner,
      model: null,
      reasoningTier: (template === "feature" ? "high" : "medium") as ReasoningTier,
    },
    challenger: {
      harness: rotation.challenger,
      model: null,
      reasoningTier: (template === "feature" ? "xhigh" : "high") as ReasoningTier,
    },
    implementer: {
      harness: rotation.implementer,
      model: null,
      reasoningTier: (template === "feature" ? "high" : "medium") as ReasoningTier,
    },
    reviewer: { harness: rotation.reviewer, model: null, reasoningTier: reviewTier[risk] },
    verifier: { harness: rotation.verifier, model: null, reasoningTier: verifyTier[risk] },
  });

  const cells = Object.fromEntries(
    TASK_TEMPLATES.map((template) => [
      template,
      Object.fromEntries(RISK_TIERS.map((risk) => [risk, byTemplate(template, risk)])),
    ]),
  ) as PolicyCells;

  const table: PolicyTable = { providerAllowlist: PROVIDER_FAMILIES, cells };

  const structural = validatePolicyTable(table);
  if (structural.length > 0) {
    throw new Error(
      `default policy table failed structural validation: ${structural
        .map((v) => `${v.path}: ${v.reason}`)
        .join("; ")}`,
    );
  }
  const crossFamily = crossFamilyViolations(table);
  if (crossFamily.length > 0) {
    throw new Error(
      `default policy table breaks cross-family construction (CAM-ROUTE-02): ${crossFamily
        .map((v) => `${v.template}/${v.riskTier} ${v.constraint}: ${v.roles.join("=")}`)
        .join("; ")}`,
    );
  }
  return table;
}

/**
 * The shipped default policy table (CAM-ROUTE-02). Rotation: the plan is
 * authored by one family, challenged by a second, and the mission verified
 * by a third — pairwise-distinct planner/challenger/verifier; issue review
 * is cross-family from the implementer. Deep-frozen: per-project EDITS live
 * in the daemon's RoutingPolicyStore, never as mutations of this object.
 */
export const DEFAULT_POLICY_TABLE: PolicyTable = deepFreeze(
  makeCrossFamilyDefaults({
    planner: "claude-code",
    challenger: "codex-cli",
    implementer: "claude-code",
    reviewer: "codex-cli",
    verifier: "grok-build",
  }),
);

/* ------------------------------------------------------------------ */
/* Capability registry schema (CAM-ROUTE-01)                           */
/* ------------------------------------------------------------------ */

/**
 * How firmly a capability attribute's value is grounded:
 *   documented  — stated by the provider or an approved in-repo record
 *   provisional — a stated shape awaiting confirmation from observation
 *   observed    — derived from adapter signals / ledger observation
 *   unverified  — no grounded value recorded yet (stated, not guessed)
 */
export const CAPABILITY_CONFIDENCE = deepFreeze([
  "documented",
  "provisional",
  "observed",
  "unverified",
] as const);
export type CapabilityConfidence = (typeof CAPABILITY_CONFIDENCE)[number];

/**
 * A time-varying, source-linked attribute (CAM-ROUTE-01): every value
 * carries when it was snapshotted, where it came from, and what triggers a
 * re-check. Attributes are replaced by re-checks, never silently edited.
 */
export interface CapabilityAttribute<T> {
  readonly value: T;
  /** ISO-8601 date the value was recorded (snapshot, not a live claim). */
  readonly snapshotAt: string;
  /** Where the value comes from — an in-repo record path or a provider document. */
  readonly source: string;
  readonly confidence: CapabilityConfidence;
  /** Events that obligate re-checking this attribute. */
  readonly recheckTriggers: readonly string[];
  /** Recorded caveats/tensions carried with the value (stated, not hidden). */
  readonly notes?: readonly string[];
}

/** A model the harness can route to, with its documented context limits. */
export interface ModelInfo {
  readonly id: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

/**
 * A quota-window shape per PRD §5 registry item 13. Windows are tracked
 * from adapter rate-limit signals; shapes are refined from ledger
 * observation (QuotaWindowTracker).
 */
export interface WindowShape {
  readonly id: string;
  /** v1 models rolling windows only; calendar-reset shapes are an observation away. */
  readonly kind: "rolling";
  readonly durationMs: number;
}

/** A billing pool a harness draws on (subscription vs API-key fallback). */
export interface BillingPool {
  readonly kind: "subscription" | "api-key";
  readonly label: string;
  /**
   * True when a funded fallback account is attested in the WP-000 gate
   * record (CAM-ROUTE-08 prerequisite half); absent for pools that carry no
   * attestation obligation.
   */
  readonly fundedFallbackAttested?: boolean;
}

/** Recorded sanctioned-path disposition (the contractual half of enablement). */
export interface SanctionedPathRecord {
  readonly status: "recorded-accepted" | "recorded-refused" | "not-recorded";
  /** Who/when recorded it, where the memo or record lives. */
  readonly recordedBy?: string;
  readonly recordedOn?: string;
}

/**
 * The static, source-linked capability record for one provider (the seed
 * half of CAM-ROUTE-01). The daemon's buildCapabilityRegistry() composes
 * this with LIVE state: adapter enablement (the dispatch registry's
 * sanctioned-path + CLI gate) and window consumption estimates (the
 * QuotaWindowTracker).
 */
export interface ProviderCapabilityRecord {
  readonly family: ProviderFamily;
  readonly harness: OfficialAdapterName;
  readonly models: CapabilityAttribute<readonly ModelInfo[]>;
  readonly quotaWindows: CapabilityAttribute<readonly WindowShape[]>;
  readonly harnessFeatures: CapabilityAttribute<readonly string[]>;
  readonly sanctionedPath: CapabilityAttribute<SanctionedPathRecord>;
  readonly billingPools: CapabilityAttribute<readonly BillingPool[]>;
}
