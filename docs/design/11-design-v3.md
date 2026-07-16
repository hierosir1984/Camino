# Camino — Consolidated Design v3

> **2026-07-16 (later): HISTORICAL — frozen as round 3's review target. Superseded by [14-design-v4.md](14-design-v4.md)** after round 3 returned "safe to build on: no" with 7 blockers ([12 raw](12-adversarial-review-round3.md), [13 dispositions](13-review-round3-dispositions.md)).
>
> 2026-07-16. **The authoritative current design.** Supersedes [08-design-v2.md](08-design-v2.md) (frozen as round 2's review target) by folding in all 30 round-2 dispositions ([09 raw](09-adversarial-review-round2.md), [10 dispositions](10-review-round2-dispositions.md)). §12 maps round 2's corrections to resolving sections. This document is the round-3 falsification target.

## 1. What Camino is

A local-first developer tool — mission control for autonomous development. The user feeds a PRD (or a single quick task) into a simple GUI; the planner asks clarifying questions inline and constructs issues on an observable board; coding agents on the user's existing subscriptions (Claude Code, Codex CLI; other backends via adapters) implement each issue in an isolated workspace; work flows through independent validation into a mission integration branch and then to main; a continuously maintained **Living Canon** records intent and how much of it is demonstrably satisfied. Personal use first; open-source later; business model out of scope.

Five failure points the design must hold: plan quality, worker completion, merge-without-a-human, durability, escalation quality.

**v1 autonomy, honestly:** everything starts in **training mode** — the user approves the plan, each issue's merge into the mission branch, the mission's merge to main, and answers escalations. Autonomy is then earned in stages (§8.3): first issue→branch auto-merge (contained risk), much later mission→main. "Two approvals per mission" is the earned steady state, not day one. "Interrupted only by genuine escalations" is the roadmap's end, reached by evidence.

## 2. Invariants

1. **Claims are not state.** Done is observed, not declared.
2. **Split authority, precisely:** no creative process (worker, planner, or reviewer) holds repository credentials, and **no creative output becomes enforced policy without passing a human or deterministic gate** — plans and contracts through plan approval; probes and canon changes through the mission PR; routing changes through policy-diff approval. Workers hold model-provider auth only (inherent to BYO-subscription): they can spend quota, never touch the remote repo.
3. **The event log is the source of truth for decisions; external systems are the source of truth for external facts.** Recovery reconciles; it never blindly replays.
4. **Ceremony scales with mission class**, and classification itself is never trusted to a single creative judgment (§3.5).
5. **Autonomy is earned per capability, staged, and revocable.**
6. **The user's PRD text is the ultimate source of intent**; the canon is its compiled, statused form; canon updates derive from approved intent, never from implementation diffs.
7. **Evidence binds to (attempt, commit SHA, base SHA).** History-rewriting operations are forbidden on branches carrying evidence (merges only, no rebase).

## 3. The Living Canon v3

### 3.1 Intent plus status, with a real state machine

The canon records **desired state** and never claims to describe reality. Per-requirement status with defined transitions in both directions:

- `intended` — accepted, not on main.
- `built` — implementing changes are **on main** (merges into a mission branch do not set `built`; context packs for issues inside a mission additionally see "present on this mission branch" as a separate flag).
- `verified` — a currently-green, requirement-mapped check exists. **Verified is a live claim:** if the probe later fails, flakes into quarantine, or becomes infra-blocked, status downgrades to `built` with a `verification-stale` marker and a register entry — evidence that stops being green stops counting.
- `disputed` — conflicting evidence of intent. Exits: resolved (user answers), `assumed` (user signs off a documented assumption when history is unknowable), or `descoped`.
- `descoped` — removed from intent by explicit user approval.
- **Reverse transitions:** reverting a mission moves its requirements back to `intended` (with history); superseding intent moves old requirements to `descoped`.

Context packs always carry status and flags, so an agent is never fed an unbuilt or no-longer-verified feature as an existing, working one.

### 3.2 Verification methods and coverage

Every requirement carries a **verification-method attribute**: `probe` (behavioral, executable), `audit` (structural checks where feasible), `planner-check` (policy/exclusions checked against every new PRD and plan), `guard` (protected paths and "must not change" constraints checked deterministically at diff time), or `none` (descriptive; explicitly unverifiable). Headline **canon coverage = verified fraction of probe-method requirements**, labeled as exactly that; other methods report their own check status. No metric claims a denominator it doesn't cover. In v0 this metric is explicitly immature (§8.1).

### 3.3 Brownfield induction: provisional, not authoritative

Draft canon with provenance (`doc`/`code`/`inferred`) and confidence per statement; conflicts become `disputed` plus a blast-radius-ranked question queue answered lazily (the first mission touching a disputed area forces resolution; `assumed` exists for unknowable history). Induction also sets up the validatable-repo profile for that repo. Authority accretes; day one is a draft.

### 3.4 Gap register semantics

Requirement → status → evidence provenance → disposition (`fix-queued`, `disputed`, `false-positive-waived` — waivers only for detector false positives). Real unmet requirements stay open or are `descoped` by the user. Mission terminal states: `complete`, `complete-with-residue` (descopes listed, counted against coverage and delivery metrics), `abandoned`.

### 3.5 Folds, intake checks, classification, and the shared-premise defenses

- **Intake:** PRD compiles to canon deltas; the user confirms a **requirement checklist diff** (unmapped PRD items highlighted). This catches dropped intent.
- **Cross-family plan challenge (restored from doc 02):** before plan approval, a reviewer model from a different provider critiques the plan — architecture, slicing, interpretation, latent assumptions — risk-tiered (always for missions above a size threshold or touching sensitive areas). The checklist catches omissions; the challenge attacks bad premises. Neither is claimed to be complete; together with plan approval they are the designed defense.
- **Folds ride the mission branch:** canon updates land as commits inside the mission PR — one approval covers code and canon together, and reverting the mission reverts its fold. Standalone fold PRs arise only from periodic audits.
- **Ceremony classification is provisional until the diff exists.** The planner labels missions `canon-affecting`/`canon-neutral` at intake, but deterministic triggers re-classify on implementation evidence: touching migrations, auth/authz paths, dependency manifests, feature flags, validation/boot configuration, or protected paths forces `canon-affecting`. Independently of the label, **any user-observable change gets a probe** (the label governs folds, not probes). Canon-neutral quick tasks: no fold, register updates batched.
- **Periodic audit:** canon consistency + sampled PRD-vs-canon checks every N missions.

### 3.6 Probes and detectors

Behavioral probes: authored from the canon at plan time by the planner/reviewer side, never modifiable by the judged worker, mutation-tested — **probe mutation testing doubles as the probe false-negative estimator** (§8.3). Probe lifecycle: pass / fail / flaky / quarantined / infra-blocked; auto-retry ×2; environment-boot failures classify as infra-blocked; quarantine opens a maintenance item; the register consumes only stable signals; per-repo flake budget; detector-health view. Wiring detectors are **heuristics** emitting suspected gaps with known false-positive rates, ranked below probe evidence; sound cross-framework reachability is out of scope.

### 3.7 Per-repo operational knowledge (restored)

`.camino/knowledge.md`: build quirks, flaky areas, forbidden zones, migration ordering, environment gotchas — appended by attempts on discovery, curated at folds, included in every context pack. Product intent lives in the canon; operational craft lives here; both persist across missions.

## 4. Mission pipeline v3

### 4.1 Intake, contracts, and change control

PRD → clarifying questions → issue set with acceptance criteria → cross-family plan challenge → user approves plan + checklist. Criteria freeze into hash-referenced contract versions.

**Edit protocol:** an edit creates contract v(n+1); compatible running work completes and revalidates against v(n+1), otherwise cancel-with-summary and replan. **Downstream invalidation is semantic, not signature-based:** the planner runs an impact assessment over dependent issues on every contract change (authorization, ordering, consistency, latency, and error-behavior changes count); the conservative default is revalidate. Edit-cancelled attempts are excluded from router scorecards but included in mission economics (§6). All edits are events.

### 4.2 Merge strategy: integration branch with freshness invariants

- Issue PRs target `mission/<id>`. **In training mode (default) the user approves them; auto-merge into the branch is the first earned autonomy tier** (§8.3).
- **Freshness invariant, applied recursively:** every verdict binds to (head SHA, base SHA). An issue merges only if validated against the current mission-branch head (or is automatically revalidated). The mission merges to main only when the branch contains the current main head and the full probe suite is green **at that exact head** — enforced by control-plane check plus GitHub's required-up-to-date branch protection. What was validated is what merges.
- **After every issue merge**, a fast suite (build, unit, smoke) runs on the new branch head — cross-issue breakage surfaces at the merge that caused it, not at mission end. Full requirement probes plus risk-tiered cross-family review gate the mission merge.
- Branch syncs from main are **merges, never rebases** (invariant 7); each sync triggers scoped revalidation via the planner's impact assessment.
- **Rollback is a repair-mission type, not a slogan:** its opening move is reverting the mission merge commit (which includes the fold), followed by canon status reversal (§3.1) and an external-state checklist — migrations and third-party mutations flagged at plan time carry recorded down-paths where feasible; unrevertable effects escalate rather than pretend.
- **Quick tasks** (single-issue, canon-neutral, non-sensitive paths) PR directly to main with user approval.
- **Urgent lane:** an `urgent` task may cancel a repair-looping attempt at a safe checkpoint (not only wait for issue boundaries), lands on main directly, then the mission branch merges main in and revalidates per impact assessment. No rebases; evidence bindings survive.

### 4.3 Validation stack

Per issue: deterministic revalidation in the clean test environment, heuristic detectors, risk-tiered cross-family semantic review, probes for user-observable criteria. Per mission: fast suite per merge, full probe suite + review at completion. Failure classifications feed the ledger; two failures in a family switch families with a structured handoff; four escalate.

### 4.4 Durability: intent → act → confirm → reconcile, with real keys

Side-effecting operations record an intent event carrying a **UUID that is embedded in the artifact itself** (branch names, PR bodies) — GitHub offers no generic idempotency parameter, so recovery correlates by searching for objects bearing the UUID. Recovery runs under a **single-writer lock** (one daemon, one recovery pass; no concurrent retries). External facts reconcile from GitHub; decisions reconcile from the log. **Environments use reset-before-use as the primary hygiene** (a crashed run's debris is cleared by the next run's reset, not by hoping cleanup ran), plus a scheduled janitor for external test tenants.

### 4.5 Out-of-band human edits (restored lifecycle)

David keeps using Claude Code and Codex interactively — the design treats that as normal, not corruption. The poller detects non-Camino commits on watched branches and emits **ExternalEdit events**: on main → mission branches sync and revalidate per impact assessment; on a mission or issue branch → the affected issue pauses, the planner assesses contract impact, and work resumes or replans. All interventions are recorded events; reproducibility means auditable history, not human-free history.

## 5. Execution plane and security v3

### 5.1 Git mediation with quarantine (no shared metadata)

- Workers run in containers with **isolated full clones** — never linked worktrees sharing a `.git` directory — and no GitHub credentials.
- The control plane keeps its own **pristine clone** per repo with hooks disabled and fixed config. It **fetches** worker commits from the worker clone as an untrusted remote (fetching executes no worker hooks), then verifies: ancestry (commits descend from the assigned base), **full-tree diff scope** — not filename lists: submodule/gitlink introductions blocked, symlink targets checked, `.git*`, hook paths, CI config, and `.camino/` validation config are protected paths — plus contract reference and budget. Only then does it push from the pristine clone using its credential (v1: fine-grained PAT, noting org-policy and API-coverage caveats; GitHub App later).
- Credentialed git never executes inside anything a worker has touched.
- Egress allowlists and per-attempt budgets with kill-and-escalate apply to workers. Context packs tag content provenance (canon vs repo text vs external), and the injection red-team experiment runs before any hardening claims are made — "untrusted text is data" is a posture to be enforced and tested, not an assumed property.

### 5.2 Worker backends (harness abstraction restored)

A worker backend is an adapter: **official vendor CLIs** running on the user's subscriptions (Claude Code, Codex — subscription auth is *only* ever used through that vendor's official harness), **API-key backends** (any provider, including self-hosted or OpenAI-compatible endpoints), and future harnesses. This restores the founding brief's requirement that the architecture never be permanently constrained to subscription authentication. Adapters own stream protocols, cancellation, process-tree cleanup, quota classification.

### 5.3 Secrets and test environments: bounded blast radius, not imaginary isolation

Round 2 established the uncomfortable truth: **validation executes worker-authored code in the environment where test secrets live.** No process boundary fixes that, so the design bounds and detects instead of claiming isolation:

- Secrets are **test-scoped only, disposable, and rotated on schedule** — a leaked test-tenant credential is a contained, replaceable asset by construction. Production credentials do not exist in v1 anywhere.
- The validation environment has **no outbound network** except explicitly allowlisted test-service endpoints; exfiltration paths are narrowed to what validation itself requires.
- All retained artifacts, logs, and evidence pass **secret-pattern scrubbing** before storage.
- Worker changes to boot scripts, validation config, or dependency manifests trigger reclassification (§3.5) and **human review of the validation-config diff** while merge autonomy is anything above training mode.
- Per-repo test environment profile: boot recipe, seeded fixtures, reset scripts. **Pre-mission preflight** boots the environment and checks credential health, catching expired tenants and stale callbacks before work starts; plan-time resource declaration catches the declarable subset early; anything missed classifies as `infra-blocked` at validation, never as requirement failure.
- Workers develop against mocks and local fakes; probes prove live wiring in the seeded environment.

### 5.4 Local daemon surface

Binds 127.0.0.1 only; the GUI authenticates to the daemon with a token from a 0600-permission file; state-changing endpoints carry CSRF protection; the stated trust model is a single OS user on a machine they control. Remote exposure is out of scope for v1.

## 6. Router v3

Registry (with per-provider sanctioned-path and billing-pool attributes), user-editable policy table with per-project provider allowlists, and an outcome ledger recording what is cheaply recordable — with attribution honesty. **Reward is defined at issue resolution over the full trajectory:** the sum of all attempt costs for an issue reaching `merged`, `descoped`, or `abandoned` (abandonment carries full sunk cost plus a user-set penalty; blocked-age is tracked so hopeless work can't hide from the penalty by never terminating). Edit-cancelled attempts are excluded from model comparisons (not the model's fault) but included in mission economics. Failure-triggered family switches are logged as biased, selected comparisons. Stages: report (coarse cells: provider × model × role, pooled) → advisor (evidence-attached policy diffs, human-approved) → bounded actor, which remains a **conditional aspiration** dependent on sample sizes (~120–300 outcomes per compared pair) the solo volume won't reach without opt-in community telemetry. Scheduling prices quota opportunity cost (queue-aware shadow price); "best model everywhere" is a policy the table can express under low pressure, not an assumed optimum.

## 7. Human surface and attention accounting

Board as home; exception lane with purpose-built artifacts; three-way gate outcomes with question quality tracked. **v1 routine approvals, stated honestly:** plan, per-issue merges (training mode), mission merge, disputed-canon answers, validation-config diffs when flagged. **Attention measurement is proxy-plus-correction:** approval-surface dwell time, a weekly one-question self-report to catch off-surface work, headline metric **per mission** (per-issue numbers are gameable through the granularity dial and are reported only as secondary). Budget overrun responses include raising the budget, pausing autonomy expansion, or tightening ceremony — explicitly not just re-tuning the classifier that round 2 showed is fallible.

## 8. v1 scope and staging

### 8.1 Skeleton v0

One repo; PAT; polling (which also powers ExternalEdit detection); SQLite event store; feature + quick-task templates; GUI = board, plan approval, merge approvals, escalation inbox; two harness adapters (Claude Code, Codex CLI) + one API-key adapter interface defined; mission integration branch with fast-suite-per-merge; detectors: TODO/stub scan + coverage-on-new-code; canon root + statuses with manual-assisted folds; register as a table. **Status honesty in v0:** probes exist only as mission-level integration checks, so requirements cap at `built` + mission-checked unless a requirement-mapped check exists; `verified` and the coverage metric become meaningful as the probe suite accumulates — the metric is labeled immature until then. Deferred: GitHub App, webhooks, multi-repo, other templates, advisor router, gap-register UI, xAI/GLM adapters, deployment.

### 8.2 No calendar promises

Phases gated on measurement: skeleton → instrumented pilot missions → hardening. Named schedule eaters: GitHub plumbing and reconciliation, CLI auth/stream lifecycle, sandboxing, reproducible boot/seeding, Playwright auth/traces/flakes.

### 8.3 Evaluation and earned autonomy, with stated statistics

- Dispatch spike de-risks mechanics only. Completion rates come from instrumented pilots (at 90% per-issue reliability, a six-issue mission succeeds 53% of the time — the repair loop is load-bearing).
- Calibration replay (20–30 historical PRs + seeded defects) is a **gross-failure screen** (zero false approvals in 30 bounds the rate only at ≤10%, 95% confidence). It can disqualify the gate, not license it.
- **Autonomy staging:** tier 1 = issue→branch auto-merge, unlocked per repo after ≥50 consecutive human-confirmed issue-level agreements with zero false approvals — **stated plainly: that bounds the true failure rate only at ≤5.8% (95% one-sided), so tier 1 is a risk-managed policy, not a safety proof** — justified by containment (main untouched), continuing post-merge outcome labels, and instant auto-revocation on any disagreement or regression. Tier 2 = mission→main auto-merge, requiring months of tier-1 evidence plus probe false-negative estimates from probe mutation testing (§3.6). Human agreement at decision time and 30-day survival are both acknowledged as weak labels; they are the labels available, supplemented over time by revert/hotfix outcomes.
- Training mode is the default for every new repo and after every revocation.

## 9. Provider policy risk register

Unchanged in substance from v2 (§9 there; round 2 confirmed it): per-provider sanctioned-path table as time-varying registry data; OpenAI endorsed for third-party subscription harness use; Anthropic guidance internally tense (support: Agent SDK/`claude -p` currently draw from subscription limits; legal: third-party *products* directed to API keys; billing separation announced then paused); xAI/GLM verified at adapter onboarding; **funded** API fallback accounts as an explicit continuity prerequisite. **Credential-handling claim, stated precisely:** Camino composes worker sandboxes that *reference* the host's existing credential state for official CLIs; it never reads, stores, or transmits provider secrets itself. Personal use is the low-risk end; the open-source release is the exposure step and requires a compliance pass first.

## 10. Market position

As in v2 §10 with one correction: unclaimed-integration and no-current-platform-billed-incumbent statements are scoped to **the assessed competitor set** (Factory, GitHub, OpenAI Symphony, Vibe Kanban and the local-orchestrator cohort; Devin, Cursor, Kiro, Tessl, Qodo, OpenHands and the router products were not assessed in depth). Factory's published mission economics (validation ≈ 37% of runtime; 21 fix-features per 40 planned; 0/6 milestones passing first validation) are adopted as planning reality.

## 11. Experiments (updated)

1. Dispatch spike (mechanics). 2. PRD-to-plan probe including the cross-family plan challenge (question quality, checklist usability). 3. Thin pilot mission in training mode (failure catalog against the four-mode done-problem taxonomy; completion-rate instrumentation). 4. Gate calibration replay (screen). 5. **Injection red-team, promoted:** hostile issue text, README, and web content against planner and workers — before any hardening claim and before the first unattended mission. 6. Secret-scrubbing and egress tests on the validation environment.

## 12. Round-2 correction map

| Round-2 correction (Sol's bottom line) | Resolved in |
|---|---|
| Validation-secret trust boundary | §5.3 (bounded blast radius: disposable test-only secrets, no-egress, scrubbing, config-diff review) |
| Earned-vs-default auto-merge contradiction | §1, §4.2, §8.3 (training default; staged tiers with stated bounds) |
| Git mediation isolation | §5.1 (isolated clones, pristine-clone quarantine fetch, full-tree checks, no credentialed git in worker-touched dirs) |
| Exact-tree evidence and merge freshness | §2 inv. 7, §4.2 (SHA-bound verdicts, recursive freshness, required-up-to-date) |
| Canon reverse transitions | §3.1 (state machine incl. revert, stale-verification, assumed) |
| Mission rollback and urgent-rebase semantics | §4.2 (revert-first repair mission incl. fold; merge-only syncs; checkpoint cancel) |
| External idempotency and cleanup | §4.4 (embedded UUIDs, single-writer recovery, reset-before-use, janitor) |
| Planner challenge and canon-neutral classification | §3.5 (cross-family challenge restored; provisional labels with deterministic triggers; probes independent of label) |
| Terminal-state reward and attention metrics | §6 (issue-trajectory reward, blocked-age), §7 (per-mission headline, proxy-plus-correction) |
| Dropped human-edit, credential, and future-harness lifecycle requirements | §4.5 (ExternalEdit lifecycle), §9 (precise credential claim), §5.2 (backend adapters incl. API/self-hosted) |
| (Individual findings 1–30) | [10-review-round2-dispositions.md](10-review-round2-dispositions.md) maps each to its section |
