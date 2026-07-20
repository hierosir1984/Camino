import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterSpec } from "@camino/shared";
import { claudeAdapter } from "./adapters/claude.js";
import { codexAdapter } from "./adapters/codex.js";
import { grokAdapter } from "./adapters/grok.js";
import { buildRegistry, cliOnPath, DEFAULT_ATTESTATIONS_PATH } from "./registry.js";
import { runAdapter, renderReport, type AdapterEvidence } from "./smoke.js";

// CAM-EXEC-01 negative path: an adapter whose sanctioned-path / presence check
// fails is installable-but-DISABLED with the reason recorded, and is NEVER
// dispatched. Proven here deterministically with injected probes (the smoke
// harness exercises the positive path when all three CLIs are present).

const ALL_PRESENT = () => true;

function tmpAttestations(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-attestations-"));
  const file = join(dir, "attestations.json");
  writeFileSync(file, content);
  return file;
}

describe("adapter enablement (CAM-EXEC-01)", () => {
  it("each adapter can be constructed disabled-with-reason", () => {
    for (const make of [claudeAdapter, codexAdapter, grokAdapter]) {
      const disabled = make({ enabled: false, disabledReason: "sanctioned-path check failed" });
      expect(disabled.enabled).toBe(false);
      expect(disabled.disabledReason).toBe("sanctioned-path check failed");
    }
  });

  it("the smoke harness SKIPS a disabled adapter: plan() is never called, reason is recorded", async () => {
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

  it("renderReport surfaces the disabled reason (visibly disabled)", () => {
    const md = renderReport(
      [{ adapter: "grok-build", enabled: false, disabledReason: "grok CLI not found on PATH" }],
      false,
    );
    expect(md).toContain("grok-build");
    expect(md).toContain("grok CLI not found on PATH");
  });

  it("a missing CLI disables that adapter with the presence reason", () => {
    const reg = buildRegistry({ cliPresent: () => false });
    expect(reg.map((a) => a.name).sort()).toEqual(["claude-code", "codex-cli", "grok-build"]);
    for (const a of reg) {
      expect(a.enabled).toBe(false);
      expect(a.disabledReason).toMatch(/CLI not found on PATH$/);
    }
  });

  it("grok is disabled with the gate reason when the attestations record is unreadable", () => {
    const reg = buildRegistry({
      cliPresent: ALL_PRESENT,
      attestationsPath: "/nonexistent/attestations.json",
    });
    const grok = reg.find((a) => a.name === "grok-build")!;
    expect(grok.enabled).toBe(false);
    expect(grok.disabledReason).toContain("unreadable");
    // The other providers' sanctioned-path records are static (source-linked
    // in the registry) — they stay enabled.
    expect(reg.find((a) => a.name === "claude-code")!.enabled).toBe(true);
    expect(reg.find((a) => a.name === "codex-cli")!.enabled).toBe(true);
  });

  it("grok is disabled with a PRECISE reason per malformation class (round-1 finding 8, round-2 finding 6)", () => {
    const cases: Array<{ content: string; reason: RegExp }> = [
      {
        content: JSON.stringify({ xaiSanctionedPath: { status: "pending" } }),
        reason: /is "pending", not "accepted"/,
      },
      { content: JSON.stringify({ somethingElse: true }), reason: /record absent/ },
      {
        content: JSON.stringify({ xaiSanctionedPath: { notStatus: 1 } }),
        reason: /status absent from record/,
      },
      { content: "not json at all", reason: /malformed \(not valid JSON\)/ },
      // JSON that parses but is not an object must DISABLE, not crash (finding 6).
      { content: "null", reason: /not a JSON object/ },
      { content: "[1,2,3]", reason: /not a JSON object/ },
      { content: '"a string"', reason: /not a JSON object/ },
      { content: "42", reason: /not a JSON object/ },
      // round-3 finding 4: xaiSanctionedPath present but the wrong shape.
      { content: JSON.stringify({ xaiSanctionedPath: null }), reason: /field is not an object/ },
      {
        content: JSON.stringify({ xaiSanctionedPath: "accepted" }),
        reason: /field is not an object/,
      },
      {
        content: JSON.stringify({ xaiSanctionedPath: { status: ["accepted"] } }),
        reason: /not "accepted"/,
      },
    ];
    for (const { content, reason } of cases) {
      const file = tmpAttestations(content);
      try {
        const reg = buildRegistry({ cliPresent: ALL_PRESENT, attestationsPath: file });
        const grok = reg.find((a) => a.name === "grok-build")!;
        expect(grok.enabled, content).toBe(false);
        expect(grok.disabledReason, content).toMatch(reason);
      } finally {
        rmSync(file, { force: true });
      }
    }
  });

  it("a deeply-nested status DISABLES without a stack-overflow crash (round-3 finding 4)", () => {
    // JSON.stringify on an arbitrarily deep value stack-overflows; the reason
    // builder must describe the status by type instead. The deep JSON is built
    // as a STRING (not via JSON.stringify, which would overflow in the test
    // itself); JSON.parse handles this depth, and the reason builder must not
    // then re-stringify it.
    const depth = 6000;
    const content = `{"xaiSanctionedPath":{"status":${"[".repeat(depth)}1${"]".repeat(depth)}}}`;
    const file = tmpAttestations(content);
    try {
      const reg = buildRegistry({ cliPresent: ALL_PRESENT, attestationsPath: file });
      const grok = reg.find((a) => a.name === "grok-build")!;
      expect(grok.enabled).toBe(false);
      expect(grok.disabledReason).toContain('not "accepted"');
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("grok is enabled when the record is accepted", () => {
    const file = tmpAttestations(JSON.stringify({ xaiSanctionedPath: { status: "accepted" } }));
    try {
      const reg = buildRegistry({ cliPresent: ALL_PRESENT, attestationsPath: file });
      const grok = reg.find((a) => a.name === "grok-build")!;
      expect(grok.enabled).toBe(true);
      expect(grok.disabledReason).toBeUndefined();
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("the DEFAULT attestations path resolves to the real repo record (accepted 2026-07-17)", () => {
    // Guards the path resolution from the compiled module location AND proves
    // the registry consumes the genuine WP-000 record: with the CLI present,
    // grok's gate decision comes from docs/plan/phase-0-prereq-attestations.json.
    expect(DEFAULT_ATTESTATIONS_PATH).toMatch(/docs\/plan\/phase-0-prereq-attestations\.json$/);
    const reg = buildRegistry({ cliPresent: ALL_PRESENT });
    const grok = reg.find((a) => a.name === "grok-build")!;
    expect(grok.enabled).toBe(true);
  });

  it("registry decisions are complete: every adapter carries enabled, and a reason when off", () => {
    const reg = buildRegistry({ cliPresent: (bin) => bin === "claude" });
    for (const a of reg) {
      expect(typeof a.enabled).toBe("boolean");
      if (!a.enabled) expect(a.disabledReason).toBeTruthy(); // reason recorded when disabled
    }
    expect(reg.find((a) => a.name === "claude-code")!.enabled).toBe(true);
    expect(reg.find((a) => a.name === "codex-cli")!.enabled).toBe(false);
  });

  it("EVERY provider routes through the CLI-presence + recorded sanctioned-path gate (round-1 finding 8)", () => {
    // Present-but-... : claude/codex are enabled by their recorded (accepted)
    // sanctioned-path constant, grok by the attestation record — none is
    // presence-only. Absence disables each with the presence reason.
    const present = buildRegistry({ cliPresent: ALL_PRESENT });
    expect(present.every((a) => a.enabled)).toBe(true);

    const absent = buildRegistry({ cliPresent: () => false });
    expect(
      absent.every((a) => !a.enabled && /CLI not found on PATH$/.test(a.disabledReason!)),
    ).toBe(true);
  });
});

describe("cliOnPath", () => {
  it("finds an executable regular file on PATH, and only that", () => {
    const dir = mkdtempSync(join(tmpdir(), "camino-clipath-"));
    try {
      const exe = join(dir, "fake-cli");
      writeFileSync(exe, "#!/bin/sh\nexit 0\n");
      chmodSync(exe, 0o755);
      const plain = join(dir, "not-executable");
      writeFileSync(plain, "data");
      chmodSync(plain, 0o644);

      expect(cliOnPath("fake-cli", dir)).toBe(true);
      expect(cliOnPath("not-executable", dir)).toBe(false); // not executable
      expect(cliOnPath("missing-cli", dir)).toBe(false); // absent
      expect(cliOnPath("fake-cli", undefined)).toBe(false); // no PATH at all
      expect(cliOnPath("fake-cli", "")).toBe(false);
      expect(cliOnPath("", dir)).toBe(false); // empty name never matches
      expect(cliOnPath("sub/fake-cli", dir)).toBe(false); // path-ish names refused
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deliberately IGNORES empty and relative PATH entries (round-1 finding 9)", () => {
    const dir = mkdtempSync(join(tmpdir(), "camino-clipath2-"));
    try {
      const exe = join(dir, "fake-cli");
      writeFileSync(exe, "#!/bin/sh\nexit 0\n");
      chmodSync(exe, 0o755);
      // An empty PATH slot (=cwd to execvp) and a relative entry must not be
      // honored — a CLI reachable only that way is not a stable install, and
      // resolving it from the daemon cwd would diverge from the worker cwd.
      expect(cliOnPath("fake-cli", `:${dir}`)).toBe(true); // absolute entry still found
      expect(cliOnPath("fake-cli", "")).toBe(false);
      expect(cliOnPath("fake-cli", ":")).toBe(false); // only empty slots
      expect(cliOnPath("fake-cli", "relative/dir")).toBe(false); // relative ignored
      expect(cliOnPath("fake-cli", ".")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
