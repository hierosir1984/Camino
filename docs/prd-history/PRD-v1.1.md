# Camino — Product Requirements Document v1.1 (draft)

> 2026-07-16. Governs the v1 build. Derived from the cleared design [17-design-v5.md](design/17-design-v5.md) (five adversarial rounds; clearance in [19-review-round5-clearance.md](design/19-review-round5-clearance.md)) and the founding brief [00-context-brief.md](design/00-context-brief.md). Design section references (§) point into design v5.
>
> **Change control:** this PRD is versioned; material changes require David's approval and, when architectural, a falsification pass. Requirements carry stable IDs (`CAM-AREA-NN`) so this document can seed Camino's own Living Canon once Camino manages its own repository.
>
> **Status: draft v1.1 — David's review round 1 incorporated (2026-07-16): file-attach intake, evidence viewer promoted to P1, plan review reframed as adversarial review, Grok Build CLI added to v1 adapters (enablement gated on sanctioned-path verification), worker question channel + orchestrator added [P2], temporal canon view added [P2]. Pending one adversarial pass.**

---

## 1. Product overview

Camino is a **local-first mission control plane for autonomous software development**. A PRD or a single task enters through a simple GUI (typed, pasted, or attached as a file); a planner asks its clarifying questions and constructs issues on an observable board; coding agents running on the user's existing subscriptions (Claude Code, Codex CLI, Grok Build CLI) implement each issue in isolated workspaces; work flows through independent validation into a mission integration branch and lands on main through a merge protocol in which **what was validated is bit-for-bit what lands**; a **Living Canon** records product intent, and a derived status layer records how much of that intent is demonstrably satisfied. The system is honest about "done": completion is observed by probes and evidence, never declared by the worker.

**User:** David — solo operator-developer, deeply technical, implementing via coding agents. **Distribution:** personal use first; open-source publication later (permissive license; a compliance pass before release). **Business model:** out of scope. **Platform:** macOS-first local daemon + browser GUI; GitHub for repositories.

**The promise, decomposed** (§1): plan quality, worker completion, merge-without-a-human, durability, escalation quality. Every requirement below serves one of these.

**v1 autonomy, honestly:** training mode is the default everywhere — David approves plans, issue merges, mission merges, and answers escalations. Autonomy is earned in tiers (§8.3) and is revocable. The end state is "interrupted only for genuine escalations and new-intent acceptance"; accepting new product intent is permanently the human role.

## 2. Goals and non-goals

**v1 goals:** (1) run real feature missions and quick tasks end-to-end on one configured repository with evidence-gated merges; (2) make the whole pipeline observable on a board David actually enjoys using; (3) instrument everything — cost, attention, outcomes — from the first dispatch; (4) establish the Living Canon + gap register on one brownfield repo; (5) earn tier-1 autonomy (issue→branch auto-merge) on at least one repo by accumulated evidence.

**v1 non-goals** (§8.1, §13): deployment and post-deployment validation; hosted/multi-tenant anything; multi-repo *execution* (the data model is multi-project from day one); webhooks (polling suffices); learned routing beyond the report stage; xAI/GLM adapters; parallel missions per repo; sophisticated gap-register UI; persistent self-hosted CI runners (unsupported); production credentials anywhere.

## 3. Product principles (the invariants, §2)

1. Claims are not state — done is observed, not declared.
2. No creative process holds repository credentials; no creative output becomes enforced policy without a human or deterministic gate.
3. The event log is truth for decisions; external systems are truth for external facts; recovery reconciles, never blindly replays.
4. Ceremony scales with mission class; classification is never a single creative judgment.
5. Autonomy is earned per capability, staged, and revocable.
6. The user's PRD text and explicit confirmations are the only sources of intent; canon text is a rendered projection of the control-plane intent ledger.
7. Evidence binds to (attempt, commit SHA, base SHA) and expires rather than rebinding; no history rewriting on evidence-bearing branches.
8. Only Camino-authored commits are pushed; worker history never leaves quarantine.

## 4. Functional requirements

Notation: **[P1]** = walking skeleton (phase 1), **[P2]** = pilot phase, **[P3]** = hardening/autonomy phase, **[F]** = future (post-v1, listed for boundary clarity). *Accept:* = acceptance criterion. (§) = design reference.

### 4.1 CAM-CORE — missions, board, GUI

- **CAM-CORE-01 [P1]** The daemon runs locally, binds 127.0.0.1 only, and serves the GUI; the GUI authenticates via a token from a 0600-permission file; state-changing endpoints carry CSRF protection. *Accept:* remote connection attempts fail; requests without the token are rejected. (§5.4)
- **CAM-CORE-02 [P1]** A mission is created from pasted/typed PRD text, **an uploaded/attached file (markdown first-class; plain text and common doc formats accepted)**, or as a single quick task. *Accept:* all paths produce a mission record with the original content retained immutably; attached markdown renders in the mission view. (§4.1)
- **CAM-CORE-03 [P1]** The board shows missions and their issues as cards with live states (planned, claimed, implementing, validating, merge-pending, merged, blocked, escalated, replanning, cancelled) streaming as events occur. *Accept:* a state change appears on the board within one polling interval without page reload.
- **CAM-CORE-04 [P1]** The GUI provides exactly these v1 actions: approve/edit plan, approve merge (issue, mission, quick task), answer escalation, pause/resume mission, cancel issue/attempt, disposition gap-register entries, view evidence. *Accept:* every action is recorded as an event with actor and timestamp.
- **CAM-CORE-05 [P1]** An escalation inbox lists everything awaiting David, each with its purpose-built artifact (plan diff, evidence packet, question). *Accept:* zero escalations means an empty inbox — no standing noise.
- **CAM-CORE-06 [P1]** The data model is multi-project (project → repo → missions) even though v1 executes on one repo. *Accept:* adding a second project requires no schema change. (§1)
- **CAM-CORE-07 [P1]** An evidence viewer renders evidence packets (schema §5 below) with artifact previews (logs, screenshots, traces). Promoted from P2 at David's direction: approving merges without inspectable evidence contradicts the product thesis, and verified outcomes are the feedback loop that gap analysis and repair depend on. Phase-1 scope is functional rendering (packet contents + artifact previews); presentation polish follows. *Accept:* every merge approval screen embeds the packet being approved; no v1 merge is approvable without its packet. (§7.2)
- **CAM-CORE-08 [P1]** Missions serialize per repo: one active mission, plus the urgent lane. *Accept:* a second mission queued on the same repo waits, visibly. (§4.2)
- **CAM-CORE-09 [P2]** The gap register is viewable as a table with status tuples and disposition actions. (§3.4)
- **CAM-CORE-10 [P1]** All GUI reads of canon/requirement state render from the control-plane ledger (never by parsing repo canon text). *Accept:* ledger and GUI never disagree. (§3.1)

### 4.2 CAM-PLAN — intake, planning, contracts

- **CAM-PLAN-01 [P1]** The planner compiles PRD text into issues with acceptance criteria, streaming to the board as constructed; every assumption it had to invent is surfaced as a clarifying question before plan approval. *Accept:* a deliberately ambiguous test PRD produces questions, not silent guesses. (§4.1)
- **CAM-PLAN-02 [P1]** Intake produces a requirement checklist diff — every PRD requirement mapped to a proposed intent-ledger entry, unmapped text highlighted — which David confirms; confirmations create `accepted` ledger entries. *Accept:* a PRD sentence with no mapped requirement is visibly flagged. (§3.5)
- **CAM-PLAN-03 [P1]** **Adversarial plan review:** before plan approval, a cross-family reviewer (different provider than the planner) runs a falsification-style critique — its mandate is to find defects, ambiguities, missing requirements, and bad premises, not to comment — and its findings attach to the approval screen. Quick tasks get an **adversarial mini-review**: a single bounded cross-family call with the same falsification mandate. This institutionalizes, per plan and at proportionate depth, the exact process that produced Camino's own design (author → non-family falsifier → human decision). *Accept:* no plan reaches approval without a second-family adversarial critique attached. (§3.5)
- **CAM-PLAN-04 [P1]** Acceptance criteria freeze at plan approval into hash-referenced contract versions; every attempt and PR references its contract hash. (§4.1)
- **CAM-PLAN-05 [P1]** Editing an issue creates contract v(n+1); compatible in-flight work completes and revalidates against it, otherwise cancel-with-summary and replan; the planner runs a semantic impact assessment over dependent issues (conservative default: revalidate). *Accept:* an edit mid-attempt never mutates a contract in place. (§4.1)
- **CAM-PLAN-06 [P1]** Mission classification (`canon-affecting`/`canon-neutral`) is proposed by the planner, provisional until the diff exists, and re-classified by deterministic triggers (migrations, auth/authz, dependency manifests, flags, boot/validation config, protected paths, user-observable surface paths). Fold suppression on quick tasks requires reviewer concurrence. (§3.5)
- **CAM-PLAN-07 [P1]** Mission templates v1: `feature` and `quick-task`. **[F]** refactor, migration, UI-rewrite, greenfield-bootstrap.
- **CAM-PLAN-08 [P2]** Probes for user-observable acceptance criteria are authored at plan time (planner/reviewer side) as executable specs under `.camino/probes/`, reviewed as part of plan approval, and never modifiable by the worker being judged. *Accept:* a worker diff touching its own judging probe is rejected by the protected-path check. (§3.6)
- **CAM-PLAN-09 [P1]** Failed attempts hand off via structured summaries (not raw transcripts); two failures in one model family switch families; four escalate. (§4.3)
- **CAM-PLAN-10 [P2]** The urgent lane: an `urgent` quick task may cancel a repair-looping attempt at a safe checkpoint, lands on main first, then the mission branch merges main in and revalidates per impact assessment. (§4.2)

### 4.3 CAM-EXEC — workers and quarantine

- **CAM-EXEC-01 [P1]** Worker adapters v1: Claude Code (official CLI), Codex CLI (official), and **Grok Build CLI (official; added at David's direction)**, spawned headless on David's subscriptions; an API-key adapter interface is defined (implementation **[F]**). Subscription auth is only ever exercised inside that vendor's official harness. **Per-adapter enablement is gated on sanctioned-path verification at onboarding** (§9 registry — xAI's policy on third-party/headless subscription use is currently unverified; the adapter ships, its activation records the verification outcome). *Accept:* all three adapters pass the dispatch spike; an adapter whose sanctioned-path check fails is installable but visibly disabled with the reason. (§5.2, §9)
- **CAM-EXEC-02 [P1]** Workers run in containers with isolated full clones — never linked worktrees — and zero GitHub credentials; provider auth is made available read-only per harness requirements. (§5.1)
- **CAM-EXEC-03 [P1]** Worker egress is allowlisted (package registries, docs domains per repo config); per-attempt budgets (tokens where reportable, wall-clock always) kill-and-escalate on breach. (§5.1)
- **CAM-EXEC-04 [P1]** Quarantine intake: shallow-fetch of the worker's final head only, with object-count/size budgets; policy checks on the final tree (scope vs contract, protected paths incl. `.gitattributes`/CI/`.camino/`, canonical path identity — case-fold and Unicode-normalization collisions rejected — submodule/gitlink introductions blocked, symlink targets checked, tree size budget); then **squash-and-rebuild**: a fresh Camino-authored commit applying that tree onto the assigned base. Worker merge commits are rejected. *Accept:* the §7.3 quarantine attack suite passes. (§5.1)
- **CAM-EXEC-05 [P1]** Worker workspace history is archived before cleanup under quotas (defaults §5.7) for audit.
- **CAM-EXEC-06 [P1]** Adapters own stream parsing, cancellation, process-tree cleanup (kill-confirm sequence §5.6), and quota-limit classification (a rate-limit failure is `quota-blocked`, never `requirement-failed`).
- **CAM-EXEC-07 [P1]** Context packs are assembled by the control plane: canon excerpts rendered with ledger status for the worker's branch context, the issue contract, approved knowledge entries, and provenance tags per content class. Workers never wander the docs folder. (§3.1, §3.7)
- **CAM-EXEC-08 [P2]** Candidate knowledge entries written by any attempt are immediately visible to repair attempts of the same issue (provenance-marked); promotion to approved happens via human batch or deterministic rule-classes only. (§3.7)
- **CAM-EXEC-09 [P1]** Untrusted text (issue bodies, repo content, web content) is treated as data; the injection red-team (§7.3) runs before the first unattended mission and its findings gate hardening claims. (§5.3 T2)
- **CAM-EXEC-10 [P2]** **Worker question channel:** Camino exposes a local MCP server to workers with read-only context tools — search the canon (rendered with ledger status), read prior attempt summaries for the issue, read approved knowledge, ask the orchestrator (below). Workers can resolve context needs mid-attempt instead of hard-stopping. *Accept:* a worker missing context obtainable from the canon retrieves it via the channel without raising a blocker. (§3.1, §3.7)
- **CAM-EXEC-11 [P2]** **Orchestrator judgment (graduated blockers):** a worker's mid-attempt question goes to an orchestrator role that answers from existing sources (canon, ledger, prior attempts, knowledge, repo), redirects the worker, or escalates to David — hard stops become the last resort, not the first. Guardrails (invariant 2): the orchestrator answers questions of fact and context only; it **cannot modify scope, contracts, or acceptance criteria** — any question touching those routes to escalation; answers are logged as events; per-attempt Q&A budget (default 5 questions) prevents cost runaway. *Accept:* escalation deflection rate (questions resolved without David) is tracked in the ledger; a scope-weakening question provably routes to escalation, never to a creative yes. (§2, §7.1)

### 4.4 CAM-VAL — validation and evidence

- **CAM-VAL-01 [P1]** Independent validation runs in a clean environment from the per-repo test-environment profile (boot recipe, seed/reset scripts); reset-before-use is the hygiene primary. (§5.3, §4.4)
- **CAM-VAL-02 [P1]** The validation runner — not the worker — receives test-scoped secrets from the local vault (OS keychain-backed); worker environments never contain them. *Accept:* worker env dumps contain no vault material. (§5.3)
- **CAM-VAL-03 [P1]** The validation environment has no outbound network except allowlisted test endpoints; retained artifacts pass literal secret-pattern scrubbing. The three-tier threat model (§5.3) is documented in-product; T3 residual risk is stated, not hidden.
- **CAM-VAL-04 [P1]** Worker changes to boot/validation config or dependency manifests trigger reclassification and human review of the validation-config diff while any autonomy is active. (§5.3)
- **CAM-VAL-05 [P1]** Deterministic heuristics run on every candidate: TODO/stub scan, coverage-on-new-code; findings enter the gap register as *suspected*, ranked below probe evidence. **[P2]** unimported-file and unapplied-migration heuristics. (§3.6)
- **CAM-VAL-06 [P2]** Risk-tiered cross-family semantic review: medium+ risk issues get a reviewer from a different provider than the implementer; verdicts are three-way (pass / fail / escalate-with-question). (§4.3)
- **CAM-VAL-07 [P2]** Probe lifecycle: pass/fail/flaky/quarantined/infra-blocked; auto-retry ×2; environment-boot failures classify infra-blocked; repeated intermittents quarantine and open a maintenance item; the register consumes only stable signals; per-repo flake budget and detector-health view exist. (§3.6)
- **CAM-VAL-08 [P1]** Evidence packets per attempt (schema §5.3 resolution below), rolled up per mission with a gate record; gating evidence is produced only on Camino-authored candidates; worker-head checks are advisory and bound to the worker SHA. (§7.2)
- **CAM-VAL-09 [P2]** Pre-mission preflight boots the test environment and checks test-credential health; failures block dispatch with a specific escalation. (§5.3)
- **CAM-VAL-10 [P2]** Mutation testing runs against probes as improvement tooling (kill-rate reports); it is never presented as a false-negative estimate. (§3.6)
- **CAM-VAL-11 [P1]** Missing test resources discovered at validation classify `infra-blocked`, never requirement-failed. (§5.3)
- **CAM-VAL-12 [P2]** Every requirement carries a verification-method attribute (probe/audit/planner-check/guard/none); canon coverage reports the verified-live fraction of probe-method requirements, labeled immature until the probe suite accumulates. (§3.2)

### 4.5 CAM-MERGE — integration and landing

- **CAM-MERGE-01 [P1]** Each mission gets integration branch `mission/<id>`; issue PRs target it; quick tasks PR directly to main. (§4.2)
- **CAM-MERGE-02 [P1]** **Merge-by-push:** the control plane constructs each merge commit locally, validates at that exact SHA (fast suite for issue→branch; full probes + review for mission→main), publishes the candidate to a temporary ref (`camino/candidates/<uuid>`), attests it via the commit-status API (context `camino/validation`), verifies the target ref still equals the validated base, then fast-forward pushes. Any base movement rebuilds and revalidates. *Accept:* pushed SHA ≡ validated SHA on 100% of merges; a simulated race produces rebuild, not a stale merge. (§4.2)
- **CAM-MERGE-03 [P1]** Verdicts bind to (head SHA, base SHA) and expire rather than rebind; revalidation means re-execution. (§2 inv. 7)
- **CAM-MERGE-04 [P1]** After every issue merge, the fast suite runs on the new branch head; failures block the next merge and open a repair issue. (§4.2)
- **CAM-MERGE-05 [P1]** Mission→main requires: branch contains current main; full probe suite green at the exact candidate; cross-family mission review (risk-tiered); David's approval (until tier-2 autonomy). (§4.2)
- **CAM-MERGE-06 [P1]** Bounded rebuild-and-revalidate: at most 2 automatic cycles per candidate, then escalate. (§13 resolution)
- **CAM-MERGE-07 [P1]** Issue PRs are closed by Camino with linkage metadata (comment + label referencing the landing SHA) — GitHub only auto-recognizes indirect merges to the default branch. (§4.2)
- **CAM-MERGE-08 [P1]** Onboarding verifies: main branch protection with required checks (incl. `camino/validation`), required-up-to-date, non-bypass; failure blocks onboarding with instructions. (§4.2)
- **CAM-MERGE-09 [P2]** Rollback is a repair-mission type: opens with the mission-merge revert (fold included), recomputes ledger projections, walks the external-state checklist (migrations flagged at plan time carry down-paths where feasible), and escalates unrevertable effects. (§4.2)
- **CAM-MERGE-10 [P1]** Syncs are merges, never rebases, on all evidence-bearing branches.
- **CAM-MERGE-11 [P1]** Non-Camino pushes to watched branches raise ExternalEdit events (below) rather than being "prevented" — integrity by detection + freshness, per the PAT actor reality. (§4.2)
- **CAM-MERGE-12 [P1]** Mission terminal states: complete / complete-with-residue (descopes listed and counted against metrics) / abandoned, with per-issue delivered flags. (§3.4, §6)

### 4.6 CAM-CANON — intent ledger, canon, gaps, knowledge

- **CAM-CANON-01 [P1]** The intent ledger lives in the control plane; only user actions (intake confirmations, dispute answers, descope approvals) mutate it. *Accept:* no code path mutates intent from merge/revert/abandon events — enforced by construction and covered by tests. (§3.1)
- **CAM-CANON-02 [P1]** Canon text in the repo is the rendered projection of accepted intent, updated by folds riding mission PRs; it carries a rendered-at marker; a standalone intent-only fold triggers when ledger-vs-text divergence exceeds 5 requirements or 7 days. (§3.1, §13)
- **CAM-CANON-03 [P1]** Status is derived per requirement: intent-disposition × implementation-state per branch context (incl. `suspected-absent`) × evidence-state; context packs and GUI render the tuple for the reader's context. (§3.1)
- **CAM-CANON-04 [P2]** Brownfield induction builds a draft canon with per-statement provenance and confidence; conflicts become `disputed` plus a blast-radius-ranked question queue resolved lazily; `assumed` exists for unknowable history; induction also establishes the validatable-repo profile. (§3.3)
- **CAM-CANON-05 [P1]** The gap register holds requirement → status tuple → evidence provenance → disposition; waivers exist only for detector false positives; real unmet requirements stay open or are descoped by the user. (§3.4)
- **CAM-CANON-06 [P1]** ExternalEdit lifecycle: polling detects commits, branch create/delete, PR field changes, protection changes, non-ff ref moves on watched branches; transient A→B→A transitions between polls are a documented v1 limitation. External commits get a canon-impact scan producing proposed deltas as questions to David; his answer — never the diff — authorizes intent changes. Active missions pause affected issues pending impact assessment. (§4.5)
- **CAM-CANON-07 [P2]** Folds update canon rendering, supersede contradicted text, delete stale files; fold approval starts human and joins the autonomy ladder. Canon-neutral quick tasks: no fold; register updates batch weekly. (§3.5)
- **CAM-CANON-08 [P2]** Periodic audit every 10 missions: canon consistency plus sampled PRD-vs-canon checks. (§3.5)
- **CAM-CANON-09 [P1]** `.camino/knowledge.md` lifecycle: candidates (immediate, provenance + commit/base validity) → approved (human batch or deterministic rule-classes: command sequences succeeding ≥3 times across ≥2 missions; quarantine-confirmed flaky-test annotations); only approved entries enter other missions' packs; entries invalidate on revert of their validity base. (§3.7)
- **CAM-CANON-10 [P2]** Mission completion = the mission's requirements demonstrated on the integration branch (per verification method), not "all issues merged." (§4.2, §3.2)
- **CAM-CANON-11 [P2]** **Temporal canon view (display-only):** the GUI renders the project's evolution over time — per-requirement history (accepted → built → verified, with the PRD/mission that drove each transition), canon text diffs per fold, and coverage-over-time. Because the event log and intent ledger are append-only, this is a projection over existing data, including **time-travel viewing**: reconstruct the canon and gap state as of any past event by replay. No new data model. *Accept:* selecting a past date renders the canon/status as it stood then, with the requirements and missions that changed it since. **State rewind is explicitly not this feature:** rolling actual repo/ledger state back is the rollback repair-mission path (CAM-MERGE-09), single-mission-grade; multi-mission state rewind (checkpoint-restore across dependent missions and external state) is out of scope and recorded as such. (§2 inv. 3, §4.2)

### 4.7 CAM-ROUTE — model routing and economics

- **CAM-ROUTE-01 [P1]** Capability registry per provider: models, quota windows, context limits, harness features, sanctioned-path and billing-pool attributes (time-varying, source-linked). (§6, §9)
- **CAM-ROUTE-02 [P1]** Per-project, user-editable policy table: role × task features → (harness, model, reasoning tier), with per-project provider allowlists; Camino ships defaults (planner/challenger/verifier cross-family by construction). (§6)
- **CAM-ROUTE-03 [P1]** The outcome ledger records per attempt: model, role, task features, verdicts, repair count, tokens where reportable, wall-clock, quota consumption best-effort, and human minutes via approval-surface dwell + weekly one-question self-report correction. (§6, §7.1)
- **CAM-ROUTE-04 [P2]** Router trajectories are terminal only at mission resolution with per-issue delivered flags; edit-cancelled attempts are excluded from model scorecards but included in mission economics; blocked-age past 14 days charges the abandonment penalty provisionally, reversed on delivery. (§6)
- **CAM-ROUTE-05 [P2]** The report stage: descriptive analytics on coarse cells (provider × model × role, pooled) — cost-to-green per issue trajectory, repair rates, survival. No significance claims. (§6)
- **CAM-ROUTE-06 [P1]** Scheduling is quota-aware: dispatch pauses at 85% estimated window consumption per provider (conservative default; refined from ledger data); quota exhaustion queues work rather than failing it. (§6)
- **CAM-ROUTE-07 [F]** Advisor stage (evidence-attached policy diffs) and bounded-actor stage per §6's conditional aspiration.
- **CAM-ROUTE-08 [P1]** A funded API fallback account per critical provider is a documented onboarding prerequisite for continuity. (§9)

### 4.8 CAM-STATE — durability

- **CAM-STATE-01 [P1]** Append-only event log in SQLite; every state transition is an event with actor, cause, and payload; derived views are rebuildable from events. (§2 inv. 3)
- **CAM-STATE-02 [P1]** The idempotency contract table (§4.4) is implemented per operation class; ambiguity is durably recorded before any retry; workflow dispatch is at-most-once with correlation-only run-name.
- **CAM-STATE-03 [P1]** Recovery runs under a single-writer lock; external facts reconcile from GitHub queries (UUID/natural-key correlation); decisions reconcile from the log.
- **CAM-STATE-04 [P1]** Attempt leases carry generations (fencing): every environment operation presents its generation; stale-generation writes are rejected; re-grant only after kill-confirm. Heartbeat 30s, TTL 5min. (§4.6)
- **CAM-STATE-05 [P1]** The full mission/issue/attempt transition table (states per §4.6 incl. blocked/escalated/cleanup-failed) ships as code + doc together; illegal transitions are rejected and logged.
- **CAM-STATE-06 [P1]** The daemon resumes cleanly from kill -9 at any point: unconfirmed intents reconcile, leases inspect, environments reset-before-use. *Accept:* a chaos test killing the daemon at random points during a pilot mission never produces duplicate side effects or lost state. 
- **CAM-STATE-07 [P2]** A scheduled janitor sweeps external test tenants, respecting lease generations.

### 4.9 CAM-SEC — security posture

- **CAM-SEC-01 [P1]** The control plane holds the sole GitHub credential (v1: fine-grained PAT scoped to configured repos); workers hold zero GitHub credentials; policy checks (scope, protected paths, contract reference, budgets) precede every push. (§5.1)
- **CAM-SEC-02 [P3]** A GitHub App identity replaces the PAT as the push/merge actor **before any autonomy tier unlocks**. (§4.2, §8.3)
- **CAM-SEC-03 [P1]** CI posture at onboarding: default workflow token read-only; Actions on `mission/*`/issue branches disabled or restricted to no-secret, read-only workflows; Camino's runner is the gating check on worker refs; pre-existing privileged main workflows are inventoried — secrets behind environment protection with required reviewers where the plan supports it, else warn/relocate/record-accepted-risk; persistent self-hosted runners unsupported. (§5.5, §13)
- **CAM-SEC-04 [P1]** Secrets vault: OS-keychain-backed storage for test-scoped credentials and (when used) API keys; injection into validation runner only; per-repo tenant isolation; scheduled rotation, per-mission rotation for sensitive tenants. (§5.3)
- **CAM-SEC-05 [P1]** The three-tier threat model is documented with the product; T3 and post-merge supply-chain residual risk are stated in onboarding material. (§5.3)
- **CAM-SEC-06 [P1]** Subscription credentials are never read, stored, transmitted, or proxied by Camino; sandbox composition references host credential state for official CLIs only. (§9)
- **CAM-SEC-07 [P2]** The injection red-team suite (hostile issue text, README, web content against planner and workers) runs and its findings are dispositioned before the first cruise-mode mission. (§11)
- **CAM-SEC-08 [P1]** Artifact retention: scrubbing before storage; quotas per §5.7 resolutions.
- **CAM-SEC-09 [P1]** Open-source release checklist exists from day one: license (permissive), no secrets in repo, compliance pass on provider policies, threat-model re-pricing for distribution. (§9)

### 4.10 CAM-AUTON — earned autonomy

- **CAM-AUTON-01 [P1]** Training mode is the default for every repo and after every revocation; all merges human-approved. (§8.3)
- **CAM-AUTON-02 [P3]** Tier 1 (issue→branch auto-merge) unlocks per repo after ≥50 consecutive human-confirmed issue-level agreements with zero false approvals under **joint**-distribution guards (risk × area × template combination must be represented in the window); presented as a policy heuristic, no statistical bound claimed. (§8.3)
- **CAM-AUTON-03 [P3]** Any disagreement, regression, revert, or post-merge failure revokes the tier instantly and returns the repo to training mode.
- **CAM-AUTON-04 [F]** Tier 2 (mission→main), tier 3 (quick tasks), tier 4 (plan auto-approval restricted to plans referencing only pre-existing accepted requirement IDs with no ledger additions — deterministically checked — plus an escalation class for consequential architectural decisions). (§8.3, §13)
- **CAM-AUTON-05 [P2]** Training mode toggle per mission for accelerated label collection is recorded in the ledger. (§4.2)
- **CAM-AUTON-06 [P1]** The autonomy state per repo/tier is visible on the board at all times.

### 4.11 CAM-OBS — attention and evaluation instrumentation

- **CAM-OBS-01 [P1]** Every mission records: David-minutes (dwell + weekly correction), tokens, dollars/quota, wall-clock, outcome, per-issue delivered flags. (§7.1)
- **CAM-OBS-02 [P1]** Attention budget: provisional 15 min routine attention per merged issue-equivalent (trailing 30-day), 45 min per mission plan; 2 consecutive weeks over budget forces the explicit choice dialog (raise budget / pause autonomy expansion / tighten ceremony). (§7.1, §13)
- **CAM-OBS-03 [P2]** Gate-quality tracking: every gate verdict vs eventual human decision and post-merge outcome (revert/hotfix within 30 days) accumulates as calibration data. (§8.3)
- **CAM-OBS-04 [P2]** Failure classification per attempt against the done-problem taxonomy (stub / wiring / self-report / dropped-requirement) plus infra/quota classes; the catalog drives detector investment. (§11)
- **CAM-OBS-05 [P2]** Escalation question quality is tracked (David rates: good question / obviously fine). (§7.1)

## 5. Registry resolutions (§13 → concrete)

1. **Revalidation retry bound:** 2 automatic rebuild-and-revalidate cycles per merge candidate, then escalate.
2. **User-observable path heuristics (initial):** `**/{components,pages,views,screens,routes}/**`, template/style files, API schema files (`openapi*`, `*.graphql`), CLI entrypoints, notification/email templates, i18n resources, migrations touching user-visible data, feature-flag definitions. Extensible per repo in `.camino/config.yml`.
3. **Attention numbers:** as CAM-OBS-02.
4. **Transition table:** per CAM-STATE-05; kill-confirm = SIGTERM → 30s → SIGKILL → process-tree-gone verification → lease release.
5. **Lease generations:** monotonic per environment in SQLite; 30s heartbeat, 5min TTL; runner rejects stale generations.
6. **Knowledge promotion rule-classes:** as CAM-CANON-09.
7. **Probe tooling:** Playwright specs + HTTP scripts in `.camino/probes/`, one file per requirement ID.
8. **Evidence-packet schema (v1):** per attempt `{attempt_id, issue_id, contract_hash, candidate_sha, base_sha, worker_head_sha, commands[], artifacts[{path,type,sha256,scrubbed}], checks[{name,sha,result,duration}], reviews[{model,family,verdict,summary}], retries, failure_class, verdict, created_at}`; mission rollup `{mission_id, requirement_map, gate_record, per_issue_delivered}`.
9. **Gap-register UI:** table with filters + disposition actions only (CAM-CORE-09).
10. **Webhooks:** post-v1.
11. **Quota values:** fetch ≤5,000 objects / 500 MB; workspace ≤2 GB; archive ≤500 MB compressed per attempt, retained 90 days or last 10 attempts per issue (whichever more).
12. **Multi-repo scheduling:** post-v1.
13. **Provider quota models:** track Claude 5-hour/weekly and Codex windows from adapter rate-limit signals; 85% dispatch pause threshold.
14. **Additional adapters:** Grok Build CLI is in v1 (CAM-EXEC-01, enablement gated on sanctioned-path verification); GLM-range adapters post-v1 behind the same interface and gate.
15. **Sequential-grade autonomy statistics:** not pursued; heuristics stand as stated.
16. **Deployment/post-deploy:** future scope.
17. **Round-5 additions:** attestation protocol (CAM-MERGE-02); tier-4 eligibility (CAM-AUTON-04); private-repo env-reviewer boundary (CAM-SEC-03); issue-PR closure (CAM-MERGE-07); canon freshness (CAM-CANON-02).

## 6. Technology defaults (recommended; substitutable with recorded justification)

TypeScript on Node 22 for daemon and GUI (largest agent training corpus; Playwright-native); Fastify daemon; React + Vite GUI served by the daemon; SQLite via better-sqlite3 (event tables + derived views; WAL mode); system `git` in pristine clones (hooks disabled by config); Octokit for GitHub REST; execa for process control; Docker Desktop containers for workers and validation; Playwright for probes; age-encrypted file or macOS Keychain for the vault. Camino's own repo conforms to the validatable-repo profile from day one (devcontainer, one-command test, seeded fixtures) — it must eventually be a repo Camino itself can operate on.

## 7. Build phases and exit criteria

### Phase 0 — Spikes (de-risk mechanics; no product code commitments)
1. **Dispatch spike:** one issue through each adapter → local commits in an isolated clone. Exit: both harnesses spawn, stream, cancel, and clean up under the adapter interface; quota classification observed.
2. **PRD-to-plan probe:** one real PRD through the planner + cross-family challenge; David times his review. Exit: question quality rated; checklist usability confirmed; review time recorded against budget.
3. **Quarantine attack suite:** executable tests for reachable-history smuggling, path-collision, `.gitattributes`, submodule introduction, size bombs. Exit: all attacks rejected. (These tests persist as CI for Camino itself.)
4. **Injection red-team baseline:** hostile issue/README/web content vs planner and one worker. Exit: findings catalogued and dispositioned into CAM-SEC hardening.

### Phase 1 — Walking skeleton (all [P1] requirements)
One repo, PAT, polling, training mode. Exit criteria: **one real feature mission (3–6 issues) delivered end-to-end on a real repository** — plan approved with its adversarial review attached, issues implemented by at least two adapter families, validated in clean environments, merged via merge-by-push through the integration branch to main with David approving against rendered evidence packets in the viewer, fold rendered, gap register populated; plus the chaos test (CAM-STATE-06) passing; plus economics instrumentation live.

### Phase 2 — Pilot missions (all [P2] requirements)
5–10 instrumented missions across feature and quick-task templates on the primary repo; brownfield induction executed on a second repo (data model proof); calibration replay (20–30 historical PRs + seeded defects) run as the gate's gross-failure screen. Exit: completion-rate and attention data collected and reviewed; failure catalog classified per taxonomy; gate screen passed (no gross failure mode); probe suite accumulating; David's routine attention within 1.5× budget.

### Phase 3 — Hardening and first autonomy (all [P3] requirements)
GitHub App identity; injection findings hardened; tier-1 window accumulation. Exit: **tier-1 auto-merge live on one repo** with the joint-distribution guard active, revocation tested (deliberately), and post-merge outcome tracking feeding gate calibration.

**v1 is done** when Phase 3 exits. No calendar commitments; each phase gates on its exit criteria.

## 8. Evaluation

North star (long-horizon): PRDs delivered end-to-end with only plan/new-intent/merge approvals, whose merges survive 30 days. v1 proxies: missions completed per week; canon coverage (behavioral class, labeled immature); gate agreement rate vs David + post-merge outcomes; David-minutes per merged issue-equivalent vs budget; cost per mission; escalation question quality. All computed from the ledger — no self-reported success anywhere, including Camino's own.

## 9. Risks and dependencies

1. **Provider policy drift (Anthropic headless economics; ToS posture):** registry attributes + funded API fallback + official-harness-only posture; re-checked on schedule. (§9)
2. **GitHub platform changes** (merge semantics, PAT/App capabilities): merge-by-push isolates the dependency to push + status APIs; the quarantine attack suite doubles as a platform regression canary.
3. **Model capability/quality shifts:** cross-family redundancy; adapter abstraction; ledger detects degradation as rising repair rates.
4. **Solo-builder bandwidth:** phases are strictly gated; the registry and change control resist scope creep; every phase produces a usable artifact.
5. **Agent-built build quality (Camino built by agents):** Camino's own repo gets the validatable-repo profile, cross-family review of its own PRs, and the quarantine/chaos/attack suites as CI from Phase 0 — the medicine applied to the doctor.
6. **Open-source exposure:** release checklist (CAM-SEC-09) gates publication; distribution re-prices the threat model.

## 10. Open questions

None blocking. Remaining unknowns are measured by phases (completion rates, attention costs, gate quality) rather than decided in advance — by design.
