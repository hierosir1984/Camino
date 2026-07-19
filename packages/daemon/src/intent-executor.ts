/**
 * Intent executor (WP-104, CAM-STATE-02): drives one external operation
 * through the durable protocol
 *
 *   recorded → execution-started → [transport call] → confirmed
 *
 * with every arrow durable before the next step runs. The ordering IS the
 * durability contract: the barrier (`execution-started`) is appended and
 * committed BEFORE any transport is invoked, so a crash at any instant
 * leaves the journal able to say either "provably never sent" (barrier
 * absent) or "may have been sent — reconcile" (barrier present). The
 * kill-point chaos suite drives a real process through exactly these gaps.
 *
 * Idempotent completion: executing an intent that is already `confirmed`
 * returns the recorded result WITHOUT touching any transport — that is
 * the seeded duplicate-intent fixture behavior of CAM-STATE-02 (replayed
 * intents produce zero duplicate external side effects). Executing an
 * intent in `execution-started` REFUSES: only reconciliation (recovery)
 * may move an intent out of its ambiguity window.
 *
 * Transport outcome contract (see @camino/shared): a returned result is a
 * definitive success; `IndeterminateOutcomeError` means the outcome is
 * unknown (lost response while alive) and the intent is deliberately left
 * in `execution-started` for the same reconciliation path a crash uses;
 * any other throw is a definitive clean refusal recorded as `failed`.
 *
 * Test-service mutations run reset-before-use unconditionally: the reset
 * is the hygiene primary that makes the ENVIRONMENT the idempotency unit
 * (§4.4). The irreversible flag changes nothing at execution time — it is
 * recovery that must never auto-retry an unconfirmed irreversible effect.
 */
import { IndeterminateOutcomeError } from "@camino/shared";
import type { ExternalOperationSpec, MutationTransports, OperationResult } from "@camino/shared";
import type { IntentViewEntry } from "@camino/core";
import type { IntentJournal } from "./intent-journal.js";

/** Test seam for the chaos harness: called at named protocol points. */
export type ProtocolHook = (point: string) => void;

export interface IntentExecutorOptions {
  /** Actor recorded on journal rows this executor writes. */
  readonly actor?: string;
  /** Chaos/kill seam; default no-op. */
  readonly hook?: ProtocolHook;
}

export type ExecutionOutcome =
  | {
      readonly kind: "confirmed";
      readonly result: OperationResult;
      /** True when the journal already held a confirmation and no transport ran. */
      readonly alreadyComplete: boolean;
    }
  | { readonly kind: "failed"; readonly reason: string }
  | {
      /**
       * Outcome unknown (transport lost the response). The intent remains
       * in `execution-started`; reconciliation settles it.
       */
      readonly kind: "indeterminate";
      readonly reason: string;
    };

export class IntentExecutor {
  private readonly journal: IntentJournal;
  private readonly transports: MutationTransports;
  private readonly actor: string;
  private readonly hook: ProtocolHook;

  constructor(
    journal: IntentJournal,
    transports: MutationTransports,
    options: IntentExecutorOptions = {},
  ) {
    this.journal = journal;
    this.transports = transports;
    this.actor = options.actor ?? "camino:executor";
    this.hook = options.hook ?? (() => {});
  }

  /**
   * Durably record a new intent (the first protocol step). The full spec —
   * every reconciliation key the class will ever need — is validated and
   * persisted before anything can act on it. Duplicate ids refuse (intent
   * ids are unique forever).
   */
  submit(intentId: string, spec: ExternalOperationSpec): void {
    this.journal.append(
      {
        intentId,
        event: "recorded",
        actor: this.actor,
        payload: spec as unknown as Readonly<Record<string, unknown>>,
      },
      { expectedLastSeq: this.journal.lastSeq },
    );
  }

  /**
   * Execute a recorded intent through its transport, or complete
   * idempotently from the journal. Throws on unknown intents and on
   * statuses where execution is not the legal move (in-flight, escalated,
   * terminal-failed, abandoned) — those are caller bugs or recovery's job.
   */
  execute(intentId: string): ExecutionOutcome {
    const entry = this.journal.entry(intentId);
    if (entry === undefined) {
      throw new Error(`intent ${intentId} has no recorded row — submit() it first`);
    }
    switch (entry.status) {
      case "confirmed":
        return { kind: "confirmed", result: entry.result ?? {}, alreadyComplete: true };
      case "execution-started":
        throw new Error(
          `intent ${intentId} is in execution-started — it may have reached the external ` +
            "system; only reconciliation (recovery) may settle it, never a second execution",
        );
      case "ambiguity-recorded":
      case "escalated":
        throw new Error(
          `intent ${intentId} is ${entry.status} — awaiting the human decision ` +
            "(retry-authorized or abandoned); execution refuses",
        );
      case "failed":
      case "abandoned":
        throw new Error(`intent ${intentId} is terminally ${entry.status} — execution refuses`);
      case "recorded":
        break;
    }
    // The pre-execution barrier: durable before ANY transport code runs.
    this.journal.append(
      { intentId, event: "execution-started", actor: this.actor, payload: {} },
      { expectedLastSeq: this.journal.lastSeq },
    );
    this.hook("after-execution-started");
    let result: OperationResult;
    try {
      result = this.perform(entry);
    } catch (error) {
      if (error instanceof IndeterminateOutcomeError) {
        // Outcome unknown: leave the ambiguity window intact for
        // reconciliation — recording anything else here would be a guess.
        return { kind: "indeterminate", reason: error.message };
      }
      const reason = error instanceof Error ? error.message : String(error);
      this.journal.append(
        {
          intentId,
          event: "failed",
          actor: this.actor,
          payload: { via: "response", reason },
        },
        { expectedLastSeq: this.journal.lastSeq },
      );
      return { kind: "failed", reason };
    }
    this.hook("after-external-call");
    this.journal.append(
      {
        intentId,
        event: "confirmed",
        actor: this.actor,
        payload: { via: "response", result, note: "transport reported definitive success" },
      },
      { expectedLastSeq: this.journal.lastSeq },
    );
    return { kind: "confirmed", result, alreadyComplete: false };
  }

  /** Dispatch to the class's transport (reset-before-use for test-service). */
  private perform(entry: IntentViewEntry): OperationResult {
    const spec = entry.spec;
    switch (spec.op) {
      case "branch-create":
        return this.transports.github.createBranch(spec);
      case "push":
        return this.transports.github.push(spec);
      case "pr-create":
        return this.transports.github.createPullRequest(spec);
      case "merge-by-push":
        return this.transports.github.mergeByPush(spec);
      case "label-set":
        return this.transports.github.setLabel(spec);
      case "comment-post":
        return this.transports.github.postComment(spec);
      case "workflow-dispatch":
        return this.transports.github.dispatchWorkflow(spec);
      case "test-service-mutation": {
        // Reset-before-use is the hygiene primary: it runs on EVERY use,
        // making the environment the idempotency unit (§4.4).
        this.transports.testService.resetEnvironment(spec.environmentId);
        return this.transports.testService.mutate(spec);
      }
      case "catch-all":
        return this.transports.catchAll.perform(spec);
    }
  }
}
