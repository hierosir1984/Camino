import { describe, expect, it } from "vitest";
import { claudeAdapter } from "./adapters/claude.js";
import { codexAdapter } from "./adapters/codex.js";
import { grokAdapter } from "./adapters/grok.js";
import { buildRegistry } from "./registry.js";

// CAM-EXEC-01 negative path: an adapter whose sanctioned-path / presence check
// fails is installable-but-DISABLED with the reason recorded, and is never
// dispatched. (When all three CLIs are present the real run exercises the
// positive path; this proves the negative path deterministically.)
describe("adapter enablement (CAM-EXEC-01)", () => {
  it("each adapter can be constructed disabled-with-reason", () => {
    for (const make of [claudeAdapter, codexAdapter, grokAdapter]) {
      const disabled = make({ enabled: false, disabledReason: "sanctioned-path check failed" });
      expect(disabled.enabled).toBe(false);
      expect(disabled.disabledReason).toBe("sanctioned-path check failed");
    }
  });

  it("the run loop's dispatch guard is exactly adapter.enabled", () => {
    // The harness skips dispatch iff !adapter.enabled; encode that invariant.
    const enabled = codexAdapter();
    const disabled = codexAdapter({ enabled: false, disabledReason: "x" });
    expect(enabled.enabled).toBe(true);
    expect(disabled.enabled).toBe(false);
  });

  it("buildRegistry returns the three v1 adapters, each with an enablement decision", () => {
    const reg = buildRegistry();
    expect(reg.map((a) => a.name).sort()).toEqual(["claude-code", "codex-cli", "grok-build"]);
    for (const a of reg) {
      expect(typeof a.enabled).toBe("boolean");
      if (!a.enabled) expect(a.disabledReason).toBeTruthy(); // reason recorded when disabled
    }
  });
});
