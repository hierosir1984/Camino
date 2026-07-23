/**
 * Issue contracts (WP-110, CAM-PLAN-04/-11): the durable cross-package
 * schema for frozen acceptance criteria.
 *
 * At plan approval, each planned issue's acceptance criteria freeze into a
 * hash-referenced contract VERSION. The hash is the content identity of
 * the contract's TERMS — computed over the canonical JSON of ContractTerms
 * and nothing else — so any consumer holding a hash can verify byte-exactly
 * what was approved. Record metadata (when it froze, who approved) rides
 * alongside, outside the hash: re-approving identical terms yields the
 * identical hash.
 *
 * Consumers this schema is designed for (§5 dependency table):
 *   - WP-108 quarantine: scope checks run against the issue's frozen contract
 *   - WP-111 plan review: critiques attach to contract-versioned plans
 *   - WP-112 change control: an edit creates version n+1, never a mutation
 *   - WP-113 context packs: dependents see this contract's declared interfaces
 *   - WP-114 scheduler: dependency readiness reads dependsOn edges
 *
 * Every attempt and PR references its contract hash (CAM-PLAN-04). The
 * shape of that reference is ContractRef below; the obligations table
 * names the artifacts that owe one, so consuming WPs assert against a
 * pinned list instead of re-deriving the rule.
 */
import { canonicalJson, sha256Hex } from "./canonical-json.js";
import { isRequirementId } from "./requirement-id.js";
import type { DeclaredInterface, MissionTemplateName } from "./plan.js";
import {
  INTERFACE_KINDS,
  MISSION_TEMPLATE_NAMES,
  PLAN_MAX_LIST_LENGTH,
  PLAN_MAX_TEXT_LENGTH,
} from "./plan.js";

/**
 * Bumped only by a PRD-level schema change; part of the hashed terms so a
 * reader can never confuse two schema generations of the same contract.
 */
export const CONTRACT_SCHEMA_VERSION = 1;

/**
 * The hashed contract terms — everything the hash covers, nothing else.
 * Field set is CLOSED: adding a field is a schema-version bump, because it
 * changes every hash.
 */
export interface ContractTerms {
  readonly schemaVersion: number;
  readonly missionId: string;
  /** Durable issue id: `<missionId>.<planIssueId>`, minted at freeze. */
  readonly issueId: string;
  /** Contract version: 1 at plan approval; WP-112 mints n+1 on edit. */
  readonly version: number;
  readonly template: MissionTemplateName;
  readonly title: string;
  readonly goal: string;
  /** The frozen acceptance criteria, verbatim from the approved plan. */
  readonly acceptanceCriteria: readonly string[];
  /** Accepted intent-ledger requirement ids this issue implements (sorted). */
  readonly requirementIds: readonly string[];
  /** Durable issue ids that must merge first (sorted; CAM-PLAN-11). */
  readonly dependsOn: readonly string[];
  /** Interfaces exposed to dependents (CAM-PLAN-11; WP-113 renders these). */
  readonly interfaces: readonly DeclaredInterface[];
}

/** A frozen contract record: hashed terms plus unhashed record metadata. */
export interface IssueContract extends ContractTerms {
  /** sha256(canonicalJson(terms)) — the reference every attempt/PR carries. */
  readonly contractHash: string;
  /** ISO-8601 UTC instant of the freeze (record metadata, outside the hash). */
  readonly frozenAt: string;
  /** Actor of the approval act that froze this version (outside the hash). */
  readonly approvedBy: string;
}

/** The terms of a contract record — exactly the fields the hash covers. */
export function contractTermsOf(contract: IssueContract): ContractTerms {
  return {
    schemaVersion: contract.schemaVersion,
    missionId: contract.missionId,
    issueId: contract.issueId,
    version: contract.version,
    template: contract.template,
    title: contract.title,
    goal: contract.goal,
    acceptanceCriteria: [...contract.acceptanceCriteria],
    requirementIds: [...contract.requirementIds],
    dependsOn: [...contract.dependsOn],
    interfaces: contract.interfaces.map((i) => ({ ...i })),
  };
}

/** The content hash of contract terms: sha256 hex over their canonical JSON. */
export function contractHash(terms: ContractTerms): string {
  return sha256Hex(canonicalJson(terms));
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
export const SHA256_HEX_PATTERN_SOURCE: string = SHA256_HEX_RE.source;

/** Lowercase-hex sha-256 shape check (the form contractHash and prd hashes use). */
export function isSha256Hex(value: string): boolean {
  return SHA256_HEX_RE.test(value);
}

/** Strict ISO-8601 UTC instant in Date#toISOString form, round-trip verified. */
function isIsoInstant(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function boundedText(field: string, value: unknown, problems: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    problems.push(`${field} must be a non-empty string`);
    return;
  }
  if (value.length > PLAN_MAX_TEXT_LENGTH) {
    problems.push(`${field} exceeds ${PLAN_MAX_TEXT_LENGTH} code units`);
  }
  if (value.includes("\u0000")) problems.push(`${field} contains U+0000`);
}

/**
 * Sparse-array holes have no canonical JSON form and are skipped by every
 * iteration method (forEach/map/every), so validators must hunt them by
 * index or a holed list would validate and then fail (or alias) at the
 * hash (r1 finding 7).
 */
function arrayHoleProblems(field: string, value: readonly unknown[]): string[] {
  const problems: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    if (!Object.hasOwn(value, i)) problems.push(`${field}[${i}] is a sparse-array hole`);
  }
  return problems;
}

function sortedStringList(
  field: string,
  value: unknown,
  problems: string[],
  perEntry: (entry: string) => string | null,
): void {
  if (!Array.isArray(value)) {
    problems.push(`${field} must be an array`);
    return;
  }
  if (value.length > PLAN_MAX_LIST_LENGTH) {
    problems.push(`${field} exceeds ${PLAN_MAX_LIST_LENGTH} entries`);
  }
  problems.push(...arrayHoleProblems(field, value));
  let previous: string | undefined;
  value.forEach((entry, i) => {
    if (typeof entry !== "string") {
      problems.push(`${field}[${i}] must be a string`);
      return;
    }
    const problem = perEntry(entry);
    if (problem !== null) problems.push(`${field}[${i}] ${problem}`);
    if (previous !== undefined && !(previous < entry)) {
      problems.push(`${field} must be strictly sorted and duplicate-free (${field}[${i}])`);
    }
    previous = entry;
  });
}

/**
 * Total validator for a contract record, hash INCLUDED: an empty result
 * means the record is well-formed and its contractHash equals the
 * recomputed hash of its terms. Used at freeze (before insert) and at
 * adoption (a store row that fails this is refused, never repaired).
 */
export function contractProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["contract must be a plain object"];
  }
  const record = value as Record<string, unknown>;
  const problems: string[] = [];
  if (record["schemaVersion"] !== CONTRACT_SCHEMA_VERSION) {
    problems.push(
      `schemaVersion must be ${CONTRACT_SCHEMA_VERSION}, got ${JSON.stringify(record["schemaVersion"])}`,
    );
  }
  boundedText("missionId", record["missionId"], problems);
  boundedText("issueId", record["issueId"], problems);
  if (
    typeof record["missionId"] === "string" &&
    typeof record["issueId"] === "string" &&
    !String(record["issueId"]).startsWith(`${String(record["missionId"])}.`)
  ) {
    problems.push("issueId must be namespaced under missionId (`<missionId>.<planIssueId>`)");
  }
  const version = record["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    problems.push("version must be an integer >= 1");
  }
  const template = record["template"];
  if (
    typeof template !== "string" ||
    !(MISSION_TEMPLATE_NAMES as readonly string[]).includes(template)
  ) {
    problems.push(`template must be one of ${MISSION_TEMPLATE_NAMES.join(", ")}`);
  }
  boundedText("title", record["title"], problems);
  boundedText("goal", record["goal"], problems);
  const criteria = record["acceptanceCriteria"];
  if (!Array.isArray(criteria) || criteria.length === 0) {
    problems.push("acceptanceCriteria must be a non-empty array");
  } else {
    if (criteria.length > PLAN_MAX_LIST_LENGTH) {
      problems.push(`acceptanceCriteria exceeds ${PLAN_MAX_LIST_LENGTH} entries`);
    }
    problems.push(...arrayHoleProblems("acceptanceCriteria", criteria));
    criteria.forEach((criterion, i) => {
      boundedText(`acceptanceCriteria[${i}]`, criterion, problems);
    });
  }
  sortedStringList("requirementIds", record["requirementIds"], problems, (entry) =>
    isRequirementId(entry) ? null : "must be a CAM-AREA-NN requirement id",
  );
  sortedStringList("dependsOn", record["dependsOn"], problems, (entry) =>
    entry.trim().length > 0 && entry.length <= PLAN_MAX_TEXT_LENGTH
      ? null
      : "must be a durable issue id",
  );
  if (Array.isArray(record["dependsOn"]) && record["dependsOn"].includes(record["issueId"])) {
    problems.push("dependsOn must not contain the contract's own issueId");
  }
  const interfaces = record["interfaces"];
  if (!Array.isArray(interfaces)) {
    problems.push("interfaces must be an array");
  } else {
    if (interfaces.length > PLAN_MAX_LIST_LENGTH) {
      problems.push(`interfaces exceeds ${PLAN_MAX_LIST_LENGTH} entries`);
    }
    problems.push(...arrayHoleProblems("interfaces", interfaces));
    interfaces.forEach((entry, i) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        problems.push(`interfaces[${i}] must be an object`);
        return;
      }
      const iface = entry as Record<string, unknown>;
      boundedText(`interfaces[${i}].name`, iface["name"], problems);
      boundedText(`interfaces[${i}].description`, iface["description"], problems);
      if (
        typeof iface["kind"] !== "string" ||
        !(INTERFACE_KINDS as readonly string[]).includes(iface["kind"])
      ) {
        problems.push(`interfaces[${i}].kind must be one of ${INTERFACE_KINDS.join(", ")}`);
      }
      const extra = Object.keys(iface).filter((k) => !["name", "kind", "description"].includes(k));
      for (const key of extra)
        problems.push(`interfaces[${i}] has unknown field ${JSON.stringify(key)}`);
    });
  }
  if (!isIsoInstant(record["frozenAt"])) {
    problems.push("frozenAt must be an ISO-8601 UTC instant (toISOString form)");
  }
  boundedText("approvedBy", record["approvedBy"], problems);
  const hash = record["contractHash"];
  if (typeof hash !== "string" || !isSha256Hex(hash)) {
    problems.push(`contractHash must match /${SHA256_HEX_PATTERN_SOURCE}/`);
  } else if (problems.length === 0) {
    // Only recompute over a structurally sound record — the cast is licensed
    // by every check above having passed. TOTAL even so: a value the
    // canonicalizer refuses becomes a named problem, never a throw
    // (r1 finding 7).
    try {
      const recomputed = contractHash(contractTermsOf(value as IssueContract));
      if (recomputed !== hash) {
        problems.push(
          `contractHash ${hash} does not match the recomputed terms hash ${recomputed} — ` +
            "the record's terms and its hash disagree",
        );
      }
    } catch (error) {
      problems.push(`terms have no canonical JSON form: ${(error as Error).message}`);
    }
  }
  const allowed = [
    "schemaVersion",
    "missionId",
    "issueId",
    "version",
    "template",
    "title",
    "goal",
    "acceptanceCriteria",
    "requirementIds",
    "dependsOn",
    "interfaces",
    "contractHash",
    "frozenAt",
    "approvedBy",
  ];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) problems.push(`unknown field ${JSON.stringify(key)}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Contract references (CAM-PLAN-04: every attempt/PR references its hash)
// ---------------------------------------------------------------------------

/**
 * The reference an artifact carries to the contract it was produced under.
 * The hash is the binding; issueId and version make it resolvable and
 * human-readable without a store lookup.
 */
export interface ContractRef {
  readonly issueId: string;
  readonly contractVersion: number;
  readonly contractHash: string;
}

/** Total validator for a ContractRef; empty result licenses the cast. */
export function contractRefProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["contractRef must be a plain object"];
  }
  const record = value as Record<string, unknown>;
  const problems: string[] = [];
  boundedText("contractRef.issueId", record["issueId"], problems);
  const version = record["contractVersion"];
  // SAFE integer, not merely integer (review r6 finding 8): 2^53, 1.8e308, and a
  // JSON literal like 9007199254740993 are all `Number.isInteger` yet lose
  // precision on parse — an identity-bearing version that silently CHANGES across
  // a store round-trip. Number.isSafeInteger also excludes ±Infinity and NaN.
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    problems.push("contractRef.contractVersion must be a safe integer >= 1");
  }
  const hash = record["contractHash"];
  if (typeof hash !== "string" || !isSha256Hex(hash)) {
    problems.push(`contractRef.contractHash must match /${SHA256_HEX_PATTERN_SOURCE}/`);
  }
  for (const key of Object.keys(record)) {
    if (!["issueId", "contractVersion", "contractHash"].includes(key)) {
      problems.push(`contractRef has unknown field ${JSON.stringify(key)}`);
    }
  }
  return problems;
}

/**
 * The artifacts that owe a ContractRef (CAM-PLAN-04 "every attempt and PR
 * references its contract hash"), pinned as data so each consuming WP's
 * suite asserts the obligation it owes instead of re-deriving the rule.
 * WP-110 discharges the first row at freeze time; the later rows bind when
 * their artifact class lands.
 */
export const CONTRACT_REFERENCE_OBLIGATIONS: readonly string[] = Object.freeze([
  "issue-created event payload carries { contractVersion, contractHash } (WP-110, at freeze)",
  "attempt records carry a ContractRef for the contract they execute (WP-114 dispatch)",
  "issue PRs embed their ContractRef in the PR body (WP-120 PR lifecycle; enforced at push by WP-119)",
  "mission PRs embed the ContractRef set of their issues (WP-120 PR lifecycle; enforced at push by WP-119)",
  "evidence packets carry the ContractRef their evidence binds to (WP-116)",
  "context packs cite the ContractRef they were assembled against (WP-113)",
]);
