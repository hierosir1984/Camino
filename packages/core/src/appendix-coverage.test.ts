/**
 * Row-coverage harness (WP-101 acceptance, CAM-STATE-05): exhaustive
 * transition tests over every legal Appendix A row of all three machines,
 * plus representative illegal ones.
 *
 * Coverage is mechanical, not curated: for each machine the test fails if
 * any table row lacks a vector, if any vector names a row that does not
 * exist, or if a vector's outcome disagrees with the machine. Rows sourced
 * from several states ("any active", the attempt terminals) are re-run
 * from every listed source state.
 */
import { describe, expect, it } from "vitest";
import type { MachineDef, MachineEvent } from "./machine.js";
import { transition } from "./machine.js";
import type { IllegalVector, LegalVector } from "./appendix-vectors.js";
import {
  ATTEMPT_ILLEGAL,
  ATTEMPT_LEGAL,
  ISSUE_ILLEGAL,
  ISSUE_LEGAL,
  MISSION_INTEGRATION_ILLEGAL,
  MISSION_INTEGRATION_LEGAL,
  MISSION_QUICK_ILLEGAL,
  MISSION_QUICK_LEGAL,
} from "./appendix-vectors.js";
import { missionIntegrationMachine, missionQuickTaskMachine } from "./mission.js";
import { issueMachine } from "./issue.js";
import { attemptMachine } from "./attempt.js";

interface MachineSuite<State extends string, Event extends MachineEvent> {
  machine: MachineDef<State, Event>;
  legal: readonly LegalVector<State, Event>[];
  illegal: readonly IllegalVector<State, Event>[];
  /** States legitimately unreachable on this machine (route differences). */
  expectedUnreachable: readonly State[];
  /** Rows allowed to leave a terminal state (the attempt archival step). */
  terminalExitRefs?: readonly string[];
}

/** Type-erased suite so machines with different state unions share one loop. */
type ErasedSuite = MachineSuite<string, MachineEvent>;

/** Checks suite consistency at the call site, then erases the generics. */
function suite<State extends string, Event extends MachineEvent>(
  s: MachineSuite<State, Event>,
): ErasedSuite {
  return s as unknown as ErasedSuite;
}

const SUITES = [
  suite({
    machine: missionIntegrationMachine,
    legal: MISSION_INTEGRATION_LEGAL,
    illegal: MISSION_INTEGRATION_ILLEGAL,
    // re-routed is an A.1b-only terminal (Appendix A state-set note).
    expectedUnreachable: ["re-routed"],
  }),
  suite({
    machine: missionQuickTaskMachine,
    legal: MISSION_QUICK_LEGAL,
    illegal: MISSION_QUICK_ILLEGAL,
    // Quick tasks have no residue terminal and no external/urgent pauses
    // (A.1b inherits only queued, plan rejection, manual pause/resume,
    // escalated/blocked and their recoveries, and abandonment).
    expectedUnreachable: ["complete-with-residue", "paused-external", "paused-urgent"],
  }),
  suite({
    machine: issueMachine,
    legal: ISSUE_LEGAL,
    illegal: ISSUE_ILLEGAL,
    expectedUnreachable: [],
  }),
  suite({
    machine: attemptMachine,
    legal: ATTEMPT_LEGAL,
    illegal: ATTEMPT_ILLEGAL,
    expectedUnreachable: [],
    // A.3 terminals each take the single archival step (A.4#5).
    terminalExitRefs: ["A.3#8"],
  }),
];

for (const { machine, legal, illegal, expectedUnreachable, terminalExitRefs } of SUITES) {
  describe(machine.name, () => {
    it("covers every Appendix A row with at least one vector, and no vector is orphaned", () => {
      const rowRefs = new Set(machine.rows.map((row) => row.ref));
      const vectorRefs = new Set(legal.map((vector) => vector.ref));
      const uncovered = [...rowRefs].filter((ref) => !vectorRefs.has(ref));
      const orphaned = [...vectorRefs].filter((ref) => !rowRefs.has(ref));
      expect(uncovered, "rows without a covering vector").toEqual([]);
      expect(orphaned, "vectors naming a nonexistent row").toEqual([]);
    });

    it("has structurally sound rows (unique refs, known states, absorbing terminals)", () => {
      const refs = machine.rows.map((row) => row.ref);
      expect(new Set(refs).size, "row refs must be unique").toBe(refs.length);
      for (const row of machine.rows) {
        if (row.from !== null) {
          for (const from of row.from) expect(machine.states).toContain(from);
        }
        if (typeof row.to === "string") expect(machine.states).toContain(row.to);
        const exitsTerminal =
          row.from !== null && row.from.some((from) => machine.terminalStates.includes(from));
        if (exitsTerminal) {
          expect(terminalExitRefs ?? [], `row ${row.ref} leaves a terminal state`).toContain(
            row.ref,
          );
        }
      }
    });

    it("reaches exactly the states the appendix says this route reaches", () => {
      const reachable = new Set<string>();
      for (const row of machine.rows) {
        if (typeof row.to === "string") reachable.add(row.to);
      }
      // Derived targets (manual resume) return to already-reachable active
      // states; creation targets are included above.
      const unreachable = machine.states.filter(
        (state) => !reachable.has(state) && !expectedUnreachable.includes(state),
      );
      expect(unreachable, "states no row reaches (beyond the expected route gaps)").toEqual([]);
      for (const state of expectedUnreachable) {
        expect(reachable.has(state), `${state} must stay unreachable on this route`).toBe(false);
      }
    });

    describe("legal rows", () => {
      for (const vector of legal) {
        it(`${vector.ref}: ${vector.from ?? "(creation)"} --${vector.event.type}--> ${vector.to}`, () => {
          const result = transition(machine, vector.from, vector.event);
          expect(result).toEqual({ ok: true, to: vector.to, ref: vector.ref });
        });
      }
    });

    it("multi-source rows accept from every listed source state", () => {
      for (const row of machine.rows) {
        if (row.from === null || row.from.length < 2) continue;
        const vector = legal.find((v) => v.ref === row.ref);
        expect(vector, `row ${row.ref} needs a vector to expand`).toBeDefined();
        for (const from of row.from) {
          const result = transition(machine, from, (vector as (typeof legal)[number]).event);
          expect(result.ok, `${row.ref} from ${from}`).toBe(true);
        }
      }
    });

    describe("representative illegal transitions", () => {
      for (const vector of illegal) {
        it(vector.name, () => {
          const result = transition(machine, vector.from, vector.event);
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.code).toBe(vector.expect);
        });
      }
    });
  });
}
