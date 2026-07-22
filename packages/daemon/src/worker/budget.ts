// WP-107: per-attempt budget supervision — kill-and-escalate (CAM-EXEC-03).
//
// The MECHANISM lives in the dispatch lifecycle (DispatchOptions.budget →
// kill-confirm → outcome "killed-budget"), where every other classification
// lives, so no caller can misclassify a budget kill. THIS module is the
// policy seam above it:
//
//   - it validates the budget shape fail-closed (a budget SUPPLIED to this seam
//     must carry a finite positive wall-clock ceiling — "tokens where reportable"
//     means a token budget alone can never be the only guard; the lower-level
//     dispatch() primitive may run with no budget where none applies, e.g. an
//     internal plan-runner step);
//   - it maps a killed-budget outcome onto the Appendix A events the state
//     machines consume: A.3#5 (attempt `running → killed-budget`) and A.2#10
//     (issue `implementing → escalated`);
//   - it structurally CANNOT retry: there is no retry parameter, no loop, and
//     no code path that dispatches twice — and the core tables it feeds have
//     no row from a budget breach back to `ready` ("never an automatic
//     retry", pinned by budget.test.ts walking the tables).
//
// BOUNDARY, stated honestly (round-11 findings 4/5/6, CORRECTED round-15 findings
// 2/3 + round-16 finding 4): the wall-clock guard is an IN-PROCESS event-loop timer
// plus a reliable POST-REAP exit-handling check. It is best-effort to within the
// daemon loop's scheduling latency — and that latency IS worker-influenceable: a
// worker can make Camino's OWN daemon-side work (N concurrent archival hashes, the
// synchronous credential scan, a large fsync) delay the timer by tens-to-hundreds
// of ms and overrun by that much. Camino shrinks its own contribution where cheap
// (spawned/yielding tar+hash+delete+walk, off-loop fsync, capped candidate reads, a
// per-line CPU cap), but does NOT claim to bound it — an in-process timer cannot be
// made immune to concurrent same-process CPU. Under such a stall the guard still
// fails SAFE (it escalates a DETECTED overrun for review, never credits a detected
// one; a SUB-STALL overrun it cannot observe may be classified succeeded — the
// best-effort limit above, bounded authoritatively out-of-process),
// and the exit-handling check reliably catches DESCENDANT overruns. The
// AUTHORITATIVE out-of-process bound is the container / WP-114 supervisor (kill the
// container ⇒ reap every pid); this timer is a fast-path best-effort kill, not the
// guarantee.
import type { AdapterContext, AdapterSpec, AttemptBudget, DispatchRecord } from "@camino/shared";
import type { AttemptEvent, IssueEvent } from "@camino/core";
import {
  dispatch,
  processGroupConfirmedGone,
  type DispatchOptions,
} from "../dispatch/lifecycle.js";

export class BudgetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetConfigError";
  }
}

/**
 * Validate an attempt budget fail-closed: wall-clock must be a finite positive
 * number of milliseconds — it is always PART OF a valid budget (unlike tokens,
 * which are conditional on the stream reporting usage); its ENFORCEMENT is
 * best-effort in-process and authoritative out-of-process (see the module
 * boundary). Tokens, when present, a finite positive count. A malformed budget is
 * a configuration refusal — never a silently unenforced one.
 */
export function validateAttemptBudget(budget: AttemptBudget): void {
  if (!Number.isFinite(budget.wallClockMs) || budget.wallClockMs <= 0) {
    throw new BudgetConfigError(
      `attempt budget wallClockMs must be a finite positive number of milliseconds (got ${String(budget.wallClockMs)}) — a wall-clock ceiling is always REQUIRED (CAM-EXEC-03; enforced best-effort in-process, authoritatively out-of-process)`,
    );
  }
  if (budget.tokens !== undefined && (!Number.isFinite(budget.tokens) || budget.tokens <= 0)) {
    throw new BudgetConfigError(
      `attempt budget tokens must be a finite positive count when set (got ${String(budget.tokens)})`,
    );
  }
}

/** The escalation package a budget breach produces (and nothing else does). */
export interface BudgetBreachEscalation {
  /** A.3#5: `running` --budget breach / kill-confirm--> `killed-budget`. */
  attemptEvent: Extract<AttemptEvent, { type: "attempt-budget-breached" }>;
  /** A.2#10: `implementing` --attempt budget breach--> `escalated`, never a retry. */
  issueEvent: Extract<IssueEvent, { type: "attempt-budget-breached" }>;
}

export interface BudgetedDispatchResult {
  record: DispatchRecord;
  /** Present iff the outcome is `killed-budget`. */
  escalation?: BudgetBreachEscalation;
}

/**
 * Run ONE dispatch under a per-attempt budget. On breach the lifecycle has
 * already run kill-confirm and classified `killed-budget`; this returns the
 * Appendix A escalation events alongside the record. There is deliberately
 * no retry affordance on this API.
 *
 * `killConfirmed` = the worker process GROUP is confirmed gone
 * (processGroupConfirmedGone), which is the operative "worker is stopped"
 * property the A.2#10 / A.3#5 guard requires before escalating. It is TRUE
 * either because a kill-confirm sequence ran and confirmed group-gone, or
 * because the worker exited on its own before the breach was detected (a late
 * usage report) — in both cases the worker is stopped, so escalation (never
 * auto-retry) is the correct next step. When the group can NOT be confirmed
 * gone, killConfirmed is FALSE and the guard refuses the clean escalation,
 * routing to the cleanup-failed path (A.2 "cleanup failure during teardown →
 * blocked") — a failed kill is never papered over.
 *
 * BOUNDARY (round-1 finding 9), the same group-vs-tree boundary WP-105 states
 * throughout: "group gone" is process-GROUP scope. A descendant that changed
 * its own process group (setpgid/setsid) is invisible to the group probe —
 * and is exactly the residual THIS work package's container closes (kill the
 * container ⇒ reap every pid). So in the delivered architecture the escaped
 * descendant cannot outlive the attempt; at this daemon-side seam the claim is
 * scoped to the group and does not overreach.
 */
export async function dispatchWithBudget(
  adapter: AdapterSpec,
  ctx: AdapterContext,
  budget: AttemptBudget,
  opts: Omit<DispatchOptions, "budget"> = {},
): Promise<BudgetedDispatchResult> {
  validateAttemptBudget(budget);
  const record = await dispatch(adapter, ctx, { ...opts, budget });
  if (record.outcome !== "killed-budget") return { record };
  const killConfirmed = processGroupConfirmedGone(record);
  return {
    record,
    escalation: {
      attemptEvent: { type: "attempt-budget-breached", killConfirmed },
      issueEvent: { type: "attempt-budget-breached", killConfirmed },
    },
  };
}
