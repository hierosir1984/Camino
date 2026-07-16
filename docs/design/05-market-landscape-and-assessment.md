# Camino — Market Landscape and Honest Assessment (July 2026)

> **2026-07-16: HISTORICAL. Superseded by [08-design-v2.md](08-design-v2.md) §9–10** — round 1 falsified or narrowed several "unclaimed" cells in this doc's scoreboard and corrected the ToS reading and pain-evidence figures; see [07-review-round1-dispositions.md](07-review-round1-dispositions.md) findings 24–37.
>
> Working document v0.1 — 2026-07-15. Based on a deep-research pass (113 agents, 30 sources fetched, 144 claims extracted, 25 adversarially verified: 24 confirmed, 1 refuted) plus journal-recovered claims from the pain-evidence and subscription-policy angles that were fetched with verbatim quotes but not run through the adversarial verification pass — those are marked **[JV]** (journal, verbatim-quoted, unverified). Answers the pre-adversarial-review questions: is there a product like this; what is Factory.ai's Missions; does the intent fit the industry; real gap or skill issue.

## 1. Headline answers

1. **Is there a product like this?** Not end-to-end as specified — but the loop is no longer white space. **Factory.ai's Missions** (research preview since Feb 2026) is the closest shipped product and covers a striking share of the design, including independent validators. GitHub **Agent HQ** covers the multi-vendor board at massive distribution. OpenAI's **Symphony** (open-source, ~26k stars) proves the board-as-control-plane pattern and explicitly vacates the productization slot. No funded incumbent natively executes on users' existing consumer subscriptions, and the one open-source product that did (**Vibe Kanban**, ~27.4k stars) shut down commercially in April 2026 for lack of a business model.
2. **Skill issue?** No. The pains are mainstream, quantified, and in one case academically named in 2026 with an explicit "no tooling exists" finding.
3. **Fit with industry direction?** Uncomfortably good — parts of the thesis have been convergently built by a funded company, which validates the reasoning and contests the ground. The genuinely unclaimed pillars: repo-level continuous canon with a gap register, learning cost-quality routing, BYO-subscription multi-vendor execution (with a serious legal asymmetry), and a fully local-first control plane.
4. **The load-bearing risk is confirmed and specific:** Anthropic restricts and actively enforces against third-party use of consumer-subscription auth, and moved (then paused) headless billing out of subscription pools; OpenAI publicly blesses third-party harness use of Codex subscriptions. Architecture must treat "sanctioned automation path" as per-vendor, time-varying policy data.

## 2. Factory.ai Missions — the closest existing product (verified, high confidence)

**What it is.** A research preview (customer use since mid-Jan 2026, launch post Feb 26, 2026), gated to Factory's Enterprise and Max plans, invoked via `/missions` inside a Droid session. "Describe what you want, approve the scope, and come back to finished work." 14% of missions run >24h; longest reported 16 days; median ~2h consuming ~12x a normal session's tokens.

**Architecture — striking convergence with docs 01–04:**
- **Three roles: orchestrator / workers / validators.** Fresh-context workers with narrowly scoped goals; "the final judgment on correctness is not their call."
- **Validation contract written before feature work** (behavioral assertions authored at planning time — the same author-separation we specified in doc 04).
- **Independent validators that have never seen the code**, including black-box user-testing validators that "launch the application, navigate through flows, check that pages render correctly" — a shipped attack on the done problem. In a 16-day Slack-clone build, validation consumed 37.2% of runtime.
- **Externalized shared state per mission:** validation-contract.md, features.json, services.yaml, AGENTS.md.
- **Cross-vendor static role routing at launch:** Anthropic Opus 4.6 orchestration, Sonnet/Opus implementation, Moonshot Kimi K2.5 research, OpenAI GPT-5.3-Codex validation — cross-family verification is shipped, though as a fixed table.
- **"Agent Readiness Level 4" requirement:** the repo must have a scriptable way to exercise the app — their version of our validatable-repo profile, including the leveling idea (worth adopting as a repo-readiness ladder).
- **Mission Control** observable surface across CLI/Web/Desktop; local execution or cloud containers — but the control plane is cloud SaaS (airgapped only at enterprise tier).

**Where Factory stops (verified):** per-mission artifacts, not a continuously maintained repo-level canon; no canon-vs-code gap register anywhere in their materials; platform-billed (Pro $20 / Plus $100 / Max $200 ladder; Missions requires prepaid "Extra Usage" credits; BYOK is API-keys-only and metered) with **no consumer-subscription path** — verified three independent ways, and an ecosystem of unofficial ToS-risky proxies (CLIProxyAPI etc.) exists precisely because the native feature doesn't. Factory publishes **no validator efficacy data**, concedes the orchestrator "still scopes too broadly sometimes," and openly asks whether parallel execution even helps (supporting our serialize-first posture).

**Lessons to take:** the convergence is evidence the design reasoning is sound; the validation-cost figure (37%+) belongs in our cost-to-green model; the readiness-ladder framing is good UX; their gaps — cross-mission canon, gap register, subscription economics, local-first control plane, learning router, indie/prosumer segment — are exactly Camino's remaining identity.

## 3. The rest of the field (verified)

- **GitHub Agent HQ** (announced Oct 2025, rolled out H1 2026): Anthropic/OpenAI/Google/Cognition/xAI agents "as part of your paid GitHub Copilot subscription," plus a **"mission control"** command center across GitHub/VS Code/mobile/CLI. Covers the board and multi-vendor pillars at massive distribution — GitHub-hosted, GitHub-billed, verification unevidenced, no canon. (Note the naming collision: GitHub owns the literal term "mission control.")
- **OpenAI Symphony** (open-sourced ~Mar 2026; ~26k stars by July): Linear board becomes the control plane; every issue gets a continuously running Codex agent in an isolated workspace on local devboxes; agent-generated dependency-ordered task DAG; agents file their own follow-up issues; self-reported "500% increase in landed PRs" on some internal teams. **Codex-only by design; verification is workflow-prompt proof-of-work** (review packets with video walkthroughs; runs end at "Human Review," not "Done"; OpenAI concedes agents sometimes "completely missed the mark"). OpenAI explicitly declines to productize — "reference implementation"; "rich web UI or multi-tenant control plane" is a verbatim spec non-goal — and multi-vendor forks appeared within days (Claude Code + GitHub Issues fork; hatice on the Claude Agent SDK; oh-my-symphony driving Codex + Claude + Gemini), showcased on OpenAI's own page. **Direct evidence the productized multi-vendor slot is wanted and vacant.** Symphony's SPEC.md is Apache-2.0 and the README encourages re-implementation — a legitimate skeleton to mine.
- **Vibe Kanban** (Bloop): the nearest architectural neighbor — local-first kanban running 10+ CLI agents (Claude Code, Codex, Gemini CLI, Copilot, Amp, Cursor, OpenCode, Droid, CCR, Qwen Code) **on the user's own logins/subscriptions**. ~27.4k stars, 2.9k forks — and **commercial shutdown April 10, 2026**: "the vast majority are free users and we couldn't find a business model that we could get excited about." OSS continues community-maintained. Simultaneously: proof the BYO-subscription pillar is feasible and demanded, and the strongest cautionary datum on monetizing it. The wider local-orchestrator category shows the same pattern **[JV]**: free AGPL tools (Claude Squad, Conductor, Opcode/abandoned), paid tiers "planned," Terragon operating BYO-subscription commercially as of Jan 2026 (current status unclear post-enforcement).
- **Coverage not established** (research didn't produce surviving claims): Devin/Cognition, Cursor background agents, Kiro/Tessl/spec-kit product details beyond the movement analysis below, Qodo, OpenHands, model routers (OpenRouter, NotDiamond, Martian, LiteLLM). Absence here is not absence in the market.

### The seven-pillar scoreboard (verified synthesis, medium confidence on negatives)

| Camino pillar | Status |
|---|---|
| PRD decomposition | Covered (Factory conversational scoping; Symphony agent-generated DAG). One-shot PRD-document-to-board intake specifically: unevidenced anywhere |
| Observable mission board | Widely covered — commodity |
| Multi-vendor BYO-subscription execution | **Natively unclaimed by any funded incumbent**; feasible (Vibe Kanban) but monetization-hostile and legally asymmetric (§5) |
| Independent verification / done-problem | **Contested** — Factory shipped it at preview maturity, efficacy unproven; absent in Symphony; unevidenced at GitHub |
| Living Canon (repo-level, continuous) + gap register | **Unclaimed** — Factory is per-mission; SDD tools are spec-first not spec-living; academically validated as an open problem (§4) |
| Learning cost-quality router | **Unclaimed** — only static role tables shipped (Factory) |
| Local-first control plane | Rare — local *execution* is table stakes; a local control plane is not shipped by any funded player |

## 4. "Skill issue" — no. The evidence **[JV — sourced, verbatim-quoted, not adversarially verified]**

- **Stack Overflow 2025 survey (~49,000 respondents):** the single biggest AI frustration, cited by **66%** of developers, is "AI solutions that are almost right, but not quite"; **46% distrust** AI accuracy vs 33% trust, with experienced developers most skeptical.
- **METR RCT (July 2025):** experienced open-source developers were **19% slower** with early-2025 AI tools while believing they were ~20% faster — and METR attributes part of the slowdown to AI underperforming where quality bars and tacit repository requirements are high.
- **DORA 2025:** ~90% adoption, yet ~30% report little/no trust in AI-generated code; **AI adoption is positively associated with throughput but negatively with delivery stability** ("acceleration can expose weaknesses downstream" — the case for gated merges); and its central finding — "the greatest returns come not from the tools themselves but from the surrounding organizational system" — is nearly a restatement of the control-plane thesis.
- **GitClear (211M changed lines, 2020–2024):** refactoring collapsed from 25% of changed lines (2021) to under 10% (2024); copy/paste up 8.3%→12.3%, exceeding moved/reused code for the first time; short-term churn rising — quantified AI-era code-quality rot.
- **Benchmark evidence for the fake-done problem (May 2026 paper):** all frontier coding models "saturate visible test suites while failing held-out end-to-end tests… once test pass rate becomes the optimization target, it can cease to be a reliable measure of whether the generated system actually satisfies the intended specification."
- **Context rot, academically named (June 2026 paper):** stale references found in AI config files (CLAUDE.md, AGENTS.md, .cursorrules) in **23.0% of a representative 356-repo sample**; the authors formally define "context rot," state **no purpose-built detection/repair tooling exists**, and publish a research roadmap. This is the Living Canon's problem statement, peer-adjacent-reviewed, with an explicit tooling vacuum.

## 5. The subscription-policy picture **[JV — multiple consistent secondary sources with verbatim quotes; the single most decision-relevant unverified cluster]**

- **Anthropic:** Consumer ToS has long prohibited automated/non-human access except via API key or explicit permission. **Feb 2026:** legal language clarified — OAuth tokens from Free/Pro/Max may be used **only in Claude Code and Claude.ai**; use in any other product **including the Agent SDK** violates the ToS. **Jan–Feb 2026 enforcement:** countermeasures against harness spoofing, account bans, and legal requests that made OpenCode remove Claude Pro/Max support. **May 14, 2026:** announced that Agent SDK, headless `claude -p`, Claude Code GitHub Actions, and ACP third-party apps would leave subscription pools June 15 and bill against separate API-rate credits ("the 25x subsidization has been removed" — developer reaction); **paused June 16 before taking effect, deferred not cancelled**; interactive Claude Code explicitly unaffected. Meanwhile Anthropic's own docs still market headless/CI use without subscription warnings — the boundary is ambiguous even in their materials.
- **OpenAI:** the opposite posture — an OpenAI leader **publicly endorsed using Codex subscriptions inside third-party harnesses**, and Symphony itself is OpenAI shipping the pattern.
- **Industry drift:** GitHub reportedly moved toward usage-based AI credits ~June 2026; Factory gates Missions behind prepaid credits. The flat-subscription free-marginal-quota era is visibly closing for *automated* workloads.

**Design consequences (adopted into the record):**
1. **Drive official vendor harnesses only** — Camino spawns the real `claude` CLI and real `codex` CLI; it never re-implements a harness or extracts OAuth tokens. That keeps Camino on the right side of the bright line Anthropic actually drew (tokens used outside Claude Code), leaving mainly the economic risk (headless billing separation) and ambiguity risk.
2. **The capability registry gains a per-provider `sanctioned-path` + `billing-pool` attribute**, treated as time-varying policy data. Today: Codex headless = blessed; Claude headless = permitted-but-repricing-risk; Grok/GLM = verify at onboarding (per training knowledge, Zhipu explicitly markets GLM coding plans for third-party harness use — re-verify).
3. **API-key fallback per vendor, held ready** — so a policy/billing change is a cost-model change in the ledger, never an outage.
4. **The router's cost-to-green calculator gains value as the industry moves to usage pricing** — in a flat-subscription world it was mostly "greedy quality"; in a usage-credit world, cost-quality optimization is a durable differentiator.
5. Budget projections should carry two scenarios for Anthropic: subscription-pooled (today) and API-rate credits (announced-then-paused).

## 6. My honest assessment

**The problem is real and the reasoning has been independently replicated.** Factory converged on validation contracts, author-separated verification, fresh-context workers, externalized state, and repo-readiness levels — the same shapes as docs 01–04, built by a funded team. That is strong evidence the design is right, and equally strong evidence the verification pillar alone is not a moat.

**Camino's defensible identity, post-research:** the *combination* of (a) BYO-subscription multi-vendor execution on a fully local control plane — structurally unavailable to Factory (platform-billed), GitHub (Copilot-billed), and OpenAI (single-vendor); (b) the Living Canon + gap register — unclaimed commercially, academically certified as an open problem with no tooling; (c) the learning cost-to-green router — unclaimed, and appreciating as pricing shifts to usage. Pillars 1, 2, and 7 are chassis, not differentiation; pillar 4 must match Factory's preview quality for personal use but won't win alone.

**The three honest risks:** (1) **Anthropic policy drift** — mitigated by official-harness-only + API fallback, but the subscription-economics advantage should be treated as a launch window, not a permanent moat; (2) **platform absorption** — GitHub/Factory/OpenAI each own a slice and ship weekly; the durable ground is the cross-vendor trust layer they're structurally disinclined to build (no vendor wants its model graded by a rival's); (3) **monetization gravity** — Vibe Kanban proves orchestration glue doesn't monetize; if Camino ever commercializes, the value must sit in the canon/gap/verification layer, and the personal-tool-first framing is exactly right.

**Net:** build it — as the personal primary interface it has standalone ROI regardless of market outcome, the unclaimed pillars are the ones David's own pain points to (canon, gaps, routing economics), and the crowded pillars can be assembled from patterns the market has already validated (and in Symphony's case, published under Apache 2.0 with an explicit invitation to re-implement). Trial Factory Missions as a benchmark UX; mine Symphony's SPEC.md as a skeleton; do not compete on the board.

## 7. Post-research scope decision (David, 2026-07-15)

**Business model is explicitly out of scope for the build.** Camino is built for personal use first, then published as an open-source repository for others to use and contribute to. Any monetization (a basic ~$20/mo subscription, possibly a hosted variant) is a distant, optional future and must not shape the architecture now. Implications adopted: the monetization-gravity risk in §6 is moot for v1; open-sourcing neutralizes the Vibe Kanban precedent (no business model required) and follows the already-normalized Symphony-fork pattern; mild build considerations only — pick a permissive license, keep secrets out of the repo, and keep the daemon/GUI seam clean so a hosted variant remains *possible* without being designed for.

## 8. Open items carried forward

- Verify the §5 policy cluster against primary sources before any architectural commitment hardens (it is currently consistent secondary reporting with verbatim quotes).
- Unassessed competitors: Devin, Cursor background agents, Kiro/Tessl/spec-kit product depth, Qodo, OpenHands, the router products — a targeted follow-up scan before the PRD, or accept the risk.
- Factory validator efficacy: no published data; if a Missions trial happens, measure it against our four-mode done-problem taxonomy (doc 04).
- Naming: GitHub owns "mission control" as a term; consider whether Camino keeps "mission" as its user-facing noun.
