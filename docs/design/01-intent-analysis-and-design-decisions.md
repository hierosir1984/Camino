# Camino — Intent Analysis and the Decisions That Shape the PRD

> Working document v0.1 — 2026-07-15. Responds to [00-context-brief.md](00-context-brief.md). This precedes any PRD. Nothing here is locked: each decision carries a recommendation and, where meaningful, what evidence would flip it. The brief already hedges most of its own positions; this document converts those hedges into named decisions.
>
> **2026-07-16: HISTORICAL. Superseded by [08-design-v2.md](08-design-v2.md)**, which consolidates the corrected design after adversarial review round 1.
>
> **Status update, later 2026-07-15: partially superseded by [02-revised-product-definition.md](02-revised-product-definition.md)** after David's course correction. In particular, the gate-first wedge (Decision 2) and the exception-queue home surface (Decision 8) are revised there: Camino is a mission-control developer tool with an observable GUI, executing PRDs end-to-end on subscription agents. The trust machinery (Decisions 4–7, 9–10) carries forward in service of that product.

---

## 1. What you are actually proposing to build

Strip the brief to its skeleton and it contains **two distinct products tangled together**:

1. **A factory** — turns an approved spec into scheduled, executed, merged work: planning, decomposition, scheduling, model routing, workspace management, repository operations. Its value is throughput.
2. **A proof system** — decides whether work is demonstrably done: validation contracts, independent verification, evidence packets, gate decisions, audit history. Its value is trust.

Your own thesis says the factory commoditizes ("the ability to call coding models is likely to become increasingly commoditized") while the proof system is the durable value. Yet the brief's architecture spends most of its surface area on the factory — graphs, routing, scheduling, orchestration state. That mismatch is the single most consequential observation in this analysis.

The differentiated product is the **contract compiler at the front** (intent becomes a testable contract) and the **gate at the back** (evidence becomes a merge decision). The middle — agents doing the work — is the most replaceable part, and it is exactly the part GitHub, OpenAI, Anthropic, Cursor, and Devin are all racing to commoditize. Architecture shorthand: **own the two ends, rent the middle.**

Two more framing observations:

**The scarce resource shifts from code production to your judgment.** Once agents produce work faster than you can evaluate it, the system's real constraint is the cost and quality of your judgment moments: reviewing a plan, approving a contract, trusting a merge. The product succeeds or fails on how cheap and well-founded those moments are — which makes the review surfaces core product, not UI polish to figure out later.

**For a solo operator, the payoff is asynchrony more than parallelism.** Work happening overnight, unattended, at trustworthy quality is the life upgrade. Ten agents in parallel matter far less than not having to babysit one. This should re-rank several architectural priorities: durable resumption and trustworthy gates come before concurrent slice scheduling.

In one sentence, the intent is: **a trust machine that converts "an agent says it's done" into "the system can show it's done," wrapped around whatever agents happen to be best this quarter.**

## 2. Contradictions and ambiguities in the brief

### 2.1 "Minimal supervision" collides with the approval list

You want minimal supervision, but the loop as sketched asks you to review plans, approve contracts, judge escalations, and approve merges. Concretely: a 12-slice mission with 10 minutes of contract review, 10 of evidence review, and 5 of merge decision per slice is about five hours of your attention — plausibly more than pairing with Claude Code interactively on the same feature. Autonomy that generates more review work than it saves is negative-value. Resolution: treat **your attention as a budgeted resource with an explicit target** (decision 8), design every review artifact to fit the budget, and let autonomy expand as the gate earns trust (graduated autonomy, also decision 8).

A sub-problem hiding here: you want to intervene "when requirements are genuinely ambiguous" — which requires the system to *know when it doesn't know*. Calibrated escalation is one of the hardest capabilities in the design, not a footnote. If the system never asks, it guesses silently; if it always asks, it is a nag. Escalation quality needs to be designed and measured like gate quality.

### 2.2 Immutable contracts collide with iterative discovery

Frozen, hash-addressed contracts are the right instinct — a worker must not grade its own homework. But real implementation constantly discovers that the spec was wrong: a requirement is contradictory, a threshold unachievable, an edge case was mis-imagined. If every discovery requires human contract review, you are back to contradiction 2.1. If workers can propose changes that get rubber-stamped, immutability is theater. The contract needs a **designed renegotiation protocol with tiers**: clarifications that don't change acceptance criteria are recorded automatically; scope-neutral substitutions (a test is impossible as written, an equivalent one replaces it) are approved by a reviewer model and batched for your awareness; anything that weakens or drops an outcome goes to you. Immutability without cheap renegotiation produces either constant escalation or quiet lying.

### 2.3 "Proof" language collides with what evidence can deliver

The brief says proof, proven, demonstrated. Passing tests, screenshots, and traces are *evidence*; an LLM semantic review is *opinion*. None of it is proof. The danger is building an expensive evidence pipeline that produces convincing-looking packets and unearned confidence — worse than knowing you are unsure. The honest reframe: **the system cannot promise truth; it can promise a measured error rate.** The gate's real specification is its false-approve rate (bad work merged) and false-reject rate (good work bounced), measured against outcomes like reverts and hotfixes. Evidence exists for two purposes: to feed the gate decision, and to make your audits cheap. Both are measurable. "Proof" is not.

### 2.4 The slice dependency graph may be imagined elegance

The brief warns against designing around imagined elegance, then centers a decomposition-into-parallel-slices model that is the classic example of it. Observed failure modes of parallel agent slices are merge conflicts, interface drift between slices, and integration surprises at the end — while current frontier agents keep getting better at long, sequential, single-context runs. The real near-term value of decomposition is not parallelism; it is **reviewability and risk isolation** — each slice is one contract, one PR, one revertable unit sized to your attention budget. That changes what the planner optimizes for. Parallelism should be an optimization earned by evidence later, not a founding abstraction.

### 2.5 Independent validation in a fresh environment assumes reproducible environments

Deterministic revalidation "in a fresh environment" quietly assumes the repo can be built, seeded, and tested from scratch by a machine. For arbitrary repositories, environment bootstrapping is the hard, boring 80% and a known tarpit. For *your* repositories it is tractable, because you control them. So make it a stated precondition: a repo must meet a **"validatable repo" profile** (containerized dev environment, one-command test suite, seedable data) before Camino will operate on it. Making a repo conform is itself work the system can help with — but universal environment inference should be explicitly out of scope.

### 2.6 Subscription authentication collides with the commercial ambition

Running Claude Code and Codex headlessly under your personal subscriptions is fine for a personal tool and roughly free at the margin. It cannot be resold, multi-tenanted, or contractually relied on for a commercial control plane. Happily, the architecture that serves the personal constraint — thin control plane, execution on a machine you own where the CLIs are logged in — is the *same* architecture enterprises want (bring-your-own-compute, credentials never leave the customer). The shape that differs is the hosted SaaS middle. Resolution: abstract the worker as "a harness invoked in the execution plane with its own auth," build the two ends now, and accept that subscriptions are a personal-scale bridge, not a foundation.

### 2.7 Mission-scale focus collides with how trust is actually built

The brief centers big missions (PRD in, many slices out), while you plan to keep doing targeted changes interactively. Risk: a cathedral used once a month, where each use is high-stakes and the system never accumulates enough runs to calibrate the gate or earn trust. The trust flywheel spins on **frequent, medium-sized, well-specified tasks** — the boring middle of development. Worth an explicit decision: which grain does v1 earn trust on? (My recommendation in decision 2: start where frequency is highest, let mission-scale planning come second.)

### 2.8 Vocabulary drift will corrupt every document after this one

Mission, specification, contract, plan, slice, ticket, and attempt are used with overlapping meanings in the brief. Before a PRD exists, fix the ontology — the set of nouns and their relationships (decision 3). Otherwise every later document inherits the ambiguity.

### 2.9 Linear's role — you already answered it, so commit

The brief suspects Linear cannot be the authoritative store. Correct — commit to it: the control plane owns state; Linear is at most a read-only mirror for visibility, and probably absent from v1 entirely. The trap to avoid is *approval via Linear* (dragging a ticket to approve a contract), which creates two-way sync and dual-write bugs for zero v1 value.

## 3. What the brief does not cover and should

- **Economics.** No mention of cost accounting. Every attempt should record tokens, dollars, wall-clock time, and *your* minutes consumed, or you can never answer "is this cheaper than doing it myself interactively?" — the personal ROI question, and later the pricing basis. Subscription quota is also a finite scheduling resource: the scheduler must treat "Claude capacity remaining this window" like it treats CI runners.
- **You and the agents share the repository.** You will keep committing to the same repos mid-mission, including directly editing agent branches. That must be a supported, recorded event — not corruption. This also reframes the brief's reproducibility worry: reproducibility means an auditable, replayable history of what happened, not a human-free history.
- **A failure-mode catalog.** The brief's principle 7 says design around observed failure modes, but none are listed because none have been observed yet. The experiments in section 6 exist to generate this catalog *before* the architecture locks.
- **Partial mission completion.** When some slices permanently fail, the mission should complete with an explicit residue: the descoped contracts, stated as unmet outcomes, which become input to a new spec. This is a representation question to settle in the ontology, not an edge case.
- **Where repo-specific knowledge accumulates.** "Repository-specific operational knowledge" is listed as differentiation with no mechanism. Cheap v1: a per-repo knowledge file the system reads before every attempt and appends to after failures (build quirks, flaky tests, forbidden areas). Structured memory can come later.
- **Rollback as a first-class state.** A merged slice that later proves bad needs a deterministic revert path inside the mission, not just the deploy-stage rollback the brief mentions.

## 4. The design decisions to resolve before a PRD

### Product shape

**Decision 1 — v1 boundary: personal control plane with product-shaped seams.**
Build for exactly one user (you), which deletes tenancy, auth, roles, and hosted-infrastructure work and legitimizes subscription CLIs. But hold three interfaces to product quality from day one, because they are what would survive into a product: the **contract schema**, the **evidence packet format**, and the **event log**. Code around them is disposable. Flip condition: a concrete external user with money changes this; curiosity does not.

**Decision 2 — the wedge and build order: gate first, compiler second, rent the middle.**
Build the verification gate first: given a contract and a PR (from any source — Symphony, Claude Code headless, Codex cloud, or you), run independent validation, assemble the evidence packet, issue a verdict. Then the contract compiler (spec in, contracts and surfaced assumptions out), because hand-writing contracts gets old fast. Own orchestration last, and minimally — existing runners already execute issues. Rationale: the gate is the thesis's heart, it is testable retroactively against your own PR history (experiment 1), it composes with everything including your interactive work, and a planner without a trustworthy gate just produces unverified work faster. Flip condition: if experiment 1 shows the gate cannot beat your own review, the thesis itself needs rework — better to learn that in week one than month six.

**Decision 3 — fix the vocabulary and the unit of work.**
Proposed nouns: **Spec** (versioned human intent) → **Plan** (proposed decomposition, editable) → **Contract** (per-slice acceptance criteria, frozen at approval) → **Attempt** (one worker run against a contract) → **Evidence** (artifacts bound to attempt and commit) → **Verdict** (gate decision); **Mission** is the container. One authoritative store holds all of these; GitHub and Linear are projections. Unit of work: **one slice = one contract = one PR**, sized for reviewability, sequential in v1 (which defers all stacked-PR and merge-ordering questions). When main moves under an open slice: deterministic rebase, full gate re-run, and conflicts become a repair attempt.

### Trust core

**Decision 4 — contract authority and change control.**
Contracts freeze at approval, are hash-referenced by every attempt and PR, and live outside the worker's writable workspace (worker gets a read-only copy). Acceptance tests are authored **at contract time by the planner/reviewer side, not at implementation time by the worker** — this is the main structural defense against tests that merely encode whatever the code does. Workers may add tests and propose contract changes through the tiered renegotiation protocol (section 2.2) but can never weaken criteria in place. Keep a **held-out subset of acceptance checks** the worker doesn't see during implementation, revealed on failure (hidden entirely forever makes debugging hell; hidden until failure preserves the honesty incentive at low cost).

**Decision 5 — the verification stack, by risk tier.**
Three layers, applied by declared risk level: deterministic revalidation in a clean environment (always); cross-family semantic review — the reviewer model from a different provider than the implementer (medium risk and above, because double-inference on everything is expensive); behavioral evidence via browser automation (any user-facing change). Weak-test detection gets a deterministic tool: **mutation testing** — deliberately break the code and check the tests notice. Gate quality (false approves, false rejects, measured against later reverts and hotfixes) is instrumented from the first run; every evidence packet plus its eventual outcome becomes labeled calibration data.

### Operations

**Decision 6 — execution isolation and the credential invariant.**
The invariant, worth writing on the wall: **models propose, the control plane disposes — nothing with credentials is creative, nothing creative has credentials.** Workers run in containers with git worktrees (a second checkout of the same repo so parallel work doesn't collide), scoped short-lived tokens that can push only to their own branch, no access to the contract store or gate configuration, an outbound-network allowlist (the worker machine may only talk to approved hosts — package registries, docs), and per-attempt budget caps on tokens and wall-clock with automatic kill-and-escalate. Untrusted text (issue bodies, web pages, even repo content) is data, never instructions. Severity to be tested by experiment 4.

**Decision 7 — state and durability: one append-only log, boring technology first.**
One authoritative store owned by the control plane, structured as an append-only event log (history is only ever added to, never edited) with derived current-state views — this buys audit, replay, and intervention-recording in one move. The *requirement* — resume after crashes, rate limits, restarts, week-long pauses — is non-negotiable; the *technology* is not. Postgres plus a simple worker loop carries v1; a workflow engine like Temporal (a job scheduler that guarantees long multi-step jobs resume exactly where they left off) earns its complexity only if the full-orchestration path is chosen after the experiments. Defer that choice; it is not blocking.

**Decision 8 — the human interface is an attention budget, not a dashboard.**
Set explicit targets — for example, ten minutes of your time per merged slice and forty-five per mission plan — and design every review artifact backward from them. The operator's home surface is an **exception queue** (things needing judgment, each with a purpose-built artifact: contract diff, evidence summary, escalation question), not a mission graph; graphs and event streams are diagnostics. Every gate outcome is three-way: pass, fail, or **escalate-with-a-question**, and question quality is tracked (did you say "good catch" or "obviously fine, why did you ask?"). Autonomy is **earned, not configured**: auto-merge for a risk tier in a repo unlocks only after the gate demonstrates a low false-approve rate over a trailing window of human-verified decisions, and it revokes itself on regression.

**Decision 9 — routing v1: a static table plus an escalation rule.**
A hand-written table maps role (planner, challenger, implementer, verifier, summarizer) and repo area to model and harness — no learned routing. Two dynamic behaviors only: failure escalation (two failed attempts in one family triggers a switch to the other family, carrying a structured summary of what failed rather than raw transcripts; four triggers human escalation) and capacity awareness (subscription quota windows and provider outages are scheduling inputs; attempts queue rather than fail). The cross-family challenger/verifier requirement means both harnesses are wired from day one — which you have, and which single-vendor competitors structurally won't do.

### Evaluation

**Decision 10 — the benchmark and the north star, chosen before building.**
Build the calibration set from your own history: 20–30 past PRs across your repos — clean ones, ones that later needed fixes, plus deliberately sabotaged variants (subtle bug injected, test weakened, requirement quietly narrowed). Retro-write contracts for them and measure whether the gate separates good from bad. Candidate north star: **durable autonomous merges per week** — slices merged without human code review that survive 30 days with no revert or hotfix — with guardrail metrics of gate false-approve rate, your minutes per merged slice, and cost per merged slice. Success for v1 is a numeric claim like: "the gate catches ≥90% of seeded defects at ≤10% false rejection, and a merged slice costs ≤10 minutes of David."

### Non-goals for v1 (proposed)

Deployment and post-deploy validation; hosted multi-tenant anything; learned routing; cross-repo missions; parallel slice execution; Linear write-back; universal environment inference (the validatable-repo profile replaces it); production use on repos with active external users.

## 5. Three materially different shapes to keep on the table

**Shape A — the full control plane** (the brief's default): missions, graphs, scheduler, router, runners, gate, all owned. Complete end state, but it front-loads the commodity middle and builds heavily before any failure mode has been observed.

**Shape B — bookends: compiler + gate wrapped around rented execution.** Camino owns spec-to-contract and evidence-to-verdict; Symphony, Claude Code headless, and Codex cloud execute; GitHub's own branch protection, checks API, and merge queue enforce. The control plane shrinks to a state machine, a policy engine, and integrations. Differentiated, composable (it even gates your interactive work), and buildable by one person.

**Shape C — the in-harness prototype: no service at all.** Everything runs inside Claude Code itself — skills, subagents, hooks, with contracts and state as files in the repo. Not durable, not the product, but assemblable in days and the cheapest possible vehicle for generating the failure catalog.

Recommendation: **C is the experiment vehicle (this quarter), B is the v1 product shape, A is the north star** — earned only if B's gate proves trustworthy and throughput becomes the binding constraint.

## 6. The smallest experiments that reduce the most uncertainty

**Experiment 1 — gate calibration replay.** (Tests the thesis itself.) Take the decision-10 benchmark set; run the verification stack; measure false approves and false rejects; run mutation testing on agent-written tests to quantify the weak-test problem. No orchestration required. If the gate can't beat your own review on historical data, stop and rethink before building anything.

**Experiment 2 — contract compiler probe.** (Tests planning representation and your attention budget.) Take one real PRD you have; have Claude compile it into contracts, with every assumption it was forced to invent surfaced as an explicit question — that list *is* the spec-readiness detector, mechanized. Time your own review of the output. This measures whether contract review fits the decision-8 budget and whether the escalation questions are good.

**Experiment 3 — wizard-of-Oz end-to-end.** (Generates the failure catalog.) One small real feature in one repo: scripts and manual button-clicks play the control plane, Codex implements, Claude verifies cross-family, an evidence packet is produced, you merge by hand. Every failure gets written down. The architecture is then designed against that list, honoring the brief's principle 7.

**Experiment 4 — injection red-team.** (Prices the security posture.) Plant hostile instructions in an issue body, a code comment, and a README in a sandbox repo; observe what each harness does under each isolation setting. The result determines how much of decision 6 is mandatory on day one versus hardening later.

Experiments 1 and 2 can start immediately and independently; 3 follows 2; 4 is parallel to everything.

## 7. Suggested sequence from here

1. **You take positions on decisions 1–3** (boundary, wedge, vocabulary) — they gate everything else. The remaining decisions can be provisionally adopted as written and revisited.
2. **Adversarial review of this document** by Codex once your positions are in (or before, if you prefer the framing itself attacked) — the /adversarial-review path you already planned.
3. **Start experiment 1** — needs only the choice of which repo's history to replay.
4. **Draft the PRD** for the chosen shape (likely B), explicitly marking which assumptions each experiment is due to confirm or kill.
5. Optional input to decision 1: a competitive scan (GitHub Agent HQ / Copilot coding agent, Devin, Cursor background agents, OpenAI Codex cloud, Temporal-based OSS orchestrators) to verify the "gate and contracts are the gap" claim against the mid-2026 landscape.

---

## Appendix — coverage map of the brief's open questions

| Brief section | Where addressed |
|---|---|
| Product boundary (user, unit, autonomy defaults, approvals) | §1, D1, D2, D3, D8 |
| Planning (PRD conversion, plan quality, planner-generated tests, readiness detection) | D3, D4, E2; plan quality via cross-family challenger + your review, later correlated with slice failure rates (D10) |
| Validation (formal outcomes, hidden tests, weak tests, visual proof, evidence by risk) | D4, D5, E1 |
| Execution (isolation, overlap, attachment through repairs, reassignment, context transfer) | D6, D9; overlap deferred by sequential v1 (D3) |
| Routing (roles, cost/latency, subscriptions vs APIs, history, outages) | D9, §2.6; historical-performance routing deferred (non-goal) |
| Source control (PR per slice, stacking, merge order, conflicts, partial completion) | D3; partial completion residue §3 |
| State & durability (system of record, Linear, engine, audit, recovery) | D7, §2.9 |
| Security (credentials, permissions, untrusted content, injection, egress) | D6, E4 |
| UX (operator surface, interventions vs reproducibility, explainability) | D8, §3 (interventions as recorded events) |
| Evaluation (benchmark, replay, success definition, false approvals, north star) | D10, E1 |
