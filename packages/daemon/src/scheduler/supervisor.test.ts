// WP-114: out-of-process budget supervisor — the validation half (no
// Docker needed). The authoritative-kill proof lives in
// container-obligations.test.ts against a real container.
import { describe, expect, it } from "vitest";
import { armContainerSupervisor, SupervisorError } from "./supervisor.js";

describe("armContainerSupervisor validation (fail-closed)", () => {
  it("refuses an empty container name", () => {
    expect(() =>
      armContainerSupervisor({ containerName: "", wallClockMs: 1000, dockerPath: "/usr/bin/true" }),
    ).toThrow(SupervisorError);
  });

  it("refuses a non-positive or non-finite wall-clock budget (unbounded is no supervisor)", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        armContainerSupervisor({
          containerName: "c",
          wallClockMs: bad,
          dockerPath: "/usr/bin/true",
        }),
      ).toThrow(/finite positive/);
    }
  });

  it("refuses an ambient-PATH docker (absolute trusted path required)", () => {
    expect(() =>
      armContainerSupervisor({ containerName: "c", wallClockMs: 1000, dockerPath: "docker" }),
    ).toThrow(/absolute trusted path/);
  });

  it("arms a detached supervisor with the budget-derived deadline and disarms it", () => {
    const t0 = Date.parse("2026-07-23T10:00:00.000Z");
    const armed = armContainerSupervisor({
      containerName: "camino-attempt-test",
      wallClockMs: 30_000,
      dockerPath: "/usr/bin/true",
      now: () => new Date(t0),
    });
    try {
      expect(armed.deadlineMs).toBe(t0 + 30_000);
      expect(armed.pid).toBeGreaterThan(0);
    } finally {
      armed.disarm();
    }
    // Disarm is idempotent (already-gone supervisors are a settled state).
    armed.disarm();
  });
});
