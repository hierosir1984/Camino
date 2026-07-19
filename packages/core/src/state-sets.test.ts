/**
 * Transcription checks for the Appendix A preamble: state sets, the
 * serialization predicate, and the retry-policy helper. These tests pin the
 * code to the appendix text so a drift in either shows up as a diff here
 * (feeding the recorded consistency audit, docs/design/26).
 */
import { describe, expect, it } from "vitest";
import {
  isExecutionBearing,
  MISSION_ACTIVE_STATES,
  MISSION_CREATION_EVENTS,
  MISSION_STATES,
  MISSION_TERMINAL_STATES,
} from "./mission.js";
import { ISSUE_ACTIVE_STATES, ISSUE_TERMINAL_STATES, retryPolicy } from "./issue.js";
import {
  ATTEMPT_ACTIVE_STATES,
  ATTEMPT_ARCHIVED_STATE,
  ATTEMPT_TERMINAL_STATES,
} from "./attempt.js";

describe("Appendix A state sets (preamble transcription)", () => {
  it("mission states match the preamble", () => {
    expect(MISSION_ACTIVE_STATES).toEqual([
      "queued",
      "draft",
      "planned",
      "approved",
      "executing",
      "awaiting-merge-approval",
      "merging",
      "paused-external",
      "paused-urgent",
      "paused-manual",
      "escalated",
      "blocked",
    ]);
    expect(MISSION_TERMINAL_STATES).toEqual([
      "complete",
      "complete-with-residue",
      "abandoned",
      "re-routed",
    ]);
    expect(new Set(MISSION_STATES).size).toBe(16);
  });

  it("issue states match the preamble", () => {
    expect(ISSUE_ACTIVE_STATES).toEqual([
      "waiting-deps",
      "ready",
      "queued-quota",
      "claimed",
      "implementing",
      "validating",
      "merge-pending",
      "blocked",
      "escalated",
      "replanning",
    ]);
    expect(ISSUE_TERMINAL_STATES).toEqual(["merged", "cancelled"]);
  });

  it("attempt states match the preamble (six terminals, then archived)", () => {
    expect(ATTEMPT_ACTIVE_STATES).toEqual(["running", "submitted"]);
    expect(ATTEMPT_TERMINAL_STATES).toEqual([
      "succeeded",
      "failed",
      "cancelled",
      "expired",
      "killed-budget",
      "quota-blocked",
    ]);
    expect(ATTEMPT_ARCHIVED_STATE).toBe("archived");
  });

  it("routes are derived from the creation event", () => {
    expect(MISSION_CREATION_EVENTS).toEqual({
      "mission-created": "integration",
      "quick-task-intake": "quick-task",
    });
  });
});

describe("isExecutionBearing (serialization predicate)", () => {
  it("holds the slot for the approved-through-merging span and its interrupts", () => {
    for (const state of [
      "approved",
      "executing",
      "awaiting-merge-approval",
      "merging",
      "paused-external",
      "paused-urgent",
      "escalated",
      "blocked",
    ] as const) {
      expect(isExecutionBearing(state), state).toBe(true);
    }
  });

  it("leaves the slot free for intake/planning states (they touch no workspace)", () => {
    for (const state of ["queued", "draft", "planned"] as const) {
      expect(isExecutionBearing(state), state).toBe(false);
    }
  });

  it("terminal states never hold the slot", () => {
    for (const state of MISSION_TERMINAL_STATES) {
      expect(isExecutionBearing(state), state).toBe(false);
    }
  });

  it("paused-manual holds the slot exactly when the paused-from state did", () => {
    expect(isExecutionBearing("paused-manual", "executing")).toBe(true);
    expect(isExecutionBearing("paused-manual", "merging")).toBe(true);
    expect(isExecutionBearing("paused-manual", "paused-external")).toBe(true);
    expect(isExecutionBearing("paused-manual", "draft")).toBe(false);
    expect(isExecutionBearing("paused-manual", "planned")).toBe(false);
    expect(isExecutionBearing("paused-manual", "queued")).toBe(false);
    // No recorded prior state: conservatively not slot-holding.
    expect(isExecutionBearing("paused-manual")).toBe(false);
  });
});

describe("retryPolicy (A.2#9)", () => {
  it("retries the first three failures, escalates on the fourth", () => {
    expect(retryPolicy(1)).toEqual({ escalate: false, familySwitch: false });
    expect(retryPolicy(2)).toEqual({ escalate: false, familySwitch: true });
    expect(retryPolicy(3)).toEqual({ escalate: false, familySwitch: true });
    expect(retryPolicy(4)).toEqual({ escalate: true, familySwitch: true });
  });
});
