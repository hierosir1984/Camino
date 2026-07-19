/**
 * Reconciliation decision path (WP-104, CAM-STATE-03): the single pure
 * function that turns an unresolved intent plus observed external facts
 * into a recovery verdict.
 *
 * Division of truth, exactly as the design states it: external systems are
 * truth for EXTERNAL FACTS (the `ObservedFacts` input, gathered by the
 * daemon through the read-only query transport), the log is truth for
 * DECISIONS (the `IntentSnapshot` input, folded from the intent journal —
 * intended SHAs, markers, desired states are read from what was recorded,
 * never re-derived). Recovery never blindly replays: every verdict below
 * is a comparison of those two truths under the class's §4.4 key.
 *
 * The verdict logic leans on the pre-execution barrier (see
 * @camino/shared external-ops): a `recorded` intent whose
 * `execution-started` row is absent is PROVABLY unsent — the executor
 * appends the barrier durably before invoking any transport — so it stays
 * executable for every class, including the at-most-once ones (running it
 * is the first execution, not a retry). Only the barrier-to-confirmation
 * window is genuinely dangerous, and inside it the classes split exactly
 * as the table says: decidable classes reconcile by query, at-most-once
 * classes become one durable ambiguity plus a human escalation.
 *
 * Like decideTransition (WP-101), this function is total and pure: every
 * status and every fact shape maps to exactly one verdict, callers in the
 * daemon (recovery) and in tests share the one path, and nothing here
 * performs I/O.
 */
import type {
  ExternalOperationSpec,
  IntentStatus,
  ObservedPullRequest,
  ObservedWorkflowRun,
  OperationResult,
} from "@camino/shared";

/**
 * The facts the daemon queried for one intent, tagged by class. The
 * test-service and catch-all classes carry no queryable surface — for an
 * irreversible or key-less effect there is nothing external that could
 * settle the ambiguity, which is WHY those classes escalate.
 */
export type ObservedFacts =
  | { readonly op: "branch-create"; readonly branchSha: string | null }
  | { readonly op: "push"; readonly refSha: string | null }
  | { readonly op: "pr-create"; readonly pullRequests: readonly ObservedPullRequest[] }
  | {
      readonly op: "merge-by-push";
      readonly targetAtOrPastMerge: boolean;
      readonly targetSha: string | null;
    }
  | { readonly op: "label-set"; readonly labelPresent: boolean }
  | { readonly op: "comment-post"; readonly comment: { readonly commentId: number } | null }
  | { readonly op: "workflow-dispatch"; readonly runs: readonly ObservedWorkflowRun[] }
  | { readonly op: "test-service-mutation" }
  | { readonly op: "catch-all" };

/** What recovery needs to know about one intent (folded from the journal). */
export interface IntentSnapshot {
  readonly intentId: string;
  readonly status: IntentStatus;
  readonly spec: ExternalOperationSpec;
}

export type ReconcileVerdict =
  /** Effect observed externally — recovery appends `confirmed` with these facts. */
  | { readonly kind: "confirmed-external"; readonly result: OperationResult; readonly note: string }
  /**
   * Effect provably or safely absent — recovery appends `re-armed` and the
   * intent is executable again. `resetBeforeUse` marks the test-service
   * path where the reset (not a query) is what makes re-execution safe.
   */
  | { readonly kind: "re-arm"; readonly resetBeforeUse: boolean; readonly note: string }
  /** Genuinely ambiguous — one durable ambiguity row, then escalation. Never auto-retried. */
  | { readonly kind: "ambiguous"; readonly reason: string }
  /** Effect known-absent AND the intent can never apply — terminal, surfaced. */
  | { readonly kind: "failed-terminal"; readonly reason: string }
  /** `recorded`: the barrier was never written, so the call provably never happened. */
  | { readonly kind: "pending-execution" }
  /** `ambiguity-recorded`: a crash landed between the ambiguity row and its escalation row. */
  | { readonly kind: "complete-escalation" }
  /** `escalated`: waiting on a human; recovery changes nothing. */
  | { readonly kind: "awaiting-human" }
  /** `confirmed` / `failed` / `abandoned`: nothing to reconcile. */
  | { readonly kind: "already-resolved" };

/** Fact/spec class mismatch is a caller bug — refuse loudly, never guess. */
export class ReconcileFactsMismatchError extends Error {
  constructor(intentId: string, specOp: string, factsOp: string) {
    super(
      `reconciliation facts for intent ${intentId} describe class ${JSON.stringify(factsOp)} ` +
        `but the recorded intent is class ${JSON.stringify(specOp)} — refusing to decide from mismatched facts`,
    );
  }
}

/**
 * The one reconciliation decision. Pure and total: exactly one verdict per
 * (status, spec, facts) input, throwing only on the structural
 * fact-mismatch caller bug.
 */
export function decideReconciliation(
  intent: IntentSnapshot,
  facts: ObservedFacts,
): ReconcileVerdict {
  if (facts.op !== intent.spec.op) {
    throw new ReconcileFactsMismatchError(intent.intentId, intent.spec.op, facts.op);
  }
  switch (intent.status) {
    case "recorded":
      return { kind: "pending-execution" };
    case "ambiguity-recorded":
      return { kind: "complete-escalation" };
    case "escalated":
      return { kind: "awaiting-human" };
    case "confirmed":
    case "failed":
    case "abandoned":
      return { kind: "already-resolved" };
    case "execution-started":
      return decideAmbiguityWindow(intent.intentId, intent.spec, facts);
  }
}

/**
 * The barrier-to-confirmation window, class by class per the §4.4 table.
 * Each branch re-checks the spec/facts pairing as the narrowing step —
 * structurally unreachable after the entry guard, kept as the fail-closed
 * alternative to a cast.
 */
function decideAmbiguityWindow(
  intentId: string,
  spec: ExternalOperationSpec,
  facts: ObservedFacts,
): ReconcileVerdict {
  switch (facts.op) {
    case "branch-create": {
      if (spec.op !== facts.op) throw new ReconcileFactsMismatchError(intentId, spec.op, facts.op);
      if (facts.branchSha === spec.targetSha) {
        return {
          kind: "confirmed-external",
          result: { branch: spec.branch, sha: spec.targetSha },
          note: "branch observed at the intended SHA (natural key)",
        };
      }
      if (facts.branchSha === null) {
        return {
          kind: "re-arm",
          resetBeforeUse: false,
          note: "branch absent — creation did not land; the natural key makes re-execution safe",
        };
      }
      return {
        kind: "ambiguous",
        reason:
          `branch ${spec.branch} exists at ${facts.branchSha}, not the intended ${spec.targetSha} — ` +
          "name collision or out-of-band actor; reconciliation will not overwrite it",
      };
    }
    case "push": {
      if (spec.op !== facts.op) throw new ReconcileFactsMismatchError(intentId, spec.op, facts.op);
      if (facts.refSha === spec.intendedSha) {
        return {
          kind: "confirmed-external",
          result: { ref: spec.ref, sha: spec.intendedSha },
          note: "ref observed at the intended SHA",
        };
      }
      if (facts.refSha === spec.expectedBaseSha) {
        return {
          kind: "re-arm",
          resetBeforeUse: false,
          note: "ref still at the recorded base — the push did not land; same-SHA re-push is idempotent",
        };
      }
      return {
        kind: "ambiguous",
        reason:
          `ref ${spec.ref} observed at ${facts.refSha ?? "(absent)"} — neither the intended SHA nor ` +
          "the recorded base; an out-of-band actor moved it (§4.5) and reconciliation never force-pushes",
      };
    }
    case "pr-create": {
      if (spec.op !== facts.op) throw new ReconcileFactsMismatchError(intentId, spec.op, facts.op);
      const closed = facts.pullRequests.filter((pr) => pr.state === "closed");
      if (closed.length > 0) {
        return {
          kind: "ambiguous",
          reason:
            `head branch ${spec.headBranch} carries ${closed.length} closed PR(s) ` +
            `(#${closed.map((pr) => pr.number).join(", #")}) — the closed/reused-branch ambiguity ` +
            "class escalates rather than guessing whose PR this branch now names",
        };
      }
      const open = facts.pullRequests.filter((pr) => pr.state === "open");
      const corroborated = open.filter((pr) => pr.body.includes(spec.bodyMarker));
      if (corroborated.length === 1) {
        const pr = corroborated[0]!;
        return {
          kind: "confirmed-external",
          result: { prNumber: pr.number, corroborated: true },
          note: "open PR on the head branch carries the embedded intent UUID",
        };
      }
      if (corroborated.length === 0 && open.length === 1) {
        // Bodies are mutable — the branch key is primary, the UUID only
        // corroborates. One open PR on our branch with no marker is ours
        // with an edited body; the resolution records the missing
        // corroboration for observability.
        return {
          kind: "confirmed-external",
          result: { prNumber: open[0]!.number, corroborated: false },
          note: "open PR on the head branch; body no longer carries the marker (bodies are mutable)",
        };
      }
      if (open.length === 0) {
        return {
          kind: "re-arm",
          resetBeforeUse: false,
          note: "no PR exists for the head branch — creation did not land",
        };
      }
      return {
        kind: "ambiguous",
        reason:
          `head branch ${spec.headBranch} carries ${open.length} open PRs and the embedded UUID ` +
          "does not single one out — escalating rather than claiming one",
      };
    }
    case "merge-by-push": {
      if (spec.op !== facts.op) throw new ReconcileFactsMismatchError(intentId, spec.op, facts.op);
      if (facts.targetAtOrPastMerge) {
        return {
          kind: "confirmed-external",
          result: { targetRef: spec.targetRef, mergeSha: spec.mergeSha },
          note: "target ref is at or past the constructed merge commit (ref-state idempotence)",
        };
      }
      if (facts.targetSha === spec.expectedBaseSha) {
        return {
          kind: "re-arm",
          resetBeforeUse: false,
          note: "target ref still at the expected base — the fast-forward did not land; re-push applies the same commit",
        };
      }
      return {
        kind: "failed-terminal",
        reason:
          `target ${spec.targetRef} observed at ${facts.targetSha ?? "(absent)"} — past the ` +
          "expected base without containing the constructed merge; the candidate is superseded " +
          "and can never fast-forward (the mission layer rebuilds and revalidates)",
      };
    }
    case "label-set": {
      if (spec.op !== facts.op) throw new ReconcileFactsMismatchError(intentId, spec.op, facts.op);
      if (facts.labelPresent === (spec.desired === "present")) {
        return {
          kind: "confirmed-external",
          result: { label: spec.label, desired: spec.desired },
          note: "observed label state equals the desired state (naturally idempotent)",
        };
      }
      return {
        kind: "re-arm",
        resetBeforeUse: false,
        note: "observed label state differs from desired — desired-state re-apply is idempotent",
      };
    }
    case "comment-post": {
      if (spec.op !== facts.op) throw new ReconcileFactsMismatchError(intentId, spec.op, facts.op);
      if (facts.comment !== null) {
        return {
          kind: "confirmed-external",
          result: { commentId: facts.comment.commentId },
          note: "comment carrying the embedded UUID marker found",
        };
      }
      return {
        kind: "re-arm",
        resetBeforeUse: false,
        note: "no comment carries the marker — the post did not land; the embedded UUID keeps any residual duplicate detectable",
      };
    }
    case "workflow-dispatch": {
      if (spec.op !== facts.op) throw new ReconcileFactsMismatchError(intentId, spec.op, facts.op);
      if (facts.runs.length > 0) {
        // Presence of a correlated run proves our dispatch happened;
        // several would prove duplicates (tolerable upstream —
        // advisory-only CI — but recorded honestly here).
        return {
          kind: "confirmed-external",
          result: { runId: facts.runs[0]!.runId, correlatedRuns: facts.runs.length },
          note: "workflow run carrying camino_intent_id observed (correlation presence is conclusive)",
        };
      }
      return {
        kind: "ambiguous",
        reason:
          "no run carries the correlation id, and absence proves nothing (queue lag) — " +
          "the at-most-once class records the lost-response ambiguity and never auto-retries",
      };
    }
    case "test-service-mutation": {
      if (spec.op !== facts.op) throw new ReconcileFactsMismatchError(intentId, spec.op, facts.op);
      if (spec.irreversible) {
        return {
          kind: "ambiguous",
          reason:
            "irreversible external effect (reset cannot undo it) in the ambiguity window — " +
            "recorded as ambiguity, never auto-retried",
        };
      }
      return {
        kind: "re-arm",
        resetBeforeUse: true,
        note: "resettable mutation: reset-before-use makes the environment the idempotency unit, so re-execution is safe",
      };
    }
    case "catch-all": {
      if (spec.op !== facts.op) throw new ReconcileFactsMismatchError(intentId, spec.op, facts.op);
      return {
        kind: "ambiguous",
        reason:
          "at-most-once operation with no reconciliation key — the ambiguity is durably " +
          "recorded before any manual retry, then escalated to a human",
      };
    }
  }
}
