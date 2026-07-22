# Camino — Build Plan v4 (final): Repo Scaffold + Phase 0 & Phase 1 Work Packages

> **Approved by David 2026-07-17**, with all §1.3 default recommendations confirmed as his own (Apache-2.0; npm workspaces; package split; main branch protection once CI exists; strict Phase-0 order; strict xAI gate). The xAI/Grok Build contractual research he requested is recorded in [xai-sanctioned-path-research.md](xai-sanctioned-path-research.md) — verdict: confirmed-permissive with two recorded caveats, pending his disposition at the WP-000 gate.
>
> Derived from [PRD v1.4](../PRD.md) (build-ready) and [design v5](../design/17-design-v5.md) (cleared). Build method: proto-Camino — each work package (WP) becomes a GitHub Issue carrying acceptance criteria mapped to PRD requirement IDs; an agent implements it on a branch; a reviewer from a different provider critiques the PR; David merges. Nothing is implemented until David approves this plan.
>
> **Revision history:** v1 → falsification round 1 (Codex gpt-5.6-sol xhigh): "safe to build on: **no**", 19 findings, all folded. v2 → round 2: "safe to build on: **no**", 13 findings (r1 regressions: 13 resolved, 6 partial, 0 unresolved; P1 inventory, scaffold, and exit confirmed exact), all folded. v3 → round 3 (verify-only): "safe to build on: **with corrections**" — 4 exact corrections, all folded into this v4 (§7). Raw reviews: [round 1](reviews/falsification-review-round1.md), [round 2](reviews/falsification-review-round2.md), [round 3](reviews/falsification-review-round3.md).

---

## 1. Repo scaffold

### 1.1 Layout

A single repository holding four packages that install and test together (npm workspaces — the package manager built into Node 22; no extra tooling):

```
Camino/
├── .devcontainer/                # Node 22 + Docker-capable dev environment
├── .github/
│   ├── workflows/ci.yml          # lint + typecheck + one-command test; robustness suites accumulate here
│   └── ISSUE_TEMPLATE/work-package.md
├── docs/                         # existing PRD + design record (unchanged)
│   ├── plan/                     # this plan + phase checklists + review records land here on approval
│   └── runbooks/                 # API-key fallback runbook (CAM-ROUTE-08), risk model (CAM-SEC-05)
├── packages/
│   ├── shared/                   # cross-package types + schemas: requirement IDs, event types,
│   │                             #   evidence-packet schema (registry item 8), contract schema,
│   │                             #   lease/environment interface, API DTOs (zod schemas)
│   ├── core/                     # PURE domain logic, no I/O: Appendix A state machines, ledger +
│   │                             #   status-tuple projection functions, idempotency-key derivation
│   ├── daemon/                   # Fastify server AND all I/O: SQLite event store (append/replay),
│   │                             #   intake, planner, scheduler, adapters, quarantine, validation
│   │                             #   runner, merge engine, GitHub (Octokit), vault
│   └── gui/                      # React + Vite: board, inbox, evidence viewer, gap register
├── fixtures/                     # seeded fixtures: sample target repo, ambiguous PRDs, rejection-case repos,
│                                 #   untrusted workflows, untrusted-content corpus, chaos kill-point configs
├── spikes/                       # Phase-0 spike harnesses (disposable); durable tests promote into packages
├── scripts/                      # bootstrap, one-command test entry, prerequisite checker
├── LICENSE                       # Apache-2.0 (recommendation — David to confirm; see §1.3)
├── SECURITY.md                   # three-tier risk model summary (T1/T2/T3, per design §5.3)
└── docs/release-checklist.md     # CAM-SEC-09: the four PRD items with owner/status, from day one
```

Boundary rules:
- `core` is pure — no I/O. **Enforced, not asserted** (r2 finding 11): a dependency-fence check runs in CI from WP-101 onward — `core` may import only `shared`; imports of Node I/O builtins (`fs`, `net`, `child_process`, …), `better-sqlite3`, or `daemon` fail the build.
- Cross-package contracts (packet schema, contract schema, lease/environment interface) live in `shared`, so producers and consumers build against one definition — the dependency graph in §5 sequences the implementations.

### 1.2 Tooling (PRD §6 defaults, made concrete)

| Concern | Choice | Why (recorded justification) |
|---|---|---|
| Language/runtime | TypeScript strict, Node 22 | PRD §6: largest agent training corpus, Playwright-native |
| Daemon | Fastify | PRD §6 |
| GUI | React + Vite, served by the daemon | PRD §6 |
| DB | SQLite via better-sqlite3, WAL mode | PRD §6; event tables + derived views |
| Git operations | system `git` in pristine clones, hooks disabled by config (`core.hooksPath` → empty dir on every Camino-managed clone); credentialed git never executes in worker-touched directories | PRD §6 + design §5.1 |
| Tests | Vitest (unit/integration), Playwright (GUI; probes later) | one runner across packages; Playwright already mandated for probes |
| Process control | execa | PRD §6 |
| GitHub | Octokit REST | PRD §6 |
| Containers | Docker Desktop | PRD §6 |
| Vault | macOS Keychain-backed | PRD §6 |
| Lint/format | ESLint + Prettier, CI-enforced (incl. the core dependency fence) | agent-written code needs deterministic style gates |
| Package manager | npm workspaces | zero extra install; devcontainer-friendly |

Daemon runtime state lives outside the repo in `~/.camino/` (SQLite DB, auth token file, archives) — the repo is code; the home directory is state.

### 1.3 Decisions David must confirm

1. **License: Apache-2.0** (permissive per CAM-SEC-09, adds a patent grant over MIT). Alternative: MIT.
2. **npm workspaces** (vs pnpm — faster installs, stricter, one more tool).
3. **Package split** as in §1.1 (shared/core/daemon/gui, with the enforced pure-`core` fence).
4. **Camino's own repo protection:** enable branch protection on `main` (required CI check, no force-push) once CI exists — dogfoods CAM-MERGE-08.
5. **Phase-0 order:** BUILD.md says "in order"; this plan encodes it as a strict issue-dependency chain 000→001→002→003→004→005 (§5). If David prefers items 3/5 parallel to 1/2, that is a BUILD.md amendment for him to make.
6. **xAI prerequisite timing** (r2 finding 4, r3 correction 1): BUILD.md lists the xAI contractual confirmation under "Prerequisites (before Phase 0)." The gate takes the strict reading: **WP-000 goes green only when the actual xAI contractual confirmation is recorded.** The only alternative is that David first approves a BUILD.md amendment (change-controlled, his explicit act) relaxing the prerequisite — in which case Grok Build enters Phase 0 visibly disabled-with-reason (the CAM-EXEC-01 sanctioned negative path) until the confirmation lands. There is no informal deferral path.

### 1.4 Process conventions (proto-Camino method, written down)

- One GitHub Issue per WP, from a template with: phase, track, mapped requirement IDs, acceptance criteria (checklist), dependencies (as issue links). The PRD *Accept:* text goes into the issue verbatim.
- Branch `wp/NNN-short-slug`; PR cites the issue; every PR carries a falsification review by a model **from a different provider than the implementing agent** (`reviewer.provider ≠ implementer.provider`); David merges. Merges are David's alone until Camino itself earns tiers.
- Rejection/egress/chaos suites persist as CI from the moment they exist (BUILD.md standing obligation).
- **PRD change control, in full:** *any* material PRD change — conflict-driven or not — requires David's approval before adoption; architectural changes additionally get a falsification pass before being built on. WPs never silently deviate; they open a `prd-change` issue and block on it if the change gates their acceptance criteria.
- Two GitHub milestones: `Phase 0 — Spikes`, `Phase 1 — Walking skeleton`. Labels: `phase:0|1`, `track:A..E`, `wp`.

---

## 2. Phase 0 — Spikes (6 work packages, strict chain)

Phase exits are gates, not calendars. The issue-dependency chain **000 → 001 → 002 → 003 → 004 → 005** is encoded in the generated issues (r2 finding 10); a WP's issue is unblocked only when its predecessor closes.

### WP-000 · Repo scaffold + CI + validatable-repo profile + Phase-0 entry gate
Scaffold per §1: workspaces, TS strict, lint/format + core fence, Vitest, devcontainer, CI, issue template, LICENSE, SECURITY.md stub, release checklist, prerequisite checker.
**Accept:**
- Fresh clone → `npm install && npm test` green locally and in CI (one-command test), and the run **exercises at least one seeded fixture** — a committed `fixtures/sample-repo` (script-materialized git repo) with a smoke test that clones and inspects it — so the validatable-repo profile (devcontainer, one-command test, seeded fixtures) is genuinely established. Maps: PRD §6 / BUILD.md standing obligation.
- Devcontainer boots to a working toolchain (Node 22 + Docker available).
- `docs/release-checklist.md` committed containing the four CAM-SEC-09 items — permissive license, no secrets in repo, compliance pass on provider policies, risk-model re-pricing for distribution — each with owner and status fields — **CAM-SEC-09**.
- **Phase-0 entry gate** — `scripts/check-prereqs` verifies and records every BUILD.md "before Phase 0" item: Node 22, Docker Desktop, Playwright; Claude Code, Codex CLI, Grok Build CLI authenticated; funded API fallback accounts attested by David (**CAM-ROUTE-08** prerequisite half); **the xAI contractual confirmation recorded — the gate does not go green without it unless David has first approved a BUILD.md amendment relaxing it** (§1.3 item 6; Grok Build then enters disabled-with-reason). WP-001 is blocked until the gate records green.
- Issue template renders the WP fields; milestones + labels exist.

### WP-001 · Dispatch spike (PRD §7 Phase 0 item 1)
Minimal adapter interface (spawn / stream / cancel / cleanup / quota-classify) driving one trivial issue through each enabled adapter — Claude Code, Codex CLI, Grok Build CLI — headless on David's subscriptions, producing local commits in an isolated clone.
**Accept:**
- Per enabled adapter, a recorded transcript demonstrates: spawn, live stream parsing, mid-run cancel with process-tree cleanup (kill-confirm: SIGTERM → 30s → SIGKILL → tree-gone verification), and workspace cleanup — **CAM-EXEC-01** (spike acceptance), **CAM-EXEC-06**.
- Quota/rate-limit classification observed per provider (real or provoked), classified `quota-blocked`, never `requirement-failed` — **CAM-EXEC-06**.
- Worker environment composition shown to contain no GitHub credentials and no extracted subscription credentials — **CAM-SEC-06** posture check.
- Disabled-adapter path exercised if any adapter is disabled (per the WP-000 gate record) — **CAM-EXEC-01** negative case.

### WP-002 · PRD-to-plan probe (item 2)
Prototype planner: PRD text → issues with acceptance criteria + clarifying questions + requirement checklist diff, plus one cross-provider falsification review attached. David reviews a real PRD through it.
**Accept (PRD §7 exit):**
- David rates each clarifying question; **≥70% rated "good"**; ratings recorded.
- Checklist usability confirmed by David; review time recorded against the 45-min plan budget (CAM-OBS-02 baseline data point).
- Prototype evidence toward **CAM-PLAN-01/-02/-03** (product-grade acceptance lands in Phase 1).

### WP-003 · Quarantine rejection suite (item 3)
Executable rejection fixtures + a minimal squash-and-rebuild quarantine intake that rejects all of them. The suite persists as CI for Camino itself.
**Accept:**
- Each enumerated case is a fixture and is rejected: reachable-history carry-in; path collision (case-fold + Unicode normalization); reserved-name and trailing-dot aliases; symlink-target escapes; `.gitattributes` edits; CI-definition edits; out-of-scope diffs; worker merge commits; submodule/gitlink introduction; size-budget breaches; candidate-ref workflow-trigger (an untrusted workflow must not fire on `camino/**`) — **CAM-EXEC-04** (Phase-0 suite), PRD §7 item 3 exit.
- Suite runs in Camino's CI on every PR from this WP forward.

### WP-004 · Untrusted-content robustness baseline (item 4)
Untrusted-content corpus with planted instructions (issue text, README, web content) run against the WP-002 planner and one WP-001 worker. Findings catalogued; David dispositions each.
**Accept (PRD §7 exit):**
- Every finding catalogued with a recorded disposition — hardened or accepted-risk with reason — **CAM-EXEC-09** baseline (the P2 orchestrator-channel extension is CAM-SEC-07).
- Corpus + harness persist in `fixtures/` for re-runs.

### WP-005 · Validation-environment egress + scrubbing tests (item 5)
Container profile for validation: default-deny egress with an allowlist; literal secret-pattern scrubbing of retained artifacts. Two executable tests; persist as CI.
**Accept (PRD §7 exit):**
- From inside the environment, connection attempts to non-allowlisted hosts fail **while an allowlisted test endpoint remains reachable** (a total-network-denial implementation cannot pass) — **CAM-VAL-03** (egress half).
- Seeded secret literals in logs/artifacts are redacted in retained copies — **CAM-VAL-03** (scrubbing half), **CAM-SEC-08** groundwork.

**Phase 0 exit:** all five PRD §7 Phase-0 exits green; the WP-000 gate was green before WP-001 started.

---

## 3. Phase 1 — Walking skeleton (26 work packages)

Phase-1 exit (PRD §7): one real feature mission (3–6 issues) delivered end-to-end on a real repository — plan approved with its falsification review attached, issues implemented by ≥2 adapter families, validated in clean environments, merged via merge-by-push through the integration branch to main with David approving against rendered evidence packets **in the viewer**, fold rendered, gap register populated; chaos suite (CAM-STATE-06) passing; economics instrumentation live — all under the walking-skeleton posture: **one repo, PAT, polling, training mode**.

Scheduling rule: a WP starts when its listed dependencies (§5) are merged.

### Track A — Spine & durability

#### WP-101 · State machines (core) + event store (daemon) + Appendix A consistency audit
Appendix A mission/issue/attempt machines as pure typed code in `packages/core` (states, events, guards, interrupts — including the urgent/pause interrupt rows); append-only SQLite event log in `packages/daemon` behind the `shared` store interface (actor, cause, payload; derived views rebuildable by replay).
**Accept:**
- Every state transition is an event; derived views rebuild from the log alone — **CAM-STATE-01**.
- Illegal transitions rejected and logged; exhaustive transition tests cover every legal Appendix A row (all three machines, including `queued`, `paused-urgent`, `re-routed`, budget-breach, pre-start attempt recovery, and A.4 archival ordering) and representative illegal ones — **CAM-STATE-05**, registry item 4.
- **Core dependency fence live in CI** (r2 finding 11): `core` imports only `shared`; I/O imports fail the build — with a fixture proving the fence trips.
- **Recorded Appendix A consistency audit** (BUILD.md standing obligation): code-vs-appendix diff walked; every difference resolved by fixing code or amending the appendix (amendments need David per change control); audit committed as `docs/design/26-appendix-a-audit.md`. Until then Appendix A stays authoritative.

#### WP-102 · Daemon shell: localhost, token auth, CSRF, GUI hosting
Fastify daemon binding 127.0.0.1 only; GUI token from a 0600-permission file; CSRF on state-changing endpoints; serves the GUI build.
**Accept (CAM-CORE-01, verbatim):** remote connection attempts fail; requests without the token are rejected; token-file permissions verified at startup (refuse to start otherwise); cross-origin state-changing request without the CSRF token rejected.

#### WP-103 · Domain model + mission intake + per-repo serialization (incl. urgent lane)
Project → repo → mission schema (multi-project from day one); mission creation from typed/pasted PRD text, uploaded `.md`/`.txt` (markdown first-class), or quick task; per-repo serialization with the `queued` state and the urgent lane as a first-class scheduling slot. The urgent *preemption workflow* is CAM-PLAN-10 **[P2]** — recorded, not silently dropped.
**Accept:**
- All intake paths produce a mission record with original content retained immutably; attached markdown renders; a `.docx` fixture is rejected with the stated reason, never silently truncated — **CAM-CORE-02**.
- Adding a second project requires no schema change — **CAM-CORE-06**.
- A second mission on the same repo waits, visibly, in `queued`; intake/planning may proceed concurrently; execution-bearing states hold at most one mission per repo, plus at most one urgent quick task on the urgent lane (CAM-CORE-08); while the urgent lane actively executes, the primary holder is parked in an interrupt state *(urgent-lane clause added by AMEND-6, approved by David 2026-07-19 in PR #45 — the same clause amends the PRD's Appendix A serialization preamble)*; the urgent slot exists and `executing → paused-urgent → executing` is exercised at the state-machine level — **CAM-CORE-08**, Appendix A serialization rule.

#### WP-104 · Idempotency contract + recovery + kill-point chaos harness
**Every operation class of the PRD §4.4 table as code** (r2 finding 2): branch create (natural key); push (intended-SHA intent event); PR create (intent UUID + head-branch key; closed/reused-branch ambiguity → escalation class); merge-by-push (ref-state idempotence); labels (desired-state); comments (embedded UUID); **CI/workflow dispatch — at-most-once, `camino_intent_id` in run-name as correlation only, no automatic retry on lost-response ambiguity**; external test-service mutations (environment = idempotency unit via reset-before-use; irreversible effects recorded as ambiguity, never auto-retried); catch-all at-most-once + durable ambiguity + escalation. Single-writer recovery lock; external facts reconcile from GitHub queries, decisions from the log. Deterministic kill-point harness.
**Accept:**
- Seeded duplicate-intent fixtures **for every §4.4 operation class** (fake-backed transports where the real integration lands in a later WP) → zero duplicate external side effects, one recorded ambiguity per genuinely ambiguous case — **CAM-STATE-02**, including the workflow-dispatch at-most-once/correlation-only clause.
- Recovery runs under a single-writer lock; reconciliation sources as specified — **CAM-STATE-03**.
- Kill-point suite: for every §4.4 class, kill on both sides of the external call; recovery yields zero duplicates, zero lost state; random-kill runs supplement — **CAM-STATE-06** (harness + fake-backed coverage; the WPs that implement real side effects each register their integration kill-point fixtures — WP-114/115/119/120 ACs — and WP-126 asserts the full matrix against real backends). *(Timing fixed per r2 finding 3: WP-104's own ACs are satisfiable at its wave; resume assertions for leases/environments live in WP-114/WP-115.)*

### Track B — Execution plane (adapters before planning: the planner and reviewers run on them)

#### WP-105 · Adapters, product grade + API-key adapter interface + fallback runbook
Claude Code, Codex CLI, Grok Build CLI adapters hardened from WP-001; per-adapter enablement gated on the recorded sanctioned-path verification; the API-key adapter interface defined (typed contract in `shared`; implementation **[F]**); the API-key fallback runbook.
**Accept:**
- Every enabled adapter passes the WP-001 dispatch suite, now in CI against product adapter code; a failed sanctioned-path check → installable but visibly disabled with reason — **CAM-EXEC-01**.
- API-key adapter interface exists as a compiled, documented contract with a conformance-test skeleton; no implementation shipped — **CAM-EXEC-01** (interface clause).
- Adapter conformance tests: kill-confirm sequence (SIGTERM → 30s → SIGKILL → tree-gone → lease release), rate-limit → `quota-blocked` — **CAM-EXEC-06**, registry item 4.
- Subscription credentials never read/stored/transmitted/proxied; composition references host credential state for official CLIs only — **CAM-SEC-06**.
- Fallback runbook committed under `docs/runbooks/` (same official CLIs re-authenticated with API keys; exercised in Phase 2) — **CAM-ROUTE-08** (runbook half; the funded-account prerequisite is gated in WP-000).

#### WP-106 · Routing foundation: capability registry + policy table
**Accept:**
- Capability registry per provider: models, quota windows, context limits, harness features, sanctioned-path and billing-pool attributes, time-varying and source-linked — **CAM-ROUTE-01**; window models per registry item 13 (Claude 5-hour + weekly, Codex, Grok Build windows tracked from adapter rate-limit signals; shapes refined from ledger observation).
- Per-project, user-editable policy table: role × task features → (harness, model, reasoning tier), per-project provider allowlists; shipped defaults make planner/challenger/verifier cross-family by construction — **CAM-ROUTE-02**.

#### WP-107 · Worker isolation: containers, egress, budgets, archives
Workers in containers with isolated full clones (never linked worktrees), zero GitHub credentials, provider auth read-only; egress allowlist; per-attempt budgets; workspace archival under quotas.
**Accept:**
- Workspace is a full isolated clone; no GitHub credential present (env + filesystem assertion); **provider auth is mounted read-only — a write attempt from inside the workspace fails (fixture)** (r2 finding 13) — **CAM-EXEC-02**.
- Egress: a non-allowlisted host is unreachable **while an allowlisted registry/docs endpoint from the per-repo config remains reachable** (total denial cannot pass) — **CAM-EXEC-03**; budget breach (tokens where reportable, wall-clock always) → kill-and-escalate, never auto-retry — **CAM-EXEC-03** (+ A.2 budget-breach row).
- Registry item 11 verbatim: workspace ≤ 2 GB; archive ≤ 500 MB compressed per attempt, retained 90 days or last 10 attempts per issue, **whichever is more**; archive written before cleanup in the single A.4 archival step — **CAM-EXEC-05**.

#### WP-108 · Quarantine module, product grade
Squash-and-rebuild intake per CAM-EXEC-04, replacing the WP-003 prototype; checks run against the issue's frozen contract (from WP-110); the Phase-0 rejection suite runs against it unchanged.
**Accept:**
- Shallow-fetch of the worker's final head only within registry item 11 budgets (≤ 5,000 objects / 500 MB per fetch); full policy-check list (scope vs contract, protected paths incl. `.gitattributes`/CI/`.camino/`, canonical path identity — case-fold + Unicode-normalization collisions rejected — reserved-name/trailing-dot aliases, symlink targets, submodule/gitlink block, tree size budget); fresh Camino-authored commit onto the assigned base with worker attribution trailer; worker merge commits rejected — **CAM-EXEC-04**.
- All quarantine git operations run in the pristine, hooks-disabled clone; credentialed git never executes in worker-touched directories.
- Entire WP-003 rejection suite green against the product module in CI.
- Emits the **quarantined final diff** with candidate identity (sha, base_sha) — the input consumed by classification re-triggers (WP-111) and evidence (WP-116).

### Track C — Planning & intent

#### WP-109 · Intent ledger + status tuples + canon projection & folds
Control-plane intent ledger (user actions only mutate); the CAM-CANON-03 status-tuple projection (pure functions in `core`, persistence in `daemon`); canon text rendered as a projection riding mission PRs, with rendered-at marker and divergence-triggered standalone fold.
**Accept:**
- No code path mutates intent from merge/revert/abandon events — by construction + tests — **CAM-CANON-01**.
- Canon file carries rendered-at; a standalone intent-only fold triggers at >5 requirements or >7 days divergence — **CAM-CANON-02** (registry item 17, canon-freshness clause).
- Fixture walks of every tuple transition (including revert and stale-evidence downgrades) produce the design-specified tuples; verification never inherits across branch changes — **CAM-CANON-03**.

#### WP-110 · Planner: compile, clarify, checklist, contracts, dependencies
PRD → issues with acceptance criteria streaming as constructed; every invented assumption surfaced as a clarifying question; requirement checklist diff; contract freeze with hashes (contract schema in `shared`); dependency edges validated acyclic; `feature` + `quick-task` templates.
**Accept:**
- On the ambiguous-PRD fixture set, each planted ambiguity surfaces at plan approval as an item David must actively acknowledge (answer or confirm the recorded assumption) before approval completes; passive display fails; a silent guess fails — **CAM-PLAN-01**.
- A PRD sentence with no mapped requirement is visibly flagged; confirmations create `accepted` ledger entries — **CAM-PLAN-02**.
- Acceptance criteria freeze at approval into hash-referenced contract versions; every attempt/PR references its contract hash — **CAM-PLAN-04**.
- A plan containing a dependency cycle is rejected pre-approval with the cycle named; declared interfaces persist on the contract record and are visible to dependents' context packs — **CAM-PLAN-11**.
- Both v1 templates exist — **CAM-PLAN-07**.

#### WP-111 · Cross-family plan review, classification, observability, risk & area policy
Falsification-mandate review by a different provider than the planner before every plan approval; quick tasks get the bounded mini-review; the full CAM-PLAN-06 classification protocol; risk tiers and area taxonomy per registry item 18.
**Accept:**
- No plan (or quick task) reaches approval without a second-family critique attached — **CAM-PLAN-03**.
- Classification, complete: planner proposes `canon-affecting`/`canon-neutral` provisional until the diff exists; deterministic triggers re-classify on the final quarantined diff (migrations, auth/authz, dependency manifests, flags, boot/validation config, protected paths, user-observable surface paths); fold suppression on quick tasks requires reviewer concurrence — **CAM-PLAN-06**.
- Observability adjudication: reviewer adjudicates per acceptance criterion on every plan fixture (absence fails); an observable criterion outside the heuristic paths and missed by the planner is caught by reviewer adjudication and receives a mission-gate check in P1 per CAM-VAL-13 (a probe from P2); classifying any item not-observable requires reviewer concurrence — **CAM-PLAN-06** *Accept* verbatim.
- **Registry item 2, enumerated** (r2 finding 9): the shipped default globs are exactly `**/{components,pages,views,screens,routes}/**`, template/style files, API schema files (`openapi*`, `*.graphql`), CLI entrypoints, notification/email templates, i18n resources, migrations touching user-visible data, feature-flag definitions — asserted by a comparison test against the shipped config — extensible per repo via `.camino/config.yml`, heuristics-are-the-floor semantics preserved.
- **Registry item 18, all three tiers** (r2 finding 9): **high** floor deterministic (auth/authz, payments/billing, data migrations, secrets/credential handling, sensitive paths per repo config); **medium** = user-observable behavior changes; **low** = internal refactors, docs, tests. Planner proposes; floor cannot be lowered; David may raise; **area-set derived deterministically from the final diff paths** via the glob→area map with shipped defaults (frontend, backend, api, data-migrations, auth, infra-ci, docs-tests), extensible in `.camino/config.yml`; tier + area-set persist on the issue record.

#### WP-112 · Contract change control
Issue edit → contract v(n+1); compatible in-flight work completes and revalidates; else cancel-with-summary + replan; semantic impact assessment over dependents (conservative default: revalidate).
**Accept (CAM-PLAN-05):** an edit mid-attempt never mutates a contract in place; fixtures exercise all three paths (compatible-complete-revalidate, cancel-replan, dependent invalidation) with expected downstream state changes; dependent readiness re-checked before re-dispatch (**CAM-PLAN-12** tie-in).

#### WP-113 · Context packs + knowledge lifecycle + untrusted-content posture
Control-plane-assembled context packs (canon excerpts with ledger status for the worker's branch context, the issue contract, approved knowledge, provenance tags per content class); `.camino/knowledge.md` candidate→approved lifecycle; untrusted text treated as data.
**Accept:**
- Packs contain only control-plane-assembled content; workers never wander the docs folder; provenance tags per content class — **CAM-EXEC-07**.
- Candidates immediate with provenance + commit/base validity; promotion via human batch or the two deterministic rule-classes (commands succeeding ≥3 times across ≥2 missions; quarantine-confirmed flaky-test annotations); scope + expiry fields; invalidation on revert of validity base; candidate-contradicts-approved escalates to curation — **CAM-CANON-09**, registry item 6.
- **Pack-visibility boundaries** (r2 finding 8): a fixture proves **only approved entries enter another mission's packs** (a candidate from mission A never appears in mission B's pack), and **candidates are visible to same-issue repair attempts, provenance-marked** — **CAM-CANON-09** (visibility clauses).
- Untrusted-content corpus (WP-004) re-run against pack assembly: untrusted content lands as data, not instructions; findings dispositioned — **CAM-EXEC-09** (gate for any unattended run).

#### WP-114 · Scheduler: readiness, leases, quota-aware dispatch, failure handoff
Dependency-ordered sequential dispatch per mission (consuming WP-110 contracts/dependency edges); attempt leases with fencing (lease/environment interface in `shared`); quota-aware pausing; structured failure handoff. Dispatch selects (harness, model, tier) from the WP-106 policy table.
**Accept:**
- An issue with an unmerged dependency is never dispatched; at no time do two attempts run for one mission; a contract-edit fixture re-checks dependent readiness before re-dispatch — **CAM-PLAN-12**.
- Failed attempts hand off structured summaries (not transcripts); 2 same-family failures switch families; 4 escalate; quota waits never count toward failure or family-switch counters — **CAM-PLAN-09** (+ A.2 rows).
- Registry item 5 verbatim: lease generations monotonic per environment, persisted in SQLite; heartbeat 30s, TTL 5min; every environment operation presents its generation; stale-generation writes rejected; re-grant only after kill-confirm; exactly one fenced owner per validation environment at any time, and any future janitor honors lease generations (janitor itself is CAM-STATE-07 [P2]) — **CAM-STATE-04**.
- **Post-crash resume assertion** (from r1 finding 7): after daemon kill -9, recovery inspects leases — stale generations fenced, kill-confirm before re-grant — added to the WP-104 chaos matrix — **CAM-STATE-06** (lease clause).
- Dispatch pauses at 85% estimated window consumption per provider using WP-106 window models; quota exhaustion queues (`queued-quota`), never fails work — **CAM-ROUTE-06**, registry item 13.

### Track D — Validation & merge

#### WP-115 · Validation runner: environments, vault, scrubbing, risk model
Clean-environment validation from the per-repo test-environment profile (boot recipe, seed/reset scripts, reset-before-use); environment operations present lease generations (WP-114 interface); OS-keychain vault; egress/scrubbing productized from WP-005; infra-blocked classification; validation-config diff review; risk model documented.
**Accept:**
- Validation runs in a clean environment from the profile; reset-before-use is the hygiene primary; **post-crash resume assertion: environments reset-before-use on next acquisition** (chaos-matrix entry) — **CAM-VAL-01**, **CAM-STATE-06** (environment clause).
- Worker env dumps contain no vault material; secrets reach only the runner — **CAM-VAL-02**.
- CAM-SEC-04, complete: OS-keychain-backed storage for test-scoped credentials and (when used) API keys; delivery into the validation runner only; per-repo tenant isolation; scheduled rotation; per-mission rotation for sensitive tenants — each behavior fixture-tested — **CAM-SEC-04**.
- Phase-0 egress + scrubbing tests green against the product runner (allowlist-positive case included); **the three-tier risk model documented in-product, with T3 residual risk AND post-merge supply-chain residual risk stated, and surfaced in onboarding material** (rendered into what WP-118's onboarding shows David) (r2 finding 5) — **CAM-VAL-03**, **CAM-SEC-05**; scrub-before-store + retention quotas — **CAM-SEC-08**.
- Worker changes to boot/validation config or dependency manifests → reclassification + human review of the config diff while any autonomy is active — **CAM-VAL-04**.
- Missing test resources at validation → `infra-blocked`, never requirement-failed — **CAM-VAL-11**.
- Registers its §4.4 kill-point integration fixtures (external test-service class) into the WP-104 chaos matrix — **CAM-STATE-06** tie.

#### WP-116 · Evidence packets + deterministic heuristics
Registry-item-8 packet schema (types in `shared`, assembly in `daemon`): per attempt + mission rollup with gate record; every item carries (sha, base_sha) + `advisory|gating` class; TODO/stub scan + coverage-on-new-code heuristics feeding the register as `suspected`.
**Accept:**
- Packets validate against the registry-8 schema including commands, artifacts, checks, reviews, exclusions, waivers, retries, failure_class, verdict; gating items only on Camino-authored candidates; worker-head items advisory, bound to the worker SHA; packets immutable once their verdict is recorded (A.4); mission rollup carries requirement_map, gate_record, per_issue_delivered — **CAM-VAL-08**.
- Heuristics run on every candidate; findings enter the register as suspected, ranked below probe evidence — **CAM-VAL-05** (P1 pair; unimported-file/unapplied-migration are P2).

#### WP-117 · Mission gate suite + cross-family mission review
Plan-time mission-level executable check suite (planner/reviewer-authored, worker-immutable) covering the mission's user-observable outcomes; fast subset designated at plan approval; cross-family semantic review of every mission→main candidate; verdicts recorded into WP-116 packets.
**Accept:**
- Suite authorship verifiably not the implementing worker; fast subset designated at plan approval; suite coverage of observable outcomes is part of the recorded plan-approval review; a worker diff touching the suite is rejected (via WP-108 protected paths — dependency declared) — **CAM-VAL-13** (authorship/designation rows; enforcement in WP-120; real-mission proof in WP-126; the P2 absorption fixture is out of scope).
- Every mission→main candidate gets a different-provider semantic review before the merge gate; three-way verdicts (pass / fail / escalate-with-question) recorded in the evidence packet with (sha, base_sha, class) — **CAM-VAL-06a**.

#### WP-118 · Repo onboarding: protection, CI posture, credential custody
Onboarding checks for the target repo: main protection (required checks incl. `camino/validation`, required-up-to-date, non-bypass); CI posture per CAM-SEC-03 (incl. the registry-17 private-repo clause: where environment required-reviewers are unavailable on the user's plan — warn, require secret relocation, or record accepted risk); sole fine-grained PAT custody in the control plane; onboarding material surfaces the WP-115 risk-model statement.
**Accept:**
- Onboarding fails with instructions when protection requirements are unmet — **CAM-MERGE-08**.
- Fixture repo with a secret-bearing `on: push branches: ['**']` workflow fails onboarding with the workflow named; default token read-only; Actions on `mission/*`, issue branches, and `camino/**` (incl. candidate refs) disabled or restricted to no-secret read-only; static trigger verification; privileged main workflows inventoried with the specified handling (environment protection with required reviewers where supported, else warn/relocate/record-accepted-risk); persistent self-hosted runners unsupported — **CAM-SEC-03**.
- The control plane holds the sole GitHub credential; workers hold zero GitHub credentials — **CAM-SEC-01** (custody half; pre-push policy checks are WP-119).
- Onboarding material states T3 + post-merge supply-chain residual risk — **CAM-SEC-05** (surface half).

#### WP-119 · Merge-by-push engine + approval & policy guards
Local construction of each merge commit in the pristine hooks-disabled clone; validation at that exact SHA (fast subset for issue→branch; full gate for mission→main); publish candidate to `camino/candidates/<uuid>`; attest via commit-status `camino/validation` (registry item 17 protocol); verify target ref still equals the validated base; fast-forward push; bounded rebuild-and-revalidate. The push layer enforces **policy checks and approval authority**.
**Accept:**
- Pushed SHA ≡ validated SHA on 100% of merges; a simulated race produces rebuild, not a stale merge — **CAM-MERGE-02**.
- Verdicts bind to (head SHA, base SHA) and expire rather than rebind; revalidation is re-execution — **CAM-MERGE-03**.
- At most 2 automatic rebuild cycles per candidate, then escalate — **CAM-MERGE-06**, registry item 1.
- Syncs are merges, never rebases, on evidence-bearing branches — **CAM-MERGE-10**.
- Policy checks precede every push: scope, protected paths, contract reference, budgets — **CAM-SEC-01** (enforcement half).
- Negative approval fixtures: an issue→branch merge, a quick-task→main landing, and a mission→main merge each with **no recorded approval event are blocked at the push layer** — **CAM-AUTON-01** (enforcement).
- **Revocation resets to training** (r2 finding 6): the per-repo/tier autonomy state store supports a revocation event (triggered manually in P1; automatic triggers are CAM-AUTON-03 [P3]); a fixture shows a revoked tier immediately returning the repo to training mode with human approval required again — **CAM-AUTON-01** (post-revocation invariant).
- Registers its §4.4 kill-point integration fixtures (push, merge-by-push, **and CI/workflow-dispatch** classes — the latter exercised against a real `workflow_dispatch` on the fixture repo with `camino_intent_id` in the run-name, at-most-once, no auto-retry on lost response) into the WP-104 chaos matrix — **CAM-STATE-06** tie (r3 correction 4).

#### WP-120 · PR lifecycle, landing, completion semantics
Integration branch `mission/<id>` + mission PR opened at branch creation; quick-task three-gate eligibility routing (A.1b); post-issue-merge fast suite with repair issues; the mission→main gate; Camino-side issue-PR closure; terminal states; completion declared only at confirmed landing.
**Accept:**
- Quick-task gate fixtures: sensitive-path, canon-affecting (reviewer non-concurrence), and multi-issue tasks each provably re-route through an integration branch; an eligible task provably lands via the direct A.1b path with David's approval recorded before the push, binding to (candidate SHA, packet hash) — **CAM-MERGE-01** + A.1b landing authority.
- After every issue merge the fast suite (the CAM-VAL-13 designated subset) runs on the new branch head; failure blocks the next merge and opens a repair issue `ready` within mission scope — **CAM-MERGE-04**, VAL-13 enforcement at issue grain.
- Mission→main requires: branch contains current main; the mission gate green at the exact candidate SHA (union rule per CAM-VAL-13); CAM-VAL-06a review pass; David's approval recorded as an event binding to (candidate SHA, packet hash); rebuilds require new approval — approvals never transfer between SHAs — **CAM-MERGE-05**, **CAM-VAL-13** (enforcement), A.1 rebuild row.
- Issue PRs closed by Camino with linkage metadata (comment + label referencing the landing SHA) — **CAM-MERGE-07**, registry item 17.
- **Mission PR content, complete** (r2 finding 7): the PR exists from branch creation (fixture at mission start), **carries the requirement checklist from creation, accumulates evidence-packet links as attempts complete**, and no mission merge occurs without checklist + rollup + links populated (A.4 ordering); marked merged by the landing push; retained — **CAM-MERGE-13**.
- Terminal states complete / complete-with-residue (descopes listed and counted) / abandoned, with per-issue delivered flags — **CAM-MERGE-12**.
- Completion declared only on confirmed landing push (pushed SHA ≡ approved candidate); the cancelled-requirement rule blocks completion until repair/replan or explicit descope; implementation-state becomes `on-main` only on confirmed landing; per-requirement evidence stays `unverified` absent a requirement-mapped check; mission-suite results recorded as mission-scope evidence only — **CAM-CANON-10** (P1 semantics).
- Registers its §4.4 kill-point integration fixtures (**branch create**, PR create/close, labels, comments classes — branch-create exercised against real ref creation on the fixture repo) into the WP-104 chaos matrix — **CAM-STATE-06** tie (r3 correction 4).

#### WP-121 · ExternalEdit detection + intent reconciliation
Polling detection (commits, branch create/delete, PR field changes, protection changes, non-ff moves) on watched branches; canon-impact scan of external commits → proposed-delta questions to David; affected issues pause pending impact assessment.
**Accept:**
- Non-Camino pushes raise ExternalEdit events (detection, not prevention); transient A→B→A between polls documented as the v1 limitation — **CAM-MERGE-11**.
- Fixture external commit adding user-visible behavior → proposed-delta question, no automatic canon change; fixture deletion of a verified requirement's implementation → `suspected-absent` + register question — **CAM-CANON-06**.

### Track E — Surface & instrumentation

#### WP-122 · Gap register + ledger-backed GUI reads
Register table (requirement → status tuple → evidence provenance → disposition) with filters + disposition actions; all GUI canon/requirement reads from the ledger, never parsed from repo canon text.
**Accept:**
- Register renders tuples with **working filters** (r2 finding 9) and disposition actions; waivers only for detector false positives; real unmet requirements stay open or are user-descoped — **CAM-CANON-05**, **CAM-CORE-09**, registry item 9 (table + filters + dispositions, all three asserted).
- Ledger and GUI never disagree (render-from-ledger by construction + test) — **CAM-CORE-10**.

#### WP-123 · Board, inbox, actions, autonomy visibility
Board with live mission/issue cards streaming state via polling; escalation inbox rendering purpose-built artifacts generically (plan diff, evidence packet, question, choice dialogs); the full v1 action set; training-mode and autonomy state always visible.
**Accept:**
- A state change appears within one polling interval without reload; all Appendix A states render — **CAM-CORE-03**.
- Exactly the v1 actions exist (approve/edit plan, approve merge — issue/mission/quick task, answer escalation, pause/resume mission, cancel issue/attempt, disposition gap entries, view evidence); each recorded as an event with actor + timestamp and produces its specified Appendix A transition, fixture per action — **CAM-CORE-04** (full matrix re-verified in WP-126; approval enforcement is WP-119/120).
- Zero escalations = empty inbox — **CAM-CORE-05**.
- Training mode is the visible default; autonomy state per repo/tier always on the board — **CAM-AUTON-01** (surface half), **CAM-AUTON-06**.

#### WP-124 · Evidence viewer
Renders packets: contents, artifact previews (logs, screenshots, traces inline or open-locally), gating/advisory distinction, exclusion and waiver lists; embedded in every merge-approval screen.
**Accept (CAM-CORE-07):** every merge approval embeds the packet being approved with previewable artifacts and the gating/advisory distinction visible; no v1 merge approvable without its packet.

#### WP-125 · Outcome ledger + economics + attention (daemon-side)
Per-attempt outcome ledger; mission economics; attention accounting with the overrun trigger. **Single-package scope, enforced** (r2 finding 12, r3 correction 3): the overrun choice presents as a standard escalation artifact through WP-123's existing generic inbox contract, **unchanged** — no bespoke GUI surface in this WP.
**Accept:**
- **Diff fence:** the WP's diff touches `packages/daemon` only (plus test fixtures); a diff-scope check on the PR enforces it; the escalation artifact reuses the WP-123 contract with no GUI changes.
- Outcome ledger records per attempt: model, role, task features, verdicts, repair count, tokens where reportable, wall-clock, quota consumption best-effort, human minutes (approval-surface dwell + weekly one-question self-report correction) — **CAM-ROUTE-03**.
- Every mission records David-minutes, tokens, dollars/quota, wall-clock, outcome, per-issue delivered flags — **CAM-OBS-01**.
- Budgets per registry item 3: 15 min routine attention per merged issue-equivalent (trailing 30-day), 45 min per mission plan; **2 consecutive over-budget weeks emit the explicit-choice escalation** (raise budget / pause autonomy expansion / tighten ceremony) whose answer is recorded as an event — rendered via the WP-123 inbox — **CAM-OBS-02**.

### Exit

#### WP-126 · Phase-1 exit: first real mission end-to-end
Run the PRD §7 Phase-1 exit on a real repository, clause by clause.
**Accept:**
- Posture verified: one repo, PAT identity, polling, training mode throughout.
- One real feature mission (3–6 issues): plan approved with its falsification review attached; issues implemented by ≥2 adapter families; validated in clean environments; merged via merge-by-push through the integration branch to main; David approves against rendered evidence packets **in the viewer**; fold rendered; gap register populated.
- Mission gate green at the exact landed candidate SHA — **CAM-VAL-13** Phase-1 clause.
- Chaos suite full matrix green: **every §4.4 operation class against its real backend**, including lease-inspection and environment-reset resume assertions — **CAM-STATE-06** final.
- CAM-CORE-04 full action-fixture matrix green.
- Economics instrumentation live (CAM-ROUTE-03, CAM-OBS-01/-02 producing data during the mission).
- Release checklist re-walked item by item with statuses — **CAM-SEC-09**.

---

## 4. Coverage matrices

### 4.1 P1 requirements → WPs

| Requirement | WP | Requirement | WP |
|---|---|---|---|
| CAM-CORE-01 | 102 | CAM-MERGE-01 | 120 |
| CAM-CORE-02 | 103 | CAM-MERGE-02 | 119 |
| CAM-CORE-03 | 123 | CAM-MERGE-03 | 119 |
| CAM-CORE-04 | 123, 126 | CAM-MERGE-04 | 120 |
| CAM-CORE-05 | 123 | CAM-MERGE-05 | 120 |
| CAM-CORE-06 | 103 | CAM-MERGE-06 | 119 |
| CAM-CORE-07 | 124 | CAM-MERGE-07 | 120 |
| CAM-CORE-08 | 103 | CAM-MERGE-08 | 118 |
| CAM-CORE-09 | 122 | CAM-MERGE-10 | 119 |
| CAM-CORE-10 | 122 | CAM-MERGE-11 | 121 |
| CAM-PLAN-01 | 110 | CAM-MERGE-12 | 120 |
| CAM-PLAN-02 | 110 | CAM-MERGE-13 | 120 |
| CAM-PLAN-03 | 111 | CAM-CANON-01 | 109 |
| CAM-PLAN-04 | 110 | CAM-CANON-02 | 109 |
| CAM-PLAN-05 | 112 | CAM-CANON-03 | 109 |
| CAM-PLAN-06 | 111 | CAM-CANON-05 | 122 |
| CAM-PLAN-07 | 110 | CAM-CANON-06 | 121 |
| CAM-PLAN-09 | 114 | CAM-CANON-09 | 113 |
| CAM-PLAN-11 | 110 | CAM-CANON-10 (P1) | 120 |
| CAM-PLAN-12 | 114 | CAM-ROUTE-01 | 106 |
| CAM-EXEC-01 | 001, 105 | CAM-ROUTE-02 | 106 |
| CAM-EXEC-02 | 107 | CAM-ROUTE-03 | 125 |
| CAM-EXEC-03 | 107 | CAM-ROUTE-06 | 114 |
| CAM-EXEC-04 | 003, 108 | CAM-ROUTE-08 (P1) | 000, 105 |
| CAM-EXEC-05 | 107 | CAM-STATE-01 | 101 |
| CAM-EXEC-06 | 001, 105 | CAM-STATE-02 | 104 |
| CAM-EXEC-07 | 113 | CAM-STATE-03 | 104 |
| CAM-EXEC-09 | 004, 113 | CAM-STATE-04 | 114 |
| CAM-VAL-01 | 115 | CAM-STATE-05 | 101 |
| CAM-VAL-02 | 115 | CAM-STATE-06 | 104, 114, 115, 119, 120, 126 |
| CAM-VAL-03 | 005, 115 | CAM-SEC-01 | 118, 119 |
| CAM-VAL-04 | 115 | CAM-SEC-03 | 118 |
| CAM-VAL-05 (P1) | 116 | CAM-SEC-04 | 115 |
| CAM-VAL-06a | 117 | CAM-SEC-05 | 115, 118 |
| CAM-VAL-08 | 116 | CAM-SEC-06 | 001, 105 |
| CAM-VAL-11 | 115 | CAM-SEC-08 | 005, 115 |
| CAM-VAL-13 (P1) | 117, 120, 126 | CAM-SEC-09 | 000, 126 |
| CAM-AUTON-01 | 119, 120, 123 | CAM-OBS-01 | 125 |
| CAM-AUTON-06 | 123 | CAM-OBS-02 | 125 |

P2/P3/F requirements are deliberately absent (later phases per the PRD): CAM-SEC-02/-07, CAM-VAL-06b/-07/-09/-10/-12/-14, CAM-PLAN-08/-10, CAM-EXEC-08/-10/-11, CAM-MERGE-09, CAM-CANON-04/-07/-08/-11, CAM-ROUTE-04/-05/-07, CAM-STATE-07, CAM-AUTON-02/-03/-04/-05, CAM-OBS-03/-04/-05.

### 4.2 Registry resolutions (PRD §5) → WPs

| Registry item | Where enforced |
|---|---|
| 1 — 2 rebuild cycles then escalate | 119 |
| 2 — observability globs (enumerated) + `.camino/config.yml` | 111 |
| 3 — attention numbers (15/45 min, 2-week trigger) | 125 |
| 4 — Appendix A normative + kill-confirm sequence | 101, 105, 114 |
| 5 — lease generations monotonic in SQLite, 30s/5min | 114 |
| 6 — knowledge promotion rule-classes | 113 |
| 8 — evidence-packet schema v1 | 116 |
| 9 — gap-register UI: table + filters + dispositions | 122 |
| 11 — quotas: fetch ≤5,000 obj/500 MB; workspace ≤2 GB; archive ≤500 MB, 90d or last-10 whichever more | 108 (fetch), 107 (workspace/archive) |
| 13 — provider window models, 85% pause | 106 (models), 114 (enforcement) |
| 14 — Grok Build in v1, enablement gated | 000 (gate), 001, 105 |
| 17 — round-5 additions: attestation protocol → 119; private-repo env-reviewer handling → 118; issue-PR closure → 120; canon freshness → 109; tier-4 eligibility → [F], out of Phase 1 | 109, 118, 119, 120 |
| 18 — risk tiers (high/medium/low) + area from final diff | 111 (derivation), 120 (quick-task gate consumption) |
| 7 (probe tooling — P2), 10 (webhooks post-v1), 12 (multi-repo post-v1), 15 (not pursued), 16 (future scope) | out of Phase 1, accurately classified |

## 5. Dependencies and sequencing

Explicit graph — a WP starts when its dependencies are merged; issue links encode every edge, including Phase 0 (r2 finding 10). Named artifacts: contract schema (110), quarantined diff (108), packet schema (116), lease/environment interface (114), policy table (106), chaos matrix (104), escalation-artifact contract (123).

| WP | Depends on |
|---|---|
| 000 | — |
| 001 | 000 |
| 002 | 001 |
| 003 | 002 |
| 004 | 003 |
| 005 | 004 |
| 101, 102 | — |
| 103, 104, 109 | 101 |
| 105 | 000–005 |
| 106 | 105 |
| 107 | 105 |
| 108 | 003, 107, **110** (contract for scope checks) |
| 110 | 103, 105, 109 |
| 111 | 106, **108** (quarantined-diff re-triggers), 110 |
| 112 | 110, 114 |
| 113 | 105, 109, 110 |
| 114 | 101, **104** (chaos-matrix registration), 105, 106, 107, **110** (dependency readiness) |
| 115 | 005, **104** (chaos-matrix registration), 107, **114** (lease interface) |
| 116 | 101, **108** (candidate identity) |
| 117 | **108** (worker-immutability), 110, 111, 115, **116** (verdicts into packets) |
| 118 | 103, **115** (risk-model statement in onboarding material) |
| 119 | 104, 108, 116, 117, 118 |
| 120 | **104** (chaos-matrix registration), 109, 111, 119 |
| 121 | 109, 118 |
| 122 | 102, 109 |
| 123 | 101, 102, **116** (renders evidence-packet artifacts in the inbox) |
| 124 | 116, 123 |
| 125 | 101, 105, 106, 114, **123** (escalation-artifact contract) |
| 126 | all of the above |

Waves (parallel projection; no WP shares a wave with any dependency; r3 correction 2 applied):

1. **W1:** 101, 102
2. **W2:** 103, 104, 109 · 105 (after Phase 0)
3. **W3:** 106, 107, 110, 122
4. **W4:** 108, 113, 114
5. **W5:** 111, 112, 115, 116
6. **W6:** 117, 118, 123
7. **W7:** 119, 124, 125
8. **W8:** 120, 121* → then **126**

\* 121's dependencies (109, 118) clear at the end of W6, so its earliest slot is W7; it is placed in W8 to keep David's per-wave review load flat. 118 sits in W6 because it consumes WP-115's risk-model statement in its onboarding material; 123 follows 116 because the inbox renders packet artifacts; 124/125 follow 123.

## 6. What happens on approval

1. Commit this plan to `docs/plan/phase-0-1-work-packages.md`, alongside the raw round-1/2/3 reviews and dispositions under `docs/plan/reviews/` (the archaeology convention, continued).
2. Create the two milestones, labels, and one GitHub Issue per WP (000–005, 101–126) with mapped IDs + verbatim PRD Accept text + dependency issue-links (including the Phase-0 chain).
3. Start WP-000 on a branch per the method: agent implements, cross-provider review attached, David merges.

## 7. Falsification review record

- **Round 1** (Codex gpt-5.6-sol xhigh, 2026-07-16): "safe to build on: **no**" — 19 findings; all accepted and folded into v2 (two with recorded nuances: urgent-lane P1 structure vs CAM-PLAN-10 [P2] workflow; xAI recording semantics).
- **Round 2** (same reviewer, 2026-07-16): "safe to build on: **no**" — 13 findings; regression table on round 1: 13 resolved, 6 partial, 0 unresolved; P1 ID inventory, scaffold-vs-§6, and Phase-1 exit fidelity independently CONFIRMED. All 13 findings folded into v3, including: the artifact-level dependency edges (packet schema, contract, quarantined diff, lease interface) with re-cut waves; §4.4 full-table idempotency + workflow-dispatch at-most-once clause with satisfiable WP-104 timing; the xAI item moved into the WP-000 entry gate; CAM-SEC-05's onboarding clause; CAM-AUTON-01's post-revocation reset; CAM-MERGE-13's checklist; CAM-CANON-09's visibility boundaries; enumerated registry globs + all three risk tiers + register filters; registry items 14/17 re-homed; CAM-ROUTE-08 dual ownership (000 gate + 105 runbook); the CI-enforced core import fence; the WP-125 single-package rescope; and allowlist-positive egress + read-only provider-auth fixtures.
- **Round 3** (same reviewer, verify-only, 2026-07-16): "safe to build on: **with corrections**" — r2 regressions: 10 resolved, 3 partial; r1 partials: 4 resolved, 2 partial; 2 new defects (both graph/ownership mechanics); wave consistency and all changed matrix rows independently verified clean. The four listed corrections are folded into this v4: (1) the xAI gate goes green only on the actual contractual confirmation, with a David-approved BUILD.md amendment as the sole alternative; (2) dependency edges 114→104, 115→104, 120→104, 123→116, 125→123 added and waves recut (123 after 116; 124/125 after 123); (3) WP-125 carries an enforced daemon-only diff fence and reuses the WP-123 escalation contract unchanged; (4) real-backend kill-point ownership assigned — branch-create → WP-120, CI/workflow-dispatch → WP-119 — both registering into the WP-104 chaos matrix consumed by WP-126.

## 8. Amendments

### 2026-07-22 — WP-110 decision package (approved by David on PR #57)

The WP-110 falsification review (ten rounds; record on PR #57) established that five obligation halves of WP-110's mapped criteria are delivered by consumer WPs, and that two items were unowned. David approved pinning each into its owning issue as an additional acceptance criterion; the issue bodies carry the same text under "Amendment — 2026-07-22":

1. **WP-114 (#21):** every attempt record carries a `ContractRef` (issueId, contractVersion, contractHash) for the contract it executes — CAM-PLAN-04 attempt half, pinned in `CONTRACT_REFERENCE_OBLIGATIONS`.
2. **WP-120 (#27):** issue and mission PR bodies embed their `ContractRef`(s) — CAM-PLAN-04 PR half; #27 gains the direct blocked-by edge on #17.
3. **WP-119 (#26):** push-time policy verifies the PR body's `ContractRef` against the candidate's frozen contract — CAM-PLAN-04 enforcement half.
4. **WP-113 (#20):** context packs render `dependencyInterfacesFor(issueId, contractVersion)` for the attempt's contract — CAM-PLAN-11 visibility half.
5. **WP-112 (#19):** change control defines which dependency contract version an in-flight dependent sees after an edit (conservative default: revalidate) — CAM-PLAN-11 version-policy half.
6. **WP-123 (#30):** the board renders the WP-110 plan view (streaming construction, flagged rows, acknowledgment state) — CAM-PLAN-01 board half; #30 gains the direct blocked-by edge on #17.
7. **WP-114 (#21), additionally:** recovery composition — `PlanStore` and `PlanningService.resumePendingWork()` join `openRecoveredState` with chaos-matrix coverage, as the first WP that runs planning state in the daemon process.
8. **WP-122 (#29):** the GUI wave's bundler decision resolves browser compatibility of `@camino/shared`'s node:crypto-backed hashing (split entry, polyfill, or server-only posture).

The quoted-verbatim sections of the issues are unchanged; amendments are appended sections. §5's dependency table gains no new rows beyond the two issue-link edges above (114→110 and 112/113→110 already existed).
