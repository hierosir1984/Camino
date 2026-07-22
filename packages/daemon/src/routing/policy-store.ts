/**
 * Per-project routing policy store (WP-106, CAM-ROUTE-02): the
 * user-editable role × task-features → (harness, model, reasoning tier)
 * table, with per-project provider allowlists.
 *
 * Semantics, stated exactly:
 *
 *   - A project with no stored row routes on DEFAULT_POLICY_TABLE (the
 *     shipped, cross-family-by-construction defaults). Storing a table is
 *     the edit; resetting deletes the row and returns the project to the
 *     defaults. Module-level today; the HTTP/GUI shell mounts these
 *     operations later (the WP-103 intake precedent).
 *   - Writes are validated STRUCTURALLY and refused with precise reasons
 *     on any defect (unknown role/harness/tier, missing cells, allowlist
 *     inconsistencies) — a malformed table is never persisted.
 *   - Cross-family geometry (crossFamilyViolations) is measured, RECORDED
 *     in the returned result, and re-reported on every read — but a
 *     violating edit is ACCEPTED. Rationale: the table is user policy, and
 *     a per-project allowlist can make cross-family assignments
 *     unsatisfiable (one allowlisted family); the requirements the
 *     geometry serves (CAM-PLAN-03, CAM-VAL-06a/b) are enforced where they
 *     bind — the plan-approval and merge gates — which fail loudly rather
 *     than silently accepting same-family review. The store's job is to
 *     make the trade-off visible, never to hide it.
 *   - Reads are fail-closed: a stored row that no longer parses or
 *     validates (hand-edited database, schema drift) throws rather than
 *     routing from a malformed table (the WP-109 adoption-verification
 *     pattern).
 */
import Database from "better-sqlite3";
import {
  DEFAULT_POLICY_TABLE,
  crossFamilyViolations,
  deepFreeze,
  resolveAssignment,
  validatePolicyTable,
} from "@camino/shared";
import type {
  CrossFamilyViolation,
  PolicyAssignment,
  PolicyTable,
  PolicyViolation,
  RoutingRole,
  TaskFeatures,
} from "@camino/shared";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS routing_policies (
  project_id  TEXT PRIMARY KEY CHECK (length(project_id) > 0),
  table_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL CHECK (length(updated_by) > 0)
);
`;

interface PolicyRow {
  project_id: string;
  table_json: string;
  updated_at: string;
  updated_by: string;
}

/** Result of a policy-table write. */
export type SetPolicyResult =
  | {
      readonly ok: true;
      /** Cross-family properties the accepted table trades away (recorded, never silent). */
      readonly crossFamilyViolations: readonly CrossFamilyViolation[];
    }
  | {
      readonly ok: false;
      readonly code: "invalid-table" | "invalid-request";
      readonly reason: string;
      readonly violations: readonly PolicyViolation[];
    };

/** A policy read: the effective table plus where it came from. */
export interface EffectivePolicy {
  readonly source: "default" | "project";
  readonly table: PolicyTable;
  readonly crossFamilyViolations: readonly CrossFamilyViolation[];
  /** Present exactly when source is "project". */
  readonly updatedAt?: string;
  readonly updatedBy?: string;
}

export interface RoutingPolicyStoreOptions {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

/** Exact-retention guard shared with the WP-103 stores: reject strings SQLite TEXT cannot hold faithfully. */
function assertRoundTripExact(field: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (!value.isWellFormed()) {
    throw new TypeError(`${field} contains unpaired surrogate code units`);
  }
  if (value.includes("\0")) {
    throw new TypeError(`${field} contains an embedded NUL, which SQLite TEXT cannot hold`);
  }
}

export class RoutingPolicyStore {
  readonly #db: Database.Database;
  readonly #now: () => Date;
  readonly #upsert: Database.Statement;
  readonly #select: Database.Statement;
  readonly #remove: Database.Statement;

  constructor(path: string, options: RoutingPolicyStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#db = new Database(path);
    // Every refusal path closes the native handle (WP-104 store pattern).
    try {
      this.#db.pragma("journal_mode = WAL");
      const encoding = this.#db.pragma("encoding", { simple: true }) as string;
      if (encoding !== "UTF-8") {
        throw new Error(
          `routing-policy store ${path} uses encoding ${encoding}; expected UTF-8 — refusing to open`,
        );
      }
      const version = this.#db.pragma("user_version", { simple: true }) as number;
      if (version === 0) {
        this.#db.exec(SCHEMA);
        this.#db.pragma(`user_version = ${SCHEMA_VERSION}`);
      } else if (version !== SCHEMA_VERSION) {
        throw new Error(
          `routing-policy store ${path} has schema version ${version}; this daemon expects ${SCHEMA_VERSION}`,
        );
      }
      this.#upsert = this.#db.prepare(
        `INSERT INTO routing_policies (project_id, table_json, updated_at, updated_by)
         VALUES (@projectId, @tableJson, @updatedAt, @updatedBy)
         ON CONFLICT (project_id) DO UPDATE SET
           table_json = excluded.table_json,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      );
      this.#select = this.#db.prepare("SELECT * FROM routing_policies WHERE project_id = ?");
      this.#remove = this.#db.prepare("DELETE FROM routing_policies WHERE project_id = ?");
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  /**
   * Store a project's policy table (the user edit). Structural defects
   * refuse the write with every violation listed; an accepted write
   * returns the cross-family properties the table trades away, if any.
   *
   * Ordering matters (round-1 review finding 3): the candidate is
   * serialized FIRST and every check — structural validation and the
   * cross-family measurement — runs on the parsed round-trip, i.e. the
   * exact snapshot future reads will see. A live object whose getters,
   * toJSON handler, or prototype-inherited fields present one shape to
   * validation and serialize to another therefore cannot be persisted:
   * nothing is written until every check has passed on the snapshot.
   */
  setPolicyTable(projectId: string, candidate: unknown, actor: string): SetPolicyResult {
    try {
      assertRoundTripExact("projectId", projectId);
      assertRoundTripExact("actor", actor);
    } catch (error) {
      return {
        ok: false,
        code: "invalid-request",
        reason: (error as Error).message,
        violations: [],
      };
    }
    let tableJson: string | undefined;
    try {
      tableJson = JSON.stringify(candidate);
    } catch (error) {
      return {
        ok: false,
        code: "invalid-table",
        reason: `policy table is not JSON-serializable: ${(error as Error).message}`,
        violations: [],
      };
    }
    if (typeof tableJson !== "string") {
      return {
        ok: false,
        code: "invalid-table",
        reason: "policy table must serialize to JSON",
        violations: [],
      };
    }
    const snapshot: unknown = JSON.parse(tableJson);
    const violations = validatePolicyTable(snapshot);
    if (violations.length > 0) {
      return {
        ok: false,
        code: "invalid-table",
        reason: `policy table refused: ${violations.length} structural violation(s)`,
        violations,
      };
    }
    const recordedViolations = crossFamilyViolations(snapshot as PolicyTable);
    const updatedAt = this.#now().toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T/.test(updatedAt)) {
      throw new TypeError("routing-policy clock must yield a valid Date");
    }
    this.#upsert.run({ projectId, tableJson, updatedAt, updatedBy: actor });
    return { ok: true, crossFamilyViolations: recordedViolations };
  }

  /** Delete a project's stored table, returning it to the shipped defaults. */
  resetToDefault(projectId: string): void {
    assertRoundTripExact("projectId", projectId);
    this.#remove.run(projectId);
  }

  /**
   * The effective policy for a project: its stored table, or the shipped
   * defaults when none is stored. Fail-closed on a malformed stored row.
   */
  getEffectivePolicy(projectId: string): EffectivePolicy {
    assertRoundTripExact("projectId", projectId);
    const row = this.#select.get(projectId) as PolicyRow | undefined;
    if (row === undefined) {
      return {
        source: "default",
        table: DEFAULT_POLICY_TABLE,
        crossFamilyViolations: crossFamilyViolations(DEFAULT_POLICY_TABLE),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.table_json);
    } catch {
      throw new Error(
        `stored routing policy for project ${projectId} is not valid JSON — refusing to route from it`,
      );
    }
    const violations = validatePolicyTable(parsed);
    if (violations.length > 0) {
      throw new Error(
        `stored routing policy for project ${projectId} fails validation (${violations.length} violation(s)) — ` +
          `refusing to route from it: ${violations
            .slice(0, 5)
            .map((v) => `${v.path}: ${v.reason}`)
            .join("; ")}`,
      );
    }
    const table = deepFreeze(parsed as PolicyTable);
    return {
      source: "project",
      table,
      crossFamilyViolations: crossFamilyViolations(table),
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  /**
   * The routing decision for one role under one project's effective policy
   * (the WP-114 dispatch lookup): role × task features → (harness, model,
   * reasoning tier), with the policy's provenance and the recorded
   * cross-family trade-offs OF THE RESOLVED CELL attached — so a dispatcher
   * sees at lookup time what the edited policy gave up, rather than only on
   * the edit path (round-1 review finding 9).
   *
   * NAMED BOUNDARY: this is a POLICY lookup. Composing it with live
   * enablement (capability registry), window estimates (tracker), lease
   * state, and failure/family-switch counters is the WP-114 scheduler's —
   * that component owns those stores and the dispatch decision; this store
   * deliberately does not reach into them.
   */
  resolve(
    projectId: string,
    role: RoutingRole,
    features: TaskFeatures,
  ): {
    readonly assignment: PolicyAssignment;
    readonly source: "default" | "project";
    readonly crossFamilyViolations: readonly CrossFamilyViolation[];
  } {
    const policy = this.getEffectivePolicy(projectId);
    return {
      assignment: resolveAssignment(policy.table, role, features),
      source: policy.source,
      crossFamilyViolations: policy.crossFamilyViolations.filter(
        (violation) =>
          violation.template === features.template && violation.riskTier === features.riskTier,
      ),
    };
  }
}
