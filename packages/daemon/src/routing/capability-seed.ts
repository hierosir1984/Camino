/**
 * Seeded capability registry data (WP-106, CAM-ROUTE-01): the static,
 * source-linked half of the per-provider capability record.
 *
 * Honesty rules for this file:
 *
 *   - Every attribute states WHERE its value comes from and WHEN it was
 *     recorded. Values we have no grounded source for are recorded as
 *     `unverified` with an empty/absent value and an explicit re-check
 *     obligation — never guessed. A wrong-but-confident registry would
 *     corrupt routing decisions silently; an honest gap is visible and
 *     gets filled by the recorded triggers (provider-doc re-checks,
 *     adapter transcript observation, ledger data).
 *   - The LIVE half (adapter enablement from the dispatch registry's
 *     sanctioned-path gate; window consumption from the tracker) is
 *     composed in capability-registry.ts — this file never claims live
 *     state.
 *
 * The whole seed is deep-frozen at module load (same rationale as the
 * @camino/shared barrel-immutability suite: a first-party importer must
 * not be able to edit a registry attribute in place).
 */
import type { ProviderCapabilityRecord, ProviderFamily } from "@camino/shared";
import { deepFreeze } from "@camino/shared";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** In-repo record paths the seed cites (kept as constants so tests can pin them). */
export const XAI_SANCTIONED_PATH_MEMO = "docs/plan/xai-sanctioned-path-research.md";
const ATTESTATIONS_RECORD = "docs/plan/phase-0-prereq-attestations.json";
const REGISTRY_ITEM_13 = "docs/PRD.md §5 registry item 13";

export const CAPABILITY_SEED: Readonly<Record<ProviderFamily, ProviderCapabilityRecord>> =
  deepFreeze({
    anthropic: {
      family: "anthropic",
      harness: "claude-code",
      models: {
        value: [
          { id: "claude-fable-5", contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
          { id: "claude-opus-4-8", contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
          { id: "claude-sonnet-5", contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
          { id: "claude-haiku-4-5", contextWindowTokens: 200_000, maxOutputTokens: 64_000 },
        ],
        snapshotAt: "2026-07-22",
        source:
          "Anthropic model catalog, platform.claude.com/docs/en/about-claude/models/overview (retrieved 2026-07-22; context windows and max output stated per model)",
        confidence: "documented",
        recheckTriggers: [
          "provider model-catalog change",
          "Claude Code CLI release notes announcing model additions/retirements",
          "adapter transcript reporting an unlisted served model id",
        ],
        notes: [
          "The harness also accepts stable aliases (opus / sonnet / haiku) via --model.",
          "Subscription-plan availability of individual models is not asserted here; the harness default is used when the policy table pins no model.",
        ],
      },
      quotaWindows: {
        value: [
          { id: "session-5h", kind: "unknown-reset", durationMs: 5 * HOUR_MS },
          { id: "weekly", kind: "unknown-reset", durationMs: 7 * DAY_MS },
        ],
        snapshotAt: "2026-07-17",
        source: `${REGISTRY_ITEM_13} (Claude 5-hour + weekly windows), PRD approved 2026-07-17`,
        confidence: "documented",
        recheckTriggers: [
          "provider announcement changing usage-limit structure",
          "provider documentation stating reset semantics (upgrades kind to rolling)",
          "ledger observation contradicting the recorded shape (QuotaWindowTracker)",
        ],
        notes: [
          "Window CAPACITY is deliberately unstated: it varies by plan and is estimated from ledger observation, never assumed.",
          "Both windows' PERIODS are stated by the source; neither's reset semantics are — kind unknown-reset yields a one-period pin after exhaustion and no usage fraction (see WindowShape), refined from ledger observation.",
        ],
      },
      harnessFeatures: {
        value: [
          "headless single-turn dispatch (-p) with a stream-json event feed",
          "model selection via --model (ids and aliases)",
          "subscription auth exercised only inside the official CLI (CAM-SEC-06)",
          "rate-limit signals surfaced on error-context events, classified quota-blocked (CAM-EXEC-06)",
        ],
        snapshotAt: "2026-07-20",
        source:
          "packages/daemon/src/dispatch/adapters/claude.ts (WP-105, merged 2026-07-20; exercised by the WP-001 dispatch transcripts)",
        confidence: "observed",
        recheckTriggers: [
          "Claude Code CLI major-version change",
          "adapter conformance-suite failure",
        ],
      },
      sanctionedPath: {
        value: { status: "recorded-accepted" },
        snapshotAt: "2026-07-19",
        source:
          "PRD §9 + packages/daemon/src/dispatch/registry.ts RECORDED_SANCTIONED_PATHS (official CLI on the user's own subscription is the recorded headless path)",
        confidence: "documented",
        recheckTriggers: [
          "provider ToS/usage-policy effective-date change",
          "provider statement on third-party or headless subscription use",
        ],
        notes: [
          "Design §9 records this as the internally-tense posture among the three providers; the funded API fallback (CAM-ROUTE-08) is the priced mitigation.",
        ],
      },
      billingPools: {
        value: [
          {
            kind: "subscription",
            label: "Claude subscription (official CLI on the user's own plan)",
          },
          {
            kind: "api-key",
            label: "funded API fallback account (CAM-ROUTE-08; same CLI re-authenticated)",
            fundedFallbackAttested: true,
          },
        ],
        snapshotAt: "2026-07-17",
        source: `pool modes: docs/PRD.md §4.7 CAM-ROUTE-08 (fallback = the same official CLI re-authenticated with an API key); funding attestation: ${ATTESTATIONS_RECORD} fundedFallbackAccounts.anthropic (WP-000 gate record)`,
        confidence: "documented",
        recheckTriggers: [
          "attestations record edit",
          "CAM-ROUTE-08 runbook exercise (Phase 2) recording a result",
        ],
      },
    },

    openai: {
      family: "openai",
      harness: "codex-cli",
      models: {
        value: [
          { id: "gpt-5.6-sol", contextWindowTokens: 1_050_000, maxOutputTokens: 128_000 },
          { id: "gpt-5.6-terra", contextWindowTokens: 1_050_000, maxOutputTokens: 128_000 },
          { id: "gpt-5.6-luna", contextWindowTokens: 1_050_000, maxOutputTokens: 128_000 },
        ],
        snapshotAt: "2026-07-22",
        source:
          "OpenAI model reference, developers.openai.com/api/docs/models/gpt-5.6-{sol,terra,luna} (retrieved 2026-07-22; each page states the context window and max output tokens)",
        confidence: "documented",
        recheckTriggers: [
          "provider model-catalog documentation change",
          "adapter transcript reporting an unlisted served model id",
        ],
        notes: [
          "The harness selects its own default model when the policy table pins none (-c model= pins one).",
          "GPT-5.3-Codex-Spark (research preview) is deliberately not listed: plan-gated availability, no stable documented limits at snapshot time.",
        ],
      },
      quotaWindows: {
        value: [
          { id: "session-5h", kind: "unknown-reset", durationMs: 5 * HOUR_MS },
          { id: "weekly", kind: "unknown-reset", durationMs: 7 * DAY_MS },
        ],
        snapshotAt: "2026-07-22",
        source: `ChatGPT Codex pricing documentation, learn.chatgpt.com/docs/pricing (retrieved 2026-07-22): usage limits for local messages and cloud chats share a five-hour window, with additional weekly limits; window set per ${REGISTRY_ITEM_13}`,
        confidence: "documented",
        recheckTriggers: [
          "provider announcement changing usage-limit structure",
          "provider documentation stating reset semantics (upgrades kind to rolling)",
          "ledger observation contradicting the recorded shape (QuotaWindowTracker)",
        ],
        notes: [
          "The cited page states a five-hour window and that additional weekly limits MAY apply. Only the PERIODS are asserted here; reset semantics are stated for neither window, so both are recorded kind unknown-reset — a one-period pin after exhaustion and no usage fraction (see WindowShape) — refined from ledger observation (round-2 finding 4, round-3 finding 7).",
          "Weekly-limit APPLICABILITY is plan-dependent per the source ('may apply'): the window is seeded conservatively, its pin is an upper bound, and choosing when to probe/resume among differently-pinned windows is the WP-114 scheduler's recorded policy boundary (round-4 finding 5).",
        ],
      },
      harnessFeatures: {
        value: [
          "headless dispatch (exec) with --json JSONL event feed",
          "model selection via -c model=",
          "turn.completed is the genuine success terminal; turn.failed carries the error payload",
          "rate-limit signals surfaced on error-context events, classified quota-blocked (CAM-EXEC-06)",
        ],
        snapshotAt: "2026-07-20",
        source:
          "packages/daemon/src/dispatch/adapters/codex.ts (WP-105, merged 2026-07-20; observed against Codex CLI 0.144.x)",
        confidence: "observed",
        recheckTriggers: ["Codex CLI major-version change", "adapter conformance-suite failure"],
      },
      sanctionedPath: {
        value: { status: "recorded-accepted" },
        snapshotAt: "2026-07-19",
        source:
          "PRD §9 + design doc 05 research record via packages/daemon/src/dispatch/registry.ts RECORDED_SANCTIONED_PATHS (subscription use of the official CLI in third-party harnesses is endorsed)",
        confidence: "documented",
        recheckTriggers: [
          "provider ToS/usage-policy effective-date change",
          "provider statement on third-party or headless subscription use",
        ],
      },
      billingPools: {
        value: [
          {
            kind: "subscription",
            label: "ChatGPT subscription (official Codex CLI on the user's own plan)",
          },
          {
            kind: "api-key",
            label: "funded API fallback account (CAM-ROUTE-08; same CLI re-authenticated)",
            fundedFallbackAttested: true,
          },
        ],
        snapshotAt: "2026-07-17",
        source: `pool modes: docs/PRD.md §4.7 CAM-ROUTE-08 (fallback = the same official CLI re-authenticated with an API key); funding attestation: ${ATTESTATIONS_RECORD} fundedFallbackAccounts.openai (WP-000 gate record)`,
        confidence: "documented",
        recheckTriggers: [
          "attestations record edit",
          "CAM-ROUTE-08 runbook exercise (Phase 2) recording a result",
        ],
      },
    },

    xai: {
      family: "xai",
      harness: "grok-build",
      models: {
        value: [
          { id: "grok-4.5", contextWindowTokens: 500_000 },
          { id: "grok-build-0.1", contextWindowTokens: 256_000 },
        ],
        snapshotAt: "2026-07-22",
        source:
          "xAI model catalog, docs.x.ai/docs/models and per-model pages docs.x.ai/developers/models/{grok-4.5,grok-build-0.1} (retrieved 2026-07-22; context windows stated per model); grok-4.5 is named as the model powering Grok Build at docs.x.ai/build/overview",
        confidence: "documented",
        recheckTriggers: [
          "provider model-catalog documentation change (docs.x.ai)",
          "adapter transcript reporting an unlisted served model id",
        ],
        notes: [
          "The harness selects its own default model when the policy table pins none (-m pins one).",
          "Max output tokens are not stated in the cited catalog and are deliberately absent rather than guessed.",
        ],
      },
      quotaWindows: {
        value: [],
        snapshotAt: "2026-07-22",
        source: `${REGISTRY_ITEM_13} (Grok Build windows tracked from adapter rate-limit signals; no documented shape recorded)`,
        confidence: "unverified",
        recheckTriggers: [
          "provider documentation stating a usage-window structure",
          "ledger observation of exhaustion/recovery gaps establishing a shape (QuotaWindowTracker)",
        ],
        notes: [
          "With no recorded shape, scheduling relies on live rate-limit signals: an exhaustion signal queues work (CAM-EXEC-06), and the tracker records exhaustion→success recovery gaps as shape evidence — once one exists, it synthesizes an 'observed-recovery' window from the largest gap so the pause threshold applies (registry item 13 refinement).",
        ],
      },
      harnessFeatures: {
        value: [
          "headless single-turn dispatch (-p) with streaming-json event feed",
          "model selection via -m",
          "ACP support for embedding in other apps (provider announcement, memo finding 1)",
          "native API-key auth mode (XAI_API_KEY) mirroring the CAM-ROUTE-08 fallback pattern",
          "rate-limit signals surfaced on error-context events, classified quota-blocked (CAM-EXEC-06)",
        ],
        snapshotAt: "2026-07-20",
        source: `packages/daemon/src/dispatch/adapters/grok.ts (WP-105, merged 2026-07-20; observed against Grok Build CLI 0.2.x) + ${XAI_SANCTIONED_PATH_MEMO} finding 1`,
        confidence: "observed",
        recheckTriggers: [
          "Grok Build CLI major-version change",
          "adapter conformance-suite failure",
        ],
      },
      sanctionedPath: {
        value: { status: "recorded-accepted", recordedBy: "David", recordedOn: "2026-07-17" },
        snapshotAt: "2026-07-17",
        source: `${XAI_SANCTIONED_PATH_MEMO} (disposition ACCEPTED 2026-07-17; consumed at runtime from ${ATTESTATIONS_RECORD} by the dispatch registry gate)`,
        confidence: "documented",
        recheckTriggers: [
          "ToS/AUP effective-date change (current: 2026-06-26)",
          "Grok Build beta→GA transition",
          "any xAI statement on third-party harnesses",
          "Camino open-source release (re-price the recorded caveats for distribution)",
        ],
        notes: [
          "Caveat (a): generic AUP anti-automation boilerplate sits in facial tension with the product's advertised headless mode; recorded as boilerplate-tension, not a blocker (memo §4).",
          "Caveat (b): Grok Build is labeled early beta and the ToS scopes beta evaluation to personal, non-commercial use — matches current use; re-check before any commercial context (memo §3).",
        ],
      },
      billingPools: {
        value: [
          {
            kind: "subscription",
            label: "SuperGrok / X Premium+ subscription (official Grok Build CLI)",
          },
          {
            kind: "api-key",
            label: "native XAI_API_KEY auth mode in the same official CLI",
            fundedFallbackAttested: false,
          },
        ],
        snapshotAt: "2026-07-17",
        source: `${XAI_SANCTIONED_PATH_MEMO} findings 1 and 3; ${ATTESTATIONS_RECORD} carries no xAI funding attestation`,
        confidence: "documented",
        recheckTriggers: ["attestations record edit", "provider subscription-tier change"],
        notes: [
          "CAM-ROUTE-08 names Anthropic and OpenAI as the critical providers with funded-fallback obligations; the xAI key path exists natively but carries no recorded funding attestation.",
        ],
      },
    },
  });
