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
 * ORDERING SEMANTICS, stated for review: facts are interpreted in the
 * control plane's recorded observation order (`seq`), not by git
 * ancestry. Camino lands merges serially per repo (WP-103) and records
 * observations as it makes or discovers them; the log's order is the
 * order Camino acts on (the WP-101 philosophy). Undetected external
 * transitions between polls are outside the projection's knowledge —
 * design invariant 3 and CAM-CANON-06 state that limit; the reconciler
 * (later WP) records facts in discovery order.
 *
 * EVIDENCE RULES carried verbatim from CAM-CANON-03/§4.2 (each rule has a
 * named row in EVIDENCE_RULES; the fixture walks assert coverage):
 *  - Verification never inherits across branch changes: a branch that
 *    touched R renders R's branch version unverified, whatever main says.
 *  - `verified-live` requires a passing verdict recorded IN this context
 *    whose head SHA equals the context's current head, with no later
 *    touch of R in this context (invariant 7: evidence binds to SHAs and
 *    expires rather than rebinding).
 *  - A main-context verdict applies to a branch context ONLY if the
 *    branch never touched R, and then always as `stale` at best — a
 *    cross-context binding is never "live" (SHA honesty). Branch-to-
 *    branch inheritance does not exist at all.
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
      "on-main shows through in a branch context when the branch has no own implementation, no revert, and no suspicion",
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
      "revert-recorded(B) shadows both present-on(B) and inherited on-main in context B (the branch's tree lacks R)",
  },
  {
    rule: "I7",
    axis: "implementation",
    statement: "a later implementation-recorded(B) clears a branch revert shadow (re-implemented)",
  },
  {
    rule: "I8",
    axis: "implementation",
    statement:
      "a later landed-on-main clears a main revert (repair landed, re-derived not hand-reversed)",
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
      "outstanding main suspicion also renders suspected-absent in a branch context that is merely inheriting main's copy",
  },
  {
    rule: "I11",
    axis: "implementation",
    statement:
      "a branch's OWN implementation is not doubted by a main suspicion (present-on(B) wins over main doubt)",
  },
  {
    rule: "I12",
    axis: "implementation",
    statement:
      "absence-resolved(C, present) clears the suspicion and restores the underlying state",
  },
  {
    rule: "I13",
    axis: "implementation",
    statement:
      "absence-resolved(C, absent) clears the suspicion AND the presence for C (confirmed gone ⇒ absent)",
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
      "a passing verdict in this context at exactly the context head, with no later touch ⇒ verified-live",
  },
  {
    rule: "E3",
    axis: "evidence",
    statement:
      "a passing verdict in this context at an older head, no later touch ⇒ stale (stale-evidence downgrade)",
  },
  {
    rule: "E4",
    axis: "evidence",
    statement:
      "a touch of R in this context after the verdict ⇒ unverified (verification never inherits across branch changes)",
  },
  {
    rule: "E5",
    axis: "evidence",
    statement:
      "a main verdict applies to a branch that never touched R, as stale at best (cross-context bindings are never live)",
  },
  {
    rule: "E6",
    axis: "evidence",
    statement:
      "a main verdict never applies to a branch that touched R (the CAM-CANON-03 sentence, verbatim)",
  },
  {
    rule: "E7",
    axis: "evidence",
    statement:
      "verdicts recorded on one branch never apply to another branch (no cross-branch inheritance)",
  },
  {
    rule: "E8",
    axis: "evidence",
    statement:
      "the latest applicable verdict being a FAIL ⇒ unverified (a failure is not evidence of verification)",
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
      "verified-live at the exact context head stands even while blocked is outstanding (the run already happened)",
  },
  {
    rule: "E11",
    axis: "evidence",
    statement:
      "verification-unblocked(C) clears the block and the underlying derivation shows through",
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
 * closed schemas, SHA/branch/requirement grammars, string safety.
 */
export function validateCanonFact(input: CanonFactInput): FactValidation {
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
    if (!Number.isInteger(record.seq) || record.seq <= lastSeq) {
      divergences.push({
        seq: record.seq,
        problem: `seq ${record.seq} is not strictly increasing after ${lastSeq}`,
      });
      continue;
    }
    lastSeq = record.seq;
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

interface ImplementationFold {
  onMain: boolean;
  /** Branches with a live own implementation. */
  presentOn: Set<string>;
  /** Branches whose last revert shadows R (cleared by re-implementation). */
  revertShadow: Set<string>;
  /** Context keys with an outstanding absence suspicion. */
  suspicion: Set<string>;
}

function foldImplementation(facts: readonly CanonFactRecord[]): ImplementationFold {
  const fold: ImplementationFold = {
    onMain: false,
    presentOn: new Set(),
    revertShadow: new Set(),
    suspicion: new Set(),
  };
  for (const fact of facts) {
    switch (fact.kind) {
      case "implementation-recorded": {
        const branch = fact.payload["branch"] as string;
        fold.presentOn.add(branch);
        fold.revertShadow.delete(branch); // I7
        break;
      }
      case "landed-on-main": {
        fold.onMain = true; // I3 / I8
        break;
      }
      case "revert-recorded": {
        const key = factContextKey(fact.payload);
        if (key === "main") {
          fold.onMain = false; // I5
        } else {
          fold.presentOn.delete(key);
          fold.revertShadow.add(key); // I6
        }
        break;
      }
      case "absence-suspected": {
        fold.suspicion.add(factContextKey(fact.payload)); // I9
        break;
      }
      case "absence-resolved": {
        const key = factContextKey(fact.payload);
        fold.suspicion.delete(key); // I12
        if (fact.payload["resolution"] === "absent") {
          // I13: confirmed gone.
          if (key === "main") fold.onMain = false;
          else fold.presentOn.delete(key);
        }
        break;
      }
      default:
        break; // Evidence-axis facts do not move the implementation axis.
    }
  }
  return fold;
}

function deriveImplementation(
  fold: ImplementationFold,
  context: StatusContext,
): ImplementationState {
  if (context.kind === "main") {
    if (fold.suspicion.has("main")) return { kind: "suspected-absent" }; // I9
    if (fold.onMain) return { kind: "on-main" }; // I3
    return { kind: "absent" }; // I1 / I5
  }
  const branch = context.branch;
  if (fold.suspicion.has(branch)) return { kind: "suspected-absent" }; // I9
  if (fold.revertShadow.has(branch)) return { kind: "absent" }; // I6
  if (fold.presentOn.has(branch)) return { kind: "present-on", branch }; // I2 / I11
  if (fold.suspicion.has("main")) return { kind: "suspected-absent" }; // I10 (inheriting a doubted copy)
  if (fold.onMain) return { kind: "on-main" }; // I4
  return { kind: "absent" }; // I1
}

function deriveEvidence(facts: readonly CanonFactRecord[], context: StatusContext): EvidenceState {
  const key = contextKey(context);
  const touchedInContext = (afterSeq: number): boolean =>
    facts.some(
      (f) =>
        f.kind === "requirement-touched" &&
        (f.payload["branch"] as string) === key &&
        f.seq > afterSeq,
    );
  const everTouchedInContext =
    context.kind === "branch" &&
    facts.some((f) => f.kind === "requirement-touched" && (f.payload["branch"] as string) === key);

  // Applicable verdicts: this context's own, plus main's for a branch that
  // never touched R (E5). Branch-to-branch inheritance does not exist (E7).
  const applicable = facts.filter((f) => {
    if (f.kind !== "verification-verdict") return false;
    const verdictKey = factContextKey(f.payload);
    if (verdictKey === key) return true;
    if (context.kind === "branch" && verdictKey === "main" && !everTouchedInContext) return true; // E5/E6
    return false;
  });

  const blockedOutstanding = ((): boolean => {
    let blocked = false;
    for (const f of facts) {
      if (f.kind === "verification-blocked" && factContextKey(f.payload) === key) blocked = true;
      if (f.kind === "verification-unblocked" && factContextKey(f.payload) === key) blocked = false; // E11
    }
    return blocked;
  })();

  const latest = applicable.at(-1);
  if (latest === undefined) {
    return blockedOutstanding ? "blocked" : "unverified"; // E9 / E1
  }
  if (latest.payload["outcome"] === "fail") {
    return blockedOutstanding ? "blocked" : "unverified"; // E8 (+E9)
  }
  const verdictKey = factContextKey(latest.payload);
  const liveBinding =
    verdictKey === key &&
    latest.payload["headSha"] === context.headSha &&
    !touchedInContext(latest.seq);
  if (liveBinding) return "verified-live"; // E2 / E10
  if (touchedInContext(latest.seq)) {
    // E4: a touch after the verdict invalidates it outright.
    return blockedOutstanding ? "blocked" : "unverified";
  }
  // Older binding in this context (E3) or an inherited main verdict (E5):
  // evidence exists but is not bound to this exact head.
  return blockedOutstanding ? "blocked" : "stale"; // E9
}

/**
 * Project one requirement's status tuple for a context. `facts` must be
 * this requirement's facts in ascending seq order (the store's read
 * order); facts for other requirements are the caller's filtering
 * responsibility (`projectStatus` does it for whole views).
 */
export function projectRequirementStatus(
  entry: LedgerViewEntry,
  facts: readonly CanonFactRecord[],
  context: StatusContext,
): StatusTuple {
  const fold = foldImplementation(facts);
  return {
    disposition: entry.disposition,
    implementation: deriveImplementation(fold, context),
    evidence: deriveEvidence(facts, context),
  };
}

/**
 * Project the whole ledger for a context. Facts for requirement ids the
 * ledger does not know are ignored — the ledger defines what exists
 * (CAM-CANON-01); stray observations cannot conjure a requirement.
 */
export function projectStatus(
  view: LedgerView,
  facts: readonly CanonFactRecord[],
  context: StatusContext,
): Map<string, StatusTuple> {
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
 * The reader-facing prose line (design §3.1's example shape): a worker on
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
