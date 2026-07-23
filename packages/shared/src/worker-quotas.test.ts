// Pins PRD §5 registry item 11 to its verbatim values: a later edit that
// widens a quota must change THIS file too, visibly, not just the constant.
import { describe, expect, it } from "vitest";
import { REGISTRY_ITEM_11_QUOTAS } from "./worker-quotas.js";

describe("REGISTRY_ITEM_11_QUOTAS (PRD §5 registry item 11, verbatim)", () => {
  it("carries the registry values exactly", () => {
    expect(REGISTRY_ITEM_11_QUOTAS).toEqual({
      fetch: { maxObjects: 5_000, maxBytes: 500_000_000 },
      workspace: { maxBytes: 2_000_000_000 },
      archive: {
        maxCompressedBytes: 500_000_000,
        retainDays: 90,
        retainLastAttemptsPerIssue: 10,
      },
    });
  });

  it("is frozen at every level, not just the root (PR-53/54 depth lesson)", () => {
    const walk = (value: unknown, path: string, out: string[]): void => {
      if (typeof value !== "object" || value === null) return;
      if (!Object.isFrozen(value)) out.push(path);
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`, out);
    };
    const unfrozen: string[] = [];
    walk(REGISTRY_ITEM_11_QUOTAS, "REGISTRY_ITEM_11_QUOTAS", unfrozen);
    expect(unfrozen).toEqual([]);
    expect(() => {
      (REGISTRY_ITEM_11_QUOTAS.workspace as { maxBytes: number }).maxBytes = Number.MAX_VALUE;
    }).toThrow(TypeError);
  });
});
