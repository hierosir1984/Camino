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
 * WHAT CAM-CORE-10 DELIVERS HERE, STATED PRECISELY (round 1, finding 10):
 * SNAPSHOT PROVENANCE, not live real-time agreement. The GUI never renders
 * anything but a faithful ledger projection, taken at a NAMED point in the
 * logs (`asOf` = the three store sequences plus the reader context) and
 * labeled with those sequences in the UI. It is NOT a live mirror: after a
 * GET, an out-of-band ledger write is not reflected until the next read (a
 * mutation response, a refused action's re-read, or a page reload). Continuous
 * freshness — polling so a background change appears within one interval — is
 * WP-123's job (CAM-CORE-03), explicitly out of scope here. So "ledger and GUI
 * never disagree" holds in the CAM-CORE-10 sense the requirement means: the
 * GUI never derives requirement state from anything but the ledger (never repo
 * canon text, never a client re-computation), and every render is a projection
 * the daemon itself produced at a stated sequence. The Playwright agreement
 * suite (register.spec.ts) asserts that equality field-by-field after every
 * mutation; the out-of-band case is asserted after the reload that the v1
 * refresh model requires.
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
  statusContextProblem,
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

/**
 * The state a snapshot was computed at (optimistic-concurrency token). The
 * three store sequences catch a ledger/fact/disposition write; `context`
 * catches a repository-context change that moves the tuples WITHOUT any
 * store write (round 1, finding 6: an evidence axis flips verified-live →
 * stale purely because the reader's head advanced, and a stale-tab action
 * must not bind to the tuple the user never saw). The client echoes this
 * whole token back; `recordDisposition`/`descope` refuse a mismatch.
 */
export interface RegisterAsOf {
  readonly ledgerSeq: number;
  readonly factsSeq: number;
  readonly dispositionsSeq: number;
  readonly context: StatusContext;
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

/** The context key the projection uses ("main" or the branch name). */
function contextKeyOf(context: StatusContext): string {
  return context.kind === "branch" ? context.branch : "main";
}

/** Structural equality over the closed StatusContext shape (asOf comparison). */
function contextEquals(a: StatusContext, b: StatusContext): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "main" && b.kind === "main") return a.headSha === b.headSha;
  if (a.kind === "branch" && b.kind === "branch") {
    return a.branch === b.branch && a.headSha === b.headSha && a.baseSha === b.baseSha;
  }
  return false;
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
        context,
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
    const contextKey = contextKeyOf(snapshot.context);
    const payload: Record<string, unknown> = {
      tuple: row.tuple,
      // The context is taken from the service's own projection, not the
      // client — a disposition binds to the register context it was taken
      // in (round 1, finding 7), never leaking onto another context.
      contextKey,
      reason: input.reason,
    };
    if (event === "gap-false-positive-waived") {
      // The waiver binds to what the CLIENT saw (waivedThroughSeq), and
      // the decision layer refuses it unless that still names the row's
      // outstanding findings — a finding recorded between render and
      // click can never be silently waived.
      payload["waivedThroughSeq"] = input.waivedThroughSeq;
    }
    if (event === "gap-fix-queued" || event === "gap-disputed") {
      // Re-triage anchor (AMEND-11, F8): the canon-fact seq this judgment was
      // made against. If the gap's tuple later changes and returns, the anchor
      // predates the divergence and the projection will not resurrect this
      // disposition onto the new gap episode.
      payload["factAnchorSeq"] = snapshot.asOf.factsSeq;
    }
    const decision = decideGapDisposition(snapshot.rows, contextKey, {
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
    // Own-property reads of the asOf sub-fields (round 3, finding 3): the outer
    // body field is already own-read at the HTTP layer, but its nested sequence
    // triple / context must not inherit from a polluted prototype either. A
    // missing own field reads as undefined and fails `wellFormed`. (Deeper
    // pollution of the daemon's global prototypes is the named in-process
    // boundary — see gap-dispositions.ts.)
    const own = <T>(value: unknown, key: string): T | undefined =>
      value !== null && typeof value === "object" && Object.hasOwn(value, key)
        ? ((value as Record<string, unknown>)[key] as T)
        : undefined;
    const ledgerSeq = own<number>(presented, "ledgerSeq");
    const factsSeq = own<number>(presented, "factsSeq");
    const dispositionsSeq = own<number>(presented, "dispositionsSeq");
    const context = own<StatusContext>(presented, "context");
    const wellFormed =
      Number.isSafeInteger(ledgerSeq) &&
      Number.isSafeInteger(factsSeq) &&
      Number.isSafeInteger(dispositionsSeq) &&
      context !== undefined &&
      context !== null &&
      typeof context === "object" &&
      statusContextProblem(context) === null;
    if (!wellFormed) {
      throw new RegisterActionError(
        "malformed",
        "asOf must carry the snapshot's sequence triple and context",
      );
    }
    if (
      ledgerSeq !== current.ledgerSeq ||
      factsSeq !== current.factsSeq ||
      dispositionsSeq !== current.dispositionsSeq ||
      !contextEquals(context, current.context)
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
