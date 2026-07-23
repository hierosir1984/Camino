/**
 * The core barrel carries no runtime-mutable decision tables — at any depth.
 *
 * Same model and mechanisms as the @camino/shared twin (see
 * packages/shared/src/barrel-immutability.test.ts for the full statement): a
 * first-party package-root importer — `import { X } from "@camino/core"` —
 * must not be able to mutate an exported value and thereby change a decision.
 * `as const` and `Readonly<...>` erase at runtime; a RegExp cannot be closed
 * by freezing at all, so grammars stay module-private behind functions
 * (canon-status's SHA_PATTERN is core's instance of the shared packages'
 * pattern).
 *
 * Core's difference is DEPTH. The highest-value tables on this barrel are the
 * four Appendix A machine definitions, and `Object.freeze` is shallow: a
 * frozen MachineDef whose rows stayed mutable would pass a top-level sweep
 * while `rows[i].guard.check` — the predicate deciding whether a state change
 * is legal — remained retargetable. Construction therefore deep-freezes
 * (deep-freeze.ts), and this suite re-verifies with an INDEPENDENT walker
 * (sharing the freezer's code would let one defect certify itself):
 *
 *   every value export is walked to full depth through data properties; every
 *   reachable object, array, and function must be frozen; accessor properties
 *   are refused (a getter is behavior where a table promises data); and every
 *   reachable value must be null-/Object-/Array-/Function-prototyped, which
 *   structurally excludes the shapes freeze cannot close (RegExp, Date, Map,
 *   Set, typed arrays, class instances — a frozen Set still accepts .add()).
 *
 * The sweep enumerates the WHOLE barrel (Object.entries over the namespace),
 * not a hand-kept list: a later WP that exports a new mutable table trips it
 * by name. Top-level FUNCTION exports (transition, foldView, the
 * ReconcileFactsMismatchError class, ...) are behavior, not tables — their
 * namespace bindings are already immutable from outside and they carry no
 * decision state on own properties — and are scoped out exactly as in the
 * twins.
 *
 * BOUNDARY (stated, not hidden): this closes VALUE mutation through the
 * barrel. Not prototype pollution of globals (Array.prototype is not this
 * package's export list); not closure state (beyond any freeze; core's purity
 * fence keeps module state out of this package); not deep imports into module
 * internals — core's exports map exposes "." only, which is also why the
 * appendix test vectors (appendix-vectors.ts, deliberately un-barreled) are
 * out of scope: they are unreachable through the boundary this suite guards,
 * and if a later WP barrels them, the sweep goes red on them by name.
 */
import { describe, expect, it } from "vitest";
import * as barrel from "./index.js";
import {
  ATTEMPT_TERMINAL_STATES,
  DISPOSITION_TRANSITIONS,
  IMPLEMENTATION_RULES,
  MISSION_ACTIVE_STATES,
  MISSION_CONTEXT_ENRICHMENT,
  MISSION_CREATION_EVENTS,
  RESERVED_PAYLOAD_FIELDS,
  attemptMachine,
  missionIntegrationMachine,
  transition,
} from "./index.js";

type Entry = readonly [string, unknown];
const entries: readonly Entry[] = Object.entries(barrel);

interface SweepDefect {
  readonly path: string;
  readonly problem: string;
}

/** Independent deep walker: asserts the frozen-graph property, never establishes it. */
function sweep(value: unknown, path: string, seen: Set<object>, out: SweepDefect[]): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  const node: object = value;
  if (seen.has(node)) return;
  seen.add(node);
  const proto: unknown = Object.getPrototypeOf(node);
  if (
    proto !== Object.prototype &&
    proto !== Array.prototype &&
    proto !== Function.prototype &&
    proto !== null
  ) {
    out.push({ path, problem: "shape freeze cannot close (exotic built-in or class instance)" });
    return;
  }
  if (!Object.isFrozen(node)) out.push({ path, problem: "not frozen" });
  for (const key of Reflect.ownKeys(node)) {
    const descriptor = Object.getOwnPropertyDescriptor(node, key);
    if (descriptor === undefined) continue;
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      out.push({ path: `${path}.${String(key)}`, problem: "accessor property" });
      continue;
    }
    sweep(descriptor.value, `${path}.${String(key)}`, seen, out);
  }
}

function sweepBarrel(): { defects: readonly SweepDefect[]; visited: number } {
  const seen = new Set<object>();
  const defects: SweepDefect[] = [];
  for (const [name, value] of entries) {
    if (typeof value === "function") continue; // behavior exports — see header
    sweep(value, name, seen, defects);
  }
  return { defects, visited: seen.size };
}

describe("@camino/core public barrel immutability (deep)", () => {
  it("exports the tables it is meant to guard (sweep is not vacuous, at depth)", () => {
    expect(entries.length).toBeGreaterThan(40);
    const objectExports = entries.filter(([, v]) => typeof v === "object" && v !== null);
    expect(objectExports.length).toBeGreaterThan(15);
    // The four machine tables alone contribute hundreds of reachable nodes
    // (rows, guard objects, `from` arrays, check/derive functions); a walker
    // that stopped at the top level would visit only ~the object-export count.
    const { visited } = sweepBarrel();
    expect(visited).toBeGreaterThan(300);
  });

  it("exports no live RegExp (compile() would rewrite the grammar in place)", () => {
    expect(entries.filter(([, v]) => v instanceof RegExp).map(([k]) => k)).toEqual([]);
    // Core's SHA grammar stays module-private (canon-status.ts), the same
    // mechanism the shared package uses for its id grammars.
    expect("SHA_PATTERN" in barrel).toBe(false);
  });

  it("freezes every node reachable from every value export — tables, rows, guards", () => {
    const { defects } = sweepBarrel();
    expect(defects).toEqual([]);
  });

  it("keeps a machine guard's predicate slot fixed, and the decision it guards", () => {
    const dispatch = attemptMachine.rows.find((row) => row.ref === "A.3#1");
    if (dispatch === undefined || dispatch.guard === undefined) {
      throw new Error("A.3#1 (dispatch) row with guard expected");
    }
    // Deep witnesses: exactly the nodes a shallow freeze would leave mutable.
    expect(Object.isFrozen(attemptMachine.rows)).toBe(true);
    expect(Object.isFrozen(dispatch)).toBe(true);
    expect(Object.isFrozen(dispatch.guard)).toBe(true);
    expect(Object.isFrozen(dispatch.guard.check)).toBe(true);
    // Retargeting the predicate throws (ESM strict mode) ...
    expect(() => {
      (dispatch.guard as { check: unknown }).check = () => true;
    }).toThrow(TypeError);
    // ... and the decision is unchanged: an unattested lease still refuses.
    const refused = transition(attemptMachine, null, {
      type: "attempt-dispatched",
      leaseGranted: false,
      leaseGeneration: 1,
      contractRef: { issueId: "m1.I1", contractVersion: 1, contractHash: "a".repeat(64) },
    });
    expect(refused.ok).toBe(false);
  });

  it("keeps the transition tables closed — rows cannot be added, removed, or retargeted", () => {
    expect(() => (attemptMachine.rows as unknown as unknown[]).push({})).toThrow(TypeError);
    expect(() => (missionIntegrationMachine.rows as unknown as unknown[]).splice(0, 1)).toThrow(
      TypeError,
    );
    const resume = missionIntegrationMachine.rows.find((row) => row.ref === "A.1#17");
    if (resume === undefined || typeof resume.to === "string") {
      throw new Error("A.1#17 (resume) row with derived target expected");
    }
    expect(() => {
      (resume.to as { derive: unknown }).derive = () => "executing";
    }).toThrow(TypeError);
    // archived stays absorbing: dispatch from archived is still illegal.
    const result = transition(attemptMachine, "archived", {
      type: "attempt-dispatched",
      leaseGranted: true,
      leaseGeneration: 1,
      contractRef: { issueId: "m1.I1", contractVersion: 1, contractHash: "a".repeat(64) },
    });
    expect(result).toEqual({ ok: false, code: "illegal-transition" });
  });

  it("refuses writes to the state sets and reserved-field policy (ESM strict mode)", () => {
    expect(() => (MISSION_ACTIVE_STATES as unknown as string[]).push("extra-state")).toThrow(
      TypeError,
    );
    expect(() => {
      (ATTEMPT_TERMINAL_STATES as unknown as string[])[0] = "running";
    }).toThrow(TypeError);
    expect(() => (RESERVED_PAYLOAD_FIELDS as unknown as string[]).splice(0, 1)).toThrow(TypeError);
    expect(MISSION_ACTIVE_STATES).not.toContain("extra-state");
    expect(ATTEMPT_TERMINAL_STATES[0]).toBe("succeeded");
    expect(RESERVED_PAYLOAD_FIELDS).toEqual(["type", "actor"]);
  });

  it("refuses writes through the nested records a shallow freeze would miss", () => {
    const resumeSpecs = MISSION_CONTEXT_ENRICHMENT["mission-resumed"];
    if (resumeSpecs === undefined) throw new Error("mission-resumed enrichment expected");
    // The nested array is the shallow-freeze gap made concrete: freezing the
    // record says nothing about the arrays it holds.
    expect(() =>
      (resumeSpecs as unknown as unknown[]).push({ field: "resumeTo", source: "paused-from" }),
    ).toThrow(TypeError);
    expect(() => {
      (MISSION_CREATION_EVENTS as unknown as Record<string, string>)["other-intake"] =
        "integration";
    }).toThrow(TypeError);
    expect(resumeSpecs).toHaveLength(1);
    expect(MISSION_CREATION_EVENTS["other-intake"]).toBeUndefined();
  });

  it("keeps the projection rule tables fixed, rows and statements alike", () => {
    const first = IMPLEMENTATION_RULES[0];
    if (first === undefined) throw new Error("IMPLEMENTATION_RULES must not be empty");
    expect(() => {
      (first as { statement: string }).statement = "reworded";
    }).toThrow(TypeError);
    // descoped is terminal (CAM-CANON-03): a row reopening it must not be addable.
    expect(() =>
      (DISPOSITION_TRANSITIONS as unknown as unknown[]).push({
        row: "D0",
        from: "descoped",
        event: "requirement-proposed",
        to: "proposed",
        basis: "unlicensed extension",
      }),
    ).toThrow(TypeError);
    expect(DISPOSITION_TRANSITIONS.some((t) => t.from === "descoped")).toBe(false);
  });
});
