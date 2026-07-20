# Camino — Product Requirements Document v1.4 — **BUILD-READY**

> **Accepted by David 2026-07-16 (triage option A).** Appendix A remains authoritative until superseded by Phase 1's typed state machine and its exhaustive transition-test suite, via a recorded consistency audit (every difference resolved by fixing code or amending the appendix). Falsification-review energy moves to the Phase-0 robustness suites and the code.

> 2026-07-16. Governs the v1 build. Derived from the cleared design [17-design-v5.md](design/17-design-v5.md) (five falsification rounds; clearance in [19-review-round5-clearance.md](design/19-review-round5-clearance.md)) and the founding brief [00-context-brief.md](design/00-context-brief.md). Design section references (§) point into design v5.
>
> **Change control:** this PRD is versioned; material changes require David's approval and, when architectural, a falsification pass. Requirements carry stable IDs (`CAM-AREA-NN`) so this document can seed Camino's own Living Canon once Camino manages its own repository.
>
> **Status: draft v1.4 — review halted for triage.** Revision history: v1.1 = David's review round (file-attach intake, evidence viewer → P1, falsification plan review framing, Grok Build CLI in v1, orchestrator channel [P2], temporal canon view [P2]). v1.2 = falsification round 1 resolved ([raw](design/20-adversarial-review-prd-round1.md), [dispositions](design/21-review-prd-round1-dispositions.md)). v1.3 = falsification round 2 resolved ([raw](design/22-adversarial-review-prd-round2.md), [dispositions](design/23-review-prd-round2-dispositions.md)). **v1.4 = falsification round 3's 15 findings resolved** ([raw](design/24-adversarial-review-prd-round3.md), [dispositions](design/25-review-prd-round3-dispositions.md)) — quick-task landing protocol unified (A.1b closed, tier authority scoped), approval rebinding on candidate rebuild, completion declared at landing with the cancelled-requirement rule, scope-exceeding repair path, pre-start attempt recovery, budget breach = kill-and-escalate per CAM-EXEC-03, mission `queued` state, evidence-class completion, archival ordering, acceptance tightening. **Round 3 fired the pre-committed stopping rule: no further prose review rounds pending David's decision on the path to build (see design/25).**

---

## 1. Product overview

Camino is a **local-first mission control plane for autonomous software development**. A PRD or a single task enters through a simple GUI (typed, pasted, or attached as a file); a planner asks its clarifying questions and constructs issues on an observable board; coding agents running on the user's existing subscriptions (Claude Code, Codex CLI, Grok Build CLI) implement each issue in isolated workspaces; work flows through independent validation into a mission integration branch and lands on main through a merge protocol in which **what was validated is bit-for-bit what lands**; a **Living Canon** records product intent, and a derived status layer records how much of that intent is demonstrably satisfied. The system is honest about "done": completion is observed by probes and evidence, never declared by the worker.

**User:** David — solo operator-developer, deeply technical, implementing via coding agents. **Distribution:** personal use first; open-source publication later (permissive license; a compliance pass before release). **Business model:** out of scope. **Platform:** macOS-first local daemon + browser GUI; GitHub for repositories.

**The promise, decomposed** (§1): plan quality, worker completion, merge-without-a-human, durability, escalation quality. Every requirement below serves one of these.

**v1 autonomy, honestly:** training mode is the default everywhere — David approves plans, issue merges, mission merges, and answers escalations. Autonomy is earned in tiers (§8.3) and is revocable. The end state is "interrupted only for genuine escalations and new-intent acceptance"; accepting new product intent is permanently the human role.

## 2. Goals and non-goals

**v1 goals:** (1) run real feature missions and quick tasks end-to-end on one configured repository with evidence-gated merges; (2) make the whole pipeline observable on a board David actually enjoys using; (3) instrument everything — cost, attention, outcomes — from the first dispatch; (4) establish the Living Canon + gap register on one brownfield repo; (5) earn tier-1 autonomy (issue→branch auto-merge) on at least one repo by accumulated evidence.

**v1 non-goals** (§8.1, §13): deployment and post-deployment validation; hosted/multi-tenant anything; multi-repo *execution* (the data model is multi-project from day one); webhooks (polling suffices); learned routing beyond the report stage; GLM-range adapters (Grok Build is in v1 — CAM-EXEC-01); parallel missions per repo and within-mission issue concurrency; sophisticated gap-register UI; persistent self-hosted CI runners (unsupported); production credentials anywhere.

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

- **CAM-CORE-01 [P1]** The daemon runs locally, binds 127.0.0.1 only, and serves the GUI; the GUI authenticates via a token from a 0600-permission file; state-changing endpoints carry CSRF protection. *Accept:* remote connection attempts fail; requests without the token are rejected; the token file's permissions are verified at startup (refuse to start otherwise); a cross-origin state-changing request without the CSRF token is rejected. (§5.4)
- **CAM-CORE-02 [P1]** A mission is created from pasted/typed PRD text, **an uploaded/attached file (markdown first-class)**, or as a single quick task. Attachment formats accepted in v1: `.md` and `.txt` only; every other format is rejected with a clear reason (format converters are **[F]**). *Accept:* all paths produce a mission record with the original content retained immutably; attached markdown renders in the mission view; a `.docx` fixture is rejected with the stated reason, never silently truncated. (§4.1)
- **CAM-CORE-03 [P1]** The board shows missions and their issues as cards with live states (planned, claimed, implementing, validating, merge-pending, merged, blocked, escalated, replanning, cancelled) streaming as events occur. *Accept:* a state change appears on the board within one polling interval without page reload.
- **CAM-CORE-04 [P1]** The GUI provides exactly these v1 actions: approve/edit plan, approve merge (issue, mission, quick task), answer escalation, pause/resume mission, cancel issue/attempt, disposition gap-register entries, view evidence. *Accept:* every action is recorded as an event with actor and timestamp, **and produces its specified state transition per Appendix A** (fixture per action).
- **CAM-CORE-05 [P1]** An escalation inbox lists everything awaiting David, each with its purpose-built artifact (plan diff, evidence packet, question). *Accept:* zero escalations means an empty inbox — no standing noise.
- **CAM-CORE-06 [P1]** The data model is multi-project (project → repo → missions) even though v1 executes on one repo. *Accept:* adding a second project requires no schema change. (§1)
- **CAM-CORE-07 [P1]** An evidence viewer renders evidence packets (schema §5 below) with artifact previews (logs, screenshots, traces). Promoted from P2 at David's direction: approving merges without inspectable evidence contradicts the product thesis, and verified outcomes are the feedback loop that gap analysis and repair depend on. Phase-1 scope is functional rendering (packet contents + artifact previews); presentation polish follows. *Accept:* every merge approval screen embeds the packet being approved with its artifacts previewable (logs, screenshots, traces render inline or open locally) and the gating/advisory distinction visible; no v1 merge is approvable without its packet. (§7.2)
- **CAM-CORE-08 [P1]** Missions serialize per repo: one active mission, plus the urgent lane. *Accept:* a second mission queued on the same repo waits, visibly. (§4.2)
- **CAM-CORE-09 [P1]** The gap register is viewable as a table with status tuples and disposition actions (design v0 places the register table in the skeleton). (§3.4, §8.1)
- **CAM-CORE-10 [P1]** All GUI reads of canon/requirement state render from the control-plane ledger (never by parsing repo canon text). *Accept:* ledger and GUI never disagree. (§3.1)

### 4.2 CAM-PLAN — intake, planning, contracts

- **CAM-PLAN-01 [P1]** The planner compiles PRD text into issues with acceptance criteria, streaming to the board as constructed; every assumption it had to invent is surfaced as a clarifying question before plan approval. *Accept:* across a fixture set of ambiguous PRDs with known planted ambiguities, each planted ambiguity surfaces **at plan approval as an item David must actively acknowledge** (answer the question or confirm the recorded assumption) before approval completes — passive display does not pass; a silent guess fails the fixture. (§4.1)
- **CAM-PLAN-02 [P1]** Intake produces a requirement checklist diff — every PRD requirement mapped to a proposed intent-ledger entry, unmapped text highlighted — which David confirms; confirmations create `accepted` ledger entries. *Accept:* a PRD sentence with no mapped requirement is visibly flagged. (§3.5)
- **CAM-PLAN-03 [P1]** **Falsification plan review:** before plan approval, a cross-family reviewer (different provider than the planner) runs a falsification-style critique — its mandate is to find defects, ambiguities, missing requirements, and bad premises, not to comment — and its findings attach to the approval screen. Quick tasks get a **mini falsification review**: a single bounded cross-family call with the same falsification mandate. This institutionalizes, per plan and at proportionate depth, the exact process that produced Camino's own design (author → non-family falsifier → human decision). *Accept:* no plan reaches approval without a second-family falsification critique attached. (§3.5)
- **CAM-PLAN-04 [P1]** Acceptance criteria freeze at plan approval into hash-referenced contract versions; every attempt and PR references its contract hash. (§4.1)
- **CAM-PLAN-05 [P1]** Editing an issue creates contract v(n+1); compatible in-flight work completes and revalidates against it, otherwise cancel-with-summary and replan; the planner runs a semantic impact assessment over dependent issues (conservative default: revalidate). *Accept:* an edit mid-attempt never mutates a contract in place; fixture edits exercise all three paths (compatible-complete-revalidate, cancel-replan, dependent invalidation) with the expected downstream state changes. (§4.1)
- **CAM-PLAN-06 [P1]** Mission classification (`canon-affecting`/`canon-neutral`) is proposed by the planner, provisional until the diff exists, and re-classified by deterministic triggers (migrations, auth/authz, dependency manifests, flags, boot/validation config, protected paths, user-observable surface paths). Fold suppression on quick tasks requires reviewer concurrence. **User-observability is adjudicated by heuristics *plus* independent judgment:** an item is observable if path heuristics (registry item 2) fire OR the planner judges it observable OR the cross-family reviewer judges it observable — the reviewer (CAM-PLAN-03, which already reviews every plan and quick task) **explicitly adjudicates observability per acceptance criterion**, and classifying any item as *not* observable requires reviewer concurrence, whether or not a heuristic fired. *Accept:* reviewer adjudication is recorded per criterion on every plan fixture (absence fails); a fixture criterion that is observable but outside the path list and missed by the planner is caught by reviewer adjudication and receives its gating check (a mission-gate check in P1 per CAM-VAL-13; a probe from P2). (§3.5)
- **CAM-PLAN-07 [P1]** Mission templates v1: `feature` and `quick-task`. **[F]** refactor, migration, UI-rewrite, greenfield-bootstrap.
- **CAM-PLAN-08 [P2]** Probes for user-observable acceptance criteria are authored at plan time (planner/reviewer side) as executable specs under `.camino/probes/`, reviewed as part of plan approval, and never modifiable by the worker being judged. *Accept:* a worker diff touching its own judging probe is rejected by the protected-path check. (§3.6)
- **CAM-PLAN-09 [P1]** Failed attempts hand off via structured summaries (not raw transcripts); two failures in one model family switch families; four escalate. (§4.3)
- **CAM-PLAN-10 [P2]** The urgent lane: an `urgent` quick task may cancel a repair-looping attempt at a safe checkpoint, lands on main first, then the mission branch merges main in and revalidates per impact assessment. (§4.2)
- **CAM-PLAN-11 [P1]** Plans emit **dependency edges** between issues (validated acyclic at plan approval); each issue's contract records its dependencies and the interfaces it exposes to dependents. *Accept:* a plan containing a dependency cycle is rejected before approval with the cycle named; declared interfaces persist on the contract record and are visible to dependent issues' context packs. (founding brief §Planning)
- **CAM-PLAN-12 [P1]** **Readiness and scheduling:** an issue is ready when all its dependencies are merged into the mission branch; v1 executes issues **sequentially per mission** in dependency order (within-mission concurrency is **[F]**); downstream reconciliation after contract changes follows CAM-PLAN-05. *Accept:* an issue whose dependency has not merged is never dispatched; at no time do two attempts run for the same mission; a contract-edit fixture demonstrably re-checks dependent readiness before re-dispatch. (founding brief §Execution loop)

### 4.3 CAM-EXEC — workers and quarantine

- **CAM-EXEC-01 [P1]** Worker adapters v1: Claude Code (official CLI), Codex CLI (official), and **Grok Build CLI (official; added at David's direction)**, spawned headless on David's subscriptions; an API-key adapter interface is defined (implementation **[F]**). Subscription auth is only ever exercised inside that vendor's official harness. **Per-adapter enablement is gated on sanctioned-path verification at onboarding.** For xAI, the *technical* headless path is verified — official Grok Build documentation supports scripted/headless operation and third-party integration — so the onboarding check is contractual/policy confirmation, recorded like every registry attribute. *Accept:* every **enabled** adapter passes the dispatch spike; an adapter whose sanctioned-path check fails is installable but visibly disabled with the reason recorded. (§5.2, §9)
- **CAM-EXEC-02 [P1]** Workers run in containers with isolated full clones — never linked worktrees — and zero GitHub credentials; provider auth is made available read-only per harness requirements. (§5.1)
- **CAM-EXEC-03 [P1]** Worker egress is allowlisted (package registries, docs domains per repo config); per-attempt budgets (tokens where reportable, wall-clock always) kill-and-escalate on breach. (§5.1)
- **CAM-EXEC-04 [P1]** Quarantine intake: shallow-fetch of the worker's final head only, with object-count/size budgets; policy checks on the final tree (scope vs contract, protected paths incl. `.gitattributes`/CI/`.camino/`, canonical path identity — case-fold and Unicode-normalization collisions rejected — submodule/gitlink introductions blocked, symlink targets checked, **reserved-name and trailing-dot aliases rejected**, tree size budget); then **squash-and-rebuild**: a fresh Camino-authored commit applying that tree onto the assigned base, **with worker attribution recorded in a commit trailer**. Worker merge commits are rejected. *Accept:* the Phase 0 quarantine rejection suite (§7, Phase 0 item 3) passes. (§5.1)
- **CAM-EXEC-05 [P1]** Worker workspace history is archived before cleanup under quotas (defaults: §5 registry item 11) for audit.
- **CAM-EXEC-06 [P1]** Adapters own stream parsing, cancellation, process-tree cleanup (kill-confirm sequence: §5 registry item 4), and quota-limit classification (a rate-limit failure is `quota-blocked`, never `requirement-failed`).
- **CAM-EXEC-07 [P1]** Context packs are assembled by the control plane: canon excerpts rendered with ledger status for the worker's branch context, the issue contract, approved knowledge entries, and provenance tags per content class. Workers never wander the docs folder. (§3.1, §3.7)
- **CAM-EXEC-08 [P2]** Candidate knowledge entries written by any attempt are immediately visible to repair attempts of the same issue (provenance-marked); promotion to approved happens via human batch or deterministic rule-classes only. (§3.7)
- **CAM-EXEC-09 [P1]** Untrusted text (issue bodies, repo content, web content) is treated as data; the untrusted-content robustness baseline (§7, Phase 0 item 4) runs before the first unattended mission and its findings gate hardening claims. (§5.3 T2)
- **CAM-EXEC-10 [P2]** **Worker question channel:** Camino exposes a local MCP server to workers with **read-only** context tools — search the canon (rendered with ledger status), read prior attempt summaries for the issue, read approved knowledge, ask the orchestrator (below). All channel responses carry **provenance tags** (source class per §5.3 T2) and are **bound to the attempt's contract version and context snapshot** — the channel can never serve a newer contract than the attempt is executing. *Accept:* each tool verified read-only (no channel call can write any store); responses carry provenance; a fixture where the contract is edited **and the canon/knowledge stores change mid-attempt** shows the channel still serving the attempt's frozen contract version and its snapshot-consistent canon/knowledge/summary context, never post-snapshot content; a worker missing canon-obtainable context retrieves it without raising a blocker. (§3.1, §3.7, §5.3)
- **CAM-EXEC-11 [P2]** **Orchestrator judgment (graduated blockers):** a worker's mid-attempt question goes to an orchestrator role that answers from existing sources (canon, ledger, prior attempts, knowledge, repo), redirects the worker, or escalates to David — hard stops become the last resort, not the first. Guardrails (invariant 2): the orchestrator answers questions of fact and context only; it **cannot modify scope, contracts, or acceptance criteria** — any question touching those routes to escalation; answers are logged as events with their sources; per-attempt Q&A budget (default 5 questions). *Accept:* escalation deflection rate is tracked in the ledger; in the robustness fixture suite (CAM-SEC-07), every scope- or contract-touching question routes to escalation and every planted-instruction question is answered from provenance-tagged sources or refused. (§2, §7.1)

### 4.4 CAM-VAL — validation and evidence

- **CAM-VAL-01 [P1]** Independent validation runs in a clean environment from the per-repo test-environment profile (boot recipe, seed/reset scripts); reset-before-use is the hygiene primary. (§5.3, §4.4)
- **CAM-VAL-02 [P1]** The validation runner — not the worker — receives test-scoped secrets from the local vault (OS keychain-backed); worker environments never contain them. *Accept:* worker env dumps contain no vault material. (§5.3)
- **CAM-VAL-03 [P1]** The validation environment has no outbound network except allowlisted test endpoints; retained artifacts pass literal secret-pattern scrubbing. The three-tier risk model (§5.3) is documented in-product; T3 residual risk is stated, not hidden. *Accept:* the Phase 0 egress test (connection attempts to non-allowlisted hosts fail from inside the environment) and scrubbing test (seeded secret literals in logs/artifacts are redacted in retained copies) both pass. (§11)
- **CAM-VAL-04 [P1]** Worker changes to boot/validation config or dependency manifests trigger reclassification and human review of the validation-config diff while any autonomy is active. (§5.3)
- **CAM-VAL-05 [P1]** Deterministic heuristics run on every candidate: TODO/stub scan, coverage-on-new-code; findings enter the gap register as *suspected*, ranked below probe evidence. **[P2]** unimported-file and unapplied-migration heuristics. (§3.6)
- **CAM-VAL-06a [P1]** **Mission-level cross-family review:** every mission→main candidate receives a semantic review by a model from a different provider than the primary implementer before the merge gate; verdicts are three-way (pass / fail / escalate-with-question). (§4.2, §4.3)
- **CAM-VAL-06b [P2]** **Issue-level risk-tiered review:** issues at medium+ risk (registry item 18) additionally get cross-family review at issue grain. (§4.3)
- **CAM-VAL-07 [P2]** Probe lifecycle: pass/fail/flaky/quarantined/infra-blocked; auto-retry ×2; environment-boot failures classify infra-blocked; repeated intermittents quarantine and open a maintenance item; the register consumes only stable signals; per-repo flake budget and detector-health view exist. (§3.6)
- **CAM-VAL-08 [P1]** Evidence packets per attempt (schema: §5 registry item 8), rolled up per mission with a gate record; gating evidence is produced only on Camino-authored candidates; worker-head checks are advisory and bound to the worker SHA. (§7.2)
- **CAM-VAL-09 [P2]** Pre-mission preflight boots the test environment and checks test-credential health; failures block dispatch with a specific escalation. (§5.3)
- **CAM-VAL-10 [P2]** Mutation testing runs against probes as improvement tooling (kill-rate reports); it is never presented as a false-negative estimate. (§3.6)
- **CAM-VAL-11 [P1]** Missing test resources discovered at validation classify `infra-blocked`, never requirement-failed. (§5.3)
- **CAM-VAL-13 [P1]** **Mission gate suite (the v0 probe stand-in):** at plan time, the planner/reviewer side authors a mission-level executable check suite covering the mission's user-observable outcomes (coverage reviewed at plan approval alongside the checklist); a designated **fast subset** runs at issue merges; the full suite gates the mission merge. It is worker-immutable like all judging checks. **From P2, mission checks are progressively absorbed into the per-requirement probe suite** — a mission check mapped to requirement IDs *becomes* those requirements' probes — so the mission gate is always defined as **the union of the current mission suite and accumulated per-requirement probes**, with no duplicate or superseded-but-required ambiguity. *Accept:* Phase 1's mission merges with this suite green at the exact candidate SHA; suite authorship is planner/reviewer-side (verifiably not the implementing worker); the fast subset is designated at plan approval; suite coverage of observable outcomes is part of the recorded plan-approval review; a worker diff touching the suite is rejected; an absorption fixture (a mission check mapped to requirement IDs in P2) shows the gate computing the union without duplication. (§8.1, §3.6)
- **CAM-VAL-14 [P2]** Missions declare required validation resources (test tenants, credentials, callbacks) at plan time; missing declarable resources escalate at plan approval. Combined with preflight (CAM-VAL-09) and infra-blocked classification (CAM-VAL-11), this is the designed three-layer answer. (§5.3)
- **CAM-VAL-12 [P2]** Every requirement carries a verification-method attribute (probe/audit/planner-check/guard/none); canon coverage reports the verified-live fraction of probe-method requirements, labeled immature until the probe suite accumulates. (§3.2)

### 4.5 CAM-MERGE — integration and landing

- **CAM-MERGE-01 [P1]** Each mission gets integration branch `mission/<id>`; issue PRs target it. **Quick tasks PR directly to main only when all three eligibility gates hold: single-issue ∧ canon-neutral (reviewer-concurred) ∧ non-sensitive (risk tier low, no sensitive-path trigger fired)** — failing any gate routes the task through an integration branch like a mission. *Accept:* fixtures per gate — a sensitive-path quick task, a canon-affecting quick task (reviewer non-concurrence), and a multi-issue "quick" task are each provably re-routed through an integration branch, **and an eligible quick task (all gates hold) provably lands via the direct A.1b path** — routing everything through integration fails the positive fixture. (§4.2)
- **CAM-MERGE-02 [P1]** **Merge-by-push:** the control plane constructs each merge commit locally, validates at that exact SHA (the CAM-VAL-13 fast subset for issue→branch; the full CAM-MERGE-05 mission gate for mission→main), publishes the candidate to a temporary ref (`camino/candidates/<uuid>`), attests it via the commit-status API (context `camino/validation`), verifies the target ref still equals the validated base, then fast-forward pushes. Any base movement rebuilds and revalidates. *Accept:* pushed SHA ≡ validated SHA on 100% of merges; a simulated race produces rebuild, not a stale merge. (§4.2)
- **CAM-MERGE-03 [P1]** Verdicts bind to (head SHA, base SHA) and expire rather than rebind; revalidation means re-execution. (§2 inv. 7)
- **CAM-MERGE-04 [P1]** After every issue merge, the fast suite runs on the new branch head; failures block the next merge and open a repair issue. (§4.2)
- **CAM-MERGE-05 [P1]** Mission→main requires: branch contains current main; **the mission gate green at the exact candidate** — the gate being the union of the current mission suite and accumulated per-requirement probes per CAM-VAL-13's absorption rule; cross-family mission review (CAM-VAL-06a); David's approval recorded as an event (until tier-2 autonomy). (§4.2)
- **CAM-MERGE-06 [P1]** Bounded rebuild-and-revalidate: at most 2 automatic cycles per candidate, then escalate. (§13 resolution)
- **CAM-MERGE-07 [P1]** Issue PRs are closed by Camino with linkage metadata (comment + label referencing the landing SHA) — GitHub only auto-recognizes indirect merges to the default branch. (§4.2)
- **CAM-MERGE-08 [P1]** Onboarding verifies: main branch protection with required checks (incl. `camino/validation`), required-up-to-date, non-bypass; failure blocks onboarding with instructions. (§4.2)
- **CAM-MERGE-09 [P2]** Rollback is a repair-mission type: opens with the mission-merge revert (fold included), recomputes ledger projections, walks the external-state checklist (migrations flagged at plan time carry down-paths where feasible), and escalates unrevertable effects. (§4.2)
- **CAM-MERGE-10 [P1]** Syncs are merges, never rebases, on all evidence-bearing branches.
- **CAM-MERGE-11 [P1]** Non-Camino pushes to watched branches raise ExternalEdit events (below) rather than being "prevented" — integrity by detection + freshness, per the PAT actor reality. (§4.2)
- **CAM-MERGE-12 [P1]** Mission terminal states: complete / complete-with-residue (descopes listed and counted against metrics) / abandoned, with per-issue delivered flags. (§3.4, §6)
- **CAM-MERGE-13 [P1]** **Mission PR lifecycle:** a mission→main PR is opened when the mission branch is created, carries the requirement checklist and links to evidence packets as they accumulate, serves as the review/audit surface, is marked merged by the landing push, and is retained. *Accept:* the PR exists from branch creation (fixture check at mission start); no mission merge occurs without it populated; after landing, GitHub shows it merged; it remains retrievable afterward. (§4.2)

### 4.6 CAM-CANON — intent ledger, canon, gaps, knowledge

> Amended 2026-07-20 (AMEND-9, approved by David in PR #51): CAM-CANON-01's "enforced by
> construction" is scoped to what a control-plane store can actually guarantee. The
> code-lifecycle EVENTS (merge / revert / abandon) are inexpressible as ledger mutations — they
> have no event name in the ledger vocabulary, no payload schema, no transition row, and no
> schema-permitted form — and the ledger's only write surface is the enumerated user-action
> methods, actor-bound to the user. What no store can verify is that a real user action, rather
> than a misbehaving in-process component, drove a legal user-action call; that residual sits
> inside the same single-OS-user in-process trust boundary the state directory's 0700 mode
> (WP-102) and the writer lock (WP-104) already define, and a capability token would not close it
> (its minting authority is itself trusted in-process code, so it moves the boundary rather than
> removing it). Surfaced by the WP-109 review (rounds 1–4). Raw findings and dispositions are on
> PR #51; the scoped verify pass ran against the application commit and its record follows in that
> thread.

- **CAM-CANON-01 [P1]** The intent ledger lives in the control plane; only user actions (intake confirmations, dispute answers, descope approvals) mutate it. *Accept:* no code path can express intent mutation from merge/revert/abandon events — those events have no ledger vocabulary, decision-path, or schema-permitted form, and the ledger's only write surface is the enumerated user-action methods (actor-bound to the user); enforced by construction and covered by tests. The residual in-process caller-intent trust boundary is named (AMEND-9 note above). (§3.1)
- **CAM-CANON-02 [P1]** Canon text in the repo is the rendered projection of accepted intent, updated by folds riding mission PRs; it carries a rendered-at marker; a standalone intent-only fold triggers when ledger-vs-text divergence exceeds 5 requirements or 7 days. (§3.1, §13)
- **CAM-CANON-03 [P1]** Status is derived per requirement as the design §3.1 tuple, normative here: intent-disposition (`proposed`→`accepted` | `disputed`→(`resolved-accepted`|`assumed`|`descoped`)) × implementation-state per branch context (`absent` | `present-on(<branch>)` | `on-main` | `suspected-absent`) × evidence-state (`unverified` | `verified-live` | `stale` | `blocked`). Rules carried verbatim: verification never inherits across branch changes (a branch that touched R renders R's branch version unverified); reverts and external edits recompute projections; only user actions move intent-dispositions. Context packs and GUI render the tuple for the reader's context. *Accept:* fixture walks of every transition, including revert and stale-evidence downgrades, produce the design-specified tuples. (§3.1)
- **CAM-CANON-04 [P2]** Brownfield induction builds a draft canon with per-statement provenance and confidence; conflicts become `disputed` plus a blast-radius-ranked question queue resolved lazily; `assumed` exists for unknowable history; induction also establishes the validatable-repo profile. (§3.3)
- **CAM-CANON-05 [P1]** The gap register holds requirement → status tuple → evidence provenance → disposition; waivers exist only for detector false positives; real unmet requirements stay open or are descoped by the user. (§3.4)
- **CAM-CANON-06 [P1]** ExternalEdit lifecycle: polling detects commits, branch create/delete, PR field changes, protection changes, non-ff ref moves on watched branches; transient A→B→A transitions between polls are a documented v1 limitation. External commits get a canon-impact scan producing proposed deltas as questions to David; his answer — never the diff — authorizes intent changes. Active missions pause affected issues pending impact assessment. *Accept:* a fixture external commit adding user-visible behavior produces a proposed-delta question and no automatic canon change; a fixture deletion of a verified requirement's implementation produces `suspected-absent` plus a register question. (§4.5)
- **CAM-CANON-07 [P2]** Folds update canon rendering, supersede contradicted text, delete stale files; fold approval starts human and joins the autonomy ladder. Canon-neutral quick tasks: no fold; register updates batch weekly. (§3.5)
- **CAM-CANON-08 [P2]** Periodic audit every 10 missions: canon consistency plus sampled PRD-vs-canon checks. (§3.5)
- **CAM-CANON-09 [P1]** `.camino/knowledge.md` lifecycle: candidates (immediate, provenance + commit/base validity) → approved (human batch or deterministic rule-classes: command sequences succeeding ≥3 times across ≥2 missions; quarantine-confirmed flaky-test annotations); only approved entries enter other missions' packs; candidates are visible to same-issue repair attempts, provenance-marked. **Entries carry scope (repo area or global) and expiry; entries invalidate on revert of their validity base; a candidate contradicting an approved entry escalates to curation rather than silently coexisting.** (§3.7)
- **CAM-CANON-10 [P1/P2]** Mission completion is gate-defined, not "all issues merged." **P1 semantics (honest v0, expressed strictly in the CAM-CANON-03 tuple):** completion is declared only when the landing push is **confirmed** (A.1 `merging → complete`), never at approval — the gate (CAM-VAL-13 green + CAM-VAL-06a review + David's approval) licenses the merge; the confirmed push completes it. **Cancelled-requirement rule:** an `accepted` requirement whose implementing work was cancelled and not descoped blocks completion — the mission either continues (repair/replan) or the requirement is explicitly descoped (a user action), landing the mission as complete-with-residue. Requirement statuses stay honest: implementation-state becomes `on-main` only on confirmed landing; **evidence-state remains `unverified` per requirement** unless a requirement-mapped check exists — mission-suite results are recorded as mission-scope evidence on the packet, never as per-requirement `verified-live`. P1 explicitly does **not** claim per-requirement demonstration, and the coverage metric reflects that (labeled immature per CAM-VAL-12). **P2 semantics:** per-requirement demonstration by verification method as probes accumulate. (§4.2, §3.2, §8.1)
- **CAM-CANON-11 [P2]** **Temporal canon view (display-only):** the GUI renders the project's evolution over time — per-requirement history (accepted → built → verified, with the PRD/mission that drove each transition), canon text diffs per fold, and coverage-over-time. Because the event log and intent ledger are append-only, this is a projection over existing data, including **time-travel viewing**: reconstruct **Camino's recorded state** — the ledger, status projections, and canon renderings as Camino knew them — as of any past event by replay. (What it reconstructs is the recorded projection, not objective repository history: undetected external transitions between polls are outside it, per invariant 3 and the stated polling limits.) *Accept:* selecting a past date renders the recorded canon/status as of that date, with the requirements and missions that changed it since. **State rewind is explicitly not this feature:** rolling actual repo/ledger state back is the rollback repair-mission path (CAM-MERGE-09), single-mission-grade; multi-mission state rewind (checkpoint-restore across dependent missions and external state) is out of scope and recorded as such. (§2 inv. 3, §4.2)

### 4.7 CAM-ROUTE — model routing and economics

- **CAM-ROUTE-01 [P1]** Capability registry per provider: models, quota windows, context limits, harness features, sanctioned-path and billing-pool attributes (time-varying, source-linked). (§6, §9)
- **CAM-ROUTE-02 [P1]** Per-project, user-editable policy table: role × task features → (harness, model, reasoning tier), with per-project provider allowlists; Camino ships defaults (planner/challenger/verifier cross-family by construction). (§6)
- **CAM-ROUTE-03 [P1]** The outcome ledger records per attempt: model, role, task features, verdicts, repair count, tokens where reportable, wall-clock, quota consumption best-effort, and human minutes via approval-surface dwell + weekly one-question self-report correction. (§6, §7.1)
- **CAM-ROUTE-04 [P2]** Router trajectories are terminal only at mission resolution with per-issue delivered flags; edit-cancelled attempts are excluded from model scorecards but included in mission economics; blocked-age past 14 days charges the abandonment penalty provisionally, reversed on delivery. (§6)
- **CAM-ROUTE-05 [P2]** The report stage: descriptive analytics on coarse cells (provider × model × role, pooled) — cost-to-green per issue trajectory, repair rates, survival. No significance claims. (§6)
- **CAM-ROUTE-06 [P1]** Scheduling is quota-aware: dispatch pauses at 85% estimated window consumption per provider (conservative default; refined from ledger data); quota exhaustion queues work rather than failing it. (§6)
- **CAM-ROUTE-07 [F]** Advisor stage (evidence-attached policy diffs) and bounded-actor stage per §6's conditional aspiration.
- **CAM-ROUTE-08 [P1]** A funded API fallback account per critical provider is a documented onboarding prerequisite, **and the fallback path is implementable on day one: the same official CLIs re-authenticated with API keys** (both Claude Code and Codex CLI natively support API-key auth), executed as a documented configuration runbook — no new adapter required. The [F] API-key adapter interface covers *additional* providers. *Accept:* the runbook is exercised during Phase 2 for **each critical subscription provider** (Anthropic and OpenAI: one mission issue each completed under API-key auth). (§9)

### 4.8 CAM-STATE — durability

> Amended 2026-07-20 (AMEND-8, approved by David in PR #47): CAM-STATE-02's dispatch clause gains
> the automatic-path qualification — the previously unqualified "at-most-once" over-promised
> relative to the §4.4 table it cites (no automatic retry; duplicates tolerable on worker-ref
> advisory CI), surfaced by the WP-104 falsification review (rounds 2–3). Raw finding and
> disposition are recorded on PR #47; the scoped verify pass ran against the application commit
> and its record follows in that thread.

- **CAM-STATE-01 [P1]** Append-only event log in SQLite; every state transition is an event with actor, cause, and payload; derived views are rebuildable from events. (§2 inv. 3)
- **CAM-STATE-02 [P1]** The idempotency contract table (§4.4) is implemented per operation class; ambiguity is durably recorded before any retry; workflow dispatch is at-most-once with correlation-only run-name — at-most-once binds every automatic path (no automatic retry on lost-response ambiguity); an explicit David-authorized retry of a durably recorded ambiguity may knowingly duplicate a run, which §4.4 prices as tolerable (worker-ref CI is advisory-only) and which stays visible via the correlation stamp. *Accept:* seeded duplicate-intent fixtures (replayed intents for each operation class) produce zero duplicate external side effects and one recorded ambiguity per genuinely ambiguous case.
- **CAM-STATE-03 [P1]** Recovery runs under a single-writer lock; external facts reconcile from GitHub queries (UUID/natural-key correlation); decisions reconcile from the log.
- **CAM-STATE-04 [P1]** Attempt leases carry generations (fencing): every environment operation presents its generation; stale-generation writes are rejected; re-grant only after kill-confirm. Heartbeat 30s, TTL 5min. **The validation environment has exactly one fenced owner at any time**, and the janitor honors lease generations. (§4.6)
- **CAM-STATE-05 [P1]** The mission/issue/attempt state machines are **specified normatively in Appendix A** (states, events, guards, interrupts) and ship as code + doc together; illegal transitions are rejected and logged.
- **CAM-STATE-06 [P1]** The daemon resumes cleanly from kill -9: unconfirmed intents reconcile, leases inspect, environments reset-before-use. *Accept:* a **deterministic seeded kill-point suite** — for every side-effect class in the §4.4 idempotency table, kill points **on both sides of the external call** (after intent recorded / before the call, and after the call succeeds / before confirmation recorded — the dangerous ambiguity window) — recovers every case with zero duplicate side effects and zero lost state; random-kill runs supplement but do not substitute.
- **CAM-STATE-07 [P2]** A scheduled janitor sweeps external test tenants, respecting lease generations.

### 4.9 CAM-SEC — security posture

- **CAM-SEC-01 [P1]** The control plane holds the sole GitHub credential (v1: fine-grained PAT scoped to configured repos); workers hold zero GitHub credentials; policy checks (scope, protected paths, contract reference, budgets) precede every push. (§5.1)
- **CAM-SEC-02 [P3]** A GitHub App identity replaces the PAT as the push/merge actor **before any autonomy tier unlocks**. (§4.2, §8.3)
- **CAM-SEC-03 [P1]** CI posture at onboarding: default workflow token read-only; Actions on **all Camino-managed namespaces — `mission/*`, issue branches, and `camino/**` (including candidate refs)** — disabled or restricted to no-secret, read-only workflows; onboarding statically verifies that no existing workflow trigger can fire with secrets or write tokens on those namespaces; Camino's runner is the gating check on worker-derived refs; pre-existing privileged main workflows are inventoried — secrets behind environment protection with required reviewers where the plan supports it, else warn/relocate/record-accepted-risk; persistent self-hosted runners unsupported. *Accept:* a fixture repo with a secret-bearing `on: push branches: ['**']` workflow fails onboarding with the workflow named. (§5.5, §13)
- **CAM-SEC-04 [P1]** Secrets vault: OS-keychain-backed storage for test-scoped credentials and (when used) API keys; delivery into the validation runner only; per-repo tenant isolation; scheduled rotation, per-mission rotation for sensitive tenants. (§5.3)
- **CAM-SEC-05 [P1]** The three-tier risk model is documented with the product; T3 and post-merge supply-chain residual risk are stated in onboarding material. (§5.3)
- **CAM-SEC-06 [P1]** Subscription credentials are never read, stored, transmitted, or proxied by Camino; sandbox composition references host credential state for official CLIs only. (§9)
- **CAM-SEC-07 [P2]** The untrusted-content robustness suite (planted instructions in issue text, README, web content) runs against **planner, workers, and the orchestrator question channel**, and its findings are dispositioned (accepted-risk or hardened, recorded per finding) before the first cruise-mode mission. (§11)
- **CAM-SEC-08 [P1]** Artifact retention: scrubbing before storage; quotas per §5 registry item 11.
- **CAM-SEC-09 [P1]** Open-source release checklist exists from day one: license (permissive), no secrets in repo, compliance pass on provider policies, risk-model re-pricing for distribution. (§9)

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
2. **User-observable path heuristics (initial):** `**/{components,pages,views,screens,routes}/**`, template/style files, API schema files (`openapi*`, `*.graphql`), CLI entrypoints, notification/email templates, i18n resources, migrations touching user-visible data, feature-flag definitions. Extensible per repo in `.camino/config.yml`. **Heuristics are the floor, not the decision:** planner judgment can add observability, and reviewer concurrence is required to remove it (CAM-PLAN-06).
3. **Attention numbers:** as CAM-OBS-02.
4. **Transition table:** normative in **Appendix A**; kill-confirm = SIGTERM → 30s → SIGKILL → process-tree-gone verification → lease release.
5. **Lease generations:** monotonic per environment in SQLite; 30s heartbeat, 5min TTL; runner rejects stale generations.
6. **Knowledge promotion rule-classes:** as CAM-CANON-09.
7. **Probe tooling:** Playwright specs + HTTP scripts in `.camino/probes/`, one file per requirement ID.
8. **Evidence-packet schema (v1):** per attempt `{attempt_id, issue_id, contract_hash, candidate_sha, base_sha, worker_head_sha, commands[{cmd, sha, base_sha, class}], artifacts[{path, type, sha256, scrubbed, sha, base_sha, class}], checks[{name, sha, base_sha, result, duration, class}], reviews[{model, family, verdict, summary, sha, base_sha, class}], exclusions[{item, reason, sha, base_sha, class}], waivers[{register_ref, reason, actor, sha, base_sha, class}], retries, failure_class, verdict, created_at}` — **every item carries its own (sha, base_sha) identity and a `class: advisory|gating` marker** (worker-head evidence is advisory; only Camino-authored-candidate evidence is gating, per design §7.2); mission rollup `{mission_id, requirement_map: req_id→[gating evidence refs], gate_record, per_issue_delivered}`. The viewer renders the advisory/gating distinction and the exclusion/waiver lists.
9. **Gap-register UI:** table with filters + disposition actions only (CAM-CORE-09).
10. **Webhooks:** post-v1.
11. **Quota values:** fetch ≤5,000 objects / 500 MB; workspace ≤2 GB; archive ≤500 MB compressed per attempt, retained 90 days or last 10 attempts per issue (whichever more).
12. **Multi-repo scheduling:** post-v1.
13. **Provider quota models:** track Claude 5-hour/weekly, Codex, and Grok Build windows from adapter rate-limit signals; 85% dispatch pause threshold; window shapes refined from ledger observation per provider.
14. **Additional adapters:** Grok Build CLI is in v1 (CAM-EXEC-01, enablement gated on sanctioned-path verification); GLM-range adapters post-v1 behind the same interface and gate.
15. **Sequential-grade autonomy statistics:** not pursued; heuristics stand as stated.
16. **Deployment/post-deploy:** future scope.
17. **Round-5 additions:** attestation protocol (CAM-MERGE-02); tier-4 eligibility (CAM-AUTON-04); private-repo env-reviewer boundary (CAM-SEC-03); issue-PR closure (CAM-MERGE-07); canon freshness (CAM-CANON-02).
18. **Risk-tier and area policy (PRD rounds 1–2):** three risk tiers — **high** (deterministic floor: auth/authz, payments/billing, data migrations, secrets/credential handling, security-sensitive paths per repo config), **medium** (user-observable behavior changes), **low** (internal refactors, docs, tests). The planner proposes a tier per issue; the deterministic path rules set a floor the tier cannot fall below; David may raise a tier, never lower it below the floor; tiers persist on the issue record and drive review depth (CAM-VAL-06b), quick-task eligibility (CAM-MERGE-01), and the autonomy joint-distribution guard (CAM-AUTON-02). **Area taxonomy:** a per-repo glob→area map in `.camino/config.yml` (shipped defaults: frontend, backend, api, data-migrations, auth, infra-ci, docs-tests); an issue's **area-set** is derived deterministically from its final diff paths and persisted on the issue record; the joint-distribution guard matches on the exact (risk tier, area-set, template) combination. Sensitive-path and area maps extensible per repo.

## 6. Technology defaults (recommended; substitutable with recorded justification)

TypeScript on Node 22 for daemon and GUI (largest agent training corpus; Playwright-native); Fastify daemon; React + Vite GUI served by the daemon; SQLite via better-sqlite3 (event tables + derived views; WAL mode); system `git` in pristine clones (hooks disabled by config); Octokit for GitHub REST; execa for process control; Docker Desktop containers for workers and validation; Playwright for probes; age-encrypted file or macOS Keychain for the vault. Camino's own repo conforms to the validatable-repo profile from day one (devcontainer, one-command test, seeded fixtures) — it must eventually be a repo Camino itself can operate on.

## 7. Build phases and exit criteria

### Phase 0 — Spikes (de-risk mechanics; no product code commitments)
1. **Dispatch spike:** one issue through **each enabled adapter** (Claude Code, Codex, Grok Build) → local commits in an isolated clone. Exit: every enabled harness spawns, streams, cancels, and cleans up under the adapter interface; quota classification observed per provider.
2. **PRD-to-plan probe:** one real PRD through the planner + cross-family falsification review; David times his review. Exit: David rates each clarifying question (good / obviously-fine) with ≥70% rated good; checklist usability confirmed; review time recorded against budget.
3. **Quarantine rejection suite:** executable tests for reachable-history carry-in, path-collision (case-fold + Unicode normalization), reserved-name and trailing-dot aliases, **out-of-tree symlink targets**, `.gitattributes` edits, CI-definition edits, out-of-scope diffs, worker merge commits, submodule introduction, size-budget breaches, and a **candidate-ref workflow-trigger case** (an untrusted workflow must not fire on `camino/**`). Exit: all cases rejected. (These tests persist as CI for Camino itself.)
4. **Untrusted-content robustness baseline:** planted-instruction issue/README/web content vs planner and one worker (extended to the orchestrator channel in Phase 2 per CAM-SEC-07). Exit: every finding catalogued with a recorded disposition (hardened or accepted-risk with reason).
5. **Validation-environment egress and scrubbing tests** (design §11 item 6): non-allowlisted egress fails from inside the environment; seeded secret literals are redacted in retained artifacts. Exit: both pass.

### Phase 1 — Walking skeleton (all [P1] requirements)
One repo, PAT, polling, training mode. Exit criteria: **one real feature mission (3–6 issues) delivered end-to-end on a real repository** — plan approved with its falsification review attached, issues implemented by at least two adapter families, validated in clean environments, merged via merge-by-push through the integration branch to main with David approving against rendered evidence packets in the viewer, fold rendered, gap register populated; plus the chaos test (CAM-STATE-06) passing; plus economics instrumentation live.

### Phase 2 — Pilot missions (all [P2] requirements)
5–10 instrumented missions across feature and quick-task templates on the primary repo; brownfield induction executed on a second repo (data model proof); calibration replay (20–30 historical PRs + seeded defects) run as the gate's gross-failure screen; the API-key fallback runbook exercised for each critical subscription provider (CAM-ROUTE-08). Exit: completion-rate and attention data collected and reviewed; failure catalog classified per taxonomy; **gate screen passed, defined as zero approvals among ≥5 seeded defects spanning the four done-problem classes (stub, wiring, self-report, dropped-requirement) plus one security-class defect**; probe suite accumulating; David's routine attention within 1.5× budget.

### Phase 3 — Hardening and first autonomy (all [P3] requirements)
GitHub App identity; every open robustness finding carries a recorded disposition (hardened or accepted-risk); tier-1 window accumulation. Exit: **tier-1 auto-merge live on one repo** with the joint-distribution guard active, revocation exercised deliberately (a seeded disagreement demonstrably returns the repo to training mode), and post-merge outcome tracking feeding gate calibration.

**v1 is done** when Phase 3 exits. No calendar commitments; each phase gates on its exit criteria.

## 8. Evaluation

North star (long-horizon): PRDs delivered end-to-end with only plan/new-intent/merge approvals, whose merges survive 30 days. v1 proxies: missions completed per week; canon coverage (behavioral class, labeled immature); gate agreement rate vs David + post-merge outcomes; David-minutes per merged issue-equivalent vs budget; cost per mission; escalation question quality. All computed from the ledger — no self-reported success anywhere, including Camino's own.

## 9. Risks and dependencies

1. **Provider policy drift (Anthropic headless economics; ToS posture):** registry attributes + funded API fallback + official-harness-only posture; re-checked on schedule. (§9)
2. **GitHub platform changes** (merge semantics, PAT/App capabilities): merge-by-push isolates the dependency to push + status APIs; the quarantine rejection suite doubles as a platform regression canary.
3. **Model capability/quality shifts:** cross-family redundancy; adapter abstraction; ledger detects degradation as rising repair rates.
4. **Solo-builder bandwidth:** phases are strictly gated; the registry and change control resist scope creep; every phase produces a usable artifact.
5. **Agent-built build quality (Camino built by agents):** Camino's own repo gets the validatable-repo profile, cross-family review of its own PRs, and the quarantine/chaos/robustness suites as CI from Phase 0 — the medicine applied to the doctor.
6. **Open-source exposure:** release checklist (CAM-SEC-09) gates publication; distribution re-prices the risk model.

## 10. Open questions

None blocking. Remaining unknowns are measured by phases (completion rates, attention costs, gate quality) rather than decided in advance — by design.

## Appendix A — Normative state machines (mission / issue / attempt)

> Amended 2026-07-19: AMEND-1..5 applied per change control (approved by David; proposals and
> dispositions recorded in [docs/design/26-appendix-a-audit.md](design/26-appendix-a-audit.md) §3).
>
> Amended 2026-07-19 (AMEND-6, approved by David in PR #45): the serialization preamble gains the
> urgent-lane clause — the preamble's at-most-one sentence previously contradicted the lane its own
> rows define (A.1#15/A.1#20). Approved wording applied below with one placement adjustment for
> grammar (the lane clause attaches to the at-most-one rule it modifies; the queued/FIFO text is
> unchanged as its own sentence) — proposal, application, and the scoped verify pass are recorded
> on PR #45. The same clause is noted on the plan's WP-103 accept bullet.
>
> Amended 2026-07-20 (AMEND-7, approved by David): the serialization preamble gains the
> lane-scheduling sentences, naming the three scheduler policies the daemon implements and tests
> (parked-or-parkable urgent admission, symmetric primary admission, per-lane urgent-first
> activation) and pinning FIFO activation as per-lane — the prior wording covered capacity and
> parking only and read as a single global queue. The option was recorded at WP-103 close (PR #45
> thread); David decided completion 2026-07-20. Application and the scoped verify pass are recorded
> on PR #49; the pass runs against the application commit and its record follows in that thread.

Transitions not listed are illegal: attempted illegal transitions are rejected and logged (CAM-STATE-05). Every transition emits an event with actor and cause. **State sets:** mission states = {**queued**, draft, planned, approved, executing, awaiting-merge-approval, merging, paused-external, paused-urgent, paused-manual, escalated, blocked} (active) ∪ {complete, complete-with-residue, abandoned, **re-routed** (A.1b only)} (terminal). **Serialization:** at most one mission per repo occupies an *execution-bearing* state (approved through merging, including interrupt states entered from that span; a manually paused mission holds the slot iff it held it when paused), plus at most one urgent quick task on the urgent lane (CAM-CORE-08); while the urgent lane actively executes, the primary holder is parked in an interrupt state. Additional missions wait in `queued` — visibly, satisfying CAM-CORE-08 — and activate FIFO when a slot frees (intake/planning states may proceed concurrently since they touch no workspace). Lane admission is symmetric: the urgent lane admits an urgent quick task only while the primary holder (if any) is parked in an interrupt state or parkable (a mission on the integration-branch route in `executing` — the only state with an urgent-preemption row; a quick task holding the primary slot is never preempted), and the primary slot admits a mission only while the urgent lane is empty; a mission approved while its lane is unavailable waits in `queued`. Activation from `queued` is FIFO per lane — ordered by first entry into `queued` within that lane, not a single global queue — with the urgent lane activating first: an urgent task never waits behind older queued primary missions. Issue active = {waiting-deps, ready, queued-quota, claimed, implementing, validating, merge-pending, blocked, escalated, replanning}; issue terminal = {merged, cancelled} (per-issue *delivered* flags set at mission resolution, CAM-MERGE-12). Attempt active = {running, submitted}; attempt terminal = {succeeded, failed, cancelled, expired, killed-budget, quota-blocked}, each followed by the single archival step (A.4 item 5) → `archived`.

### A.1 Mission (integration-branch route)

| From | Event | Guard | To |
|---|---|---|---|
| — | mission created (PRD intake, or quick task re-routed per A.1b) | — | `draft` |
| `draft` | plan constructed + falsification review attached | checklist rendered | `planned` |
| `planned` | David approves plan + checklist | dependency DAG acyclic; execution slot free, else `queued` | `approved` |
| `planned` | David rejects / edits | — | `draft` |
| `queued` | execution slot frees | FIFO | `approved` |
| `approved` | integration branch + mission PR created | onboarding checks green | `executing` |
| `executing` | all issues terminal ∧ no accepted requirement stranded by a cancelled issue (CAM-CANON-10 rule) ∧ mission gate green ∧ CAM-VAL-06a review pass | A.4 ordering satisfied (fold on branch, rollup + PR populated); freshness holds | `awaiting-merge-approval` |
| `executing` | mission gate red, or CAM-VAL-06a review fail | repair fits approved scope | `executing` (repair issues created `ready` under mission scope) |
| `executing` | mission gate red, repair **exceeds** approved scope | — | `escalated` (scope decision is David's) |
| `awaiting-merge-approval` | **David approves mission merge** (event; **approval binds to the candidate SHA and packet hash**), or tier-2 autonomy active | — | `merging` |
| `awaiting-merge-approval` | David rejects with reason | — | `executing` (repair/replan work created from the reason) |
| `merging` | base moved → candidate rebuilt and revalidated | new candidate green | `awaiting-merge-approval` (**a new candidate requires a new approval — approvals never transfer between SHAs**) |
| `merging` | rebuilt candidate red | — | `executing` (repair per red-gate rows) |
| `executing` | ExternalEdit impact on mission scope | — | `paused-external` |
| `executing` | urgent task claims the lane | — | `paused-urgent` |
| any active | **David pauses** (CAM-CORE-04) | running attempt checkpoints or completes | `paused-manual` |
| `paused-manual` | David resumes | — | prior state (recorded) |
| `executing` | escalation raised requiring David | — | `escalated` |
| `executing` | blocker with no automated path | — | `blocked` |
| `paused-external` / `paused-urgent` | impact assessment complete / urgent landed + resync | affected issues revalidated or re-queued | `executing` |
| `escalated` / `blocked` | David answers / obstacle cleared | affected issues transitioned per answer | `executing` |
| `merging` | merge-by-push lands on main, **push confirmed** | pushed SHA ≡ approved candidate SHA | `complete` / `complete-with-residue` (descoped requirements listed; completion and `on-main` statuses are declared here and only here) |
| `merging` | base moved > retry bound | 2 rebuilds exhausted | `escalated` |
| any active | David abandons mission | intent ledger untouched | `abandoned` |

### A.1b Quick task (all three CAM-MERGE-01 gates hold)

A.1b inherits A.1's rows for `queued`, plan rejection (`planned → draft`), manual pause/resume, `escalated`/`blocked` and their recoveries, and abandonment — with the same guards. Rows below define what differs. **Landing authority: David or tier-3 autonomy only** — A.2's tier-1 row is explicitly scoped to mission-branch targets and never applies to a main candidate. **Validation scope for quick-task→main (completing CAM-MERGE-02):** the task's full contract checks plus the repo fast suite, at the exact main candidate.

| From | Event | Guard | To |
|---|---|---|---|
| — | quick task intake | — | `draft` |
| `draft` | contract + mini falsification review attached | observability adjudicated per criterion | `planned` |
| `planned` | David approves | risk tier low; neutral concurred; single issue; execution slot free, else `queued` | `approved` |
| `approved` | the single issue executes per A.2 **with target = main candidate; no integration branch, no fold; A.2's merge rows do not apply** | — | `executing` |
| `executing` | quick-task validation green at the main candidate ∧ evidence packet populated | freshness vs main holds | `awaiting-merge-approval` |
| `executing` | validation red | retry policy per A.2 (family switch after 2 failures) | `executing`; 4 failures → `escalated` |
| `awaiting-merge-approval` | **David approves (or tier-3 autonomy)**; approval binds to candidate SHA | — | `merging` (merge-by-push direct to main) |
| `awaiting-merge-approval` | David rejects with reason | — | `executing` (repair attempt) |
| `merging` | base moved → rebuild + revalidate | green | `awaiting-merge-approval` (new approval required) |
| `merging` | rebuilds exhausted (2) | — | `escalated` |
| `merging` | push confirmed | pushed SHA ≡ approved candidate SHA | `complete` |
| any active | any CAM-MERGE-01 gate found violated (e.g., diff triggers reclassification) | work summary carried over; branch carried over where the task had entered execution | **`re-routed` (terminal)** — a new A.1 mission is created referencing this record; the quick task ends before the mission activates, preserving serialization |
| `merging` | rebuilt candidate red | — | `executing` (repair attempt) |

### A.2 Issue

| From | Event | Guard | To |
|---|---|---|---|
| — | plan approved | — | `ready` (no unmet dependencies) else `waiting-deps` |
| `waiting-deps` | dependency merged into mission branch | all deps merged | `ready` |
| `ready` | scheduler dispatches | sequential-per-mission slot free; **mission in `executing` (not paused)** | `claimed` (attempt leased) |
| `ready` | provider window exhausted | — | `queued-quota` |
| `queued-quota` | quota window frees (CAM-ROUTE-06) | — | `ready` — **quota waits never count toward failure or family-switch counters** |
| `claimed` | worker starts | lease valid | `implementing` |
| `claimed` | **attempt reaches any terminal state before the worker starts** (expired / cancelled / quota-blocked) | recorded | `ready` (or `queued-quota` for quota) — no issue is ever stranded in `claimed` without a live lease |
| `implementing` | worker submits final head | quarantine checks pass | `validating` |
| `implementing` | attempt fails | retry policy | `ready` (new attempt); family switch after 2 **failures**; `escalated` after 4 **failures** |
| `implementing` | **attempt budget breach** | kill-confirm executed | `escalated` — **kill-and-escalate per CAM-EXEC-03, never an automatic retry** |
| `implementing` | attempt quota-blocked | — | `queued-quota` (not a failure) |
| `implementing` | attempt cancelled by preemption/pause | attempt summary written | `ready` (re-dispatch when the mission resumes `executing`) |
| `validating` | gates green at candidate | freshness holds | `merge-pending` |
| `validating` | validation fails | repair policy | `ready` (repair attempt); 4 failures → `escalated` (same recorded failure counter) |
| `validating` | infra-blocked | — | `blocked` |
| `merge-pending` | approval (David in training mode, or tier-1 autonomy — **tier-1 applies to mission-branch targets only, never a main candidate**) | base check passes | `merged` (into mission branch; fast subset runs) |
| `merge-pending` | mission branch advanced since validation | — | `ready` (revalidation) |
| (mission-level) | **fast subset fails after an issue merge** | — | a **repair issue** is created `ready` within mission scope (CAM-MERGE-04) and further merges block until green |
| any active | contract edited, incompatible | — | `replanning` |
| `replanning` | replan complete under contract v(n+1) | dependency readiness re-checked | `ready` / `waiting-deps` |
| `escalated` | David answers | — | `ready` (or `cancelled` per answer) |
| any active | David cancels | — | `cancelled` |
| `blocked` | resource restored / question answered | — | `ready` |
| any active | cleanup failure during teardown | recorded | `blocked` with `cleanup-failed` cause (janitor + escalation) |
| `merge-pending` | quick-task mission push confirmed (A.1b `merging → complete`) | quick-task issue (target = main candidate) | `merged` |

### A.3 Attempt

| From | Event | Guard | To |
|---|---|---|---|
| — | dispatch | lease granted (generation g) | `running` |
| `running` | heartbeat lapse > TTL | kill-confirm executed | `expired` |
| `running` | worker completes | final head fetched | `submitted` |
| `running` | cancel (David / urgent preemption / pause / edit) | safe checkpoint or kill-confirm | `cancelled` (structured summary written; issue transitions per A.2) |
| `running` | budget breach | kill-confirm | `killed-budget` |
| `running` | provider rate limit | — | `quota-blocked` (issue → `queued-quota`) |
| `submitted` | quarantine + validation verdict | — | `succeeded` / `failed` (classified per taxonomy) |
| any terminal | single archival step: archive written (quotas enforced) → ledger row referencing it → workspace destroyed | strictly in that order | `archived` |

### A.4 Ordering guarantees

1. Advisory (worker-head) evidence items are recorded at submission; gating items only on Camino-authored candidates (registry item 8 classes).
2. **(A.1 integration route only — A.1b has no fold by definition)** the fold commit lands on the mission branch **before** the mission merge candidate is constructed.
3. The evidence rollup and PR links are populated **before** `awaiting-merge-approval` is reachable (both routes).
4. Packets are immutable once their verdict is recorded; later candidates get new packet items with their own (sha, base_sha); **approvals bind to (candidate SHA, packet hash) and never transfer** (A.1/A.1b rebuild rows).
5. Attempt archival happens exactly once, at the terminal→`archived` transition: archive written under quota → ledger row references it → workspace destroyed. No other step archives or destroys workspaces.

Environment ownership: exactly one fenced owner (attempt or janitor) per validation environment at any time; ownership transfer only after kill-confirm of the prior holder (CAM-STATE-04).
