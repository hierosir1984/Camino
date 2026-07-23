/**
 * Attempt-lease / environment-fencing interface (WP-114, CAM-STATE-04;
 * PRD §5 registry item 5 verbatim).
 *
 * This module is the NAMED cross-package contract half: types, closed
 * constant sets, result codes, and pure helpers. The daemon owns the data
 * half (packages/daemon/src/scheduler/lease-store.ts — SQLite persistence,
 * monotonic generations, adoption verification). It is designed as a
 * DURABLE seam: WP-115's validation runner presents lease generations on
 * every environment operation through exactly this interface, and any
 * future janitor (CAM-STATE-07 [P2]) honors generations through it too.
 *
 * The invariants, stated once (registry item 5 / CAM-STATE-04):
 *
 *   - Lease generations are MONOTONIC per environment and persisted in
 *     SQLite. A generation is never reused, never decremented.
 *   - Heartbeat every 30 s; TTL 5 min. A heartbeat lapse greater than the
 *     TTL EXPIRES the lease's liveness claim — but expiry alone never
 *     re-grants: RE-GRANT ONLY AFTER KILL-CONFIRM. The holder may still be
 *     running (a slow daemon loop is not a dead worker), so the environment
 *     stays fenced to the current generation until a kill-confirm is
 *     recorded for it.
 *   - EVERY environment operation presents its generation
 *     (`admitOperation`); stale-generation writes are rejected — a fenced
 *     former owner cannot touch the environment after ownership moved.
 *   - Exactly one fenced owner per validation environment at any time:
 *     `grant` refuses while any lease of that environment is `held`,
 *     whatever its heartbeat says.
 *
 * Failure results are TYPED VALUES, not throws: lease contention is a
 * normal scheduling outcome the caller routes on (queue, kill-confirm,
 * escalate), never an exception path. Throws are reserved for malformed
 * inputs and store-integrity refusals.
 */

import type { DispatchOutcome, LeaseReleaseContext } from "./adapter.js";

/** Heartbeat cadence while an attempt runs (CAM-STATE-04: "heartbeat 30s"). */
export const LEASE_HEARTBEAT_MS = 30_000;

/** Heartbeat lapse beyond which a lease is expired (CAM-STATE-04: "TTL 5min"). */
export const LEASE_TTL_MS = 300_000;

/**
 * The lifecycle states of one lease row (one (environment, generation)
 * pair). `held` is the only state that admits operations; both terminal
 * states are absorbing.
 *
 *   held           — the fenced owner; operations presenting this
 *                    generation are admitted.
 *   released       — settled cleanly by the dispatch lifecycle, strictly
 *                    after the worker process group was confirmed gone
 *                    (the WP-105 LeaseHandle ordering guarantee).
 *   kill-confirmed — settled by an explicit kill-confirm (TTL expiry path,
 *                    recovery path, budget-breach path). Also the state a
 *                    NEVER-SPAWNED dispatch's lease reaches when recovery
 *                    proves nothing ran (see KillConfirmSource).
 */
export const LEASE_STATES = Object.freeze(["held", "released", "kill-confirmed"] as const);
export type LeaseState = (typeof LEASE_STATES)[number];

/**
 * Where a kill-confirm's evidence came from. Recorded so "re-grant only
 * after kill-confirm" is auditable — every re-grant can point at the
 * confirm that licensed it.
 *
 *   process-group — the WP-105 kill-confirm sequence confirmed the worker
 *                   process GROUP gone (group scope; the container closes
 *                   the tree — AMEND-10).
 *   container     — the container was confirmed gone (kill the container ⇒
 *                   every namespaced pid is reaped — WP-107 CAM-EXEC-02).
 *   never-spawned — recovery proved no worker was ever spawned under this
 *                   lease: the dispatch protocol spawns strictly AFTER the
 *                   attempt-dispatched record is durable, so a lease whose
 *                   attempt record does not exist confirms trivially.
 */
export const KILL_CONFIRM_SOURCES = Object.freeze([
  "process-group",
  "container",
  "never-spawned",
] as const);
export type KillConfirmSource = (typeof KILL_CONFIRM_SOURCES)[number];

/** A granted lease: what the holder presents on every environment operation. */
export interface LeaseGrant {
  readonly environmentId: string;
  /** Monotonic per environment, >= 1 (A.3#1 records it). */
  readonly generation: number;
  readonly holderAttemptId: string;
  /** ISO-8601 UTC instant of the grant. */
  readonly grantedAt: string;
}

/** The full inspectable view of one lease row. */
export interface EnvironmentLeaseView extends LeaseGrant {
  readonly state: LeaseState;
  /** ISO-8601 UTC instant of the newest heartbeat (grantedAt initially). */
  readonly heartbeatAt: string;
  /** Present iff state is `released`: the dispatch outcome it settled with. */
  readonly releasedOutcome?: DispatchOutcome;
  /** Present iff state is `kill-confirmed`. */
  readonly killConfirmedAt?: string;
  readonly killConfirmSource?: KillConfirmSource;
}

/** Why a grant was refused (typed contention, never an exception). */
export type GrantResult =
  | { readonly ok: true; readonly lease: LeaseGrant }
  | {
      /**
       * A live fenced owner exists: its heartbeat is within the TTL. The
       * caller waits or queues; nothing may be killed on this signal alone.
       */
      readonly ok: false;
      readonly code: "held-live";
      readonly holder: EnvironmentLeaseView;
    }
  | {
      /**
       * The current lease's heartbeat lapsed past the TTL but no
       * kill-confirm is recorded: RE-GRANT ONLY AFTER KILL-CONFIRM
       * (CAM-STATE-04). The caller must run the kill-confirm sequence
       * (process-group or container scope) and record it, then re-grant.
       */
      readonly ok: false;
      readonly code: "kill-confirm-required";
      readonly holder: EnvironmentLeaseView;
    };

/** Result of a heartbeat or an operation-admission check (the fencing gate). */
export type FenceResult =
  | { readonly ok: true }
  | {
      /**
       * The presented generation is not the environment's current one —
       * the stale-generation write rejection CAM-STATE-04 requires.
       */
      readonly ok: false;
      readonly code: "stale-generation";
      readonly currentGeneration: number | null;
    }
  | {
      /** The generation is current but its lease is no longer `held`. */
      readonly ok: false;
      readonly code: "not-held";
      readonly state: LeaseState;
    };

/** Result of a release or kill-confirm settlement. */
export type SettleResult =
  | { readonly ok: true; readonly lease: EnvironmentLeaseView }
  | {
      readonly ok: false;
      readonly code: "stale-generation";
      readonly currentGeneration: number | null;
    }
  | { readonly ok: false; readonly code: "already-settled"; readonly state: LeaseState };

/**
 * One lease recovery finds fenced-pending-kill-confirm: held, heartbeat
 * lapsed past the TTL. Recovery REPORTS these — it never auto-confirms a
 * kill it did not execute (the worker may still be running; kill-confirm
 * is an action, not an assumption). The exception recovery may take
 * itself is `never-spawned` (see KillConfirmSource).
 */
export interface LapsedLease {
  readonly lease: EnvironmentLeaseView;
  /** Milliseconds since the newest heartbeat, at inspection time. */
  readonly lapsedMs: number;
}

export interface LeaseRecoveryReport {
  /** Held leases whose heartbeat is within the TTL (possibly still live). */
  readonly heldLive: readonly EnvironmentLeaseView[];
  /** Held leases past the TTL: fenced; kill-confirm required before re-grant. */
  readonly lapsed: readonly LapsedLease[];
}

/**
 * The lease/environment store seam (CAM-STATE-04). Implemented by the
 * daemon's SqliteLeaseStore; consumed by the WP-114 scheduler (attempt
 * leases), the WP-115 validation runner (environment operations present
 * generations through `admitOperation`), and any future janitor
 * (CAM-STATE-07) — which must route every environment mutation through
 * `admitOperation` under a granted lease, exactly like an attempt.
 */
export interface EnvironmentLeaseStore {
  /**
   * Grant the environment's next generation to `holderAttemptId`. Refuses
   * while any lease of the environment is `held` — live (`held-live`) or
   * lapsed (`kill-confirm-required`). Exactly one fenced owner.
   */
  grant(environmentId: string, holderAttemptId: string): GrantResult;

  /** Refresh the holder's heartbeat. Stale generations are rejected. */
  heartbeat(environmentId: string, generation: number): FenceResult;

  /**
   * The fencing gate: is an environment operation presenting `generation`
   * admitted right now? EVERY environment operation calls this before
   * touching the environment (CAM-STATE-04 "every environment operation
   * presents its generation; stale-generation writes are rejected").
   */
  admitOperation(environmentId: string, generation: number): FenceResult;

  /**
   * Settle a lease cleanly. Callers uphold the WP-105 LeaseHandle ordering
   * guarantee: release only after the worker process group is confirmed
   * gone (`ctx.groupGone` is literally true by construction).
   */
  release(environmentId: string, generation: number, ctx: LeaseReleaseContext): SettleResult;

  /**
   * Record a kill-confirm for a lease (TTL-expiry, budget-breach, or
   * recovery settlement). This — and only this — licenses a re-grant of an
   * un-released environment.
   */
  recordKillConfirm(
    environmentId: string,
    generation: number,
    source: KillConfirmSource,
  ): SettleResult;

  /** The newest lease row for an environment, or undefined if none ever. */
  current(environmentId: string): EnvironmentLeaseView | undefined;

  /** Every environment's newest lease row (inspection surface). */
  listCurrent(): EnvironmentLeaseView[];

  /**
   * Recovery inspection (CAM-STATE-06 lease clause): classify every held
   * lease as live or lapsed. Reports; never mutates — fencing is already
   * the store's steady state (a lapsed lease refuses re-grant until
   * kill-confirm regardless of whether this ran).
   */
  inspectRecovered(now?: Date): LeaseRecoveryReport;
}

/** Has this lease's heartbeat lapsed past the TTL at `nowMs`? Pure. */
export function leaseLapsed(
  lease: Pick<EnvironmentLeaseView, "heartbeatAt" | "state">,
  nowMs: number,
  ttlMs: number = LEASE_TTL_MS,
): boolean {
  if (lease.state !== "held") return false;
  const beat = Date.parse(lease.heartbeatAt);
  if (Number.isNaN(beat)) return true; // unreadable evidence fails closed: treat as lapsed
  return nowMs - beat > ttlMs;
}

/**
 * Validate an environment id: bounded, well-formed, no NUL (the SQLite
 * TEXT round-trip guard every WP-103 store applies). Empty result licenses
 * use as a store key.
 */
export function environmentIdProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== "string" || value.length === 0) {
    return ["environmentId must be a non-empty string"];
  }
  if (value.length > 200) problems.push("environmentId exceeds 200 UTF-16 units");
  if (!value.isWellFormed()) problems.push("environmentId contains unpaired surrogates");
  if (value.includes("\0")) problems.push("environmentId contains an embedded NUL");
  return problems;
}

/**
 * The v1 validation-environment identity for a repo: the two lanes of one
 * repo (primary mission + urgent quick task) share the repo's validation
 * environment, so the lease additionally serializes attempts ACROSS lanes
 * on the environment itself — one fenced owner, whichever lane dispatched.
 * WP-115 binds real environments to this id.
 */
export function validationEnvironmentId(repoId: string): string {
  const problems = environmentIdProblems(repoId);
  if (problems.length > 0) {
    throw new TypeError(`repoId is not a valid environment key: ${problems.join("; ")}`);
  }
  return `validation:${repoId}`;
}
