// WP-107: per-attempt budget supervision — kill-and-escalate (CAM-EXEC-03).
//
// The MECHANISM lives in the dispatch lifecycle (DispatchOptions.budget →
// kill-confirm → outcome "killed-budget"), where every other classification
// lives, so no caller can misclassify a budget kill. THIS module is the
// policy seam above it:
//
//   - it validates the budget shape fail-closed (wall-clock is ALWAYS
//     enforced — a dispatch without a finite positive wall-clock budget is
//     refused, since "tokens where reportable" means token budgets alone can
//     never be the only guard);
//   - it maps a killed-budget outcome onto the Appendix A events the state
//     machines consume: A.3#5 (attempt `running → killed-budget`) and A.2#10
//     (issue `implementing → escalated`);
//   - it structurally CANNOT retry: there is no retry parameter, no loop, and
//     no code path that dispatches twice — and the core tables it feeds have
//     no row from a budget breach back to `ready` ("never an automatic
//     retry", pinned by budget.test.ts walking the tables).
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
 * Validate an attempt budget fail-closed: wall-clock must be a finite
 * positive number of milliseconds (ALWAYS enforced); tokens, when present,
 * a finite positive count. A malformed budget is a configuration refusal —
 * never a silently unenforced one.
 */
export function validateAttemptBudget(budget: AttemptBudget): void {
  if (!Number.isFinite(budget.wallClockMs) || budget.wallClockMs <= 0) {
    throw new BudgetConfigError(
      `attempt budget wallClockMs must be a finite positive number of milliseconds (got ${String(budget.wallClockMs)}) — wall-clock is always enforced (CAM-EXEC-03)`,
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
 * `killConfirmed` is reported honestly from the record's group-gone evidence:
 * when the group could NOT be confirmed gone, the A.2/A.3 guards will refuse
 * the transition and the caller lands on the cleanup-failed path (A.2 "any
 * active | cleanup failure during teardown | blocked") instead of a clean
 * escalation — a failed kill is never papered over.
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
