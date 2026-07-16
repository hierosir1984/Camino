# Camino — Consolidated Design v2

> **2026-07-16 (later): HISTORICAL — frozen as round 2's review target. Superseded by [11-design-v3.md](11-design-v3.md)** after round 2 returned "safe to build on: no" ([09 raw](09-adversarial-review-round2.md), [10 dispositions](10-review-round2-dispositions.md)).
>
> 2026-07-16. **The authoritative current design.** Integrates docs 02–05 and all 38 round-1 adversarial dispositions ([06 raw review](06-adversarial-review-round1.md), [07 dispositions](07-review-round1-dispositions.md)). Docs 01–05 are historical record. §11 maps every round-1 correction to the section that resolves it. This document is the round-2 falsification target.

## 1. What Camino is

A local-first developer tool — mission control for autonomous development. The user feeds a PRD (or a single quick task) into a simple GUI; the planner asks its clarifying questions inline and constructs issues on an observable board; coding agents running on the user's existing subscriptions (Claude Code, Codex CLI; harness-abstracted others later) implement each issue in an isolated workspace; work flows through independent validation into a mission-level integration branch and finally to main; a continuously maintained **Living Canon** records intent and how much of it is demonstrably satisfied. Personal use first; open-source publication later; business model out of scope.

The promise decomposes into five failure points the design must hold: plan quality, worker completion, merge-without-a-human, durability, and escalation quality. Every mechanism below serves one of these.

**What v1 autonomy honestly is:** the user approves the plan, approves each mission's final merge to main, and answers escalations. Everything between — implementation, validation, merging issues into the mission branch, repair loops — runs unattended. "Interrupted only by genuine escalations" is the roadmap destination, reached by the earned-autonomy ladder (§7), not the v1 behavior.

## 2. Invariants

1. **Claims are not state.** Done is observed, not declared. No worker self-report moves a state machine; only the repo, executed checks, and evidence do.
2. **Split authority.** Creative processes (workers) hold model-provider auth only. The control plane holds all repository authority (push, PR, merge). No process holds both. (Provider auth inside a worker is inherent to BYO-subscription — the worker can spend quota; it cannot touch the remote repo.)
3. **The event log is the source of truth for decisions; external systems are the source of truth for external facts.** Recovery reconciles against GitHub's actual state; it never blindly replays side effects.
4. **Ceremony scales with mission class.** A one-line fix must cost one-line-fix overhead.
5. **Autonomy is earned per capability and revocable** — merge autonomy, fold autonomy, routing autonomy each unlock on demonstrated performance over trailing windows and revoke on regression.
6. **The user's PRD text is the ultimate source of intent.** The canon is its compiled, statused form; the PRD is retained immutable for audit. Canon updates derive from approved intent, never from implementation diffs.

## 3. The Living Canon v2

### 3.1 Intent plus status — never "current truth"

The canon is the **desired-state** record: product intent, users, invariants, scope, architecture principles, and per-feature requirements. It never claims to describe reality. Instead, **every requirement carries a status**:

- `intended` — accepted into the canon, not yet built
- `built` — implementing changes merged, not yet behaviorally verified
- `verified` — green probe (or equivalent check for its class)
- `disputed` — conflicting evidence about what the intent even is (mostly from induction)
- `descoped` — removed from intent by explicit user approval

Context packs assembled for workers quote canon requirements **with status**, so an agent is never fed an unbuilt feature as an existing one. The gap register (§3.4) is the live view derived from statuses and probe results.

### 3.2 Coverage, by requirement class

Requirements are classed at fold time: **behavioral** (user-observable; probeable), **structural** (architecture and dependency rules; checkable by lint/audit where feasible), **policy** (exclusions, constraints; checked by the planner at intake against new PRDs), **descriptive** (glossary, rationale; unmeasured). The headline metric **canon coverage = verified fraction of behavioral requirements**, labeled as exactly that. Other classes report their own check status or "unmeasured." No metric claims a denominator it doesn't cover.

### 3.3 Brownfield induction: provisional, not authoritative

Adopting an existing repo produces a **draft canon**: every extracted statement tagged with provenance (`doc` / `code` / `inferred`) and confidence. Doc-vs-code conflicts (docs say 30-day refunds, code implements 14) become `disputed` entries plus an item in a **triaged question queue**, ranked by blast radius, answered lazily — the first mission touching a disputed area forces its resolution; nothing requires a day-one product audit. Canon authority accretes over missions. Induction also sets up the validatable-repo profile for that one repo (bounded per-repo work, not universal environment inference).

### 3.4 The gap register, with honest semantics

A persistent entity: requirement → status → evidence provenance (which detector or probe, what confidence) → disposition. Dispositions: `fix-queued`, `disputed`, `false-positive-waived` — **waivers exist only for detector false positives, never for real unmet requirements**. A real unmet requirement either stays open or is `descoped` by the user (a canon edit requiring approval). Mission completion semantics follow: `complete` (all mission requirements verified), `complete-with-residue` (descoped items listed on the mission record), `abandoned`. Coverage and "PRDs delivered" metrics count residue against themselves — relabeling failure cannot improve a number.

### 3.5 Folds, intake checks, and the shared-premise defense

- **At intake:** the PRD is compiled to canon deltas, and the user confirms a **requirement checklist diff** — every PRD requirement mapped to a canon entry, unmapped ones highlighted. This is the defense against the planner silently narrowing intent (author-separated probes mitigate self-confirmation; they cannot recreate dropped intent — only this checklist and the retained PRD can).
- **At mission completion:** a fold updates statuses, integrates new requirements, supersedes contradicted text, deletes stale files (history lives in git and the control plane). Folds are PRs; fold approval starts human and joins the autonomy ladder.
- **Ceremony scaling:** the planner marks each mission `canon-affecting` or `canon-neutral` at intake (visible, overridable). Canon-neutral quick tasks get no fold and no new probes; register updates batch weekly.
- **Periodic audit:** every N missions, a consistency pass over the canon plus a sampled PRD-vs-canon check.

### 3.6 Probes and detectors

- **Behavioral probes** are the gold standard: per behavioral requirement, an executable check (Playwright flow, API sequence) authored from the canon at plan time by the planner/reviewer side, never modifiable by the worker being judged; mutation-tested occasionally.
- **Probe lifecycle with flake discipline:** states pass / fail / flaky / quarantined / infra-blocked. Automatic retry ×2; environment-boot failures are classified `infra-blocked`, not requirement-failed; repeated intermittents quarantine the probe and open a maintenance item; the gap register consumes only stable signals; a per-repo flake budget and a detector-health view exist from v1. (One hundred 99.5%-reliable probes false-alarm 39% of the time without this — the math is why this is structural, not hygiene.)
- **Wiring detectors are heuristics, not sound analysis.** TODO/stub scans, coverage-on-new-code, unimported-file and unapplied-migration checks emit **suspected** gaps with known false-positive rates, always below probe evidence in ranking. Sound cross-framework reachability analysis is explicitly out of scope; per-language detector plugins can sharpen heuristics over time.

## 4. Mission pipeline v2

### 4.1 Intake and contracts

PRD in → clarifying questions (every assumption the planner had to invent becomes a question) → issue set streamed to the board with acceptance criteria → user approves plan + requirement checklist. Acceptance criteria freeze at approval into a hash-referenced **contract version** per issue.

**Edit protocol (contracts are versioned, not violated):** editing an issue mid-flight creates contract v(n+1). If the running attempt's work is compatible (additive delta), it completes and revalidates against v(n+1); otherwise it is cancelled with a structured summary and the issue replans. Downstream issues whose interfaces changed are invalidated back to `ready` with a note. Every edit is an event; nothing mutates in place.

### 4.2 Merge strategy: the mission integration branch

The round-1 review exposed that per-issue merges to main can land exactly the unwired framework Camino exists to prevent. v2:

- Each mission gets an integration branch `mission/<id>` off main. Issue PRs target the mission branch.
- **Issue PRs merge into the mission branch without the user** once independent validation passes — they cannot touch main, so the risk stays contained. This is the big ergonomic win recovered from the review: a six-issue mission needs two human approvals (plan, final merge), not seven.
- The mission branch syncs from main frequently (serialize-per-repo keeps cross-traffic low); each sync re-runs affected validation.
- When all mission requirements are demonstrated **on the integration branch** (probes green there), one mission PR to main, reviewed and merged by the user in v1. Merge yields a single revertable merge commit — **rollback = revert one commit**, now designed rather than aspirational.
- **Quick tasks** (single-issue, canon-neutral) skip the integration branch and PR directly to main with user approval — the contained-risk argument doesn't apply, and ceremony must stay one-line-sized.
- Trunk-plus-feature-flags is noted as a future per-repo alternative for flag-friendly codebases; v1 is integration-branch only.
- **Urgent lane:** an `urgent` quick task pauses the active mission at the next issue boundary, executes against main directly, then the mission branch rebases and re-validates affected issues. Serialization holds except through this designed door.

**Training mode vs cruise mode:** early missions can enable per-issue human confirmation (David reviews issue PRs into the mission branch too) purely to generate labeled gate-calibration data faster; cruise mode is the default described above. The mode is a per-mission toggle, recorded.

### 4.3 Validation stack

Per issue: deterministic revalidation in the clean test environment (§5.3), heuristic detectors (§3.6), risk-tiered cross-family semantic review, behavioral probes for user-observable criteria. Per mission: the requirement-level probe suite on the integration branch is the completion gate. Failure classifications feed the ledger; two failed attempts in one model family trigger a family switch with a structured handoff; four trigger escalation.

### 4.4 Durability: intent → act → confirm, then reconcile

Every side-effecting operation (push, PR create, merge, CI dispatch) is recorded as an intent event with an idempotency key, executed, then confirmed as an event. On crash/restart/resume, recovery **reconciles**: it queries GitHub for the actual state of unconfirmed intents (did the PR get created? did the merge land?) and adopts external reality, appending reconciliation events. The event log is never treated as knowing GitHub better than GitHub. SQLite/Postgres transactions are never presumed to span external systems.

## 5. Execution plane and security v2

### 5.1 Credential architecture (control-plane-mediated git)

- Workers run in containers/worktrees with **no GitHub credentials at all**. They implement and commit locally.
- The control plane holds the sole GitHub credential (v1: a fine-grained PAT scoped to the target repos; a GitHub App is a later upgrade, valuable mainly for the open-source release). It performs every push, PR, and merge **after policy checks**: diff-scope check (files touched vs issue scope), protected-path list, contract reference present, budget not exceeded.
- Branch-level enforcement is by control-plane policy plus GitHub branch protection on main — *not* by mythical branch-scoped tokens.
- Workers' provider auth (the CLI's own subscription login) is mounted into their workspace read-only where the harness requires it; egress allowlists and per-attempt token/wall-clock budgets with kill-and-escalate apply. Untrusted text (issue bodies, web content, repo content) is data, never instructions; the injection red-team experiment prices how much hardening v1 needs.

### 5.2 Provider harnesses

Only **official vendor harnesses** are spawned (real `claude`, real `codex` binaries); Camino never re-implements a harness or extracts OAuth tokens. Harness adapters handle stream protocols, cancellation, process-tree cleanup, and quota-limit classification — acknowledged as real engineering, not glue (§8).

### 5.3 Secrets and test environments

- Per-repo **test environment profile**: how to boot the app for validation (compose/devcontainer), seed and reset scripts, artifact retention.
- A control-plane **secrets vault** (v1: OS keychain or an age-encrypted file) holds *test-scoped* credentials: test tenants, sandbox API keys, callback URLs. Secrets inject **only into the validation runner's environment**, never into worker environments. Workers develop against mocks and local fakes; probes prove live wiring against the seeded test environment with test-tenant credentials.
- Missions declare required test resources **at planning time** (an auth-platform migration declares "Auth0 test tenant + callback URL"); missing resources escalate at plan approval, not at validation failure. Cleanup hooks run post-validation.
- Production credentials do not exist anywhere in v1 (no deployment scope).

## 6. The router v2 (humbled)

- **Capability registry** per provider: models, quota windows, context limits, harness features, **sanctioned-path and billing-pool attributes** (time-varying policy data, §9).
- **Policy table** per project and role — user-editable, shipping with defaults; per-project provider allowlists.
- **Outcome ledger** records per attempt what is *cheaply and honestly recordable*: model, role, task features, verdicts, repair count, tokens, wall-clock, attempt cost where the provider exposes it; human minutes approximated from approval-surface dwell time with manual correction; per-provider quota consumption best-effort. Recording is near-free; *attribution* is acknowledged as noisy.
- **Reward = expected total cost per issue across all terminal states** — accepted (with 30-day survival as a lagging quality signal, not a correctness label), reassigned (sunk cost carried), abandoned (full sunk cost plus a user-set penalty). Nothing conditions on success; the worst outcomes teach the most.
- **Stages:** (1) *Report* — descriptive analytics on coarse cells (provider × model × role, pooled across repos until volume justifies splits). (2) *Advisor* — proposed policy diffs with the evidence attached, human-approved. (3) *Bounded actor* — **demoted to an explicitly conditional aspiration**: viable only if outcome volume reaches documented sample-size thresholds (~120–300 outcomes per compared pair for 10–15-point differences), realistically via opt-in community telemetry after open-sourcing, or never. The design does not depend on Stage 3.
- **Scheduling treats quota as having opportunity cost** even when prepaid: a queue-aware shadow price rises as windows deplete and missions queue. "Best model everywhere" is a policy the table can express when pressure is low, not an assumed optimum. Failure-triggered family switches are logged as *selected*, biased comparisons — never treated as clean A/B data.

## 7. Human surface and attention accounting

The board is the home surface; an exception lane carries escalations with purpose-built artifacts (contract diff, evidence summary, question). Gate outcomes are three-way (pass / fail / escalate-with-question) and question quality is tracked. **v1 routine approvals, stated honestly:** plan approval, mission-merge approval, quick-task merge approval, fold approval (until folds earn autonomy), disputed-canon answers as they surface. Attention is *measured* — including canon and probe-review overhead — against targets (order of 10 minutes per merged issue equivalent, ~45 per mission plan) rather than asserted; if measurement shows ceremony blowing the budget, ceremony scaling rules tighten (§3.5) before autonomy loosens. Autonomy unlocks are evidence-gated per §8.3.

## 8. v1 scope, cut, and build phases

### 8.1 Skeleton v0 (first runnable loop)

One repo. PAT auth. **Polling, no webhooks** (no tunnel infrastructure). SQLite event store. Two mission templates (feature, quick task). GUI: mission board, plan approval, merge approval, escalation inbox — nothing else. Probes: mission-level integration checks only (the per-requirement accumulating suite grows later). Router: static policy table + ledger recording (report view only). Gap register: a table, no dedicated UI. Canon: root doc + statuses, manual-assisted folds. Two harness adapters (Claude Code, Codex). Detectors: TODO/stub scan + coverage-on-new-code only.

Explicitly deferred: GitHub App, webhooks, multi-repo execution, refactor/migration/UI-rewrite/greenfield templates, advisor-stage router, probe accumulation at scale, gap-register UI, xAI/GLM adapters, any deployment.

### 8.2 No time promises

The round-1 review was right that "week one" language was fantasy. Build proceeds in phases — skeleton, pilot missions, hardening — each gated on what the previous phase measured, not on calendar claims. Schedule-eater components are named up front: GitHub plumbing and remote-state reconciliation, CLI stream/auth lifecycle handling, sandboxing and network policy, reproducible app boot and seeding, Playwright auth/traces/flake handling.

### 8.3 Evaluation honesty

- The **dispatch spike** de-risks mechanics (spawn, sandbox, auth, quota classification) — it estimates nothing about completion rates.
- **Completion rates come from instrumented pilot missions**; at 90% per-issue reliability a six-issue mission succeeds 53% of the time, so the repair loop is load-bearing and measured from the start.
- The **calibration replay** (20–30 historical PRs + seeded defects) is a **gross-failure screen** — zero false approvals in 30 bounds the rate only at ≤10% (95% confidence). It can *disqualify* the gate; it cannot license auto-merge.
- **Auto-merge unlocks per repo per risk tier** only on accumulated production agreement: e.g., ≥50 consecutive human-confirmed gate decisions with zero false approvals in the tier — months of evidence, low-risk tier first, revoked on any regression. Training mode (§4.2) accelerates label collection.

## 9. Provider policy risk register

| Provider | Automated path status (2026-07) | Design posture |
|---|---|---|
| OpenAI (Codex) | Third-party harness use of subscriptions publicly endorsed | Primary headless workhorse |
| Anthropic (Claude Code) | Sources in tension: support guidance says Agent SDK / `claude -p` currently draw from subscription limits ("for now, nothing has changed"); legal guidance directs third-party *products* to API keys; a billing separation was announced then paused. Enforcement history against non-official harnesses is secondary-sourced | Spawn official CLI only; treat headless economics as repricing-prone; pre-provisioned **funded** API fallback (an unfunded fallback is an outage, not a mitigation) |
| xAI, Zhipu (GLM) | Unverified | Verify sanctioned path at adapter onboarding |

**Personal use vs distribution:** running Camino personally on one's own logins is the low-risk end. **Open-source release is the step that creates third-party-product exposure** — the release requires a compliance pass, and the distributed tool must never handle provider credentials itself (each user authenticates each vendor's official tool directly). Policy attributes live in the capability registry as time-varying data with linked sources, re-checked on a schedule.

## 10. Market position (corrected)

Differentiation, stated at survivable strength: **the integration is unclaimed, the categories are not.** Learned cost-quality routing exists (Not Diamond custom routers; OpenRouter Auto) — Camino's router differs by optimizing *delivery outcomes* (repair loops, survival, human minutes) inside a pipeline rather than per-request quality. Spec-living workflows exist (Spec Kit's converge flow, Tessl's requirement-test links, Kiro sync, decades of requirements-traceability tooling) — the canon differs as an *agent-maintained, statused, probe-verified* repo artifact wired into execution. PRD-to-board intake exists (Rovo, Kiro). GitHub validates agent output (security scanning, agentic review) — not black-box behavioral verification. Factory Missions ships the orchestrator/worker/validator loop platform-billed and cloud-controlled; no *current platform-billed incumbent* offers native BYO-subscription multi-vendor execution, and the funded player that did (Vibe Kanban, YC-backed Bloop) exited commercially — which matters little for an explicitly non-commercial build. Factory's published mission data (185 runs, 778.5M tokens, 21 fix-features for 40 planned, 0/6 milestones passing first validation) is adopted as planning reality: validation and repair dominate autonomous delivery cost.

Pain evidence, at corrected strength: Stack Overflow 2025 (~31–33k respondents on the AI questions): 66% cite "almost right, but not quite" as the top frustration; 46% distrust vs 33% trust. DORA 2025: ~90% adoption, ~30% low trust, throughput up while stability degrades. GitClear: duplication up, refactoring collapsed (observational). SpecBench: frontier models saturate visible tests while failing held-out end-to-end tests (30 tasks). METR's 2025 RCT (19% slower) is **superseded by its 2026 update** (early-2026 tools probably speed developers up) — the honest conclusion is that the *verification and trust* problems are documented and current, while raw capability keeps improving, which is precisely the gap a control plane addresses.

## 11. Round-1 correction map

| Round-1 correction (Sol's bottom line) | Resolved in |
|---|---|
| Split desired-state canon from as-built truth | §3.1 (status lifecycle), §3.2 (coverage denominators) |
| Prevent partial mission merges / atomic integration + rollback | §4.2 (integration branch, single revertable merge, urgent lane) |
| Replace branch-scoped credentials with control-plane-mediated git + real isolation | §5.1, invariant 2 |
| Idempotent GitHub reconciliation + secrets/test environments | §4.4, §5.3 |
| Cut and revalidate v1 scope | §8.1–8.2 |
| Measure worker, gate, probe error rates before auto-merge | §8.3, §3.6 (flake discipline) |
| Demote learned routing, canon/gap-register, and market novelty claims | §6 (stage-3 conditional), §10 |
| Provider permission as use-context-specific, time-varying policy | §9 |
| (Individual findings 1–38) | Dispositions in [07](07-review-round1-dispositions.md); notably #10→§4.1, #16→§3.5+§4.2, #21→§1+§7, #22→§3.4, #23→§4.2, #12→§6, #18→§3.2, #19→§3.3, #20→§3.5 |
