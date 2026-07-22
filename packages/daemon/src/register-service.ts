/**
 * Gap-register service (WP-122): the composition layer between the
 * durable stores and the HTTP surface.
 *
 * CAM-CORE-10 BY CONSTRUCTION — the whole argument, in one place:
 *
 *  1. The GUI's ONLY source of canon/requirement state is
 *     `GET /api/register` (server.ts), whose handler calls
 *     `snapshot()` below and returns it verbatim.
 *  2. `snapshot()` reads exactly three inputs — the intent ledger's
 *     folded view, the canon-fact log, and the gap-disposition log — and
 *     hands them to `projectGapRegister` (@camino/core), the same pure
 *     projection any other consumer uses. No repo canon text is read,
 *     parsed, or even reachable in this path: the service holds store
 *     handles only, and the daemon does not know a repo checkout path in
 *     this surface at all.
 *  3. Disposition writes go through `decideGapDisposition` over the
 *     CURRENT projection before the store append, with an optimistic
 *     concurrency check (`asOf`) so an action taken against a stale
 *     render is refused instead of silently binding to newer state.
 *
 * What remains is agreement-at-a-sequence: a GET returns the register AT
 * its `asOf` sequence triple; the ledger may advance after the response
 * is written (the GUI re-reads; v1 refresh, WP-123 polling). "Ledger and
 * GUI never disagree" means the GUI never renders anything but a ledger
 * projection, at a named point in the logs — asserted end-to-end by the
 * Playwright agreement suite (register.spec.ts).
 *
 * CONTEXT: the register renders the MAIN context (the user's delivery
 * view; branch contexts are worker context-pack territory). The daemon
 * does not yet track the configured repo's main head — that lands with
 * the polling/merge work packages — so the production context source
 * reports "unavailable" and this surface answers honestly with
 * `available: false` rather than projecting against an invented SHA.
 * Test and fixture composition inject a real context.
 */
import {
  DAVID_ACTOR,
  decideGapDisposition,
  projectGapRegister,
  singleLineTextProblem,
} from "@camino/core";
import type { GapRegisterRow } from "@camino/core";
import { GAP_DISPOSITION_EVENTS } from "@camino/shared";
import type {
  GapDispositionEventName,
  GapDispositionRecord,
  LedgerEventRecord,
  StatusContext,
} from "@camino/shared";
import type { CanonFactsStore } from "./canon-facts.js";
import type { CanonLedgerStore } from "./canon-ledger.js";
import type { GapDispositionsStore } from "./gap-dispositions.js";

/**
 * Where the register's reader context comes from. Later WPs (repo head
 * polling, merge machinery) supply a live main-context source; until
 * then production wiring returns null and the register is honestly
 * unavailable.
 */
export interface RegisterContextSource {
  current(): StatusContext | null;
}

/** The store sequence triple a snapshot was computed at (optimistic-concurrency token). */
export interface RegisterAsOf {
  readonly ledgerSeq: number;
  readonly factsSeq: number;
  readonly dispositionsSeq: number;
}

export type RegisterSnapshot =
  | {
      readonly available: true;
      readonly context: StatusContext;
      readonly rows: readonly GapRegisterRow[];
      readonly asOf: RegisterAsOf;
    }
  | { readonly available: false; readonly reason: "no-repository-context" };

/** Client-facing action names: the event vocabulary minus the `gap-` prefix. */
export const REGISTER_ACTIONS = Object.freeze([
  "fix-queued",
  "disputed",
  "false-positive-waived",
  "reopened",
] as const);
export type RegisterAction = (typeof REGISTER_ACTIONS)[number];

export interface RegisterActionInput {
  readonly action: RegisterAction;
  readonly reason: string;
  /** Required for `false-positive-waived`: the findings the waiver binds to. */
  readonly waivedThroughSeq?: number;
  /** The snapshot the user acted on; a mismatch refuses the action. */
  readonly asOf: RegisterAsOf;
}

export interface RegisterActionResult {
  readonly record: GapDispositionRecord;
  readonly snapshot: RegisterSnapshot;
}

export interface RegisterDescopeResult {
  readonly record: LedgerEventRecord;
  readonly snapshot: RegisterSnapshot;
}

export type RegisterErrorCode =
  | "unavailable" // no repository context — the register cannot project
  | "malformed" // the request shape is wrong
  | "register-advanced" // asOf mismatch — re-read and act on current state
  | "unknown-row" // no live register row for that requirement
  | "refused"; // the decision layer refused (incl. the CAM-CANON-05 waiver rule)

export class RegisterActionError extends Error {
  readonly code: RegisterErrorCode;
  constructor(code: RegisterErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RegisterServiceDeps {
  readonly canonLedger: CanonLedgerStore;
  readonly canonFacts: CanonFactsStore;
  readonly gapDispositions: GapDispositionsStore;
  readonly contextSource: RegisterContextSource;
}

const ACTION_TO_EVENT: Readonly<Record<RegisterAction, GapDispositionEventName>> = Object.freeze({
  "fix-queued": "gap-fix-queued",
  disputed: "gap-disputed",
  "false-positive-waived": "gap-false-positive-waived",
  reopened: "gap-reopened",
});

function isRegisterAction(value: unknown): value is RegisterAction {
  return typeof value === "string" && (REGISTER_ACTIONS as readonly string[]).includes(value);
}

export class RegisterService {
  readonly #deps: RegisterServiceDeps;

  constructor(deps: RegisterServiceDeps) {
    this.#deps = deps;
  }

  snapshot(): RegisterSnapshot {
    const context = this.#deps.contextSource.current();
    if (context === null) return { available: false, reason: "no-repository-context" };
    const view = this.#deps.canonLedger.currentView();
    const facts = this.#deps.canonFacts.read();
    const dispositions = this.#deps.gapDispositions.read();
    const rows = projectGapRegister(view, facts, dispositions, context);
    return {
      available: true,
      context,
      rows,
      asOf: {
        ledgerSeq: this.#deps.canonLedger.lastSeq,
        factsSeq: facts.at(-1)?.seq ?? 0,
        dispositionsSeq: this.#deps.gapDispositions.lastSeq,
      },
    };
  }

  /**
   * Record one register disposition action. The event payload's basis
   * (the row's current tuple, and for waivers the findings bound) is
   * taken from THIS service's current projection — never from the
   * client — so a recorded disposition always binds to the state the
   * store actually held when it was decided.
   */
  recordDisposition(requirementId: string, input: RegisterActionInput): RegisterActionResult {
    if (!isRegisterAction(input.action)) {
      throw new RegisterActionError(
        "malformed",
        `unknown register action ${JSON.stringify(input.action)}`,
      );
    }
    const reasonIssue = singleLineTextProblem("reason", input.reason);
    if (reasonIssue !== null) throw new RegisterActionError("malformed", reasonIssue);

    const snapshot = this.snapshot();
    if (!snapshot.available) {
      throw new RegisterActionError(
        "unavailable",
        "the register has no repository context to project against",
      );
    }
    this.#assertAsOf(input.asOf, snapshot.asOf);
    const row = snapshot.rows.find((r) => r.requirementId === requirementId);
    if (row === undefined) {
      throw new RegisterActionError("unknown-row", `${requirementId} has no live gap-register row`);
    }
    const event = ACTION_TO_EVENT[input.action];
    const payload: Record<string, unknown> = { tuple: row.tuple, reason: input.reason };
    if (event === "gap-false-positive-waived") {
      // The waiver binds to what the CLIENT saw (waivedThroughSeq), and
      // the decision layer refuses it unless that still names the row's
      // outstanding findings — a finding recorded between render and
      // click can never be silently waived.
      payload["waivedThroughSeq"] = input.waivedThroughSeq;
    }
    const decision = decideGapDisposition(snapshot.rows, {
      requirementId,
      event,
      actor: DAVID_ACTOR,
      payload,
    });
    if (!decision.ok) throw new RegisterActionError("refused", decision.problem);
    const record = this.#deps.gapDispositions.append({ requirementId, event, payload });
    return { record, snapshot: this.snapshot() };
  }

  /**
   * Descope a requirement from the register surface: the intent-ledger
   * action (CAM-CANON-05's user path for a real unmet requirement). The
   * ledger's own lifecycle decides legality; the register only requires
   * that the action targets a live row and a current snapshot.
   */
  descope(
    requirementId: string,
    input: { readonly reason: string; readonly asOf: RegisterAsOf },
  ): RegisterDescopeResult {
    const reasonIssue = singleLineTextProblem("reason", input.reason);
    if (reasonIssue !== null) throw new RegisterActionError("malformed", reasonIssue);
    const snapshot = this.snapshot();
    if (!snapshot.available) {
      throw new RegisterActionError(
        "unavailable",
        "the register has no repository context to project against",
      );
    }
    this.#assertAsOf(input.asOf, snapshot.asOf);
    const row = snapshot.rows.find((r) => r.requirementId === requirementId);
    if (row === undefined) {
      throw new RegisterActionError("unknown-row", `${requirementId} has no live gap-register row`);
    }
    let record: LedgerEventRecord;
    try {
      record = this.#deps.canonLedger.descopeRequirement(requirementId, { reason: input.reason });
    } catch (error) {
      throw new RegisterActionError("refused", (error as Error).message);
    }
    return { record, snapshot: this.snapshot() };
  }

  #assertAsOf(presented: RegisterAsOf, current: RegisterAsOf): void {
    const wellFormed =
      presented !== null &&
      typeof presented === "object" &&
      Number.isSafeInteger(presented.ledgerSeq) &&
      Number.isSafeInteger(presented.factsSeq) &&
      Number.isSafeInteger(presented.dispositionsSeq);
    if (!wellFormed) {
      throw new RegisterActionError("malformed", "asOf must carry the snapshot's sequence triple");
    }
    if (
      presented.ledgerSeq !== current.ledgerSeq ||
      presented.factsSeq !== current.factsSeq ||
      presented.dispositionsSeq !== current.dispositionsSeq
    ) {
      throw new RegisterActionError(
        "register-advanced",
        "the register advanced past the snapshot this action was taken on — re-read and " +
          "act on the current state",
      );
    }
  }
}

/** Sanity guard: the action list and the event vocabulary must stay in lockstep. */
const MAPPED = Object.values(ACTION_TO_EVENT);
for (const event of GAP_DISPOSITION_EVENTS) {
  if (!MAPPED.includes(event)) {
    throw new Error(`register action map is missing gap-disposition event ${event}`);
  }
}
