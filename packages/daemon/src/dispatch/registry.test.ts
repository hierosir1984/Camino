import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterSpec } from "@camino/shared";
import { claudeAdapter } from "./adapters/claude.js";
import { codexAdapter } from "./adapters/codex.js";
import { grokAdapter } from "./adapters/grok.js";
import { isAbsolute } from "node:path";
import {
  buildRegistry,
  buildRegistryForTest,
  cliOnPath,
  resolveCliPath,
  DEFAULT_ATTESTATIONS_PATH,
  hasRegistryProvenance,
} from "./registry.js";
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
    const reg = buildRegistryForTest({ cliPresent: () => false });
    expect(reg.map((a) => a.name).sort()).toEqual(["claude-code", "codex-cli", "grok-build"]);
    for (const a of reg) {
      expect(a.enabled).toBe(false);
      expect(a.disabledReason).toMatch(/CLI not found on PATH$/);
    }
  });

  it("grok is disabled with the gate reason when the attestations record is unreadable", () => {
    const reg = buildRegistryForTest({
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
        const reg = buildRegistryForTest({ cliPresent: ALL_PRESENT, attestationsPath: file });
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
      const reg = buildRegistryForTest({ cliPresent: ALL_PRESENT, attestationsPath: file });
      const grok = reg.find((a) => a.name === "grok-build")!;
      expect(grok.enabled).toBe(false);
      expect(grok.disabledReason).toContain('not "accepted"');
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("a huge status string yields a BOUNDED reason, and null/array/object are distinguished (round-4 finding 5)", () => {
    const huge = tmpAttestations(
      JSON.stringify({ xaiSanctionedPath: { status: "x".repeat(5_000_000) } }),
    );
    try {
      const grok = buildRegistryForTest({ cliPresent: ALL_PRESENT, attestationsPath: huge }).find(
        (a) => a.name === "grok-build",
      )!;
      expect(grok.enabled).toBe(false);
      expect(grok.disabledReason!.length).toBeLessThan(200); // not 5 MB
    } finally {
      rmSync(huge, { force: true });
    }
    // Precise, distinct reasons for null / array / object statuses.
    const cases: Array<[unknown, RegExp]> = [
      [null, /status is null/],
      [[1, 2], /status is an array/],
      [{ a: 1 }, /status is an object/],
    ];
    for (const [status, reason] of cases) {
      const file = tmpAttestations(JSON.stringify({ xaiSanctionedPath: { status } }));
      try {
        const grok = buildRegistryForTest({ cliPresent: ALL_PRESENT, attestationsPath: file }).find(
          (a) => a.name === "grok-build",
        )!;
        expect(grok.enabled).toBe(false);
        expect(grok.disabledReason, JSON.stringify(status)).toMatch(reason);
      } finally {
        rmSync(file, { force: true });
      }
    }
  });

  it("a gated ENABLED spec spawns the resolved ABSOLUTE executable, not the bare name (round-8 finding 1)", () => {
    const reg = buildRegistryForTest({
      resolveCli: (bin) => `/opt/camino/bin/${bin}`, // the exact path the gate attested
    });
    const ctx = { prompt: "hi", workdir: "/tmp/ws" };
    expect(reg.find((a) => a.name === "claude-code")!.plan(ctx).file).toBe(
      "/opt/camino/bin/claude",
    );
    expect(reg.find((a) => a.name === "codex-cli")!.plan(ctx).file).toBe("/opt/camino/bin/codex");
    expect(reg.find((a) => a.name === "grok-build")!.plan(ctx).file).toBe("/opt/camino/bin/grok");
    // resolveCli → null disables (and a disabled spec is never dispatched).
    const none = buildRegistryForTest({ resolveCli: () => null });
    expect(none.every((a) => !a.enabled)).toBe(true);
  });

  it("grok is enabled when the record is accepted", () => {
    const file = tmpAttestations(JSON.stringify({ xaiSanctionedPath: { status: "accepted" } }));
    try {
      const reg = buildRegistryForTest({ cliPresent: ALL_PRESENT, attestationsPath: file });
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
    const reg = buildRegistryForTest({ cliPresent: ALL_PRESENT });
    const grok = reg.find((a) => a.name === "grok-build")!;
    expect(grok.enabled).toBe(true);
  });

  it("the PUBLIC registry is zero-argument: real PATH scan + real attestations only (round-7 finding 1)", () => {
    // The public surface cannot substitute the gates that mint provenance —
    // injection lives ONLY in buildRegistryForTest, which the package barrel
    // does not export (and the "exports" map blocks deep imports). Enablement
    // here depends on the running machine, so assert decision COMPLETENESS and
    // the provenance invariant, not specific enablement.
    const reg = buildRegistry();
    expect(reg.map((a) => a.name).sort()).toEqual(["claude-code", "codex-cli", "grok-build"]);
    for (const a of reg) {
      expect(typeof a.enabled).toBe("boolean");
      if (!a.enabled) expect(a.disabledReason).toBeTruthy();
      expect(hasRegistryProvenance(a), a.name).toBe(a.enabled === true);
    }
  });

  it("provenance = gate-ENABLED specs only; factories, copies, and disabled specs carry none (round-6 finding 1)", () => {
    for (const spec of buildRegistryForTest({ cliPresent: ALL_PRESENT })) {
      expect(hasRegistryProvenance(spec), spec.name).toBe(true);
    }
    // A DISABLED registry spec is deliberately NOT registered: dispatch refuses
    // it on enablement, and flipping its `enabled` flag cannot confer a
    // provenance the gate never granted.
    for (const spec of buildRegistryForTest({ cliPresent: () => false })) {
      expect(hasRegistryProvenance(spec), spec.name).toBe(false);
    }
    // The raw factory and even a field-for-field COPY of a gated spec carry no
    // provenance — WeakSet membership cannot be forged by copying properties.
    expect(hasRegistryProvenance(claudeAdapter())).toBe(false);
    const gated = buildRegistryForTest({ cliPresent: ALL_PRESENT })[0]!;
    expect(hasRegistryProvenance({ ...gated })).toBe(false);
  });

  it("registry decisions are complete: every adapter carries enabled, and a reason when off", () => {
    const reg = buildRegistryForTest({ cliPresent: (bin) => bin === "claude" });
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
    const present = buildRegistryForTest({ cliPresent: ALL_PRESENT });
    expect(present.every((a) => a.enabled)).toBe(true);

    const absent = buildRegistryForTest({ cliPresent: () => false });
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

  it("resolveCliPath returns the ABSOLUTE path, never a cwd-relative one (round-8 finding 1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "camino-resolve-"));
    try {
      const exe = join(dir, "fake-cli");
      writeFileSync(exe, "#!/bin/sh\nexit 0\n");
      chmodSync(exe, 0o755);
      // Even with a cwd-relative slot FIRST, resolution yields the absolute
      // candidate — this is the exact executable dispatch will spawn, so a
      // workspace-local ./fake-cli shadow can never be selected.
      expect(resolveCliPath("fake-cli", `.:${dir}`)).toBe(exe);
      expect(isAbsolute(resolveCliPath("fake-cli", `.:${dir}`)!)).toBe(true);
      expect(resolveCliPath("fake-cli", ".")).toBeNull(); // relative-only → unresolved
      expect(resolveCliPath("fake-cli", "relative/dir")).toBeNull();
      expect(resolveCliPath("missing", dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
