/**
 * Generic transition engine for the Appendix A state machines (WP-101,
 * CAM-STATE-05). A machine is a table of rows transcribed one-to-one from
 * the appendix: each row carries an appendix anchor (`ref`) so the recorded
 * consistency audit (docs/design/26-appendix-a-audit.md) can walk code
 * against spec row by row.
 *
 * Guards are named pure predicates over the event payload. Every factual
 * clause in an appendix row's event or guard column is modeled as a payload
 * field the caller must attest, and the guard checks it — the machine
 * refuses a transition unless every stated fact is present, so a caller
 * that skips a precondition produces a rejected-and-logged attempt, not a
 * silent state change.
 *
 * The engine is pure: no I/O, no clock, no randomness. Recording applied
 * and rejected transitions is the daemon recorder's job.
 */

/** A machine event: a name plus a payload carrying its guard inputs. */
export interface MachineEvent {
  readonly type: string;
}

/** Target state, either fixed or derived from the event payload (named for the audit). */
export type TransitionTarget<State extends string, Event extends MachineEvent> =
  | State
  | {
      readonly name: string;
      /** Returns the target state, or undefined when the payload cannot resolve one. */
      readonly derive: (event: Event) => State | undefined;
    };

export interface TransitionRow<State extends string, Event extends MachineEvent> {
  /** Appendix A anchor, e.g. "A.1#3a" — the audit key. Unique per machine. */
  readonly ref: string;
  /** Source states; null marks a creation row (entity does not exist yet). */
  readonly from: readonly State[] | null;
  readonly eventType: Event["type"];
  /** Named guard; omitted only where the appendix guard column is "—". */
  readonly guard?: {
    readonly name: string;
    readonly check: (event: Event) => boolean;
  };
  readonly to: TransitionTarget<State, Event>;
  /** Where the code encoding deviates from or refines the appendix text (audit pointer). */
  readonly note?: string;
}

export interface MachineDef<State extends string, Event extends MachineEvent> {
  readonly name: string;
  readonly states: readonly State[];
  readonly terminalStates: readonly State[];
  readonly rows: readonly TransitionRow<State, Event>[];
}

export type TransitionResult<State extends string> =
  | { readonly ok: true; readonly to: State; readonly ref: string }
  | { readonly ok: false; readonly code: "illegal-transition" }
  | {
      readonly ok: false;
      readonly code: "guard-rejected";
      /** Rows that matched (state, event) but whose guard refused the payload. */
      readonly refs: readonly string[];
    };

/**
 * Attempt a transition. `from` is the entity's current state, or null when
 * the event is a creation. Rows are evaluated in table order; the first row
 * whose guard accepts wins (guard-split rows — e.g. slot free vs queued —
 * rely on this and use mutually exclusive guards).
 */
export function transition<State extends string, Event extends MachineEvent>(
  def: MachineDef<State, Event>,
  from: State | null,
  event: Event,
): TransitionResult<State> {
  const guardRejectedRefs: string[] = [];
  let matchedAny = false;
  for (const row of def.rows) {
    if (row.eventType !== event.type) continue;
    if (row.from === null ? from !== null : from === null || !row.from.includes(from)) continue;
    matchedAny = true;
    if (row.guard && !row.guard.check(event)) {
      guardRejectedRefs.push(row.ref);
      continue;
    }
    const to = typeof row.to === "string" ? row.to : row.to.derive(event);
    if (to === undefined || !def.states.includes(to)) {
      guardRejectedRefs.push(row.ref);
      continue;
    }
    return { ok: true, to, ref: row.ref };
  }
  if (matchedAny) return { ok: false, code: "guard-rejected", refs: guardRejectedRefs };
  return { ok: false, code: "illegal-transition" };
}

/**
 * Recorded-context sources: payload fields the daemon recorder must fill
 * from the derived view (never trusting caller-supplied values) before
 * running a transition. Each machine module declares which of its events
 * carry recorded context (MISSION_CONTEXT_ENRICHMENT / ISSUE_CONTEXT_ENRICHMENT).
 */
export type EnrichmentSource =
  | "paused-from" // mission pausedFrom (A.1#17 "prior state (recorded)")
  | "current-candidate-sha" // latest candidate SHA (A.4#4 approval binding)
  | "approved-candidate-sha" // the bound approval's SHA (A.1#22 / A.1b#11 guard)
  | "next-mission-failure-count" // quick-task failure counter, post-increment (A.1b#6)
  | "next-issue-failure-count"; // issue failure counter, post-increment (A.2#9/#14)

export interface EnrichmentSpec {
  readonly field: string;
  readonly source: EnrichmentSource;
}

/** True when the payload field is exactly `true` (attested facts must be explicit). */
export function attested(value: unknown): value is true {
  return value === true;
}

/** True when the value is a non-empty string (SHA bindings, identifiers). */
export function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
