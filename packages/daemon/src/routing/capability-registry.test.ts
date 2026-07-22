/**
 * WP-106 capability registry (CAM-ROUTE-01): per-provider records carrying
 * models, quota windows, context limits, harness features, sanctioned-path
 * and billing-pool attributes — every attribute time-varying
 * (snapshot-dated, re-check-triggered) and source-linked — composed with
 * LIVE enablement from the dispatch registry's gate and live window state
 * from the tracker.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CAPABILITY_CONFIDENCE, PROVIDER_FAMILIES } from "@camino/shared";
import type { CapabilityAttribute } from "@camino/shared";
import { buildRegistryForTest } from "../dispatch/registry.js";
import { CAPABILITY_SEED, XAI_SANCTIONED_PATH_MEMO } from "./capability-seed.js";
import { buildCapabilityRegistry } from "./capability-registry.js";
import { QuotaWindowTracker } from "./window-tracker.js";

let dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-caps-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** An attestations record with the xAI disposition accepted (the WP-000 shape). */
function acceptedAttestations(): string {
  const path = join(tempDir(), "attestations.json");
  writeFileSync(path, JSON.stringify({ xaiSanctionedPath: { status: "accepted" } }));
  return path;
}

const ALL_PRESENT = { resolveCli: (bin: string) => `/attested/${bin}` };

function isAttribute(value: unknown): value is CapabilityAttribute<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "snapshotAt" in value &&
    "source" in value
  );
}

describe("capability seed — time-varying, source-linked attributes", () => {
  it("covers every provider family with every required attribute class", () => {
    for (const family of PROVIDER_FAMILIES) {
      const record = CAPABILITY_SEED[family];
      expect(record.family).toBe(family);
      for (const key of [
        "models",
        "quotaWindows",
        "harnessFeatures",
        "sanctionedPath",
        "billingPools",
      ] as const) {
        expect(isAttribute(record[key]), `${family}.${key} must be a capability attribute`).toBe(
          true,
        );
      }
    }
  });

  it("stamps every attribute-shaped field with snapshot date, source, confidence, and re-check triggers (sweep)", () => {
    // Sweep every non-identity field rather than a hand-kept list, so a
    // later attribute added without its metadata trips this test.
    for (const family of PROVIDER_FAMILIES) {
      const record = CAPABILITY_SEED[family] as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(record)) {
        if (key === "family" || key === "harness") continue;
        expect(isAttribute(value), `${family}.${key} must carry attribute metadata`).toBe(true);
        const attribute = value as CapabilityAttribute<unknown>;
        expect(attribute.snapshotAt, `${family}.${key}.snapshotAt`).toMatch(/^\d{4}-\d{2}-\d{2}/);
        expect(attribute.source.length, `${family}.${key}.source`).toBeGreaterThan(0);
        expect(CAPABILITY_CONFIDENCE).toContain(attribute.confidence);
        expect(
          attribute.recheckTriggers.length,
          `${family}.${key} must state what obligates a re-check (CAM-ROUTE-01)`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("carries a dated, documented model catalog with context limits for every provider (CAM-ROUTE-01)", () => {
    for (const family of PROVIDER_FAMILIES) {
      const models = CAPABILITY_SEED[family].models;
      expect(models.confidence, `${family} model catalog`).toBe("documented");
      expect(models.value.length, `${family} must list at least one model`).toBeGreaterThan(0);
      for (const model of models.value) {
        expect(model.id.length).toBeGreaterThan(0);
        expect(
          model.contextWindowTokens,
          `${family}/${model.id} context limit must come from the cited source`,
        ).toBeGreaterThan(0);
      }
    }
    // Values absent from the cited source stay absent — never guessed: the
    // xAI catalog states context windows but not output caps.
    for (const model of CAPABILITY_SEED.xai.models.value) {
      expect(model.maxOutputTokens).toBeUndefined();
    }
    expect(CAPABILITY_SEED.anthropic.models.value.map((m) => m.id)).toContain("claude-opus-4-8");
    expect(CAPABILITY_SEED.anthropic.models.value.map((m) => m.id)).toContain("claude-fable-5");
    expect(CAPABILITY_SEED.openai.models.value.map((m) => m.id)).toContain("gpt-5.6-sol");
    expect(CAPABILITY_SEED.xai.models.value.map((m) => m.id)).toContain("grok-4.5");
  });

  it("pins the registry-item-13 window shapes: Claude and Codex 5-hour + weekly documented; Grok unrecorded", () => {
    for (const family of ["anthropic", "openai"] as const) {
      const windows = CAPABILITY_SEED[family].quotaWindows;
      expect(windows.value.map((w) => w.durationMs).sort((a, b) => a - b)).toEqual([
        5 * 3_600_000,
        7 * 24 * 3_600_000,
      ]);
      expect(windows.confidence).toBe("documented");
      // The sources state PERIODS, not reset semantics — so every seeded
      // window is kind unknown-reset until a source or the ledger upgrades
      // it (round-3 review finding 7).
      for (const window of windows.value) {
        expect(window.kind).toBe("unknown-reset");
      }
    }
    // No documented Grok Build shape: tracked purely from adapter signals,
    // synthesized by the tracker once a recovery gap is observed.
    expect(CAPABILITY_SEED.xai.quotaWindows.value).toEqual([]);
    expect(CAPABILITY_SEED.xai.quotaWindows.confidence).toBe("unverified");
  });

  it("carries the xAI disposition with both recorded caveats and the memo's re-check triggers", () => {
    const sanctioned = CAPABILITY_SEED.xai.sanctionedPath;
    expect(sanctioned.value.status).toBe("recorded-accepted");
    expect(sanctioned.value.recordedOn).toBe("2026-07-17");
    expect(sanctioned.source).toContain(XAI_SANCTIONED_PATH_MEMO);
    // The two caveats the acceptance recorded (memo §§3–4).
    expect(sanctioned.notes?.some((n) => n.includes("anti-automation"))).toBe(true);
    expect(sanctioned.notes?.some((n) => n.includes("non-commercial"))).toBe(true);
    // The four re-check triggers from the memo's recommendation section.
    expect(sanctioned.recheckTriggers).toHaveLength(4);
    expect(sanctioned.recheckTriggers.join(" ")).toContain("beta→GA");
    expect(sanctioned.recheckTriggers.join(" ")).toContain("open-source release");
  });

  it("records billing pools with the WP-000 funding attestations: anthropic/openai attested, xai not", () => {
    for (const family of PROVIDER_FAMILIES) {
      const pools = CAPABILITY_SEED[family].billingPools.value;
      expect(pools.some((p) => p.kind === "subscription")).toBe(true);
      expect(pools.some((p) => p.kind === "api-key")).toBe(true);
    }
    const attested = (family: "anthropic" | "openai" | "xai") =>
      CAPABILITY_SEED[family].billingPools.value.find((p) => p.kind === "api-key")
        ?.fundedFallbackAttested;
    expect(attested("anthropic")).toBe(true);
    expect(attested("openai")).toBe(true);
    expect(attested("xai")).toBe(false);
  });

  it("is deep-frozen: registry attributes refuse in-place edits", () => {
    expect(() => {
      (CAPABILITY_SEED.anthropic.models.value as unknown as unknown[]).push({ id: "forged" });
    }).toThrow(TypeError);
    expect(() => {
      (CAPABILITY_SEED.xai.sanctionedPath.value as { status: string }).status = "recorded-refused";
    }).toThrow(TypeError);
  });
});

describe("buildCapabilityRegistry — live composition", () => {
  it("mirrors the dispatch registry's enablement decisions, reasons included", () => {
    const adapters = buildRegistryForTest({
      attestationsPath: acceptedAttestations(),
      resolveCli: (bin) => (bin === "codex" ? null : `/attested/${bin}`),
    });
    const view = buildCapabilityRegistry({ adapters });
    expect(view.providers.anthropic.enablement).toEqual({ enabled: true });
    expect(view.providers.xai.enablement).toEqual({ enabled: true });
    expect(view.providers.openai.enablement.enabled).toBe(false);
    expect(view.providers.openai.enablement.reason).toBe("codex CLI not found on PATH");
  });

  it("tracks a withdrawn xAI disposition in BOTH enablement and the sanctioned-path attribute", () => {
    // Round-6 review finding 3: the capability record must never contradict
    // its own gate — the attribute varies with the live attestation record.
    const path = join(tempDir(), "attestations.json");
    writeFileSync(path, JSON.stringify({ xaiSanctionedPath: { status: "withdrawn" } }));
    const adapters = buildRegistryForTest({ attestationsPath: path, ...ALL_PRESENT });
    const view = buildCapabilityRegistry({
      adapters,
      attestationsPath: path,
      now: () => new Date("2026-07-22T10:00:00Z"),
    });
    expect(view.providers.xai.enablement.enabled).toBe(false);
    expect(view.providers.xai.enablement.reason).toContain("sanctioned-path");
    const sanctioned = view.providers.xai.sanctionedPath;
    expect(sanctioned.value.status).toBe("recorded-refused");
    expect(sanctioned.snapshotAt).toBe("2026-07-22");
    expect(sanctioned.source).toContain("live read at assembly");
    expect(sanctioned.notes?.some((n) => n.includes("withdrawn"))).toBe(true);
    // While the record reads accepted, the seed's dated disposition IS the
    // live truth and passes through unchanged.
    const accepted = buildCapabilityRegistry({
      adapters: buildRegistryForTest({ attestationsPath: acceptedAttestations(), ...ALL_PRESENT }),
      attestationsPath: acceptedAttestations(),
    });
    expect(accepted.providers.xai.sanctionedPath.value.status).toBe("recorded-accepted");
  });

  it("computes every window-state read at the single assembly instant (round-6 finding 4)", () => {
    // The tracker's own clock is far in the future; the registry's instant
    // must govern, so a recovery recorded after the assembly instant is
    // invisible in the assembled snapshot.
    const tracker = new QuotaWindowTracker(join(tempDir(), "windows.sqlite"), {
      now: () => new Date("2026-07-22T20:00:00Z"),
    });
    try {
      tracker.recordDispatch("xai", {
        dispatchId: "asm-1",
        outcome: "quota-blocked",
        durationMs: 60_000,
        quotaSignalSeen: true,
        at: new Date("2026-07-22T09:00:00Z"),
      });
      tracker.recordDispatch("xai", {
        dispatchId: "asm-2",
        outcome: "succeeded",
        durationMs: 60_000,
        quotaSignalSeen: false,
        at: new Date("2026-07-22T15:00:00Z"),
      });
      const view = buildCapabilityRegistry({
        adapters: buildRegistryForTest({
          attestationsPath: acceptedAttestations(),
          ...ALL_PRESENT,
        }),
        attestationsPath: acceptedAttestations(),
        tracker,
        now: () => new Date("2026-07-22T10:00:00Z"),
      });
      expect(view.assembledAt).toBe("2026-07-22T10:00:00.000Z");
      const state = view.providers.xai.windowState;
      expect(state?.windows).toEqual([]); // the 15:00 recovery is after the snapshot instant
      expect(state?.lastQuotaBlockedAt).toBe("2026-07-22T09:00:00.000Z");
    } finally {
      tracker.close();
    }
  });

  it("refuses enablement from an enabled-looking spec without registry provenance", () => {
    // Round-5 review finding 3: enablement is believed only from specs the
    // dispatch gate ENABLED (the same provenance dispatch() requires).
    const forged = {
      name: "grok-build",
      enabled: true,
      plan: () => ({ file: "/forged/grok", args: [] }),
      parseLine: () => null,
    };
    const view = buildCapabilityRegistry({ adapters: [forged] });
    expect(view.providers.xai.enablement.enabled).toBe(false);
    expect(view.providers.xai.enablement.reason).toContain("provenance");
  });

  it("reports an absent adapter as disabled rather than guessing", () => {
    const view = buildCapabilityRegistry({ adapters: [] });
    for (const family of PROVIDER_FAMILIES) {
      expect(view.providers[family].enablement.enabled).toBe(false);
      expect(view.providers[family].enablement.reason).toContain("absent");
    }
  });

  it("stamps the assembly instant and includes live window state when a tracker is supplied", () => {
    const tracker = new QuotaWindowTracker(join(tempDir(), "windows.sqlite"), {
      now: () => new Date("2026-07-22T10:00:00Z"),
    });
    try {
      tracker.recordDispatch("anthropic", {
        dispatchId: "d1",
        outcome: "quota-blocked",
        durationMs: 60_000,
        quotaSignalSeen: true,
        at: new Date("2026-07-22T09:00:00Z"),
      });
      const view = buildCapabilityRegistry({
        adapters: buildRegistryForTest({
          attestationsPath: acceptedAttestations(),
          ...ALL_PRESENT,
        }),
        tracker,
        now: () => new Date("2026-07-22T10:00:00Z"),
      });
      expect(view.assembledAt).toBe("2026-07-22T10:00:00.000Z");
      const state = view.providers.anthropic.windowState;
      expect(state?.lastQuotaBlockedAt).toBe("2026-07-22T09:00:00.000Z");
      // One hour after exhaustion, both recorded windows still report full.
      expect(state?.windows.map((w) => w.estimatedConsumption)).toEqual([1, 1]);
      // Without a tracker, no live claim is made at all.
      const bare = buildCapabilityRegistry({
        adapters: buildRegistryForTest({
          attestationsPath: acceptedAttestations(),
          ...ALL_PRESENT,
        }),
      });
      expect(bare.providers.anthropic.windowState).toBeUndefined();
    } finally {
      tracker.close();
    }
  });
});
