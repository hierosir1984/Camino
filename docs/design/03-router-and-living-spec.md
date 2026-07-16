# Camino — The Model Router, the Living Spec, and Mission Types

> **2026-07-16: HISTORICAL. Superseded by [08-design-v2.md](08-design-v2.md)** — notably, round 1 falsified this doc's "repo holds current truth" framing (canon is intent + status now) and demoted the learning router's autonomous stage.
>
> Working document v0.1 — 2026-07-15. Extends [02-revised-product-definition.md](02-revised-product-definition.md) with David's third round of direction. Two new core subsystems are designed here; several open decisions are closed.

## 1. Decisions closed this round

- **Single-issue tickets: confirmed.** A mission is 1..N issues; a one-issue mission is a ticket and rides the same pipeline with no extra ceremony.
- **Brownfield and greenfield both in scope.** Confirmed interpretation: an ongoing stream of PRDs against living repos. Scenarios explicitly named: greenfield build from a selected project folder (PRD plus context in, serial autonomous build to spec); feature additions on existing repos; refactors as PRDs; UI/UX rewrites; migrations (e.g., one auth platform to another, one database host to another).
- **Local-first: confirmed.**
- **Verification reframed at the right altitude.** David's verification emphasis in the founding brief stems from *agent-harness best practice* — agents that check their work, repos maintained so agents perform well — not from wanting a proof bureaucracy. Design consequence: the contract/evidence machinery is plumbing that surfaces mostly when things fail, and repo maintenance is promoted to a first-class subsystem (section 4).
- **Model routing promoted from "static table, defer learning" to a designed subsystem** with a staged path to a learning router (section 3). Provider set to plan for: Anthropic and Codex today, expanding to xAI's coding harness ("Grok Build") and the GLM model range; blended usage desired.

## 2. Mission types and templates

The scenarios David listed have materially different plan shapes and validation profiles. Rather than one generic planner, missions carry a **type**, and each type is a template: planning prompts, default validation profile, default risk posture.

| Type | Plan shape | Validation emphasis |
|---|---|---|
| Greenfield build | Bootstrap stage first (scaffold, CI, validatable-repo profile, canon creation — section 4), then serial feature issues | Standard + growing e2e suite |
| Feature (brownfield) | Canon-diff at intake, integration-aware slicing | Standard + mission-level integration checks |
| Refactor | Outcomes are invariants ("behavior unchanged") | Characterization tests — tests that pin down current behavior before internals move — plus regression and perf comparison |
| Migration | Staged with compatibility windows, cutover and rollback plan | Migration tests, dual-running checks, data integrity |
| UI/UX rewrite | Screen/flow-sliced | Browser-evidence-heavy (Playwright flows, screenshots, accessibility snapshots) |
| Quick task | Single issue, no decomposition | Scaled to declared risk |

Templates are the cheap, high-leverage way to encode "how this kind of work is done well" — and they are where repo-specific and type-specific lessons accumulate.

## 3. The Model Router

### 3.1 What is being decided

At dispatch time, for each unit of work: **(harness, model, reasoning tier, context budget)**, chosen per role (planner, challenger, implementer, verifier, summarizer) given task features (mission type, size, language/framework, repo area, risk, prior attempt history). Reasoning tier is a first-class dimension — "frontier at max reasoning to break down PRDs, mid-tier to implement" is exactly the kind of policy the user writes.

### 3.2 Architecture: four layers

**Layer 1 — Capability registry.** What this user has connected: subscriptions (Claude, ChatGPT/Codex, xAI, GLM, …) and optionally API keys, each with cost model, quota windows, context limits, latency, and harness features. Adapters make providers plug-in; whatever a given vendor's current coding harness looks like, it slots in behind the same interface.

**Layer 2 — Policy (explicit, user-visible, per project).** The dial David asked for: a per-project table mapping role and task features to model preferences and constraints — minimum reasoning tier for planning, budget caps, and **per-project provider allowlists** (some codebases — e.g., client work — may not be permitted to route to certain providers at all; this is a policy row, not an afterthought). Camino ships opinionated defaults; the user can override everything. Crucially, this table is also **the substrate the learning router writes into later**: learned routing arrives as *proposed policy edits with evidence attached*, not as opaque per-call decisions. The router stays observable, inspectable, and overrideable — the same design invariant as the rest of the control plane.

**Layer 3 — Outcome ledger.** Every attempt already records model, harness, reasoning tier, task features, gate verdict, repair count, human interventions, post-merge survival, tokens, dollars, quota consumed, and wall-clock. This is the router's training data, and it starts accumulating from the first mission at essentially zero cost. The ledger must record task features, not just outcomes, because of a known statistical trap: hard tasks get sent to frontier models, so naive averages will "show" frontier models failing more. Comparisons need difficulty controls.

**Layer 4 — Optimizer (staged).** See 3.4.

### 3.3 The calculator: optimize cost-to-green, not sticker price

David's intuition — the cheapest implementation model can be a false economy because bugs cost repair loops — is formalized as the router's objective:

**cost-to-green(assignment)** = implementation cost + all repair-loop costs + verification costs across attempts + escalated human minutes (priced at the user's valuation), for an issue that ends accepted and survives 30 days. The router estimates *expected total issue cost given the first assignment*, including the probability that a cheap first attempt fails and the work is redone by a better model. Choosing a slightly stronger implementer wins whenever its higher per-call price is smaller than the repair-loop and redo costs it avoids. A quality floor sits alongside: no assignment may push the projected gate-failure rate past a threshold, regardless of cost.

**Subscription economics invert the usual routing logic.** API routing minimizes dollars per call. Subscriptions are prepaid capacity that resets in windows — so the real cost of a subscription call is its **quota opportunity cost**: what else wanted that capacity before the window resets. When quota is abundant, frontier calls are effectively free and the optimal policy is simply "best model everywhere." Cost optimization only starts to bite under quota pressure, at higher volumes, or when API/cheap-provider overflow enters the mix. Practical consequence: v1 routing can be honest and simple — **quota-aware greedy quality** — while the ledger quietly accumulates the data that makes the calculator meaningful as volume and providers grow.

### 3.4 The staged path to a learning router

- **Stage 1 — Report (v1).** Explicit policy table plus the ledger, and the calculator as descriptive analytics: cost, repair rate, and survival by model, task type, language, and repo. The user reads the report and edits the policy.
- **Stage 2 — Advisor.** The router proposes policy diffs with evidence ("on TypeScript frontend issues in this repo, model A averaged 1.1 repair loops at $X; model B 2.7 at $Y — recommend switching the implementer row"). Human approves the edit.
- **Stage 3 — Bounded actor.** The router applies its own proposals within bounds, on low-risk tiers first — **earning autonomy exactly the way the merge gate does**: demonstrated performance over a trailing window unlocks it; regression revokes it. One autonomy mechanic, reused across subsystems.

The machinery underneath is a contextual bandit — in plain terms, per-cell scorecards (task type × language × repo × model) that are updated with each outcome and consulted with a controlled taste for experimentation. Two honest hard parts, neither of which is the algorithm: the **reward definition** (cost-to-green, defined above) and **thin data** at a single developer's volume. Thin data is handled three ways: scorecards start from priors seeded by public benchmark data and shrink toward global averages until a repo has enough history of its own ("borrow strength until you have your own evidence"); **exploration is budgeted and risk-gated** — the non-favored model gets tried only on low-risk issues, which is the "testing new hypotheses" behavior David described, made safe; and failure-triggered family switches (already designed) generate natural comparative data for free. This is also why per-repo, per-language performance differences — the ones nobody needs to consciously know about — get captured: they show up as diverging scorecards, and surface only as routing proposals.

## 4. The Living Spec (working name: the canon)

### 4.1 The problem, and the principle

David's observed failure mode: a well-scoped initial vision, then feature after feature appends documents until the docs folder accumulates contradictions — and agent performance degrades, because agents read stale intent as current truth. This is context rot, and it compounds.

The fix borrows from accounting: **separate the ledger from the balance sheet.** PRDs and missions are *transactions* — historical, immutable, and they live in the control plane's record, not strewn through the repo. The repo carries the *current state*: what the product is and intends to be **now**. The division of truth:

> **The repo holds current truth. The control plane holds history and process.**

### 4.2 What the canon is

A single **vision document at the root** — product intent, users, invariants (the "what must not change" list from the founding brief lives here), current scope in and out, architecture principles, glossary — with a small structured layer beneath it: per-feature current-state specs, an architecture note, and the agent-facing instruction files (AGENTS.md / CLAUDE.md, validation commands). One entry point, indexed, explicitly marked authoritative. One file can't hold a product without becoming the next mess; one *root* with a curated tree can. The canon is versioned with the code and reviewed like code.

### 4.3 How it stays alive — four moments

1. **At PRD intake:** the new PRD is diffed against the canon. "This PRD says X; the canon says the product currently does Y — is this a deliberate change of scope?" Contradiction detection lands inside the existing inline-clarifying-questions flow, so scope confirmation happens exactly where David already answers questions, and stays minimal.
2. **At mission completion (the fold):** a docs-maintenance step folds the delivered mission into the canon — updates the vision and feature specs, supersedes contradicted statements, refreshes agent instructions if conventions changed. Superseded documents are deleted from the working tree (history survives in git and the control plane); stale files lying around are precisely the disease. The fold is itself a PR — cheap to review, human-approved early on, another candidate for earned autonomy.
3. **Periodic audit:** every N missions, a self-consistency pass over the canon (do the architecture note and feature specs disagree; do agent instructions contradict each other), with proposed resolutions escalated in tiers like contract renegotiation.
4. **At adoption (brownfield induction):** when Camino adopts an existing repo, it inventories the existing docs, reads the code, builds the initial canon, flags the contradictions it finds *on day one*, and sets up the validatable-repo profile and harness files. Greenfield is the degenerate case: the canon is born from the first PRD.

**One guard, subtle but load-bearing:** canon updates derive from the mission's *approved intent* (PRD and accepted contracts), never from the implementation diff. Otherwise the canon slowly drifts into describing whatever got built, laundering shortfalls into spec. Built-versus-intended discrepancies get flagged, not folded.

### 4.4 Harness best practice as input and output

Camino ships with opinionated harness practice (how context packs are assembled per issue: relevant canon excerpts, the issue's acceptance criteria, repo conventions — agents are *fed* curated context, not left to wander the docs folder), and it leaves behind an agent-optimal repo (current canon, clean instructions, one-command validation). **Every mission leaves the repo easier for the next mission.** This is also quietly differentiating: brownfield induction alone — "point Camino at a messy repo, get an agent-ready repo with a coherent living spec" — is valuable before a single mission runs.

## 5. Adjustments to v1 and the experiments

- The outcome ledger records everything from the first dispatch (near-zero cost; enables Stage 1 routing immediately). Router in v1 is registry + policy table + report — no learner.
- Brownfield induction slots naturally before or alongside the PRD-to-plan probe (experiment 2), since the planner wants canon-grade context anyway. Experiment order otherwise unchanged: dispatch spike first.
- Mission templates start as two (feature, quick task); refactor, migration, UI-rewrite, and greenfield-bootstrap templates follow once the skeleton walks.

## 6. New open questions

- ~~Naming: "canon" vs "living spec" vs "vision" for the user-facing artifact.~~ **Resolved: the Living Canon** (see [04-gap-reconciliation-and-done-problem.md](04-gap-reconciliation-and-done-problem.md)).
- Fold cadence: per merged mission (proposed) vs per merged PR (chattier) — and when fold-PRs earn auto-merge.
- Exploration appetite: what fraction of low-risk issues the router may use for trials once Stage 3 arrives.
- Benchmark priors: how much curation of public per-language/per-task model benchmarks to invest in for scorecard seeding, versus letting the user's own ledger speak.
- Provider allowlist defaults for new projects (permissive vs conservative).
