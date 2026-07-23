/**
 * Attempt scheduler (WP-114): dependency-ordered sequential dispatch per
 * mission (CAM-PLAN-12), attempt leases with fencing (CAM-STATE-04),
 * quota-aware pausing (CAM-ROUTE-06), structured failure handoff
 * (CAM-PLAN-09), and the WP-107 outcome routing (killed-budget →
 * escalate, never auto-retry; unconfirmed kill → the A.2 cleanup-failed
 * path). Dispatch selects (harness, model, tier) from the WP-106 policy
 * table.
 *
 * THE DURABLE DISPATCH PROTOCOL, in order, each step durable before the
 * next (kill hooks name every gap; the chaos suite kills in all of them):
 *
 *   1. lease grant (SQLite; monotonic generation)   [scheduler-after-lease-granted]
 *   2. issue `dispatched` A.2#3 → claimed           [scheduler-after-issue-claimed]
 *   3. attempt `attempt-dispatched` A.3#1 → running [scheduler-after-attempt-recorded]
 *      — the payload carries the ContractRef (CAM-PLAN-04 attempt half)
 *        and the policy assignment (CAM-ROUTE-02 output tuple)
 *   4. issue `worker-started` A.2#6 → implementing  [scheduler-after-worker-started]
 *   5. ONLY NOW does the runner spawn the worker (dispatch/lifecycle).
 *
 * PROTOCOL INVARIANT the recovery pass leans on: the worker is spawned
 * strictly AFTER step 4 is durable. Recovery finding a claimed issue
 * without step 3, or steps 3–4 incomplete, therefore KNOWS nothing was
 * spawned and can settle the lease with a `never-spawned` kill-confirm;
 * an interrupted attempt at or past step 4 is NEVER assumed dead — it is
 * reported for a real (container / process-group) kill-confirm first
 * (re-grant only after kill-confirm, CAM-STATE-04).
 *
 * On the outcome side, `recordOutcome` is IDEMPOTENT per attempt: the
 * window observation and the structured summary replay by content, and the
 * state-machine records are guarded by the attempt's current state — a
 * crash anywhere in the sequence re-runs to the same end state.
 *
 * The mission-lane interaction (AMEND-7 / WP-103): this scheduler NEVER
 * computes lane facts — it reads the recorder's mission state and refuses
 * to dispatch unless the mission is literally in `executing` (the A.2#3
 * guard). A primary mission parked by the urgent lane (`paused-urgent`),
 * or queued behind another mission, dispatches nothing; the
 * SerializationScheduler's tested policies stand unchanged.
 */
import type {
  AttemptBudget,
  AttemptSummary,
  ContractRef,
  DispatchRecord,
  EnvironmentLeaseStore,
  GrantResult,
  IssueContract,
  KillConfirmSource,
  LeaseGrant,
  LeaseHandle,
  PolicyAssignment,
  PolicyTable,
  ProviderFamily,
  SummaryAttemptTerminal,
  TaskFeatures,
} from "@camino/shared";
import type { ProviderWindowState, WindowConsumptionEstimate } from "../routing/window-tracker.js";
import {
  ATTEMPT_SUMMARY_SCHEMA_VERSION,
  HARNESS_FAMILY,
  LEASE_HEARTBEAT_MS,
  PROVIDER_FAMILIES,
  QUOTA_PAUSE_THRESHOLD,
  harnessFamily,
  resolveAssignment,
  summaryHeadline,
  validationEnvironmentId,
} from "@camino/shared";
import type { OfficialAdapterName } from "@camino/shared";
import type { EventStore } from "@camino/shared";
import { retryPolicy } from "@camino/core";
import type { SqliteDomainStore } from "../domain-store.js";
import { processGroupConfirmedGone } from "../dispatch/lifecycle.js";
import type { RecordOutcome, TransitionRecorder } from "../transition-recorder.js";
import { SCHEDULER_ACTOR } from "../serialization-scheduler.js";
import type { AttemptSummaryStore } from "./summary-store.js";
import {
  latestContracts,
  selectNextDispatch,
  type DispatchHold,
  type IssueStateSnapshot,
} from "./readiness.js";

/**
 * Resume policy for a provider with NO recorded window shape after an
 * exhaustion (the QuotaWindowTracker's stated boundary: "resuming on
 * evidence is the WP-114 scheduler's policy"): dispatch stays paused for
 * this long after the last quota-blocked outcome, then ONE probe dispatch
 * is allowed — its result becomes the evidence (a success synthesizes a
 * recovery gap; another exhaustion re-pins).
 */
export const QUOTA_PROBE_BACKOFF_MS = 15 * 60_000;

/** The window-tracker slice this scheduler consumes (WP-106). */
export interface WindowStateReader {
  windowState(family: ProviderFamily, options?: { now?: Date }): ProviderWindowState;
  recordDispatch(
    family: ProviderFamily,
    input: {
      dispatchId: string;
      outcome: DispatchRecord["outcome"];
      durationMs: number;
      quotaSignalSeen: boolean;
      at?: Date;
    },
  ): unknown;
}

/** Why dispatch is quota-paused for a family (CAM-ROUTE-06). */
export type QuotaPause =
  | {
      readonly reason: "window-threshold";
      /** The first window at or past QUOTA_PAUSE_THRESHOLD (or pinned at 1). */
      readonly estimate: WindowConsumptionEstimate;
    }
  | {
      /** Exhausted with no shape evidence: reset horizon unknown; probe after backoff. */
      readonly reason: "exhausted-horizon-unknown";
      readonly lastQuotaBlockedAt: string;
      readonly probeAfter: string;
    };

/** Everything the runner needs to execute one dispatched attempt. */
export interface AttemptDispatchPlan {
  readonly missionId: string;
  readonly repoId: string;
  readonly issueId: string;
  readonly attemptId: string;
  readonly environmentId: string;
  readonly lease: LeaseGrant;
  readonly contractRef: ContractRef;
  readonly assignment: PolicyAssignment;
  readonly family: ProviderFamily;
  readonly features: TaskFeatures;
  readonly budget: AttemptBudget;
  /** True when CAM-PLAN-09 family switching overrode the table's harness. */
  readonly familySwitched: boolean;
  /**
   * True when the switch was DUE (>= 2 failures) but the allowlist offers
   * no other family — recorded honestly, never silently.
   */
  readonly familySwitchUnavailable?: true;
}

export type DispatchDecision =
  | { readonly kind: "dispatch"; readonly plan: AttemptDispatchPlan }
  | {
      readonly kind: "idle";
      readonly reason: "mission-not-executing";
      readonly missionState: string | undefined;
    }
  | { readonly kind: "held"; readonly hold: DispatchHold }
  | {
      /** Recorded as A.2#4 (ready → queued-quota): the wait is visible, never a failure. */
      readonly kind: "quota-paused";
      readonly issueId: string;
      readonly family: ProviderFamily;
      readonly pause: QuotaPause;
    }
  | {
      /** The validation environment has a fenced owner (possibly the other lane's). */
      readonly kind: "lease-unavailable";
      readonly issueId: string;
      readonly grant: Exclude<GrantResult, { ok: true }>;
    };

/** What recordOutcome routed the attempt/issue to. */
export interface OutcomeRouting {
  readonly attemptTerminal: SummaryAttemptTerminal | "running";
  readonly issueTo: string;
  readonly summary: AttemptSummary | null;
  /** Present on an UNCONFIRMED budget kill: the A.2#24 cleanup-failed path. */
  readonly cleanupFailed?: true;
}

export interface RecordOutcomeOptions {
  /**
   * Attestation that the runner fetched the workspace's final head after
   * the worker exited (A.3#3's guard). The fetch reads whatever HEAD the
   * isolated clone has — it exists even for a worker that committed
   * nothing; whether that head passes is the verdict's business.
   */
  readonly finalHeadFetched?: boolean;
  /** Cancellation context when the dispatch outcome is `cancelled`. */
  readonly cancel?: {
    readonly reason: "david" | "urgent-preemption" | "pause" | "edit";
    readonly actor?: string;
    readonly settledBy: "checkpoint" | "kill-confirm";
  };
}

/** One interrupted attempt recovery cannot settle without a real kill-confirm. */
export interface InterruptedAttempt {
  readonly missionId: string;
  readonly issueId: string;
  readonly attemptId: string;
  readonly environmentId: string;
  readonly leaseGeneration: number;
  readonly issueState: "claimed" | "implementing";
}

export interface SchedulerRecoveryReport {
  /** Claimed issues settled never-spawned (protocol invariant) → ready. */
  readonly settledNeverSpawned: readonly string[];
  /** Attempts needing a REAL kill-confirm before settlement (worker may live). */
  readonly requiresKillConfirm: readonly InterruptedAttempt[];
  /**
   * Attempts whose lease was durably RELEASED with a non-success outcome:
   * the dispatch completed before the crash, and recovery routed exactly
   * that outcome (a quota block stays a quota block, a cancel stays a
   * cancel — round-1 finding 5).
   */
  readonly settledFromDurableOutcome: ReadonlyArray<{
    readonly issueId: string;
    readonly attemptId: string;
    readonly outcome: string;
  }>;
  /**
   * Attempts whose lease says the dispatch SUCCEEDED: never auto-failed.
   * The workspace is intact; completeSucceededInterrupted routes the
   * submission once the final head is re-fetched.
   */
  readonly succeededAwaitingSubmission: readonly InterruptedAttempt[];
}

export interface AttemptSchedulerDeps {
  readonly recorder: TransitionRecorder;
  /** The event log itself (recovery reads recorded dispatch facts from it). */
  readonly events: EventStore;
  readonly domain: SqliteDomainStore;
  /** The WP-110 contract source (PlanStore#contractsForMission). */
  readonly contracts: (missionId: string) => IssueContract[];
  readonly leases: EnvironmentLeaseStore;
  readonly windows: WindowStateReader;
  /** The effective WP-106 policy table (RoutingPolicyStore or defaults). */
  readonly policyTable: () => PolicyTable;
  readonly summaries: AttemptSummaryStore;
  readonly now?: () => Date;
  /** Chaos instrumentation (WP-104): a no-op unless a chaos child arms it. */
  readonly killHook?: (point: string) => void;
}

/** Internal signal: the mission left `executing` between protocol records. */
class MidProtocolPauseError extends Error {
  constructor(missionId: string) {
    super(`mission ${missionId} left executing mid-protocol`);
    this.name = "MidProtocolPauseError";
  }
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The issue id inside an attempt id (`<issueId>.a<n>`), or undefined. */
function holderIssueId(attemptId: string): string | undefined {
  const match = /^(.*)\.a[1-9]\d*$/.exec(attemptId);
  return match?.[1];
}

/** Harness of a family (the HARNESS_FAMILY inverse; total over the v1 set). */
function familyHarness(family: ProviderFamily): OfficialAdapterName {
  for (const [harness, fam] of Object.entries(HARNESS_FAMILY)) {
    if (fam === family) return harness as OfficialAdapterName;
  }
  throw new TypeError(`no harness for provider family ${JSON.stringify(family)}`);
}

export class AttemptScheduler {
  readonly #recorder: TransitionRecorder;
  readonly #events: EventStore;
  readonly #domain: SqliteDomainStore;
  readonly #contracts: (missionId: string) => IssueContract[];
  readonly #leases: EnvironmentLeaseStore;
  readonly #windows: WindowStateReader;
  readonly #policyTable: () => PolicyTable;
  readonly #summaries: AttemptSummaryStore;
  readonly #now: () => Date;
  readonly #hook: (point: string) => void;

  constructor(deps: AttemptSchedulerDeps) {
    this.#recorder = deps.recorder;
    this.#events = deps.events;
    this.#domain = deps.domain;
    this.#contracts = deps.contracts;
    this.#leases = deps.leases;
    this.#windows = deps.windows;
    this.#policyTable = deps.policyTable;
    this.#summaries = deps.summaries;
    this.#now = deps.now ?? (() => new Date());
    this.#hook = deps.killHook ?? (() => {});
  }

  /**
   * Decide (and durably record) the next dispatch for a mission, or say
   * precisely why there is none. See the module header for the protocol.
   */
  dispatchNext(
    missionId: string,
    opts: { features: TaskFeatures; budget: AttemptBudget },
  ): DispatchDecision {
    const mission = this.#requireMission(missionId);
    const missionState = this.#recorder.currentState("mission", missionId);
    if (missionState !== "executing") {
      // The A.2#3 guard ("mission in executing, not paused") — and the
      // whole WP-103 lane machinery in one line: parked, queued, paused,
      // escalated missions dispatch NOTHING until the lanes say executing.
      return { kind: "idle", reason: "mission-not-executing", missionState };
    }

    const view = this.#recorder.currentView;
    const stateOf = (issueId: string): IssueStateSnapshot | undefined => view.issues.get(issueId);
    const selection = selectNextDispatch(this.#contracts(missionId), stateOf);
    if (!selection.ok) return { kind: "held", hold: selection.hold };
    const { issueId, contract } = selection;

    // Sequential slot, ATTEMPT grain (round-1 finding 10): issue states
    // alone are not enough — a running/submitted attempt ENTITY belonging
    // to any of this mission's issues holds the slot even if its issue's
    // recorded state has moved (foreign or partially-recovered histories).
    const missionIssueIds = new Set(this.#contracts(missionId).map((c) => c.issueId));
    for (const [attemptId, snapshot] of view.attempts) {
      if (snapshot.state !== "running" && snapshot.state !== "submitted") continue;
      // Ownership comes from the DURABLE A.3#1 record's issueId (round-2
      // finding 2: id-shape parsing was confusable; the payload is not).
      const owner = this.#attemptOwner(attemptId);
      if (owner !== undefined && missionIssueIds.has(owner)) {
        return { kind: "held", hold: { kind: "attempt-active", issueId: owner } };
      }
    }

    // (harness, model, tier) from the WP-106 policy table; family switch
    // per CAM-PLAN-09 after 2 recorded failures (quota waits never reached
    // the counter — the fold enforces that).
    const table = this.#policyTable();
    const base = resolveAssignment(table, "implementer", opts.features);
    const failureCount = stateOf(issueId)?.failureCount ?? 0;
    let assignment: PolicyAssignment = base;
    let familySwitched = false;
    let familySwitchUnavailable = false;
    if (retryPolicy(failureCount).familySwitch) {
      const switched = this.#switchedAssignment(issueId, base, table);
      if (switched === null) familySwitchUnavailable = true;
      else {
        assignment = switched;
        familySwitched = true;
      }
    }
    const family = harnessFamily(assignment.harness);

    // Quota gate (CAM-ROUTE-06): pause at QUOTA_PAUSE_THRESHOLD of the
    // estimated window; queue the issue VISIBLY (A.2#4), never fail it.
    const pause = this.quotaPauseFor(family);
    if (pause !== null) {
      this.#record({
        entityKind: "issue",
        entityId: issueId,
        event: "provider-window-exhausted",
        cause: `quota gate: ${family} ${pause.reason} (CAM-ROUTE-06; dispatch pauses, work queues)`,
        payload: { family },
      });
      return { kind: "quota-paused", issueId, family, pause };
    }

    // The environment is DERIVED, never caller-selectable (round-1 finding
    // 10): a chooseable environment id would bypass the per-repo lease
    // serialization the fencing rests on. WP-115 binds real environments
    // behind this same derivation.
    const environmentId = validationEnvironmentId(mission.repoId);
    const attemptId = this.#mintAttemptId(issueId, view.attempts.keys());
    const granted = this.#leases.grant(environmentId, attemptId);
    if (!granted.ok) return { kind: "lease-unavailable", issueId, grant: granted };
    const lease = granted.lease;
    this.#hook("scheduler-after-lease-granted");

    // RE-CHECK the mission state in the same synchronous frame as the
    // records (round-1 finding 9, the WP-103 approvePlan discipline): the
    // policy-table and window-state calls above are injected callbacks — a
    // re-entrant callback could have parked the mission after the first
    // check. From here to the records there are no foreign calls, so the
    // fact recorded is the fact that held when it was recorded.
    if (this.#recorder.currentState("mission", missionId) !== "executing") {
      this.#leases.recordKillConfirm(environmentId, lease.generation, "never-spawned");
      return {
        kind: "idle",
        reason: "mission-not-executing",
        missionState: this.#recorder.currentState("mission", missionId),
      };
    }

    const contractRef: ContractRef = {
      issueId: contract.issueId,
      contractVersion: contract.version,
      contractHash: contract.contractHash,
    };

    // Refuses mid-protocol the instant the mission leaves `executing`
    // (round-2 finding 3: the chaos hooks between records are INJECTED
    // calls — a no-op in production, but the guarantee must not depend on
    // that). Thrown to the catch below, which settles the lease
    // never-spawned and unwinds the issue.
    const assertStillExecuting = (): void => {
      if (this.#recorder.currentState("mission", missionId) !== "executing") {
        throw new MidProtocolPauseError(missionId);
      }
    };
    try {
      assertStillExecuting();
      this.#record({
        entityKind: "issue",
        entityId: issueId,
        event: "dispatched",
        cause: `scheduler dispatch: dependency order satisfied, sequential slot free (CAM-PLAN-12)`,
        payload: {
          sequentialSlotFree: true,
          missionExecuting: true,
          attemptId,
          environmentId,
          leaseGeneration: lease.generation,
        },
      });
      this.#hook("scheduler-after-issue-claimed");

      assertStillExecuting();
      this.#record({
        entityKind: "attempt",
        entityId: attemptId,
        event: "attempt-dispatched",
        cause: `attempt lease granted at generation ${lease.generation} on ${environmentId} (CAM-STATE-04)`,
        payload: {
          leaseGranted: true,
          leaseGeneration: lease.generation,
          environmentId,
          issueId,
          // CAM-PLAN-04 attempt half (CONTRACT_REFERENCE_OBLIGATIONS row 2):
          // every attempt record carries the ContractRef it executes.
          contractRef: { ...contractRef },
          // CAM-ROUTE-02 output tuple, recorded as dispatched.
          assignment: {
            harness: assignment.harness,
            model: assignment.model,
            reasoningTier: assignment.reasoningTier,
          },
          family,
          // CAM-PLAN-09 family-switch facts, DURABLE (round-1 finding 12):
          // a due-but-unavailable switch (single-family allowlist) is
          // recorded evidence, never only a return value.
          familySwitched,
          familySwitchUnavailable,
        },
      });
      this.#hook("scheduler-after-attempt-recorded");

      assertStillExecuting();
      const fence = this.#leases.admitOperation(environmentId, lease.generation);
      this.#record({
        entityKind: "issue",
        entityId: issueId,
        event: "worker-started",
        cause: "runner about to spawn; lease presented and admitted (A.2#6)",
        payload: { leaseValid: fence.ok === true, attemptId },
      });
      this.#hook("scheduler-after-worker-started");
    } catch (error) {
      // Nothing was spawned (spawn happens strictly after step 4): settle
      // the lease honestly. A mid-protocol PAUSE additionally unwinds the
      // partial records through the machine's own rows (attempt expires,
      // issue re-queues via A.2#7a) and reports idle; any other refusal is
      // a scheduler/machine disagreement — a bug to surface loudly.
      this.#leases.recordKillConfirm(environmentId, lease.generation, "never-spawned");
      if (error instanceof MidProtocolPauseError) {
        this.#unwindNeverSpawned(issueId, attemptId);
        return {
          kind: "idle",
          reason: "mission-not-executing",
          missionState: this.#recorder.currentState("mission", missionId),
        };
      }
      throw error;
    }

    return {
      kind: "dispatch",
      plan: {
        missionId,
        repoId: mission.repoId,
        issueId,
        attemptId,
        environmentId,
        lease,
        contractRef,
        assignment,
        family,
        features: opts.features,
        budget: opts.budget,
        familySwitched,
        ...(familySwitchUnavailable ? { familySwitchUnavailable: true as const } : {}),
      },
    };
  }

  /**
   * The LeaseHandle the runner passes to dispatch()/dispatchWithBudget():
   * the lifecycle settles it AT MOST ONCE, strictly after the worker
   * process group is confirmed gone (WP-105 ordering). An unconfirmed
   * group holds the lease — exactly the fencing CAM-STATE-04 wants.
   */
  leaseHandle(plan: AttemptDispatchPlan): LeaseHandle {
    return {
      release: (ctx) => {
        this.#leases.release(plan.environmentId, plan.lease.generation, ctx);
      },
    };
  }

  /** Refresh the attempt's lease heartbeat (every LEASE_HEARTBEAT_MS while running). */
  heartbeat(plan: AttemptDispatchPlan): ReturnType<EnvironmentLeaseStore["heartbeat"]> {
    return this.#leases.heartbeat(plan.environmentId, plan.lease.generation);
  }

  /**
   * The production heartbeat DRIVER (round-1 finding 7: the 30-second
   * cadence must exist as a scheduled loop, not only as a constant): an
   * unref'd interval that heartbeats the plan's lease until stopped. The
   * runner arms it when the worker spawns and stops it in its outcome
   * finally-block; a heartbeat failure surfaces through the TTL (the lease
   * lapses and fences), never as a crash of the driver.
   */
  armHeartbeat(
    plan: AttemptDispatchPlan,
    intervalMs: number = LEASE_HEARTBEAT_MS,
  ): { stop(): void } {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new TypeError("heartbeat interval must be a finite positive number of milliseconds");
    }
    const timer = setInterval(() => {
      try {
        this.heartbeat(plan);
      } catch {
        // A broken store surfaces through the TTL lapse (fencing), not by
        // crashing the daemon from a timer callback.
      }
    }, intervalMs);
    timer.unref();
    return {
      stop: () => clearInterval(timer),
    };
  }

  /**
   * Is dispatch quota-paused for this family right now? Null = clear.
   * (CAM-ROUTE-06: threshold pause on estimates; exhaustion queues work
   * regardless of estimates; unknown-horizon exhaustion pauses until the
   * probe backoff elapses — QUOTA_PROBE_BACKOFF_MS.)
   */
  quotaPauseFor(family: ProviderFamily): QuotaPause | null {
    const now = this.#now();
    const state = this.#windows.windowState(family, { now });
    for (const window of state.windows) {
      if (
        window.estimatedConsumption !== null &&
        window.estimatedConsumption >= QUOTA_PAUSE_THRESHOLD
      ) {
        return { reason: "window-threshold", estimate: window };
      }
    }
    if (state.windows.length === 0 && state.lastQuotaBlockedAt !== null) {
      const blockedMs = Date.parse(state.lastQuotaBlockedAt);
      const probeAtMs = blockedMs + QUOTA_PROBE_BACKOFF_MS;
      if (now.getTime() < probeAtMs) {
        return {
          reason: "exhausted-horizon-unknown",
          lastQuotaBlockedAt: state.lastQuotaBlockedAt,
          probeAfter: new Date(probeAtMs).toISOString(),
        };
      }
    }
    return null;
  }

  /**
   * Re-check every queued-quota issue of a mission against the CURRENT
   * quota gate for the family it would dispatch on; record A.2#5
   * (`quota-window-freed` → ready) for each now-clear issue. Quota waits
   * never touched the failure counter (the fold enforces the A.2#5 note).
   */
  releaseQuotaWaits(missionId: string, features: TaskFeatures): string[] {
    const view = this.#recorder.currentView;
    const contracts = this.#contracts(missionId);
    const table = this.#policyTable();
    const released: string[] = [];
    const issueIds = new Set(contracts.map((c) => c.issueId));
    for (const issueId of issueIds) {
      if (view.issues.get(issueId)?.state !== "queued-quota") continue;
      const base = resolveAssignment(table, "implementer", features);
      const failureCount = view.issues.get(issueId)?.failureCount ?? 0;
      let assignment = base;
      if (retryPolicy(failureCount).familySwitch) {
        assignment = this.#switchedAssignment(issueId, base, table) ?? base;
      }
      const family = harnessFamily(assignment.harness);
      if (this.quotaPauseFor(family) !== null) continue;
      this.#record({
        entityKind: "issue",
        entityId: issueId,
        event: "quota-window-freed",
        cause: `quota gate clear for ${family} (CAM-ROUTE-06; the wait never counted as failure)`,
        payload: { family },
      });
      released.push(issueId);
    }
    return released;
  }

  /**
   * Route one finished dispatch into the state machines, the window
   * ledger, and the structured summary (CAM-PLAN-09). IDEMPOTENT per
   * attempt: replays converge on the same terminal.
   *
   * Routing map (dispatch outcome → A.3 / A.2):
   *   succeeded          → worker-completed → submitted   (verdict is WP-108/115's)
   *   requirement-failed → worker-completed + verdict fail → failed; issue attempt-failed
   *   killed (runaway)   → same as requirement-failed, failureClass "killed-runaway"
   *   quota-blocked      → rate-limited → quota-blocked; issue → queued-quota (never a failure)
   *   cancelled          → attempt-cancel-requested → cancelled; issue per reason
   *   killed-budget +kc  → attempt-budget-breached → killed-budget; issue → escalated
   *   killed-budget -kc  → issue cleanup-failed → blocked; attempt HELD at running
   *                        (the worker may still live; settle via confirmKillAndSettle)
   */
  recordOutcome(
    plan: AttemptDispatchPlan,
    record: DispatchRecord,
    opts: RecordOutcomeOptions = {},
  ): OutcomeRouting {
    // The dangerous ambiguity window: the worker's external effect exists,
    // confirmation not yet recorded (the §4.4 both-sides posture).
    this.#hook("scheduler-before-outcome-recorded");

    // 1. Window observation — idempotent on attemptId (WP-106 contract).
    // `at` is deliberately OMITTED (round-2 finding 9): an omitted instant
    // is the tracker's own clock derivation, which its replay rule does not
    // compare — a crash-replay at a later time returns the original row
    // instead of refusing as conflicting evidence.
    this.#windows.recordDispatch(plan.family, {
      dispatchId: plan.attemptId,
      outcome: record.outcome,
      durationMs: record.durationMs,
      quotaSignalSeen: record.quotaSignalSeen,
    });

    const attemptState = this.#recorder.currentState("attempt", plan.attemptId);

    let routing: OutcomeRouting;
    switch (record.outcome) {
      case "succeeded": {
        const fetched = opts.finalHeadFetched === true;
        this.#recordAttemptIfActive(attemptState, plan.attemptId, "worker-completed", {
          finalHeadFetched: fetched,
        });
        routing = { attemptTerminal: "succeeded", issueTo: "implementing", summary: null };
        // The attempt parks at `submitted`; quarantine + validation record
        // the verdict (A.3#7) and the issue's A.2#8 — WP-108/115 seams.
        // No summary: CAM-PLAN-09 summaries are FAILURE handoff.
        return this.#finishOutcome(routing);
      }
      case "requirement-failed":
      case "killed": {
        const failureClass = record.outcome === "killed" ? "killed-runaway" : "requirement-failed";
        const summary = this.#writeSummary(plan, record, "failed", failureClass);
        this.#recordAttemptIfActive(attemptState, plan.attemptId, "worker-completed", {
          finalHeadFetched: opts.finalHeadFetched === true,
        });
        // For a dispatch-level failure the verdict IS the centralized
        // CAM-EXEC-06 classification — there is nothing for quarantine or
        // validation to add to an attempt that produced no candidate; the
        // WP-108/115 verdicts use these same rows for submitted candidates.
        this.#recordAttemptIfActive(
          this.#recorder.currentState("attempt", plan.attemptId),
          plan.attemptId,
          "verdict-recorded",
          {
            quarantineAndValidationComplete: true,
            verdict: "fail",
            failureClass,
          },
        );
        this.#recordIssueIfIn(plan, ["implementing"], "attempt-failed", {
          attemptId: plan.attemptId,
        });
        routing = {
          attemptTerminal: "failed",
          issueTo: this.#recorder.currentState("issue", plan.issueId) ?? "unknown",
          summary,
        };
        return this.#finishOutcome(routing);
      }
      case "quota-blocked": {
        const summary = this.#writeSummary(plan, record, "quota-blocked", "quota-blocked");
        this.#recordAttemptIfActive(attemptState, plan.attemptId, "rate-limited", {});
        this.#recordIssueIfIn(plan, ["implementing"], "attempt-quota-blocked", {
          attemptId: plan.attemptId,
        });
        this.#recordIssueIfIn(plan, ["claimed"], "attempt-pre-start-terminal", {
          attemptTerminal: "quota-blocked",
          recorded: true,
        });
        routing = { attemptTerminal: "quota-blocked", issueTo: "queued-quota", summary };
        return this.#finishOutcome(routing);
      }
      case "cancelled": {
        const cancel = opts.cancel ?? {
          reason: "pause" as const,
          settledBy: "kill-confirm" as const,
        };
        const summary = this.#writeSummary(plan, record, "cancelled", `cancelled:${cancel.reason}`);
        // `actor` rides the event ENVELOPE (reserved in payloads); a
        // David-reason cancel must carry David as the envelope actor for
        // the A.3#4 guard.
        const cancelActor = cancel.reason === "david" ? (cancel.actor ?? "david") : SCHEDULER_ACTOR;
        if (attemptState === "running") {
          this.#record({
            entityKind: "attempt",
            entityId: plan.attemptId,
            event: "attempt-cancel-requested",
            cause: `scheduler outcome routing (attempt-cancel-requested: ${cancel.reason})`,
            payload: {
              reason: cancel.reason,
              settledBy: cancel.settledBy,
              summaryWritten: true,
            },
            actor: cancelActor,
          });
        }
        if (cancel.reason === "urgent-preemption" || cancel.reason === "pause") {
          this.#recordIssueIfIn(plan, ["implementing"], "attempt-cancelled", {
            reason: cancel.reason,
            summaryWritten: true,
          });
        }
        this.#recordIssueIfIn(plan, ["claimed"], "attempt-pre-start-terminal", {
          attemptTerminal: "cancelled",
          recorded: true,
        });
        routing = {
          attemptTerminal: "cancelled",
          issueTo: this.#recorder.currentState("issue", plan.issueId) ?? "unknown",
          summary,
        };
        return this.#finishOutcome(routing);
      }
      case "killed-budget": {
        // The operative "worker is stopped" property, computed by the same
        // WP-105/107 predicate dispatchWithBudget uses (never re-derived).
        const killConfirmed = processGroupConfirmedGone(record);
        const summary = this.#writeSummary(plan, record, "killed-budget", "budget-breach");
        if (killConfirmed) {
          this.#recordAttemptIfActive(attemptState, plan.attemptId, "attempt-budget-breached", {
            killConfirmed: true,
          });
          this.#recordIssueIfIn(plan, ["implementing", "claimed"], "attempt-budget-breached", {
            killConfirmed: true,
          });
          // Kill-and-escalate (CAM-EXEC-03): there is no retry path from
          // here by construction — A.2#10's target is `escalated`.
          routing = { attemptTerminal: "killed-budget", issueTo: "escalated", summary };
          return this.#finishOutcome(routing);
        }
        // UNCONFIRMED kill (WP-107's killConfirmed:false): the worker may
        // still be running. The attempt HOLDS at `running` (the A.3#5
        // guard refuses an unattested kill-confirm — correctly), the lease
        // stays held (fencing), and the ISSUE takes the A.2#24
        // cleanup-failed path. confirmKillAndSettle completes it after a
        // real container/group kill-confirm.
        this.#recordIssueIfIn(plan, ["implementing", "claimed"], "cleanup-failed", {
          recorded: true,
          attemptId: plan.attemptId,
        });
        routing = {
          attemptTerminal: "running",
          issueTo: "blocked",
          summary,
          cleanupFailed: true,
        };
        return this.#finishOutcome(routing);
      }
    }
  }

  /**
   * Complete an UNCONFIRMED budget kill after a REAL kill-confirm (the
   * container was killed and confirmed gone ⇒ every namespaced pid is
   * reaped — WP-107; or the process group was confirmed gone). Settles the
   * lease (re-grant now lawful) and records the A.3#5 terminal.
   */
  confirmKillAndSettle(plan: AttemptDispatchPlan, source: KillConfirmSource): OutcomeRouting {
    if (source === "never-spawned") {
      // A budget breach implies a worker RAN (round-1 finding 3): the
      // trivial confirm is attestable only for dispatches the protocol
      // proves never spawned, which this is not. A caller cannot settle a
      // possibly-live worker's environment with words.
      throw new TypeError(
        "confirmKillAndSettle requires a REAL kill-confirm source (container or process-group): " +
          "a budget-breached attempt ran a worker; never-spawned cannot be attested for it",
      );
    }
    this.#leases.recordKillConfirm(plan.environmentId, plan.lease.generation, source);
    this.#recordAttemptIfActive(
      this.#recorder.currentState("attempt", plan.attemptId),
      plan.attemptId,
      "attempt-budget-breached",
      { killConfirmed: true },
    );
    return {
      attemptTerminal: "killed-budget",
      issueTo: this.#recorder.currentState("issue", plan.issueId) ?? "unknown",
      summary: this.#summaries.get(plan.attemptId) ?? null,
    };
  }

  /**
   * The post-crash scheduler reconciliation (CAM-STATE-06): settle what
   * the protocol PROVES never spawned; REPORT what needs a real
   * kill-confirm. Never re-grants, never assumes a worker dead.
   */
  recoverInterrupted(): SchedulerRecoveryReport {
    const view = this.#recorder.currentView;
    const settledNeverSpawned: string[] = [];
    const requiresKillConfirm: InterruptedAttempt[] = [];
    const settledFromDurableOutcome: SchedulerRecoveryReport["settledFromDurableOutcome"][number][] =
      [];
    const succeededAwaitingSubmission: InterruptedAttempt[] = [];
    // ORPHAN LEASES first: a held lease whose holder attempt has NO
    // recorded attempt entity is a dispatch killed between the grant
    // (step 1) and the attempt record (step 3) — by the protocol
    // invariant nothing was spawned, so the lease settles never-spawned.
    // (A lease whose holder IS recorded is handled through its issue
    // below; settling here would race that classification.)
    for (const lease of this.#leases.listCurrent()) {
      if (lease.state !== "held") continue;
      if (this.#recorder.currentState("attempt", lease.holderAttemptId) !== undefined) continue;
      const issueId = holderIssueId(lease.holderAttemptId);
      const issueState =
        issueId === undefined ? undefined : this.#recorder.currentState("issue", issueId);
      if (issueState === "claimed" || issueState === "implementing") continue; // classified below
      this.#leases.recordKillConfirm(lease.environmentId, lease.generation, "never-spawned");
    }
    for (const [issueId, snapshot] of view.issues) {
      if (snapshot.state !== "claimed" && snapshot.state !== "implementing") continue;
      const dispatchRecord = this.#latestDispatchRecord(issueId);
      if (dispatchRecord === undefined) continue; // pre-WP-114 state shapes: nothing to settle
      const { attemptId, environmentId, leaseGeneration, missionId } = dispatchRecord;
      const attemptState = this.#recorder.currentState("attempt", attemptId);
      const workerStarted = snapshot.state === "implementing";
      if (!workerStarted) {
        // claimed: steps 3–4 incomplete ⇒ the worker was NEVER spawned
        // (protocol invariant). Settle the lease never-spawned; the
        // attempt (if recorded) expires with that kill-confirm; the issue
        // returns to ready via A.2#7a — nothing is stranded in `claimed`.
        this.#leases.recordKillConfirm(environmentId, leaseGeneration, "never-spawned");
        if (attemptState === "running") {
          this.#record({
            entityKind: "attempt",
            entityId: attemptId,
            event: "heartbeat-lapsed",
            cause:
              "recovery: dispatch interrupted before worker-started; never spawned (kill-confirm trivial)",
            payload: { killConfirmed: true },
          });
        }
        this.#record({
          entityKind: "issue",
          entityId: issueId,
          event: "attempt-pre-start-terminal",
          cause: "recovery: dispatch interrupted before worker start; issue re-queued (A.2#7a)",
          payload: {
            attemptTerminal: attemptState === "running" ? "expired" : "cancelled",
            recorded: true,
          },
        });
        settledNeverSpawned.push(issueId);
        continue;
      }
      // implementing: consult the DISPATCH'S OWN lease row first (round-1
      // finding 5). A RELEASED lease proves the dispatch lifecycle
      // COMPLETED — the worker group is gone (release is sequenced after
      // group-gone) and the outcome is durably recorded. Recovery routes
      // that outcome; it never re-classifies a durably-settled dispatch as
      // a kill-confirm case (which would count a success as a failure).
      // An attempt already past `running` (submitted, terminal) needs no
      // settlement — and must not be re-reported on every recovery pass
      // (round-2 finding 5's replay case).
      if (attemptState !== "running") continue;
      const leaseRow = this.#leases.at(environmentId, leaseGeneration);
      const ref: InterruptedAttempt = {
        missionId,
        issueId,
        attemptId,
        environmentId,
        leaseGeneration,
        issueState: "implementing",
      };
      if (leaseRow?.state === "released" && leaseRow.releasedOutcome !== undefined) {
        const outcome = leaseRow.releasedOutcome;
        if (outcome === "succeeded") {
          // NEVER auto-failed: the worker's product exists (workspace
          // intact). Reported for completeSucceededInterrupted once the
          // final head is re-fetched — or David's call.
          succeededAwaitingSubmission.push(ref);
        } else {
          this.#settleFromReleasedOutcome(ref, outcome);
          settledFromDurableOutcome.push({ issueId, attemptId, outcome });
        }
        continue;
      }
      if (leaseRow?.state === "kill-confirmed") {
        // The kill was already confirmed (a prior recovery, or the budget
        // path): settle directly instead of demanding a second external
        // confirmation (round-2 finding 5).
        this.#recordAttemptIfActive(attemptState, attemptId, "heartbeat-lapsed", {
          killConfirmed: true,
        });
        this.#recordIssueIfIn({ issueId }, ["implementing"], "attempt-failed", { attemptId });
        settledFromDurableOutcome.push({ issueId, attemptId, outcome: "kill-confirmed" });
        continue;
      }
      // Held (worker may still be alive — kill -9 killed the daemon, not
      // the worker) or missing: a REAL kill-confirm settles it. Re-grant
      // only after kill-confirm.
      requiresKillConfirm.push(ref);
    }
    return {
      settledNeverSpawned,
      requiresKillConfirm,
      settledFromDurableOutcome,
      succeededAwaitingSubmission,
    };
  }

  /**
   * Route a durably-released dispatch's outcome during recovery. The
   * kill-confirm attestations here are licensed by the RELEASE itself:
   * the lifecycle releases strictly after the worker process group is
   * confirmed gone (WP-105 ordering), so "the worker is stopped" is
   * durable fact, not an assumption.
   */
  #settleFromReleasedOutcome(
    ref: InterruptedAttempt,
    outcome: Exclude<DispatchRecord["outcome"], "succeeded">,
  ): void {
    const attemptState = this.#recorder.currentState("attempt", ref.attemptId);
    switch (outcome) {
      case "quota-blocked": {
        this.#recordAttemptIfActive(attemptState, ref.attemptId, "rate-limited", {});
        this.#recordIssueIfIn(ref, ["implementing"], "attempt-quota-blocked", {
          attemptId: ref.attemptId,
        });
        this.#backfillWindowObservation(ref, "quota-blocked");
        return; // queued-quota; the wait never counts (A.2#11)
      }
      case "cancelled": {
        // The original cancel context did not survive the crash; the
        // recovery record says so and uses the non-counting A.2#12 row —
        // a cancel must never inflate the failure counter.
        this.#record({
          entityKind: "attempt",
          entityId: ref.attemptId,
          event: "attempt-cancel-requested",
          cause:
            "recovery: dispatch settled cancelled before outcome recording; original cancel context not durable",
          payload: { reason: "pause", settledBy: "kill-confirm", summaryWritten: true },
        });
        this.#writeRecoverySummary(ref, "cancelled", "cancelled:recovered", "cancelled");
        this.#backfillWindowObservation(ref, "cancelled");
        this.#recordIssueIfIn(ref, ["implementing"], "attempt-cancelled", {
          reason: "pause",
          summaryWritten: true,
        });
        return;
      }
      case "killed-budget": {
        this.#recordAttemptIfActive(attemptState, ref.attemptId, "attempt-budget-breached", {
          killConfirmed: true,
        });
        this.#writeRecoverySummary(ref, "killed-budget", "budget-breach", "killed-budget");
        this.#backfillWindowObservation(ref, "killed-budget");
        this.#recordIssueIfIn(ref, ["implementing", "claimed"], "attempt-budget-breached", {
          killConfirmed: true,
        });
        return; // escalated; never auto-retried (A.2#10)
      }
      case "requirement-failed":
      case "killed": {
        this.#recordAttemptIfActive(attemptState, ref.attemptId, "heartbeat-lapsed", {
          killConfirmed: true,
        });
        this.#writeRecoverySummary(ref, "expired", `recovered:${outcome}`, outcome);
        this.#backfillWindowObservation(ref, outcome);
        this.#recordIssueIfIn(ref, ["implementing"], "attempt-failed", {
          attemptId: ref.attemptId,
        });
        return; // counted — the dispatch genuinely failed (A.2#9)
      }
    }
  }

  /**
   * Backfill the WP-106 window ledger for a recovered dispatch: idempotent
   * on the attempt id, and a row the ORIGINAL recording already wrote (with
   * richer content) wins — the conflict refusal is caught, never propagated
   * (round-2 finding 5: recovered quota exhaustion must reach the ledger).
   */
  #backfillWindowObservation(ref: InterruptedAttempt, outcome: DispatchRecord["outcome"]): void {
    const family = this.#attemptFamily(ref.attemptId);
    if (family === undefined) return;
    try {
      this.#windows.recordDispatch(family, {
        dispatchId: ref.attemptId,
        outcome,
        durationMs: 0,
        quotaSignalSeen: outcome === "quota-blocked",
      });
    } catch {
      // The original, richer row exists — better evidence stands.
    }
  }

  /** The family the durable A.3#1 record names, if readable. */
  #attemptFamily(attemptId: string): ProviderFamily | undefined {
    const rows = this.#events.read({ entityKind: "attempt", entityId: attemptId });
    const created = rows.find((r) => r.event === "attempt-dispatched" && r.outcome === "applied");
    const family = created?.payload["family"];
    return (PROVIDER_FAMILIES as readonly string[]).includes(family as string)
      ? (family as ProviderFamily)
      : undefined;
  }

  /**
   * Complete a recovered SUCCEEDED dispatch: the caller re-fetched the
   * intact workspace's final head (the fetch is idempotent — the crash
   * lost the in-memory record, not the workspace). Routes A.3#3 →
   * submitted; quarantine/validation take it from there.
   */
  completeSucceededInterrupted(
    ref: InterruptedAttempt,
    evidence: { finalHeadFetched: boolean },
  ): void {
    if (evidence.finalHeadFetched !== true) {
      throw new TypeError(
        "completeSucceededInterrupted requires finalHeadFetched: true — without a re-fetched head " +
          "the submission cannot proceed; escalate to David instead of guessing",
      );
    }
    this.#recordAttemptIfActive(
      this.#recorder.currentState("attempt", ref.attemptId),
      ref.attemptId,
      "worker-completed",
      { finalHeadFetched: true },
    );
  }

  /** A minimal, honest recovery summary (durations/streams not durable → zeros). */
  #writeRecoverySummary(
    ref: InterruptedAttempt,
    terminal: SummaryAttemptTerminal,
    failureClass: string,
    outcome: DispatchRecord["outcome"],
  ): void {
    const contract = latestContracts(this.#contracts(ref.missionId)).get(ref.issueId);
    if (contract === undefined) return; // no contract → no summary (foreign state; events still routed)
    const table = this.#policyTable();
    const attemptRecord = this.#events
      .read({ entityKind: "attempt", entityId: ref.attemptId })
      .find((r) => r.event === "attempt-dispatched" && r.outcome === "applied");
    const recordedAssignment = attemptRecord?.payload["assignment"] as
      { harness: string; model: string | null; reasoningTier: string } | undefined;
    const assignment =
      recordedAssignment ??
      resolveAssignment(table, "implementer", { template: "feature", riskTier: "medium" });

    try {
      this.#summaries.record({
        schemaVersion: ATTEMPT_SUMMARY_SCHEMA_VERSION,
        attemptId: ref.attemptId,
        issueId: ref.issueId,
        missionId: ref.missionId,
        contractRef: {
          issueId: contract.issueId,
          contractVersion: contract.version,
          contractHash: contract.contractHash,
        },
        harness: assignment.harness,
        family: harnessFamily(assignment.harness),
        model: assignment.model,
        reasoningTier: assignment.reasoningTier as AttemptSummary["reasoningTier"],
        outcome,
        attemptTerminal: terminal,
        failureClass,
        quotaSignalSeen: false,
        exitCode: null,
        durationMs: 0,
        streamedEvents: 0,
        headline: "recovered after daemon interruption; details not durable",
        recordedAt: this.#instant(),
      });
    } catch {
      // A summary that already exists (idempotent replay) or fails
      // validation must not abort recovery routing; the events carry the
      // authoritative state either way.
    }
  }

  /**
   * Settle one recovered attempt AFTER a real kill-confirm was executed
   * (container or process-group scope): lease kill-confirm recorded →
   * attempt expires (A.3#2) → issue takes an attempt failure (A.2#9,
   * counted — the attempt died without submitting).
   */
  settleInterrupted(interrupted: InterruptedAttempt, source: KillConfirmSource): void {
    if (source === "never-spawned") {
      throw new TypeError(
        "settleInterrupted requires a REAL kill-confirm source (container or process-group): " +
          "an attempt past worker-started may have spawned; never-spawned cannot be attested for it",
      );
    }
    this.#leases.recordKillConfirm(interrupted.environmentId, interrupted.leaseGeneration, source);
    this.#recordAttemptIfActive(
      this.#recorder.currentState("attempt", interrupted.attemptId),
      interrupted.attemptId,
      "heartbeat-lapsed",
      { killConfirmed: true },
    );
    const issueState = this.#recorder.currentState("issue", interrupted.issueId);
    if (issueState === "implementing") {
      this.#record({
        entityKind: "issue",
        entityId: interrupted.issueId,
        event: "attempt-failed",
        cause:
          "recovery: interrupted attempt kill-confirmed and expired; counted as a failure (A.2#9)",
        payload: { attemptId: interrupted.attemptId },
      });
    }
  }

  // -------------------------------------------------------------------

  #finishOutcome(routing: OutcomeRouting): OutcomeRouting {
    this.#hook("scheduler-after-outcome-recorded");
    return routing;
  }

  /** CAM-PLAN-09 family switch: a different family than the last failure's. */
  #switchedAssignment(
    issueId: string,
    base: PolicyAssignment,
    table: PolicyTable,
  ): PolicyAssignment | null {
    const lastFailed = this.#summaries
      .forIssue(issueId)
      .filter((s) => s.attemptTerminal === "failed" || s.attemptTerminal === "expired")
      .at(-1);
    const avoid: ProviderFamily = lastFailed?.family ?? harnessFamily(base.harness);
    const allowed = table.providerAllowlist;
    // Deterministic rotation: PROVIDER_FAMILIES order, starting after the
    // family being avoided, first allowlisted family that differs.
    const start = PROVIDER_FAMILIES.indexOf(avoid);
    for (let i = 1; i <= PROVIDER_FAMILIES.length; i++) {
      const candidate = PROVIDER_FAMILIES[(start + i) % PROVIDER_FAMILIES.length] as ProviderFamily;
      if (candidate === avoid) continue;
      if (!allowed.includes(candidate)) continue;
      const harness = familyHarness(candidate);
      // The pinned model (if any) belongs to the ORIGINAL harness; the
      // switched harness runs its own default model at the same tier.
      return { harness, model: null, reasoningTier: base.reasoningTier };
    }
    return null;
  }

  #writeSummary(
    plan: AttemptDispatchPlan,
    record: DispatchRecord,
    terminal: SummaryAttemptTerminal,
    failureClass: string,
  ): AttemptSummary {
    const summary: AttemptSummary = {
      schemaVersion: ATTEMPT_SUMMARY_SCHEMA_VERSION,
      attemptId: plan.attemptId,
      issueId: plan.issueId,
      missionId: plan.missionId,
      contractRef: { ...plan.contractRef },
      harness: plan.assignment.harness,
      family: plan.family,
      model: plan.assignment.model,
      reasoningTier: plan.assignment.reasoningTier,
      outcome: record.outcome,
      attemptTerminal: terminal,
      failureClass,
      ...(record.budgetBreach === undefined ? {} : { budgetBreach: { ...record.budgetBreach } }),
      ...(record.killConfirm === undefined
        ? {}
        : {
            killConfirm: {
              groupGone: record.killConfirm.groupGone,
              escalatedToSigkill: record.killConfirm.escalatedToSigkill,
            },
          }),
      quotaSignalSeen: record.quotaSignalSeen === true,
      exitCode: record.exitCode,
      durationMs: record.durationMs,
      streamedEvents: record.streamedEvents,
      headline: summaryHeadline(record.finalText),
      recordedAt: this.#instant(),
    };
    return this.#summaries.record(summary);
  }

  /** Record an attempt event only while the attempt is in a matching active state (idempotent replay). */
  #recordAttemptIfActive(
    state: string | undefined,
    attemptId: string,
    event: string,
    payload: Record<string, unknown>,
  ): void {
    if (state === undefined) return;
    if (state !== "running" && state !== "submitted") return; // already terminal: replay no-op
    // worker-completed fires from running; verdict-recorded from submitted;
    // the machine's own guards keep an out-of-order call from applying.
    const eligible =
      (event === "verdict-recorded" && state === "submitted") ||
      (event !== "verdict-recorded" && state === "running");
    if (!eligible) return;
    this.#record({
      entityKind: "attempt",
      entityId: attemptId,
      event,
      cause: `scheduler outcome routing (${event})`,
      payload,
    });
  }

  #recordIssueIfIn(
    plan: Pick<AttemptDispatchPlan, "issueId">,
    states: readonly string[],
    event: string,
    payload: Record<string, unknown>,
  ): void {
    const state = this.#recorder.currentState("issue", plan.issueId);
    if (state === undefined || !states.includes(state)) return;
    this.#record({
      entityKind: "issue",
      entityId: plan.issueId,
      event,
      cause: `scheduler outcome routing (${event})`,
      payload,
    });
  }

  #record(input: {
    entityKind: "mission" | "issue" | "attempt";
    entityId: string;
    event: string;
    cause: string;
    payload: Record<string, unknown>;
    actor?: string;
  }): RecordOutcome {
    const outcome = this.#recorder.record({
      entityKind: input.entityKind,
      entityId: input.entityId,
      event: input.event,
      actor: input.actor ?? SCHEDULER_ACTOR,
      cause: input.cause,
      payload: input.payload,
    });
    if (!outcome.ok) {
      throw new Error(
        `scheduler record of ${input.event} on ${input.entityKind} ${input.entityId} was refused ` +
          `(${outcome.code}) — the scheduler and the machine disagree; refusing to continue`,
      );
    }
    return outcome;
  }

  /**
   * Attempt ids are `<issueId>.a<n>`, n = 1 + prior attempts for the
   * issue. The grammar stays inside the WP-107 archival id fence
   * (`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`) so every attempt is archivable,
   * and the `a<n>` leaf cannot collide with plan issue ids (`I<n>`).
   */
  #mintAttemptId(issueId: string, attemptIds: Iterable<string>): string {
    // Collision-free by construction (round-2 finding 2): take 1 + the MAX
    // ordinal among ids of exactly this issue's grammar, then walk forward
    // past any existing entity — a foreign id sharing the prefix can skew
    // a COUNT but never the max-ordinal/existence pair.
    const exact = new RegExp(`^${escapeForRegExp(issueId)}\\.a([1-9]\\d*)$`);
    const existing = new Set<string>();
    let maxOrdinal = 0;
    for (const id of attemptIds) {
      existing.add(id);
      const match = exact.exec(id);
      if (match !== null) maxOrdinal = Math.max(maxOrdinal, Number(match[1]));
    }
    let ordinal = maxOrdinal + 1;
    while (existing.has(`${issueId}.a${ordinal}`)) ordinal++;
    return `${issueId}.a${ordinal}`;
  }

  /** The issueId the durable A.3#1 record names for an attempt, if any. */
  #attemptOwner(attemptId: string): string | undefined {
    const rows = this.#events.read({ entityKind: "attempt", entityId: attemptId });
    const created = rows.find((r) => r.event === "attempt-dispatched" && r.outcome === "applied");
    const issueId = created?.payload["issueId"];
    return typeof issueId === "string" && issueId.length > 0 ? issueId : undefined;
  }

  /** Unwind a mid-protocol pause: attempt (if recorded) expires with the
   * never-spawned confirm; a claimed issue re-queues via A.2#7a. */
  #unwindNeverSpawned(issueId: string, attemptId: string): void {
    if (this.#recorder.currentState("attempt", attemptId) === "running") {
      this.#record({
        entityKind: "attempt",
        entityId: attemptId,
        event: "heartbeat-lapsed",
        cause: "mission left executing mid-protocol; never spawned (kill-confirm trivial)",
        payload: { killConfirmed: true },
      });
    }
    if (this.#recorder.currentState("issue", issueId) === "claimed") {
      this.#record({
        entityKind: "issue",
        entityId: issueId,
        event: "attempt-pre-start-terminal",
        cause: "mission left executing mid-protocol; issue re-queued (A.2#7a)",
        payload: { attemptTerminal: "expired", recorded: true },
      });
    }
  }

  /** The latest applied `dispatched` record's payload facts for an issue. */
  #latestDispatchRecord(
    issueId: string,
  ):
    | { attemptId: string; environmentId: string; leaseGeneration: number; missionId: string }
    | undefined {
    const rows = this.#events.read({ entityKind: "issue", entityId: issueId });
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row === undefined || row.event !== "dispatched" || row.outcome !== "applied") continue;
      const payload = row.payload as Record<string, unknown>;
      const attemptId = payload["attemptId"];
      const environmentId = payload["environmentId"];
      const leaseGeneration = payload["leaseGeneration"];
      if (
        typeof attemptId !== "string" ||
        typeof environmentId !== "string" ||
        typeof leaseGeneration !== "number"
      ) {
        return undefined;
      }
      // Durable issue ids are `<missionId>.<planIssueId>` (WP-110 mint);
      // plan issue ids contain no dot, so the LAST dot splits correctly
      // even for a mission id that itself contains dots.
      const missionId = issueId.includes(".")
        ? issueId.slice(0, issueId.lastIndexOf("."))
        : issueId;
      return { attemptId, environmentId, leaseGeneration, missionId };
    }
    return undefined;
  }

  #requireMission(missionId: string) {
    const mission = this.#domain.getMission(missionId);
    if (mission === undefined) {
      throw new Error(`mission ${missionId} does not exist in the domain store`);
    }
    return mission;
  }

  #instant(): string {
    const now = this.#now();
    const ms = now instanceof Date ? now.getTime() : Number.NaN;
    if (!Number.isFinite(ms)) throw new TypeError("scheduler clock must yield a valid Date");
    return now.toISOString();
  }
}
