# Camino — Revised Product Definition (after course correction)

> **2026-07-16: HISTORICAL. Superseded by [08-design-v2.md](08-design-v2.md)** after adversarial review round 1 (findings in [06](06-adversarial-review-round1.md)/[07](07-review-round1-dispositions.md)).
>
> Working document v0.1 — 2026-07-15. Supersedes parts of [01-intent-analysis-and-design-decisions.md](01-intent-analysis-and-design-decisions.md); what carries forward and what changes is mapped in section 4. Written from David's correction, treated as the authoritative product statement.

## 1. The correction, in David's words

> "What I'd like to do is, essentially from a blank slate, produce a developer's tool that allows for effectively hands-free missions similar to Fewer's mission feature. It should utilise existing subscriptions from Claude and from Codex and other agents. It should have an observable control plane so that we can see the issues or tickets that are being constructed. The granularity of those issues and such is entirely up for debate.
>
> What I'm looking to do is create a system where you can effectively feed it through some very easy-to-use GUI and have it execute the PRD end-to-end. It can then continually add new PRDs for additional features or modifications that it can then construct. We're really creating a developer tool here that I will then use not just for project Fewer but for other development processes and projects that I've got underway.
>
> Of course, we can begin with a tool that only works on a single repository and project, but going forward, the goal is to have it be effectively my primary interface (as opposed to what is effectively, at the moment, a combination of linear and symphony and then routing those tasks to Codex agents, etc., etc.)."

Two clarifications recorded:

- **Note on provenance:** the Claude session that produced doc 01 had no context from Fewer or any other project — only the Camino brief. The gate-first emphasis was an amplification of the brief's "demonstrated behaviour" language, not imported history. Either way, this document reasons from the correction alone.
- **Interpretation adopted for "continually add new PRDs":** the tool supports an ongoing stream of PRDs against a living, evolving repository — brownfield missions running on the accumulated result of prior missions — not a one-shot greenfield scaffolder. (If the intent was stronger — the system *proposing* its own follow-on PRDs — that is a distinct capability to discuss separately.) This reading has a real design consequence: knowledge about the repo must accumulate across missions.

## 2. What Camino is, restated from a blank slate

**Camino is mission control for autonomous development: a developer tool where a PRD goes in through a simple GUI and merged software comes out, with every step observable along the way.**

The loop as the user experiences it:

1. **Feed it a PRD** through an easy GUI — paste or write; the planner asks its clarifying questions inline at submission, then gets to work.
2. **Watch the plan get constructed** — issues/tickets appear on the board as the planner creates them, with dependencies, acceptance criteria, and sizing visible. The user can edit, reorder, or reject before (and during) execution.
3. **Agents execute hands-free** — Claude Code, Codex, and other harnesses run under existing subscriptions, on hardware the user controls, each issue in an isolated workspace, each producing a PR.
4. **Work flows through validation to merge** — independent checks, review, and merge policy run as pipeline stages; the user watches rather than drives, and is interrupted only by genuine escalations.
5. **Keep feeding it** — new PRDs for new features and modifications queue as missions against the same living repo; the portfolio view spans multiple projects.
6. **It becomes the primary interface** — replacing the current combination of Linear for backlog, Symphony for issue-to-agent dispatch, and manual routing to Codex/Claude.

The product is the control room. Verification is not the product — it is the control room's most safety-critical component, because "hands-free" is only honest if merges can happen well without a human. Doc 01 had that inverted: it proposed the gate as the wedge and the factory as rented commodity. The correction stands that back up: Camino owns the whole visible loop — interface, planning, dispatch, state — and rents the *agent capability* (models via subscriptions) plus commodity infrastructure (GitHub's checks, branch protection, merge machinery).

## 3. One architectural commitment this implies: local-first, bring-your-own-agents

Subscription authentication is not a compromise to route around; it defines the architecture. Claude Code and Codex CLIs run under personal subscriptions on machines where they are logged in. Therefore:

- The **control plane and GUI run on the user's own hardware** (a local daemon serving a web UI, in the simplest form), and workers spawn locally as CLI processes in isolated workspaces.
- Nothing is resold and no provider terms are strained: each user brings their own subscriptions, repos, and machine.
- This is also the shape that scales into a product later. A local-first developer tool with BYO-agents (the pattern users already accept from tools like Cursor, but with subscriptions instead of API keys, so execution must stay client-side) avoids the multi-tenant hosting problem entirely. The commercial version is "everyone runs their own Camino," not "Camino runs everyone's agents."
- Practical consequence: truly overnight, multi-day missions eventually want an always-awake box (a mini PC or small server with the CLIs logged in) rather than a sleeping laptop. v1 can start laptop-bound; the daemon/UI split makes the move cheap. Hardware choice stays open.

## 4. What changes from doc 01, and what survives

### Changed

- **The wedge (was Decision 2: gate first).** Now: a **walking skeleton** — the thinnest version of every pipeline stage wired together end-to-end. GUI accepts a PRD, planner constructs visible issues, dispatcher runs one subscription harness per issue sequentially, PRs open, validation runs, and the user merges with one click in the GUI. Autonomy then deepens stage by stage (plan auto-approval for small missions, auto-merge for low-risk slices) as the gate earns trust — the "earned autonomy" mechanic from doc 01, unchanged, but applied to a full loop that exists from week one.
- **Home surface (was Decision 8: exception queue).** Now: the **mission board** — the live render of plan construction and execution state. Observability without obligation: the user *can* watch everything and *must* act rarely. The exception lane lives inside the board; the attention-budget targets and three-way verdicts (pass / fail / escalate-with-a-question) carry forward unchanged.
- **Scope (was Decision 1: one repo, defer multi).** Execution starts on one repo, but the **data model is multi-project from day one** — "primary interface across my projects" makes the portfolio view the point, and retrofitting project-as-an-entity later is expensive.
- **The GUI moves from deferred to core scope.** "Very easy-to-use GUI" is a stated requirement, and it adds real build weight (a web app). Kept thin in v1: mission list, mission board, event feed, and a handful of actions (approve plan, edit issue, pause, retry, merge). It is deliberately a *view over the event log* plus a small command set — not a second source of truth.
- **Primary-interface implication (new).** To actually replace Linear and Symphony, Camino must also accept **quick tasks**, not only PRD-scale missions — otherwise small work keeps flowing through the old tools and the migration never completes. A mission is 1..N issues; a one-issue mission is just a ticket. Same pipeline, no ceremony.
- **Issue granularity (new posture).** Not decided — made **a dial instead of a debate**. The planner takes a granularity parameter, visible and adjustable in the GUI. Starting heuristic: one issue = one PR a competent contractor would ship in a day. The right setting is empirical (worker success rates, review load, integration risk) and will likely differ per repo and mission type.
- **Mission concurrency (new posture).** Missions queue and serialize per repository in v1. A continuous PRD stream invites cross-mission conflicts; serialization is the honest first answer, concurrency an earned optimization.

### Survives intact (from doc 01, now in service of the mission tool)

- **The credential invariant** (Decision 6): models propose, the control plane disposes; workers get branch-scoped tokens, network allowlists, budget caps. Hands-free raises the stakes on this, not lowers them.
- **The append-only event log** (Decision 7) — now doubly justified: the observable control plane David asked for *is* a live render of the event log. Boring storage first; workflow engines only if later warranted.
- **Contract mechanics** (Decisions 4–5), lightened in presentation: acceptance criteria are authored at planning time and attached to issues (not a separate heavyweight "contract" artifact in the UI), frozen at approval, renegotiated through the tiered protocol. Verification stack by risk tier, cross-family review for higher risk, mutation testing against weak tests, mission-level integration checks — because issues can pass individually while the assembled feature fails.
- **Routing** (Decision 9): static role/model table, failure-based family switching with structured handoffs, subscription quota as a scheduling resource.
- **Evaluation** (Decision 10): instrument cost, tokens, David-minutes, and outcomes from the first run. North star reframed to match the product: **PRDs delivered end-to-end hands-free** — missions completed without intervention whose merges survive 30 days — with gate false-approve rate, minutes per merged issue, and cost per mission as guardrails.
- **Ontology** (Decision 3), with user-facing renames to match the mental model: **Mission** (a PRD-scale unit, or a single quick task) → **Issue** (the visible ticket; grain adjustable) → **Attempt** → **Evidence** → **Verdict**. One authoritative store; GitHub is a projection; Linear is not in the loop.

## 5. The promise, decomposed

"Feed it a PRD, get end-to-end delivery, hands-free" fails at one of five points; the design must hold all five:

1. **Plan quality** — bad decomposition poisons everything downstream. Mitigations: observable construction, inline clarifying questions at submission (every assumption the planner is forced to invent becomes a question), human plan approval early on, cross-family plan challenge for large missions.
2. **Worker completion** — subscription harnesses must reliably finish issue-grain work in isolated workspaces. This is mostly mechanics (spawning, sandboxing, quota handling, repair loops) and is testable in a week.
3. **Merge without a human** — the gate. Independent validation in a clean environment, plan-time acceptance criteria the worker cannot weaken, cross-family review by risk, mission-level integration checks. This is the linchpin: dispatching agents is commodity; ending missions with correct, merged software with nobody watching is not.
4. **Durability** — multi-day missions must survive restarts, rate limits, quota windows, and pauses. The event log plus resumable pipeline stages carry this; the always-awake box completes it.
5. **Escalation quality** — rare, well-founded questions. An always-asking system isn't hands-free; a never-asking system is reckless. Question quality is measured like gate quality.

## 6. Revised v1 shape (walking skeleton)

- Local daemon + web GUI (localhost); Postgres or SQLite event log beneath.
- GitHub App integration for branches, PRs, checks, merges — deterministic code, never model-driven.
- Worker adapters: `claude -p` (Claude Code headless) and `codex exec`, one issue per isolated worktree/container; harness abstraction so "other agents" slot in later.
- Planner: PRD → clarifying questions → issue set with acceptance criteria, streamed to the board.
- Validation runner: clean-environment revalidation + risk-tiered review; evidence attached to the PR and the board.
- Human actions in v1: approve plan, one-click merge, answer escalations. Everything else hands-free.
- One repo executing, multi-project data model, missions serialized, all economics instrumented.

## 7. Revised experiment order

1. **Dispatch spike** (was E-B, promoted to first): one issue → spawn Claude Code headless and Codex CLI in isolated worktrees → PR. Proves the subscription-harness mechanics Camino now owns: auth on a headless process, sandboxing, quota behavior, repair loop. ~Days.
2. **PRD-to-plan probe** (old E2, reframed): run a real PRD from one of David's projects through the planner; watch the issue construction; judge the clarifying questions; time the review. Tests the observable-decomposition UX and the granularity dial.
3. **Thin mission end-to-end** (old E3, now with real dispatch): a 3–6 issue mission on a real repo, David approving plan and merges only. This is the walking-skeleton milestone and generates the failure catalog the architecture gets designed against.
4. **Gate calibration replay** (old E1, repositioned): retro-contracts over historical PRs, false-approve/false-reject measurement — required **before any auto-merge is enabled**, not before the tool exists.
5. **Injection red-team** (old E4): before the box goes always-on and unattended.

## 8. Open choices for the next pass (deferrable, low regret)

- GUI substrate: local web app recommended; desktop wrapper later if wanted.
- Where the always-awake execution box lives (laptop-first is fine to start).
- Default issue-grain setting per repo.
- Whether Linear gets a temporary read-only projection during the transition (recommendation: skip unless its absence hurts).
- User-facing naming (mission / issue / ticket) — cosmetic but worth settling before the GUI is built.
