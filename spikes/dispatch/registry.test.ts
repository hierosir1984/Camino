import { describe, expect, it } from "vitest";
import { claudeAdapter } from "./adapters/claude.js";
import { codexAdapter } from "./adapters/codex.js";
import { grokAdapter } from "./adapters/grok.js";
import { buildRegistry } from "./registry.js";
import { runAdapter, renderReport, type AdapterEvidence } from "./run.js";
import type { AdapterSpec } from "./types.js";

// CAM-EXEC-01 negative path: an adapter whose sanctioned-path / presence check
// fails is installable-but-DISABLED with the reason recorded, and is NEVER
// dispatched. Proven here deterministically (the real run exercises the positive
// path when all three CLIs are present).
describe("adapter enablement (CAM-EXEC-01)", () => {
  it("each adapter can be constructed disabled-with-reason", () => {
    for (const make of [claudeAdapter, codexAdapter, grokAdapter]) {
      const disabled = make({ enabled: false, disabledReason: "sanctioned-path check failed" });
      expect(disabled.enabled).toBe(false);
      expect(disabled.disabledReason).toBe("sanctioned-path check failed");
    }
  });

  it("the harness SKIPS a disabled adapter: plan() is never called, reason is recorded", async () => {
    // A disabled adapter whose plan() throws if invoked — proves no dispatch.
    const landmine: AdapterSpec = {
      name: "grok-build",
      enabled: false,
      disabledReason: "xAI sanctioned-path not recorded accepted (WP-000 gate)",
      plan: () => {
        throw new Error("plan() must not run for a disabled adapter");
      },
      parseLine: () => null,
    };
    const evidence: AdapterEvidence = await runAdapter(landmine, true);
    expect(evidence.enabled).toBe(false);
    expect(evidence.disabledReason).toBe("xAI sanctioned-path not recorded accepted (WP-000 gate)");
    expect(evidence.solve).toBeUndefined();
    expect(evidence.cancel).toBeUndefined();
  });

  it("renderReport surfaces the disabled reason", () => {
    const md = renderReport(
      [{ adapter: "grok-build", enabled: false, disabledReason: "grok CLI not found on PATH" }],
      false,
    );
    expect(md).toContain("grok-build");
    expect(md).toContain("grok CLI not found on PATH");
  });

  it("buildRegistry returns the three v1 adapters, each with an enablement decision + reason when off", () => {
    const reg = buildRegistry();
    expect(reg.map((a) => a.name).sort()).toEqual(["claude-code", "codex-cli", "grok-build"]);
    for (const a of reg) {
      expect(typeof a.enabled).toBe("boolean");
      if (!a.enabled) expect(a.disabledReason).toBeTruthy(); // reason recorded when disabled
    }
  });
});
