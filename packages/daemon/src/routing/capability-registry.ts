/**
 * Capability registry assembly (WP-106, CAM-ROUTE-01): compose the static,
 * source-linked seed (capability-seed.ts) with LIVE state —
 *
 *   - enablement, taken from the dispatch registry's gated AdapterSpec
 *     objects (CLI presence + recorded sanctioned-path; WP-105). The
 *     registry never re-derives the gate: the specs from buildRegistry()
 *     ARE the decision, reason included, so a flipped attestation or a
 *     missing CLI shows up here without a second code path to keep in
 *     sync.
 *   - window consumption estimates, from the QuotaWindowTracker when one
 *     is supplied (adapter rate-limit signals, ledger-refined capacity —
 *     registry item 13).
 *
 * The result is a point-in-time VIEW (assembledAt-stamped), not a store:
 * time-variance lives in the seed's snapshot/re-check metadata, the
 * attestation record the gate consumes, and the tracker's observation log.
 */
import type { AdapterSpec, ProviderCapabilityRecord, ProviderFamily } from "@camino/shared";
import { HARNESS_FAMILY, PROVIDER_FAMILIES } from "@camino/shared";
import {
  DEFAULT_ATTESTATIONS_PATH,
  buildRegistry,
  hasRegistryProvenance,
  xaiSanctioned,
} from "../dispatch/registry.js";
import { CAPABILITY_SEED } from "./capability-seed.js";
import type { ProviderWindowState, QuotaWindowTracker } from "./window-tracker.js";

/** Live enablement as decided by the dispatch registry's gate (CAM-EXEC-01). */
export interface EnablementView {
  readonly enabled: boolean;
  /** Present exactly when disabled: the gate's recorded reason. */
  readonly reason?: string;
}

/** One provider's assembled capability view: seed record + live state. */
export interface ProviderCapabilityView extends ProviderCapabilityRecord {
  readonly enablement: EnablementView;
  /** Present when a tracker was supplied to buildCapabilityRegistry. */
  readonly windowState?: ProviderWindowState;
}

export interface CapabilityRegistryView {
  /** ISO-8601 instant this view was assembled (it is a snapshot, not a feed). */
  readonly assembledAt: string;
  readonly providers: Readonly<Record<ProviderFamily, ProviderCapabilityView>>;
}

export interface BuildCapabilityRegistryOptions {
  /**
   * Gated adapter specs; defaults to buildRegistry() (the production
   * sanctioned-path + CLI gate). Injectable for tests via
   * buildRegistryForTest.
   */
  readonly adapters?: readonly AdapterSpec[];
  /** Supply the tracker to include live window consumption estimates. */
  readonly tracker?: QuotaWindowTracker;
  /** Attestations record the live xAI sanctioned-path read uses (tests). */
  readonly attestationsPath?: string;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

function enablementOf(family: ProviderFamily, adapters: readonly AdapterSpec[]): EnablementView {
  const harness = CAPABILITY_SEED[family].harness;
  const spec = adapters.find((candidate) => {
    // A hostile/broken spec must not crash registry assembly; unreadable
    // specs simply do not match (the dispatch lifecycle applies the same
    // fail-closed reads — WP-105 rounds 3–5).
    try {
      return candidate.name === harness;
    } catch {
      return false;
    }
  });
  if (spec === undefined) {
    return { enabled: false, reason: `${harness} adapter absent from the dispatch registry` };
  }
  let enabled = false;
  try {
    enabled = spec.enabled === true;
  } catch {
    enabled = false;
  }
  // Enablement is believed only from a spec the dispatch registry's gate
  // ENABLED (the same WeakSet provenance dispatch() itself requires): an
  // enabled-looking spec that never passed the sanctioned-path + CLI gate
  // must not present as enabled here first (round-5 review finding 3).
  if (enabled && !hasRegistryProvenance(spec)) {
    return {
      enabled: false,
      reason: `${harness} spec lacks registry provenance — obtain adapters from buildRegistry() (CAM-EXEC-01 gate)`,
    };
  }
  if (enabled) return { enabled: true };
  let reason: string;
  try {
    reason = typeof spec.disabledReason === "string" ? spec.disabledReason : "disabled";
  } catch {
    reason = "disabled reason unavailable";
  }
  return { enabled: false, reason };
}

/**
 * Assemble the per-provider capability registry view (CAM-ROUTE-01):
 * models, quota windows, context limits, harness features, sanctioned-path
 * and billing-pool attributes — every seed attribute time-varying
 * (snapshot-dated, re-check-triggered) and source-linked — plus live
 * enablement and, when a tracker is supplied, live window estimates.
 */
export function buildCapabilityRegistry(
  options: BuildCapabilityRegistryOptions = {},
): CapabilityRegistryView {
  const adapters = options.adapters ?? buildRegistry();
  const now = options.now ?? (() => new Date());
  // ONE assembly instant: assembledAt and every window-state read use the
  // same clock reading, so the snapshot is as-of a single instant even
  // when the tracker was built with a different clock (round-6 finding 4).
  const assembledInstant = now();
  // The xAI sanctioned-path attribute is TIME-VARYING through the same
  // live record the dispatch gate consumes (round-6 finding 3): while the
  // recorded disposition stands, the seed's dated snapshot IS the live
  // truth; when the record no longer reads accepted, the assembled view
  // says so — the capability record can never contradict its own gate.
  const attestationsPath = options.attestationsPath ?? DEFAULT_ATTESTATIONS_PATH;
  const liveXai = xaiSanctioned(attestationsPath);
  const providers = Object.fromEntries(
    PROVIDER_FAMILIES.map((family) => {
      const seed = CAPABILITY_SEED[family];
      const view: ProviderCapabilityView = {
        ...seed,
        ...(family === "xai" && !liveXai.accepted
          ? {
              sanctionedPath: {
                value: { status: "recorded-refused" as const },
                snapshotAt: assembledInstant.toISOString().slice(0, 10),
                source: `${attestationsPath} (live read at assembly; the recorded disposition in the seed no longer reads accepted)`,
                confidence: "observed" as const,
                recheckTriggers: seed.sanctionedPath.recheckTriggers,
                notes: [
                  `gate reason: ${liveXai.reason ?? "not accepted"}`,
                  ...(seed.sanctionedPath.notes ?? []),
                ],
              },
            }
          : {}),
        enablement: enablementOf(family, adapters),
        ...(options.tracker
          ? { windowState: options.tracker.windowState(family, { now: assembledInstant }) }
          : {}),
      };
      return [family, view];
    }),
  ) as Record<ProviderFamily, ProviderCapabilityView>;

  // Structural consistency: the seed's harness must map to its own family
  // (a seed edit that breaks this would silently mis-attribute enablement).
  for (const family of PROVIDER_FAMILIES) {
    if (HARNESS_FAMILY[providers[family].harness] !== family) {
      throw new Error(
        `capability seed inconsistency: harness ${providers[family].harness} does not belong to family ${family}`,
      );
    }
  }

  return { assembledAt: assembledInstant.toISOString(), providers };
}
