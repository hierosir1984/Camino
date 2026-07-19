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
import { intentMarkerToken } from "@camino/shared";
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
  | {
      readonly op: "comment-post";
      readonly comments: ReadonlyArray<{ readonly commentId: number }>;
    }
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
 * The verdicts that need NO external facts (review round 1, finding 8):
 * recovery consults this FIRST and only queries the external system for
 * intents in the ambiguity window. A `recorded` intent is provably unsent
 * and an escalation pair needs completing whether or not GitHub is even
 * reachable — status-only work must never be blocked by a query.
 * Returns null exactly when the status is `execution-started` (facts
 * required).
 */
export function statusOnlyVerdict(intent: IntentSnapshot): ReconcileVerdict | null {
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
      return null;
  }
}

/**
 * The one reconciliation decision. Pure and total: exactly one verdict per
 * (status, spec, facts) input, throwing only on the structural
 * fact-mismatch caller bug. Status-only statuses resolve through the same
 * `statusOnlyVerdict` recovery consults directly.
 */
export function decideReconciliation(
  intent: IntentSnapshot,
  facts: ObservedFacts,
): ReconcileVerdict {
  if (facts.op !== intent.spec.op) {
    throw new ReconcileFactsMismatchError(intent.intentId, intent.spec.op, facts.op);
  }
  return statusOnlyVerdict(intent) ?? decideAmbiguityWindow(intent.intentId, intent.spec, facts);
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
      // A PR's identity is (head, base) — a PR from our head branch into a
      // DIFFERENT base is not this intent's PR (round-1 finding 2). Closed
      // PRs and foreign-base open PRs are both reuse evidence: the
      // closed/reused-branch ambiguity class escalates rather than
      // guessing whose PR this branch now names.
      const candidates = facts.pullRequests.filter(
        (pr) => pr.state === "open" && pr.baseBranch === spec.baseBranch,
      );
      const foreign = facts.pullRequests.filter(
        (pr) => pr.state === "closed" || pr.baseBranch !== spec.baseBranch,
      );
      if (foreign.length > 0) {
        return {
          kind: "ambiguous",
          reason:
            `head branch ${spec.headBranch} carries reuse evidence: ` +
            foreign.map((pr) => `#${pr.number} (${pr.state}, into ${pr.baseBranch})`).join(", ") +
            " — the closed/reused-branch ambiguity class escalates rather than guessing",
        };
      }
      // Corroboration matches the DELIMITED token, never a bare substring
      // (round-1 finding 1: prefix collisions).
      const token = intentMarkerToken(spec.bodyMarker);
      const corroborated = candidates.filter((pr) => pr.body.includes(token));
      if (corroborated.length === 1) {
        const pr = corroborated[0]!;
        return {
          kind: "confirmed-external",
          result: { prNumber: pr.number, corroborated: true },
          note: "open PR on the head/base pair carries the embedded intent UUID token",
        };
      }
      if (corroborated.length === 0 && candidates.length === 1) {
        // Bodies are mutable — the branch key is primary, the UUID only
        // corroborates. One open PR on our (head, base) pair with no
        // marker is ours with an edited body; the resolution records the
        // missing corroboration for observability.
        return {
          kind: "confirmed-external",
          result: { prNumber: candidates[0]!.number, corroborated: false },
          note: "open PR on the head/base pair; body no longer carries the marker (bodies are mutable)",
        };
      }
      if (candidates.length === 0) {
        return {
          kind: "re-arm",
          resetBeforeUse: false,
          note: "no PR exists for the head/base pair — creation did not land",
        };
      }
      return {
        kind: "ambiguous",
        reason:
          `head branch ${spec.headBranch} carries ${candidates.length} open PRs into ` +
          `${spec.baseBranch} and the embedded UUID token does not single one out — ` +
          "escalating rather than claiming one",
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
      if (facts.comments.length === 1) {
        return {
          kind: "confirmed-external",
          result: { commentId: facts.comments[0]!.commentId },
          note: "exactly one comment carries the embedded UUID marker token",
        };
      }
      if (facts.comments.length === 0) {
        return {
          kind: "re-arm",
          resetBeforeUse: false,
          note: "no comment carries the marker — the post did not land; the embedded UUID keeps any residual duplicate detectable",
        };
      }
      // Camino validation reserves the token namespace, so several
      // token-bearing comments mean an out-of-band actor is involved
      // (§4.5) — escalate, never pick one (round 3, finding 1).
      return {
        kind: "ambiguous",
        reason:
          `${facts.comments.length} comments carry this intent's marker token ` +
          `(#${facts.comments.map((c) => c.commentId).join(", #")}) — an out-of-band actor ` +
          "duplicated or forged the marker; escalating rather than claiming one",
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
