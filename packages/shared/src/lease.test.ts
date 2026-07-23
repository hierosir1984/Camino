// WP-114: the lease/environment interface's pure half (CAM-STATE-04).
import { describe, expect, it } from "vitest";
import {
  LEASE_HEARTBEAT_MS,
  LEASE_TTL_MS,
  environmentIdProblems,
  leaseLapsed,
  validationEnvironmentId,
} from "./lease.js";

describe("lease constants (registry item 5 verbatim)", () => {
  it("pins heartbeat 30s and TTL 5min", () => {
    expect(LEASE_HEARTBEAT_MS).toBe(30_000);
    expect(LEASE_TTL_MS).toBe(300_000);
  });
});

describe("leaseLapsed", () => {
  const base = { heartbeatAt: "2026-07-23T10:00:00.000Z", state: "held" as const };
  const beat = Date.parse(base.heartbeatAt);

  it("is false within the TTL and true past it", () => {
    expect(leaseLapsed(base, beat + LEASE_TTL_MS)).toBe(false);
    expect(leaseLapsed(base, beat + LEASE_TTL_MS + 1)).toBe(true);
  });

  it("only a held lease can lapse (settled leases are settled, not lapsed)", () => {
    expect(leaseLapsed({ ...base, state: "released" }, beat + LEASE_TTL_MS * 10)).toBe(false);
    expect(leaseLapsed({ ...base, state: "kill-confirmed" }, beat + LEASE_TTL_MS * 10)).toBe(false);
  });

  it("unreadable heartbeat evidence fails closed as lapsed", () => {
    expect(leaseLapsed({ heartbeatAt: "not a date", state: "held" }, beat)).toBe(true);
  });
});

describe("environment ids", () => {
  it("accepts a plain id and derives the repo validation environment", () => {
    expect(environmentIdProblems("repo-1")).toEqual([]);
    expect(validationEnvironmentId("repo-1")).toBe("validation:repo-1");
  });

  it("refuses empty, NUL-bearing, oversized, and ill-formed ids", () => {
    expect(environmentIdProblems("")).not.toEqual([]);
    expect(environmentIdProblems("a\0b")).not.toEqual([]);
    expect(environmentIdProblems("x".repeat(201))).not.toEqual([]);
    expect(environmentIdProblems("\ud800")).not.toEqual([]);
    expect(() => validationEnvironmentId("")).toThrow(/environmentId/);
  });
});
