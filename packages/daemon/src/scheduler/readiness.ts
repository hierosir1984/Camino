/**
 * Dependency readiness + dispatch order (WP-114, CAM-PLAN-12): an issue is
 * ready when all its dependencies are merged into the mission branch; v1
 * executes issues SEQUENTIALLY per mission in dependency order.
 *
 * Pure functions over the WP-110 contracts (dependsOn edges) and the
 * recorder's derived issue states. Everything here recomputes FRESH from
 * the LATEST contract versions on every call — that is the CAM-PLAN-12
 * "re-checks dependent readiness before re-dispatch" property: a contract
 * edit that changes edges (v n+1) changes the very next decision, because
 * no readiness fact is ever cached across decisions.
 *
 * Dependencies on issues OUTSIDE the contract set are counted as UNMET
 * (fail-closed): a contract naming an edge the plan does not contain can
 * never make its issue dispatchable.
 */
import type { IssueContract } from "@camino/shared";

/** The per-issue slice of the recorder's view this module consumes. */
export interface IssueStateSnapshot {
  readonly state: string;
  readonly failureCount: number;
}

/**
 * Reduce a mission's contracts to the LATEST version per issue. The store
 * returns every version (contract versions are immutable; edits append);
 * scheduling always reasons over the newest edges.
 */
export function latestContracts(contracts: readonly IssueContract[]): Map<string, IssueContract> {
  const latest = new Map<string, IssueContract>();
  for (const contract of contracts) {
    const existing = latest.get(contract.issueId);
    if (existing === undefined || contract.version > existing.version) {
      latest.set(contract.issueId, contract);
    }
  }
  return latest;
}

/**
 * Deterministic dependency order over the latest contracts: Kahn's
 * topological sort with lexicographic issueId tie-break. A cycle is
 * REFUSED loudly — plans validate acyclic at approval (CAM-PLAN-11), so a
 * cycle here means the store's contracts are not the approved plan.
 */
export function dependencyOrder(latest: ReadonlyMap<string, IssueContract>): string[] {
  const ids = [...latest.keys()].sort();
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const id of ids) {
    const contract = latest.get(id) as IssueContract;
    for (const dep of contract.dependsOn) {
      if (!latest.has(dep)) continue; // outside the set: readiness counts it unmet; order ignores it
      indegree.set(id, (indegree.get(id) as number) + 1);
      (dependents.get(dep) as string[]).push(id);
    }
  }
  const queue = ids.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    queue.sort();
    const next = queue.shift() as string;
    order.push(next);
    for (const dependent of dependents.get(next) as string[]) {
      const remaining = (indegree.get(dependent) as number) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }
  if (order.length !== ids.length) {
    const stuck = ids.filter((id) => !order.includes(id));
    throw new Error(
      `dependency cycle among issues ${stuck.join(", ")} — plans validate acyclic at approval ` +
        "(CAM-PLAN-11); these contracts are not an approved plan's edges",
    );
  }
  return order;
}

/**
 * The issue ids among `contract.dependsOn` not yet MERGED. An edge naming
 * an issue outside the contract set counts as unmet (fail-closed).
 */
export function unmetDependencies(
  contract: IssueContract,
  latest: ReadonlyMap<string, IssueContract>,
  stateOf: (issueId: string) => IssueStateSnapshot | undefined,
): string[] {
  const unmet: string[] = [];
  for (const dep of contract.dependsOn) {
    if (!latest.has(dep)) {
      unmet.push(dep);
      continue;
    }
    if (stateOf(dep)?.state !== "merged") unmet.push(dep);
  }
  return unmet;
}

/** Issue ids whose LATEST contract depends (directly) on `issueId`. */
export function dependentsOf(
  latest: ReadonlyMap<string, IssueContract>,
  issueId: string,
): string[] {
  const out: string[] = [];
  for (const [id, contract] of latest) {
    if (contract.dependsOn.includes(issueId)) out.push(id);
  }
  return out.sort();
}

/** Why the scheduler is not dispatching right now (visible idleness). */
export type DispatchHold =
  | { readonly kind: "no-contracts" }
  | { readonly kind: "attempt-active"; readonly issueId: string }
  | { readonly kind: "no-ready-issue" }
  | {
      /** The first dependency-ordered ready issue, with its unmet edges re-checked. */
      readonly kind: "ready-issue-has-unmet-deps";
      readonly issueId: string;
      readonly unmet: readonly string[];
    };

export type DispatchSelection =
  | { readonly ok: true; readonly issueId: string; readonly contract: IssueContract }
  | { readonly ok: false; readonly hold: DispatchHold };

/** Issue states that mean an attempt is in flight for the mission (the
 * sequential-per-mission slot is TAKEN). `claimed` counts: its attempt is
 * `running` from the A.3#1 creation row. */
const ATTEMPT_IN_FLIGHT_STATES: readonly string[] = ["claimed", "implementing", "validating"];

/**
 * Select the next dispatchable issue, or say precisely why there is none:
 *
 *   1. the sequential slot must be free — no issue of the mission in an
 *      attempt-bearing state ("at no time do two attempts run for one
 *      mission");
 *   2. issues are considered in DEPENDENCY ORDER; the first one in `ready`
 *      is the candidate;
 *   3. the candidate's dependency edges are RE-CHECKED against the latest
 *      contracts at this instant — a `ready` recorded before a contract
 *      edit does not survive the edit unexamined (CAM-PLAN-12's
 *      contract-edit acceptance).
 */
export function selectNextDispatch(
  contracts: readonly IssueContract[],
  stateOf: (issueId: string) => IssueStateSnapshot | undefined,
): DispatchSelection {
  const latest = latestContracts(contracts);
  if (latest.size === 0) return { ok: false, hold: { kind: "no-contracts" } };
  for (const issueId of latest.keys()) {
    const state = stateOf(issueId)?.state;
    if (state !== undefined && ATTEMPT_IN_FLIGHT_STATES.includes(state)) {
      return { ok: false, hold: { kind: "attempt-active", issueId } };
    }
  }
  const order = dependencyOrder(latest);
  for (const issueId of order) {
    if (stateOf(issueId)?.state !== "ready") continue;
    const contract = latest.get(issueId) as IssueContract;
    const unmet = unmetDependencies(contract, latest, stateOf);
    if (unmet.length > 0) {
      // A recorded `ready` the current edges do not support: surfaced as a
      // hold, never dispatched (the contract-edit re-check, CAM-PLAN-12).
      return { ok: false, hold: { kind: "ready-issue-has-unmet-deps", issueId, unmet } };
    }
    return { ok: true, issueId, contract };
  }
  return { ok: false, hold: { kind: "no-ready-issue" } };
}
