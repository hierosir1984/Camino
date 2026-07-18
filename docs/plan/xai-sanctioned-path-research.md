# xAI / Grok Build — sanctioned-path research (contractual half)

> **Disposition: ACCEPTED by David, 2026-07-17** (in-session). Registry attributes take effect as recommended below: sanctioned-path = confirmed (source-linked, snapshot 2026-07-17), enablement = enabled for personal use, with the two caveats recorded and the listed re-check triggers. The WP-000 entry-gate item "xAI contractual sanctioned-path confirmation recorded" is satisfied by this memo + disposition.
>
> 2026-07-17. Research memo feeding the WP-000 Phase-0 entry gate item "xAI contractual sanctioned-path confirmation recorded" (BUILD.md prerequisite; CAM-EXEC-01 enablement gate). The *technical* headless path was already verified during PRD review; this memo covers the *contractual/policy* half. Registry posture per CAM-ROUTE-01: attributes are time-varying and source-linked — this is a snapshot, re-checked on schedule and on the triggers listed at the end.

## Question

Does xAI permit Grok Build CLI, authenticated with a personal subscription, to be operated headlessly inside a third-party orchestration harness (Camino)?

## Verdict

**Confirmed-permissive for Camino's v1 usage, with two recorded caveats.** xAI affirmatively invites this usage class in its own product materials; no xAI term restricts subscription use to official surfaces (in contrast to Anthropic's posture recorded in design §9). The caveats are (a) generic AUP anti-automation boilerplate in facial tension with the product's advertised headless mode, and (b) Grok Build's "early beta" label combined with the ToS rule that beta features are for personal, non-commercial use — which matches David's use today and must be re-checked before any commercial context.

## Findings, by source

### 1. Product authorization — the strongest evidence

- Official announcement ([Introducing Grok Build](https://x.ai/news/grok-build-cli), May 25, 2026): available "to all SuperGrok and X Premium Plus subscribers" (subscription product, not API-only), and verbatim: "Headless mode (-p) allows easily running agents inside scripts and automations. The CLI also provides full ACP support to build your own bots and **agent orchestration apps**." That sentence describes Camino's exact usage class, for subscribers, in xAI's own words.
- Official docs ([Grok Build overview](https://docs.x.ai/build/overview), last updated July 6, 2026): "Use it via an interactive TUI, **headlessly in scripts or bots**, or through the Agent Client Protocol (ACP) **in other apps**"; "Headless usage is ideal for scripts, automations, or **integration into other apps**." A dedicated "Headless & Scripting" docs section exists.
- Auth modes (same docs): browser sign-in (subscription) or `XAI_API_KEY` — the API-key fallback path exists natively in the same official CLI, mirroring the CAM-ROUTE-08 pattern used for Anthropic/OpenAI.

### 2. Open source

- [xai-org/grok-build](https://github.com/xai-org/grok-build) — the CLI/TUI and agent runtime, first-party code under **Apache-2.0** ([README](https://github.com/xai-org/grok-build/blob/main/README.md)); announced ~July 15, 2026 ([official page](https://x.ai/open-source); [MarkTechPost](https://www.marktechpost.com/2026/07/15/spacexai-open-sources-grok-build-the-rust-agent-harness-tui-and-tool-layer-behind-its-coding-cli/)). External contributions are not accepted — published for transparency and local builds.
- Interpretation: the open-source license covers the **client code**, not the **service terms** — it is directional evidence of a permissive posture (David's prior) but not itself the authorization. The authorization is finding 1.

### 3. Consumer Terms of Service ([current](https://x.ai/legal/terms-of-service), effective June 26, 2026)

- **No official-surface restriction.** The consumer ToS contains no clause limiting subscription use to official apps and no clause about third-party clients or harnesses (contrast: Anthropic's recorded posture — OAuth tokens valid only inside Claude Code/claude.ai; legal directs third-party products to API keys).
- **Agentic use contemplated:** "Certain features of the Service may enable Grok to take autonomous actions on your behalf ('Agentic Actions'), including … code execution … modifying files, tool invocation" — with responsibility on the user. Compatible with Camino's design (evidence-gated, human-approved merges).
- **Credential rule:** "You may not share your account credentials or make your account available to anyone else" — a person-to-person sharing ban. Camino complies by construction: subscription auth is only ever exercised inside the official harness on David's own machine, never extracted, stored, or proxied (CAM-SEC-06).
- **Beta clause (caveat b):** "Use of our Service for evaluation purposes is for your **personal, non-commercial use** only," and Grok Build is labeled "early beta." David's use is personal — compliant. Re-check at beta→GA and before any commercial context.
- **Enterprise split:** "Our Enterprise Terms of Service govern the use of our Services for developers and businesses, including xAI APIs" — the consumer terms govern David's subscription use; the enterprise terms' competitive-use restrictions attach to the API/enterprise context, which Camino v1 does not use for xAI.

### 4. Acceptable Use Policy ([current](https://x.ai/legal/acceptable-use-policy), effective June 26, 2026) — the tensions, quoted honestly

- **(Caveat a)** Prohibited: "Accessing the Services through automated or non-human means, whether through a bot, script, or otherwise." Read literally this would ban xAI's own documented `-p` headless mode. The coherent reading — supported by its context among fake-accounts/phishing/scraping items and by finding 1's explicit invitations — is that it targets abusive automated access to consumer surfaces, not the advertised headless CLI. Camino only ever runs the **official CLI**, under David's own auth, at human direction. Recorded as boilerplate-tension, not as a blocker.
- **(Related)** "…circumventing any rate limits or restrictions" is prohibited. Camino is compliant by design: dispatch pauses at 85% estimated window (CAM-ROUTE-06), rate-limit responses classify `quota-blocked` and queue (never retried as failures).
- **(Low residual)** Prohibited: "Using the Service or any Output to develop machine learning models or related AI services that compete with xAI." Camino develops no models and is an orchestration tool that *drives* usage of Grok Build rather than substituting for it. A maximally strict reading of "related AI services" is noted for the record; risk assessed low. Re-price at open-source release (CAM-SEC-09 already requires a provider-policy compliance pass before publication).

## Comparison across Camino's v1 providers (registry context)

xAI is currently the **most** explicitly permissive of the three: it invites third-party orchestration of the subscription CLI in its own announcement and docs. OpenAI publicly blesses Codex subscription use in third-party harnesses. Anthropic remains the internally-tense case (design §9). This inverts the original risk ordering that motivated gating Grok Build hardest.

## Recommended registry attributes (for David's disposition)

- `sanctioned-path`: **confirmed** — sources above, snapshot 2026-07-17.
- `enablement`: **enabled** for personal use on David's subscription.
- Re-check triggers: ToS/AUP effective-date change (current: June 26, 2026); Grok Build beta→GA; any xAI statement on third-party harnesses; Camino open-source release (re-price caveats a/b for distribution).

**Gate effect:** with David's acceptance of this memo, the WP-000 entry-gate item "xAI contractual sanctioned-path confirmation recorded" is satisfiable as **recorded-confirmed** (no BUILD.md amendment needed; Grok Build enters Phase 0 enabled).
