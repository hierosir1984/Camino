/**
 * Status-tuple projection (WP-109, CAM-CANON-03): derive, per requirement
 * and per reader context, the design §3.1 tuple
 *
 *   intent-disposition × implementation-state × evidence-state
 *
 * PURE AND RECOMPUTED: the tuple is a total function of (ledger view,
 * canon facts, context). Nothing hand-maintains reverse transitions —
 * reverts, external edits, and probe regressions change the FACTS and the
 * projection recomputes (§3.1). Intent-disposition comes exclusively from
 * the ledger view; no fact can move it (CAM-CANON-01).
 *
 * TREE-HONEST BRANCH CONTEXTS (review round 1, findings 5/7): the
 * projection has no git, so it never GUESSES ancestry. A branch context
 * derives exclusively from branch-scoped facts; main landings appear in
 * a branch's view only through a `mainline-inherited` fact recorded by
 * the ancestry-aware machinery that verified the landing is in the
 * branch's tree. Main-context state — landings, suspicions — never
 * bleeds into a branch on its own.
 *
 * ORDERING: facts are folded in recorded observation order (`seq`); the
 * projection SORTS by seq, so callers may pass reads in any order
 * (review round 1, finding 15). Undetected external transitions between
 * polls are outside the projection's knowledge — design invariant 3 and
 * CAM-CANON-06 state that limit.
 *
 * EVIDENCE (review round 1, findings 4/6): verdicts bind to
 * (head SHA, base SHA) and expire rather than rebind (invariant 7).
 * `verified-live` requires a verdict IN this context at exactly the
 * context's current binding with no later touch. Verdicts recorded in
 * the context itself always take precedence over inherited main
 * verdicts, whatever their relative order; main evidence reaches a
 * branch only when the branch has no verdict of its own, never touched
 * the requirement, and carries the landing (`mainline-inherited`) — and
 * then as `stale` at best, because a cross-context binding is never
 * "live".
 *
 * Every rule is a named row in IMPLEMENTATION_RULES / EVIDENCE_RULES;
 * `explainRequirementStatus` reports which rules FIRED, and the fixture
 * walks assert mechanical coverage over the fired sets — coverage is
 * observed, not self-reported (review round 1, finding 10).
 */
import { REQUIREMENT_ID_PATTERN } from "@camino/shared";
import type {
  CanonFactInput,
  CanonFactRecord,
  EvidenceState,
  ImplementationState,
  StatusContext,
  StatusTuple,
} from "@camino/shared";
import { CANON_FACT_KINDS } from "@camino/shared";
import type { LedgerView, LedgerViewEntry } from "./canon-intent.js";
import { recordedAtProblem, safeErrorLabel } from "./canon-intent.js";

/** One named projection rule (implementation or evidence axis), for coverage-walked fixtures. */
export interface ProjectionRule {
  readonly rule: string;
  readonly axis: "implementation" | "evidence";
  readonly statement: string;
}

export const IMPLEMENTATION_RULES: readonly ProjectionRule[] = [
  {
    rule: "I1",
    axis: "implementation",
    statement: "no facts for a requirement ⇒ absent (in every context)",
  },
  {
    rule: "I2",
    axis: "implementation",
    statement: "implementation-recorded(B) ⇒ present-on(B) in context B",
  },
  {
    rule: "I3",
    axis: "implementation",
    statement: "landed-on-main (confirmed push, CAM-CANON-10) ⇒ on-main in context main",
  },
  {
    rule: "I4",
    axis: "implementation",
    statement:
      "mainline-inherited(B), recorded by ancestry-aware machinery, ⇒ on-main in context B; a landing NEVER leaks into a branch context without it",
  },
  {
    rule: "I5",
    axis: "implementation",
    statement: "revert-recorded(main) after a landing ⇒ absent on main (revert recomputes, §4.2)",
  },
  {
    rule: "I6",
    axis: "implementation",
    statement:
      "revert-recorded(B) clears BOTH branch presence and inherited mainline for B (the branch's tree lacks R)",
  },
  {
    rule: "I7",
    axis: "implementation",
    statement: "a later implementation-recorded(B) restores present-on(B) (re-implemented)",
  },
  {
    rule: "I8",
    axis: "implementation",
    statement:
      "a later landed-on-main restores on-main in context main (repair landed, re-derived not hand-reversed)",
  },
  {
    rule: "I9",
    axis: "implementation",
    statement:
      "outstanding absence-suspected(C) ⇒ suspected-absent in context C (conservative until re-scanned)",
  },
  {
    rule: "I10",
    axis: "implementation",
    statement:
      "main-context state never crosses into a branch on its own: main suspicion does not doubt a branch's tree, and a landing without mainline-inherited(B) leaves B absent",
  },
  {
    rule: "I11",
    axis: "implementation",
    statement:
      "absence-resolved(C, present) clears the suspicion and restores the underlying derivation",
  },
  {
    rule: "I12",
    axis: "implementation",
    statement:
      "absence-resolved(C, absent) clears the suspicion AND every presence for C — branch presence, inherited mainline, or the main landing — ⇒ absent (confirmed gone)",
  },
] as const;

export const EVIDENCE_RULES: readonly ProjectionRule[] = [
  {
    rule: "E1",
    axis: "evidence",
    statement: "no applicable verdict ⇒ unverified",
  },
  {
    rule: "E2",
    axis: "evidence",
    statement:
      "the latest same-context verdict, passing, at exactly the context's (head, base) binding, with no later touch ⇒ verified-live",
  },
  {
    rule: "E3",
    axis: "evidence",
    statement:
      "the latest same-context verdict, passing, at an expired binding (head or base drift), no later touch ⇒ stale (stale-evidence downgrade)",
  },
  {
    rule: "E4",
    axis: "evidence",
    statement:
      "a touch of R in this context after the governing verdict ⇒ unverified (verification never inherits across branch changes)",
  },
  {
    rule: "E5",
    axis: "evidence",
    statement:
      "main verdicts reach a branch ONLY with no own verdicts, no touch ever, and mainline-inherited(B) outstanding — and then as stale at best (cross-context bindings are never live)",
  },
  {
    rule: "E6",
    axis: "evidence",
    statement:
      "a branch that touched R never sees main evidence (the CAM-CANON-03 sentence, verbatim)",
  },
  {
    rule: "E7",
    axis: "evidence",
    statement: "verdicts never cross between branches, nor from a branch into main",
  },
  {
    rule: "E8",
    axis: "evidence",
    statement:
      "the governing verdict being a FAIL ⇒ unverified (a failure is not evidence of verification)",
  },
  {
    rule: "E9",
    axis: "evidence",
    statement:
      "an outstanding verification-blocked(C) renders blocked wherever the state would otherwise be unverified or stale",
  },
  {
    rule: "E10",
    axis: "evidence",
    statement:
      "verified-live at the exact context binding stands even while blocked is outstanding (the run already happened)",
  },
  {
    rule: "E11",
    axis: "evidence",
    statement:
      "verification-unblocked(C) clears the block and the underlying derivation shows through",
  },
  {
    rule: "E12",
    axis: "evidence",
    statement:
      "same-context verdicts take precedence over inherited main verdicts regardless of recording order (a later main verdict cannot mask a branch's own proof)",
  },
] as const;

const SHA_PATTERN = /^[0-9a-f]{40}$/;

export type FactValidation =
  { readonly ok: true } | { readonly ok: false; readonly problem: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function stringProblem(field: string, value: unknown): string | null {
  if (typeof value !== "string") return `${field} must be a string`;
  if (value.length === 0) return `${field} must be non-empty`;
  if (!value.isWellFormed()) return `${field} contains unpaired surrogate code units`;
  if (value.includes("\u0000")) return `${field} contains an embedded NUL`;
  return null;
}

/**
 * Branch names: storage hygiene only. Full git refname validation is
 * delegated to git at the boundary that touches git (WP-003 lesson:
 * never hand-roll git's rules); here we require a token that cannot
 * confuse the projection or the store.
 */
function branchProblem(field: string, value: unknown): string | null {
  const base = stringProblem(field, value);
  if (base !== null) return base;
  const branch = value as string;
  if (branch === "main") return `${field} must not be "main" — main is its own context kind`;
  if (branch.length > 256) return `${field} exceeds 256 characters`;
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f ~^:?*[\\]/.test(branch)) {
    return `${field} contains characters git refnames forbid`;
  }
  return null;
}

function shaProblem(field: string, value: unknown): string | null {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    return `${field} must be a 40-hex-character SHA`;
  }
  return null;
}

/** Context payload fragment: { contextKind: "main" } or { contextKind: "branch", branch }. */
function contextFieldsProblem(payload: Record<string, unknown>): string | null {
  const kind = payload["contextKind"];
  if (kind === "main") {
    if ("branch" in payload) return 'contextKind "main" must not carry a branch field';
    return null;
  }
  if (kind === "branch") {
    return branchProblem("branch", payload["branch"]);
  }
  return 'contextKind must be "main" or "branch"';
}

function expectKeys(
  payload: Record<string, unknown>,
  required: readonly string[],
  conditional: readonly string[] = [],
): string | null {
  for (const key of Object.keys(payload)) {
    if (!required.includes(key) && !conditional.includes(key)) {
      return `unexpected payload field ${JSON.stringify(key)}`;
    }
  }
  for (const key of required) {
    if (!(key in payload)) return `missing payload field ${JSON.stringify(key)}`;
  }
  return null;
}

/**
 * Shape-validate one canon fact. Facts have NO transition machine: they
 * are observations of a world Camino does not control, and the projection
 * is total over any recorded sequence. Validation is hygiene only —
 * closed schemas, SHA/branch/requirement grammars, string safety. Total:
 * hostile objects whose traps throw are refused, never thrown through
 * (review round 1, finding 15).
 */
export function validateCanonFact(input: CanonFactInput): FactValidation {
  try {
    return validateCanonFactInner(input);
  } catch (error) {
    return {
      ok: false,
      problem: `fact observation threw (${safeErrorLabel(error)}) — hostile or exotic input refused`,
    };
  }
}

function validateCanonFactInner(input: CanonFactInput): FactValidation {
  if (
    typeof input.requirementId !== "string" ||
    !REQUIREMENT_ID_PATTERN.test(input.requirementId)
  ) {
    return { ok: false, problem: "requirementId must match the stable-id grammar (CAM-AREA-NN)" };
  }
  if (!(CANON_FACT_KINDS as readonly string[]).includes(input.kind)) {
    return { ok: false, problem: `${JSON.stringify(input.kind)} is not a canon fact kind` };
  }
  const actorIssue = stringProblem("actor", input.actor);
  if (actorIssue !== null) return { ok: false, problem: actorIssue };
  if (!isPlainObject(input.payload)) {
    return { ok: false, problem: "payload must be a plain object" };
  }
  const payload = input.payload;
  const problem = ((): string | null => {
    switch (input.kind) {
      case "requirement-touched":
        return (
          expectKeys(payload, ["branch", "sha"]) ??
          branchProblem("branch", payload["branch"]) ??
          shaProblem("sha", payload["sha"])
        );
      case "implementation-recorded":
        return (
          expectKeys(payload, ["branch", "sha"]) ??
          branchProblem("branch", payload["branch"]) ??
          shaProblem("sha", payload["sha"])
        );
      case "landed-on-main":
        return expectKeys(payload, ["sha"]) ?? shaProblem("sha", payload["sha"]);
      case "mainline-inherited":
        return (
          expectKeys(payload, ["branch", "sha"]) ??
          branchProblem("branch", payload["branch"]) ??
          shaProblem("sha", payload["sha"])
        );
      case "revert-recorded":
        return (
          expectKeys(payload, ["contextKind", "sha"], ["branch"]) ??
          contextFieldsProblem(payload) ??
          shaProblem("sha", payload["sha"])
        );
      case "absence-suspected":
        return (
          expectKeys(payload, ["contextKind", "reason"], ["branch"]) ??
          contextFieldsProblem(payload) ??
          stringProblem("reason", payload["reason"])
        );
      case "absence-resolved": {
        const shape =
          expectKeys(payload, ["contextKind", "resolution"], ["branch"]) ??
          contextFieldsProblem(payload);
        if (shape !== null) return shape;
        const resolution = payload["resolution"];
        if (resolution !== "present" && resolution !== "absent") {
          return 'resolution must be "present" or "absent"';
        }
        return null;
      }
      case "verification-verdict": {
        const shape =
          expectKeys(payload, ["contextKind", "headSha", "baseSha", "outcome"], ["branch"]) ??
          contextFieldsProblem(payload) ??
          shaProblem("headSha", payload["headSha"]) ??
          shaProblem("baseSha", payload["baseSha"]);
        if (shape !== null) return shape;
        const outcome = payload["outcome"];
        if (outcome !== "pass" && outcome !== "fail") return 'outcome must be "pass" or "fail"';
        return null;
      }
      case "verification-blocked":
        return (
          expectKeys(payload, ["contextKind", "reason"], ["branch"]) ??
          contextFieldsProblem(payload) ??
          stringProblem("reason", payload["reason"])
        );
      case "verification-unblocked":
        return expectKeys(payload, ["contextKind"], ["branch"]) ?? contextFieldsProblem(payload);
    }
  })();
  if (problem !== null) return { ok: false, problem: `${input.kind}: ${problem}` };
  return { ok: true };
}

/** Re-validate an entire fact log (store adoption path — fail-closed like every Camino store). */
export function verifyCanonFactLog(
  records: readonly CanonFactRecord[],
): Array<{ seq: number; problem: string }> {
  const divergences: Array<{ seq: number; problem: string }> = [];
  let lastSeq = 0;
  for (const record of records) {
    if (!Number.isSafeInteger(record.seq) || record.seq <= lastSeq) {
      divergences.push({
        seq: record.seq,
        problem: `seq ${record.seq} is not a safe, strictly increasing integer after ${lastSeq}`,
      });
      continue;
    }
    lastSeq = record.seq;
    const timeIssue = recordedAtProblem(record.recordedAt);
    if (timeIssue !== null) {
      divergences.push({ seq: record.seq, problem: timeIssue });
      continue;
    }
    const validation = validateCanonFact(record);
    if (!validation.ok) divergences.push({ seq: record.seq, problem: validation.problem });
  }
  return divergences;
}

/** The fact context a payload names, as a comparison key ("main" or the branch name). */
function factContextKey(payload: Readonly<Record<string, unknown>>): string {
  return payload["contextKind"] === "branch" ? (payload["branch"] as string) : "main";
}

function contextKey(context: StatusContext): string {
  return context.kind === "branch" ? context.branch : "main";
}

/**
 * Validate a reader context (review round 2, findings 4/10): the context
 * comes from a caller (context-pack builder, GUI), not the trusted
 * stores, so a malformed one is a caller bug that must surface as a clean
 * error rather than a leaked trap or a silently-wrong tuple. In
 * particular a BRANCH context may not be named "main" \u2014 that would let it
 * consume main verdicts as its own (finding 4b) \u2014 and both SHAs must be
 * real 40-hex commit ids. Any exotic object whose traps throw is turned
 * into the same clean refusal (finding 10).
 */
export function statusContextProblem(context: StatusContext): string | null {
  try {
    if (context === null || typeof context !== "object") return "status context must be an object";
    const kind = context.kind;
    if (kind === "main") {
      return shaProblem("headSha", (context as { headSha: unknown }).headSha);
    }
    if (kind === "branch") {
      return (
        branchProblem("branch", (context as { branch: unknown }).branch) ??
        shaProblem("headSha", (context as { headSha: unknown }).headSha) ??
        shaProblem("baseSha", (context as { baseSha: unknown }).baseSha)
      );
    }
    return 'status context kind must be "main" or "branch"';
  } catch (error) {
    return `malformed status context (${safeErrorLabel(error)})`;
  }
}

function assertContext(context: StatusContext): void {
  const problem = statusContextProblem(context);
  if (problem !== null) throw new Error(`malformed status context: ${problem}`);
}

/**
 * A TOTAL ordering over facts (review round 2, finding 10): the store
 * guarantees strictly-increasing safe-integer seqs, but the public
 * projector must not return DIFFERENT answers for the same multiset in a
 * different array order. Facts sort by seq, then \u2014 for the
 * cannot-happen-from-a-store case of a duplicate or non-finite seq \u2014 by a
 * stable per-record key, so the result is a function of the SET of facts,
 * never their input permutation. Non-finite seqs sort last,
 * deterministically.
 */
function factSortKey(fact: CanonFactRecord): string {
  return `${fact.kind}\u0000${fact.actor}\u0000${fact.recordedAt}\u0000${JSON.stringify(fact.payload)}`;
}

function orderFacts(facts: readonly CanonFactRecord[]): CanonFactRecord[] {
  return [...facts].sort((a, b) => {
    const sa = Number.isFinite(a.seq) ? a.seq : Number.POSITIVE_INFINITY;
    const sb = Number.isFinite(b.seq) ? b.seq : Number.POSITIVE_INFINITY;
    if (sa !== sb) return sa < sb ? -1 : 1;
    const ka = factSortKey(a);
    const kb = factSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** The projection's full answer: the tuple plus which rules produced it. */
export interface ExplainedStatus {
  readonly tuple: StatusTuple;
  /** Rule ids (from IMPLEMENTATION_RULES / EVIDENCE_RULES) that fired for this derivation. */
  readonly fired: ReadonlySet<string>;
}

interface ImplementationFold {
  onMain: boolean;
  everLanded: boolean;
  landingRestored: boolean;
  /** Branches with a live own implementation. */
  presentOn: Set<string>;
  /** Branches whose own implementation was restored after a revert (I7 evidence). */
  presenceRestored: Set<string>;
  /** Branches attested (by ancestry-aware machinery) to carry R's main landing. */
  mainlineInherited: Set<string>;
  /** Context keys with an outstanding absence suspicion. */
  suspicion: Set<string>;
  /** Context keys whose suspicion was cleared by a present-resolution (I11 evidence). */
  suspicionCleared: Set<string>;
  /** Context keys confirmed absent by a rescan (I12 evidence). */
  confirmedAbsent: Set<string>;
  /** Branches cleared by a branch revert, still outstanding (I6 evidence). */
  branchReverted: Set<string>;
}

function foldImplementation(facts: readonly CanonFactRecord[]): ImplementationFold {
  const fold: ImplementationFold = {
    onMain: false,
    everLanded: false,
    landingRestored: false,
    presentOn: new Set(),
    presenceRestored: new Set(),
    mainlineInherited: new Set(),
    suspicion: new Set(),
    suspicionCleared: new Set(),
    confirmedAbsent: new Set(),
    branchReverted: new Set(),
  };
  for (const fact of facts) {
    switch (fact.kind) {
      case "implementation-recorded": {
        const branch = fact.payload["branch"] as string;
        if (fold.branchReverted.has(branch) || fold.confirmedAbsent.has(branch)) {
          fold.presenceRestored.add(branch); // I7
        }
        fold.presentOn.add(branch);
        fold.branchReverted.delete(branch);
        fold.confirmedAbsent.delete(branch);
        break;
      }
      case "landed-on-main": {
        if (fold.everLanded && !fold.onMain) fold.landingRestored = true; // I8
        fold.onMain = true; // I3
        fold.everLanded = true;
        fold.confirmedAbsent.delete("main");
        break;
      }
      case "mainline-inherited": {
        const branch = fact.payload["branch"] as string;
        fold.mainlineInherited.add(branch); // I4
        fold.branchReverted.delete(branch);
        fold.confirmedAbsent.delete(branch);
        break;
      }
      case "revert-recorded": {
        const key = factContextKey(fact.payload);
        if (key === "main") {
          fold.onMain = false; // I5
        } else {
          fold.presentOn.delete(key);
          fold.mainlineInherited.delete(key); // I6
          fold.branchReverted.add(key);
        }
        break;
      }
      case "absence-suspected": {
        fold.suspicion.add(factContextKey(fact.payload)); // I9
        break;
      }
      case "absence-resolved": {
        const key = factContextKey(fact.payload);
        if (fold.suspicion.has(key) && fact.payload["resolution"] === "present") {
          fold.suspicionCleared.add(key); // I11
        }
        fold.suspicion.delete(key);
        if (fact.payload["resolution"] === "absent") {
          // I12: confirmed gone \u2014 clear every presence for this context.
          fold.confirmedAbsent.add(key);
          fold.suspicionCleared.delete(key);
          if (key === "main") fold.onMain = false;
          else {
            fold.presentOn.delete(key);
            fold.mainlineInherited.delete(key);
            fold.branchReverted.delete(key);
          }
        }
        break;
      }
      default:
        break; // Evidence-axis facts do not move the implementation axis.
    }
  }
  return fold;
}

/**
 * Derive the implementation state, firing each rule EXACTLY in the
 * situation its statement describes (review round 2, finding 7): every
 * fire() below is reached only on the precise condition named in
 * IMPLEMENTATION_RULES, so the fixture walks' observed-coverage assertion
 * is semantically faithful, not just label-matched.
 */
function deriveImplementation(
  fold: ImplementationFold,
  context: StatusContext,
  fire: (rule: string) => void,
): ImplementationState {
  if (context.kind === "main") {
    if (fold.suspicion.has("main")) {
      fire("I9");
      return { kind: "suspected-absent" };
    }
    // A present-resolution restored the view (I11 fires, then the
    // underlying state rule shows through).
    if (fold.suspicionCleared.has("main")) fire("I11");
    if (fold.onMain) {
      fire("I3");
      if (fold.landingRestored) fire("I8");
      return { kind: "on-main" };
    }
    if (fold.confirmedAbsent.has("main")) {
      fire("I12"); // a rescan confirmed R gone from main
    } else if (fold.everLanded) {
      fire("I5"); // landed once, absent now: a revert removed it
    } else {
      fire("I1"); // no main landing ever
    }
    return { kind: "absent" };
  }
  const branch = context.branch;
  if (fold.suspicion.has(branch)) {
    fire("I9");
    return { kind: "suspected-absent" };
  }
  if (fold.suspicionCleared.has(branch)) fire("I11");
  if (fold.presentOn.has(branch)) {
    fire("I2");
    if (fold.presenceRestored.has(branch)) fire("I7");
    return { kind: "present-on", branch };
  }
  if (fold.mainlineInherited.has(branch)) {
    fire("I4");
    return { kind: "on-main" };
  }
  // Absent on this branch. Name the precise reason.
  if (fold.confirmedAbsent.has(branch)) {
    fire("I12"); // a branch rescan confirmed R gone
  } else if (fold.branchReverted.has(branch)) {
    fire("I6"); // a branch revert cleared presence/inheritance
  } else if (fold.onMain || fold.suspicion.has("main")) {
    fire("I10"); // main has state, but it does not cross into this branch's tree
  } else {
    fire("I1"); // nothing bears on this branch
  }
  return { kind: "absent" };
}

/**
 * The evidence axis. A branch "touched" R \u2014 and so can never inherit
 * main's verdict (review round 2, finding 3) \u2014 whenever it carries ANY
 * own change to R: a requirement-touched fact, an implementation-recorded
 * merge, or a revert. Same-context verdicts always govern over inherited
 * main verdicts, whatever the recording order (finding 6 / E12).
 */
function deriveEvidence(
  facts: readonly CanonFactRecord[],
  context: StatusContext,
  fire: (rule: string) => void,
): EvidenceState {
  const key = contextKey(context);
  const verdicts = facts.filter((f) => f.kind === "verification-verdict");
  const ownVerdicts = verdicts.filter((f) => factContextKey(f.payload) === key);
  // A branch change to R: requirement-touched and implementation-recorded
  // name their branch DIRECTLY (no contextKind), so factContextKey (which
  // keys on contextKind) would mis-map them to "main"; revert-recorded
  // uses contextKind. Key each on the field it actually carries.
  const branchChangeSeq = (f: CanonFactRecord): number | null => {
    if (f.kind === "requirement-touched" || f.kind === "implementation-recorded") {
      return (f.payload["branch"] as string) === key ? f.seq : null;
    }
    if (f.kind === "revert-recorded" && factContextKey(f.payload) === key) return f.seq;
    return null;
  };
  const touchSeqs = (): number[] =>
    context.kind === "branch"
      ? facts.map(branchChangeSeq).filter((s): s is number => s !== null)
      : [];
  const everTouched = context.kind === "branch" && touchSeqs().length > 0;
  const mainlineCarried =
    context.kind === "branch" &&
    ((): boolean => {
      let carried = false;
      for (const f of facts) {
        if (f.kind === "mainline-inherited" && (f.payload["branch"] as string) === key)
          carried = true;
        if (f.kind === "revert-recorded" && factContextKey(f.payload) === key) carried = false;
        if (
          f.kind === "absence-resolved" &&
          factContextKey(f.payload) === key &&
          f.payload["resolution"] === "absent"
        )
          carried = false;
      }
      return carried;
    })();

  const blockedOutstanding = ((): boolean => {
    let blocked = false;
    for (const f of facts) {
      if (f.kind === "verification-blocked" && factContextKey(f.payload) === key) blocked = true;
      if (f.kind === "verification-unblocked" && factContextKey(f.payload) === key) blocked = false;
    }
    return blocked;
  })();
  const cleared = facts.some(
    (f) => f.kind === "verification-unblocked" && factContextKey(f.payload) === key,
  );
  const blockedOr = (state: EvidenceState): EvidenceState => {
    if (blockedOutstanding) {
      fire("E9");
      return "blocked";
    }
    if (cleared) fire("E11");
    return state;
  };

  // Choose the governing verdict. Same-context verdicts win outright
  // (E12); main verdicts are inherited only by an untouched branch that
  // still carries the landing (E5/E6); no verdict crosses between
  // branches or into main (E7).
  let governing: CanonFactRecord | undefined;
  let inherited = false;
  if (ownVerdicts.length > 0) {
    governing = ownVerdicts.at(-1);
    if (
      context.kind === "branch" &&
      verdicts.some(
        (f) => factContextKey(f.payload) === "main" && f.seq > (governing as CanonFactRecord).seq,
      )
    ) {
      fire("E12"); // a later main verdict exists but does NOT mask this one
    }
  } else if (context.kind === "branch" && everTouched) {
    if (verdicts.some((f) => factContextKey(f.payload) === "main")) fire("E6");
  } else if (context.kind === "branch" && mainlineCarried) {
    const mainVerdicts = verdicts.filter((f) => factContextKey(f.payload) === "main");
    governing = mainVerdicts.at(-1);
    inherited = governing !== undefined;
    if (inherited) fire("E5");
  }
  if (
    governing === undefined &&
    verdicts.length > 0 &&
    !(context.kind === "branch" && everTouched)
  ) {
    fire("E7"); // verdicts exist, but none crosses into this context
  }

  if (governing === undefined) {
    fire("E1");
    return blockedOr("unverified");
  }
  if (governing.payload["outcome"] === "fail") {
    fire("E8");
    return blockedOr("unverified");
  }
  const touchedAfter = touchSeqs().some((seq) => seq > (governing as CanonFactRecord).seq);
  if (touchedAfter) {
    fire("E4");
    return blockedOr("unverified");
  }
  const headMatches = governing.payload["headSha"] === context.headSha;
  // A branch verdict binds to (head, base); a main verdict binds at its
  // head (main is never rebased \u2014 there is no "current base" for main to
  // drift against, so a main head uniquely determines the binding).
  const baseMatches =
    context.kind === "main" ? true : governing.payload["baseSha"] === context.baseSha;
  if (!inherited && headMatches && baseMatches) {
    fire("E2");
    if (blockedOutstanding) fire("E10");
    return "verified-live";
  }
  fire("E3");
  return blockedOr("stale");
}

/**
 * Project one requirement's status tuple for a context, reporting which
 * rules fired. `facts` are this requirement's records in any order (the
 * projection imposes a total order); facts for other requirements are the
 * caller's filtering responsibility (`projectStatus` does it for whole
 * views).
 */
export function explainRequirementStatus(
  entry: LedgerViewEntry,
  facts: readonly CanonFactRecord[],
  context: StatusContext,
): ExplainedStatus {
  assertContext(context);
  const ordered = orderFacts(facts);
  const fired = new Set<string>();
  const fire = (rule: string): void => {
    fired.add(rule);
  };
  const fold = foldImplementation(ordered);
  const implementation = deriveImplementation(fold, context, fire);
  const evidence = deriveEvidence(ordered, context, fire);
  return {
    tuple: { disposition: entry.disposition, implementation, evidence },
    fired,
  };
}

/** The tuple alone (most callers). */
export function projectRequirementStatus(
  entry: LedgerViewEntry,
  facts: readonly CanonFactRecord[],
  context: StatusContext,
): StatusTuple {
  return explainRequirementStatus(entry, facts, context).tuple;
}

/**
 * Project the whole ledger for a context. Facts for requirement ids the
 * ledger does not know are ignored \u2014 the ledger defines what exists
 * (CAM-CANON-01); stray observations cannot conjure a requirement.
 */
export function projectStatus(
  view: LedgerView,
  facts: readonly CanonFactRecord[],
  context: StatusContext,
): Map<string, StatusTuple> {
  assertContext(context);
  const byRequirement = new Map<string, CanonFactRecord[]>();
  for (const fact of facts) {
    const list = byRequirement.get(fact.requirementId);
    if (list === undefined) byRequirement.set(fact.requirementId, [fact]);
    else list.push(fact);
  }
  const out = new Map<string, StatusTuple>();
  for (const [requirementId, entry] of view) {
    out.set(
      requirementId,
      projectRequirementStatus(entry, byRequirement.get(requirementId) ?? [], context),
    );
  }
  return out;
}

/**
 * The reader-facing prose line (design \u00a73.1's example shape): a worker on
 * mission branch M sees "R: accepted; changed on this branch; branch
 * version unverified". GUI rendering proper is a later WP; this
 * formatter exists so the design's example is a literal test vector.
 */
export function renderStatusLine(
  requirementId: string,
  tuple: StatusTuple,
  context: StatusContext,
): string {
  const implementation = ((): string => {
    switch (tuple.implementation.kind) {
      case "absent":
        return "not implemented";
      case "present-on":
        return context.kind === "branch" && context.branch === tuple.implementation.branch
          ? "changed on this branch"
          : `present on ${tuple.implementation.branch}`;
      case "on-main":
        return "on main";
      case "suspected-absent":
        return "presence doubted (pending re-scan)";
    }
  })();
  const evidence = ((): string => {
    switch (tuple.evidence) {
      case "unverified":
        return context.kind === "branch" ? "branch version unverified" : "unverified";
      case "verified-live":
        return "verified live";
      case "stale":
        return "evidence stale";
      case "blocked":
        return "verification blocked";
    }
  })();
  return `${requirementId}: ${tuple.disposition}; ${implementation}; ${evidence}`;
}
