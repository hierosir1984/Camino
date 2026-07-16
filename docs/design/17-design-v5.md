# Camino — Consolidated Design v5

> 2026-07-16. **The authoritative current design — CLEARED FOR PRD.** Supersedes [14-design-v4.md](14-design-v4.md) by resolving all 6 round-4 blockers ([15 raw](15-adversarial-review-round4.md), [16 dispositions](16-review-round4-dispositions.md)). **Round 5 verdict: "safe to build on: with corrections — blockers: none"** ([18 raw](18-adversarial-review-round5.md), [19 clearance](19-review-round5-clearance.md)); its five deferrables are folded into §4.2 wording and §13.
>
> **Review history:** round 1 (38 findings, "with corrections") → round 2 (30, "no") → round 3 (17, "no"; 7 blockers) → round 4 (16, "no"; 6 blockers) → round 5 (5 deferrables, **no blockers — cleared**). Reviewer: Codex gpt-5.6-sol at xhigh throughout; every raw review preserved verbatim (docs 06, 09, 12, 15, 18) with independent verification (07, 10, 13, 16, 19).

## 1. What Camino is

A local-first developer tool — mission control for autonomous development. PRDs (or single quick tasks) enter through a simple GUI; the planner asks clarifying questions and constructs issues on an observable board; coding agents on the user's existing subscriptions (Claude Code, Codex CLI; API-key and self-hosted backends via adapters) implement each issue in an isolated workspace; work flows through independent validation into a mission integration branch, then to main; a **Living Canon** records intent, and a derived status layer records how much of that intent is demonstrably satisfied. Personal use first; open-source later; business model out of scope.

Five failure points: plan quality, worker completion, merge-without-a-human, durability, escalation quality.

**v1 autonomy, honestly:** everything starts in training mode — the user approves plans, issue merges, mission merges, and answers escalations. Autonomy is earned in stages (§8.3) covering, over time, issue merges, mission merges, quick-task merges, and plan approval for missions that introduce no new intent. **The end state is "interrupted only for genuine escalations and new-intent acceptance"** — accepting new product intent is the user's role by design (the founding brief lists "defining product intent" as the human's highest-leverage job), so it is never automated away; everything else is.

## 2. Invariants

1. **Claims are not state.** Done is observed, not declared.
2. **Split authority:** no creative process (worker, planner, reviewer) holds repository credentials; no creative output becomes enforced policy without a human or deterministic gate. Workers hold model-provider auth only.
3. **The event log is truth for decisions; external systems are truth for external facts.** Recovery reconciles per the idempotency contract (§4.4); it never blindly replays.
4. **Ceremony scales with mission class**; classification is never a single creative judgment (§3.5).
5. **Autonomy is earned per capability, staged, and revocable.**
6. **The user's PRD text and explicit confirmations are the only sources of intent.** Canon text carries intent only; it never derives from implementation diffs — external changes enter intent only through the user's answer to a proposed delta (§4.5).
7. **Evidence binds to (attempt, commit SHA, base SHA)** and expires rather than rebinding; history-rewriting operations are forbidden on branches carrying evidence.
8. **Only Camino-authored commits are pushed.** Worker history never leaves quarantine (§5.1).

## 3. The Living Canon v4

### 3.1 The intent ledger; canon text and status both derived

Round 3 proved status-in-text self-contradictory; round 4 proved *intent-in-text* transactionally coupled to delivery (reverting a fold would delete intent the user never descoped). v5 makes the architecture uniform — **the control plane's event log is authoritative for both intent and status; everything in the repo is a projection**:

- **The intent ledger lives in the control plane.** Per requirement ID: *intent-disposition* `proposed` → `accepted` | `disputed` → (`resolved-accepted` | `assumed` — user signs off a documented assumption | `descoped`). **Only user actions (intake confirmations, dispute answers, descope approvals) mutate the ledger.** Nothing that happens to code — merge, revert, abandonment — can create, delete, or change intent.
- **Canon text = the rendered projection of accepted intent**, versioned in the repo for agents and humans to read. Folds update the rendering and ride the mission PR. If a mission is reverted or abandoned, the ledger is untouched and the next fold re-renders any intent the reverted text carried — accepted-but-unbuilt requirements cannot be stranded or silently deleted.
- **Status = derived state**, per requirement ID:
  - *implementation-state, per branch context:* `absent` | `present-on(<branch>)` | `on-main` | `suspected-absent` (an external edit or failing probe suggests the implementation no longer exists — conservative invalidation until re-scanned) — derived from merge events plus reconciliation scans.
  - *evidence-state:* `unverified` | `verified-live` | `stale` | `blocked`.
- **Context packs render ledger + status for the reader's context.** A worker on mission branch M sees "R: accepted; changed on this branch; branch version unverified" — never "verified" inherited from main for code the branch touched, and never presence the reconciler now doubts.
- Reverts, external edits, and probe regressions *recompute* projections; nothing hand-maintains reverse transitions.

### 3.2 Verification methods and coverage

Per-requirement verification-method attribute: `probe` | `audit` | `planner-check` | `guard` | `none`. Headline canon coverage = verified-live fraction of probe-method requirements, labeled as such; immature in v0 by design (§8.1).

### 3.3 Brownfield induction

Draft canon with provenance (`doc`/`code`/`inferred`) and confidence; conflicts become `disputed` with a blast-radius-ranked question queue, resolved lazily; `assumed` handles unknowable history. Induction sets up the validatable-repo profile. Authority accretes.

### 3.4 Gap register

Requirement → status tuple → evidence provenance → disposition (`fix-queued` | `disputed` | `false-positive-waived` — waivers only for detector false positives). Mission terminal states: `complete`, `complete-with-residue` (descopes counted against coverage and delivery metrics), `abandoned`.

### 3.5 Folds, intake, classification

- **Intake:** PRD → canon deltas; user confirms the requirement checklist diff (unmapped items highlighted). **Cross-family plan challenge** before approval — for all missions; quick tasks get a proportionate cross-family mini-review (cheap at that scale) rather than none.
- **Folds ride the mission branch** (intent changes only, per §3.1 — the timing paradox is gone). Standalone fold PRs only from periodic audits.
- **Classification with two locks:** the planner proposes `canon-affecting`/`canon-neutral`; deterministic diff triggers (migrations, auth/authz, dependency manifests, flags, boot/validation config, protected paths, route/UI/API-surface paths) force reclassification; and fold suppression on a quick task requires the *reviewer model to concur* with the neutral label. Probes are governed by observability, not by this label: deterministic surface heuristics plus the reviewer's judgment decide "user-observable," and any user-observable change gets a probe.
- **Periodic audit:** canon consistency + sampled PRD-vs-canon checks.

### 3.6 Probes and detectors

Probes authored at plan time from the canon, author-separated from judged workers; lifecycle pass/fail/flaky/quarantined/infra-blocked with auto-retry, quarantine tickets, per-repo flake budget, detector-health view. **Mutation testing is probe-improvement tooling — it strengthens probes; it is *not* a calibrated false-negative estimator** (the literature says mutation scores correlate weakly with real-fault detection); autonomy decisions rely on outcome tracking instead (§8.3). Wiring detectors remain heuristics ranked below probe evidence.

### 3.7 Per-repo operational knowledge, with a trust lifecycle

`.camino/knowledge.md` entries carry state: attempts (including failed ones) write **candidate** entries with provenance (attempt ID, commit/base validity, context) into the control plane immediately — nothing is lost with a failed workspace. **Candidates are visible to repair attempts of the same issue** (provenance-marked, so the reader knows the source is an unvetted sibling attempt) — a discovered workaround transfers to the immediate retry without waiting for curation. Promotion to **approved** — the only state that enters other missions' context packs — happens through a human curation batch or deterministic rule-classes (e.g., "commands observed to succeed N times"), never an unattended creative judgment (invariant 2). Entries invalidate when their recorded commit/base validity is reverted; contradictions escalate to curation; entries carry scope and expiry.

## 4. Mission pipeline v4

### 4.1 Intake, contracts, change control

As v3: hash-referenced contract versions; edits create v(n+1) with compatible-work completion or cancel-and-replan; planner semantic-impact assessment over dependents on every contract change (conservative default: revalidate); edit-cancelled attempts excluded from router scorecards, included in mission economics.

### 4.2 Merge strategy with freshness and liveness

- Issue PRs target `mission/<id>`; training mode approvals per §1; earned tier-1 auto-merge per §8.3.
- **Merge-by-push protocol (round-4 fix): what is validated is bit-for-bit what lands.** GitHub's PR-merge button is not the merge mechanism — it would mint a new, never-validated SHA. Instead the control plane constructs the exact merge commit locally in the pristine clone (invariant 8 already makes Camino the author of every pushed commit; now including merge commits), runs the gating validation **at that SHA** (fast suite for issue→branch merges; full probe suite for mission→main). To satisfy protected-branch required checks, the candidate is first pushed to a temporary ref so it exists remotely, and Camino's runner attests it via the commit-status API (fine-grained PATs and Apps can) **before** the protected ref advances (round-5 correction; protocol detail in §13). The push itself is guarded by an explicit check that the target ref still equals the validated base — fast-forward success alone is not the guard, since a race to an ancestor of the candidate would still fast-forward (round-5 wording fix); any base change triggers rebuild-and-revalidate. PRs remain the review and audit surface; **mission PRs to main are marked merged by GitHub when their head lands; issue PRs targeting mission branches are closed by Camino itself with linkage metadata** (GitHub only auto-recognizes indirect merges into the default branch — round-5 correction, detail in §13).
- **Freshness:** every verdict binds to (head SHA, base SHA); old verdicts expire and are never rebound — "scoped revalidation" means re-execution of the affected subset, chosen conservatively by the impact assessment.
- **Liveness by serialization (restored):** one active mission per repo, one urgent lane, and a single validation-environment owner make the merge queue depth-one; bounded revalidation retries (registry: exact bound) then escalate rather than spin.
- **Branch integrity posture (round-4 correction):** a personal PAT authenticates as the user, so GitHub cannot distinguish "Camino" from "David's laptop" as push actors — mission-branch integrity therefore rests on **detection and reconciliation, not prevention**: ExternalEdit events plus the freshness rules plus merge-by-push mean a manual advance can never slip into a merge unvalidated. A distinct **GitHub App identity — which GitHub's rulesets can target as an actor — is a prerequisite for any autonomy unlock** (§8.3), not a deferred nicety. **Onboarding requirements:** main protected with required checks, required-up-to-date, and non-bypass settings; these are verified at onboarding, not assumed.
- After every issue merge: fast suite on the new branch head (build/unit/smoke — bounded early warning, not a semantic guarantee; full probes still gate the mission).
- Syncs are merges, never rebases. Rollback is a repair-mission type opening with the mission-merge revert (which reverts the fold), status recomputation, and an external-state checklist; unrevertable effects escalate.
- Quick tasks (single-issue, neutral-agreed, non-sensitive) PR to main with approval. Urgent lane as v3 (checkpoint-cancel allowed; merge-based; evidence bindings survive).

### 4.3 Validation stack

As v3, plus: the evidence packet (§7.2) is assembled per attempt and per mission — it is the object the human approves against, not scattered links.

### 4.4 Durability: the idempotency contract

Single daemon, single-writer recovery lock. Per side-effect class, a defined reconciliation key:

| Operation | Key / mechanism |
|---|---|
| Branch create | Branch name (natural key); state query |
| Push | Intended SHA recorded in the intent event; reconcile by comparing observed ref to intended SHA |
| PR create | Intent UUID written into the PR body at creation + head-branch natural key (bodies are mutable — the branch key is primary, the UUID corroborates); closed/reused-branch ambiguity → escalation class |
| Merge (by push, §4.2) | Idempotent by ref state: is main at/past the constructed merge commit |
| Labels | Naturally idempotent as (object, label, desired state) |
| Comments | Embedded UUID marker |
| CI / workflow dispatch | **At-most-once class** — `camino_intent_id` input surfaced via run-name is *correlation for observability, not an idempotency guarantee*; on lost-response ambiguity there is no automatic retry; duplicates are tolerable because GitHub CI on worker refs is advisory-only (Camino's runner gates merges) |
| External test-service mutations | Environment granularity: reset-before-use makes the environment the idempotency unit; janitor respects lease generations (§4.6). Irreversible effects (sent emails/webhooks, consumed quota) are recorded as ambiguity, never auto-retried |
| Anything else | At-most-once with the ambiguity durably recorded before any manual retry, then human escalation — stated, not hidden |

### 4.5 Out-of-band edits: detect, then reconcile intent through the user

Detection scope, stated exactly: polling covers commits on watched branches, branch creation/deletion, PR field changes, and protection-rule changes; force-pushes are detected as non-fast-forward ref moves. **Transient transitions that revert between polls (ref moved and restored, protection toggled off and on) are undetectable by snapshot polling — an accepted v1 limitation, stated rather than hidden; webhook migration closes it later.** Claims stop at that list. An external deletion that removes implementation sets `suspected-absent` (§3.1) with conservative invalidation until re-scanned.

Reconciliation: implementation- and evidence-states recompute automatically (§3.1). Intent reconciliation runs through the user: a canon-impact scan of external commits produces **proposed canon deltas as questions** ("you changed X on main — record it as intended behavior?"); David's answer — not the diff — authorizes any canon change (invariant 6). A deletion that breaks a verified requirement surfaces as evidence-state `stale` plus a gap-register question. Active missions pause affected issues pending the impact assessment, as v3.

### 4.6 Execution state machine (sketch; full table is PRD work)

Missions: draft → planned → approved → executing → merging → complete / complete-with-residue / abandoned, plus paused-external, paused-urgent, blocked, and escalated interrupts. Issues: ready → claimed (leased) → implementing → validating → merge-pending → merged / replanning / cancelled / blocked / escalated, with cleanup-failed recorded where teardown breaks. Attempts carry **leases with generations (fencing):** every environment operation presents its lease generation and the runner rejects stale-generation writes, so an expired-but-still-running container cannot race its successor; re-grant happens only after kill-confirm of the prior holder's processes. A crashed daemon resumes by lease inspection; transitions are events; the validation environment has exactly one *fenced* owner at a time.

## 5. Execution plane and security v4

### 5.1 Quarantine v2: squash-and-rebuild — worker history never leaves

- Workers work in isolated full clones (no shared `.git`), no GitHub credentials.
- The control plane **shallow-fetches only the worker's final head** into the pristine, hooks-disabled clone (with transfer size budgets), computes the base-tree↔head-tree diff, and runs policy checks on the final tree: scope, protected paths (now including `.gitattributes` and CI definitions), **canonical path identity** (case-fold and Unicode-normalization collisions rejected; reserved-name aliases rejected), submodule/gitlink introductions blocked, symlink targets checked, tree size budgeted.
- It then **authors a fresh commit applying that tree onto the assigned base** — Camino as committer, worker attribution in a trailer. Worker-authored history, intermediate commits, and their objects are never fetched deeply, never pushed, and cannot smuggle reachable content; worker merge commits are rejected outright. The worker's local history is archived from its workspace for audit before cleanup — **under quotas**: fetch object-count and size budgets (partial-clone blob filters where useful), workspace and archive size caps with bounded retention, so intermediate-object bloat is a contained resource problem, not a stored one.
- Credentialed git never executes in worker-touched directories; pushes use the fine-grained PAT (org-policy caveats noted; GitHub App later).

### 5.2 Worker backends

Adapters: official vendor CLIs on user subscriptions (subscription auth is only ever exercised inside that vendor's official harness); **API-key backends** (any provider, self-hosted/OpenAI-compatible included) whose keys are custodied in Camino's local vault (§9 states this plainly); future harnesses. Adapters own stream protocols, cancellation, cleanup, quota classification.

### 5.3 Secrets and validation: an explicit threat model

Validation executes worker-authored code where test secrets live. v4 states what is and isn't defended:

- **T1 — accidental leakage** (the common case): no-egress validation environment except allowlisted test endpoints; literal secret-pattern scrubbing of retained artifacts; secrets never in worker environments. Defended.
- **T2 — prompt-injected worker with observable misbehavior:** provenance-tagged context packs, deterministic reclassification triggers, validation-config diff review, cross-family review, and the injection red-team (§11) which calibrates hardening. Defended proportionately to what the red-team finds.
- **T3 — a determined, covert adversarial model: acknowledged residual risk, priced in full.** No scrubbing catches Base64-of-reversed-chunks; no destination allowlist constrains legal writes to a test service. Within pre-merge stages the damage is bounded: test-scoped secrets only, per-repo isolated tenants (no shared fixtures), quota caps, disposability, per-mission rotation for sensitive tenants, runner-side evidence capture, full audit logging. **Beyond the merge, the bound honestly ends:** a covert payload that passes every gate (probes, cross-family review, human mission approval) lands on main like any accepted contribution and will eventually run wherever the user's own CI and tooling run main's code — the standard supply-chain risk of accepting code from any source, human or AI. Camino's containment claims apply to pre-merge stages; post-merge, the defense is the gates themselves plus the §5.5 hardening. For a personal tool this residual is accepted and documented; it is re-priced before any multi-user distribution.
- Pre-mission preflight (boot + credential health), plan-time resource declaration for the declarable subset, `infra-blocked` classification for the rest — as v3.

### 5.4 Local daemon surface

As v3: 127.0.0.1 only, token-authenticated (0600 file), CSRF-protected, single-OS-user trust model stated.

### 5.5 CI posture (new): GitHub Actions is untrusted on worker refs

Repo onboarding configures: default workflow token permissions **read-only** (note: this governs `github.token` itself, which actions access implicitly — `persist-credentials: false` alone only removes checkout's stored credential); Actions on `mission/*` and issue branches disabled or restricted to no-secret, read-only-token workflows; merge gating comes from **Camino's validation runner**, not repo CI, on worker-authored refs. **Main-side hardening (round-4 fix):** v1 Camino needs no privileged main workflows at all (deployment is out of scope), so onboarding additionally verifies that any *pre-existing* privileged main workflows keep secrets behind environment protection with required reviewers, sets minimal default token permissions on main, recommends action pinning, and **does not support persistent self-hosted runners in v1** (GitHub-hosted ephemeral only) — a persistent runner would let an ostensibly read-only worker-ref job plant persistence for a later privileged job. Worker-derived code that reaches main is governed by §5.3's post-merge honesty: gates, not magic.

## 6. Router v4

As v3 with corrections: **trajectories are terminal only at mission resolution**, and mission outcomes carry a **per-issue delivered flag** — in a `complete-with-residue` mission, issues that reached main are distinguished from those descoped or reverted, so a correct issue in a partly-failed mission is not scored identically to the issue that sank it (attribution stays honest without pretending branch merges are delivery). **Blocked-age past a threshold charges the abandonment penalty as a provisional charge, reversed if the issue later delivers** — terminal-only scoring and the anti-gaming penalty coexist. Coarse cells, report → advisor stages, conditional Stage-3 aspiration, quota opportunity-cost scheduling — unchanged.

## 7. Human surface, attention, and evidence

### 7.1 Approvals and attention

Training-mode approvals per §1; the autonomy ladder (§8.3) now covers plan approval and quick tasks as later tiers, so the claimed end state has a defined path. Attention accounting: per-mission headline, dwell-plus-weekly-self-report, and a **defined overrun trigger** — provisional budget: 15 minutes of routine (non-escalation) attention per merged issue-equivalent averaged over a trailing month; overrun forces an explicit choice among raising the budget, pausing autonomy expansion, or tightening ceremony (numbers are provisional; registry).

### 7.2 The evidence packet (restored as a first-class object)

Per attempt and rolled up per mission: contract version hash, requirement map, commands executed, artifacts (logs, screenshots, traces — scrubbed), retries and failure classifications, reviewer verdicts, probe results with SHAs, exclusions and waivers. **Every packet item carries its own (SHA, base) identity, and the ordering is explicit:** worker-side checks bind to the worker head and are *advisory*; **gating evidence is produced only on Camino-authored candidates** — the squash-rebuilt commit and the constructed merge commits of §4.2 — so the evidence that licenses a merge describes exactly the bits that land (commit-dependent behavior like version-string generation differing between worker and rebuilt commits is thereby outside the gating path by construction). **The packet is what the human approves against**, the register cites, and post-merge outcomes calibrate. The v0 GUI includes an evidence viewer.

## 8. v1 scope and staging

### 8.1 Skeleton v0

As v3 (one repo, PAT, polling, SQLite, feature + quick-task templates, two subscription adapters + API-key adapter interface, integration branch with fast suite, TODO/coverage detectors, canon root + derived status, register as table) **plus**: evidence viewer in the GUI, CI-posture onboarding checks, squash-and-rebuild quarantine, serialize-per-repo, attempt leases. Status honesty: requirements cap at implementation-state until requirement-mapped checks exist; coverage labeled immature.

### 8.2 Phases

Measurement-gated: skeleton → instrumented pilot missions (training mode) → hardening. Named schedule eaters unchanged.

### 8.3 Earned autonomy, statistics stated honestly

Tiers: (1) issue→branch auto-merge; (2) mission→main auto-merge; (3) quick-task auto-merge; (4) **plan auto-approval only for plans that introduce no new intent** — quick tasks, gap-fix missions executing already-accepted requirements, maintenance. Plans carrying new intent always require user confirmation, permanently: that is the §1 end-state by design, not remaining debt. **Prerequisite for any unlock: the GitHub App identity** (§4.2) — autonomy without a distinct push actor is not offered. Unlocks are **policy heuristics, stated as such — no statistical bound is claimed**: a rolling window of human-confirmed agreements (provisional: ≥50, zero false approvals for tier 1) under a data-dependent stopping rule licenses no failure-rate inference about shifted future work, so the justification is containment (tier 1 cannot touch main), continuing post-merge outcome labels, **joint-distribution guards** (an issue auto-merges only if its combination of risk tier, area, and template is represented in the window — not merely each attribute separately), and instant revocation on any disagreement, regression, or revert. Tier 2 additionally requires months of tier-1 evidence and demonstrated probe quality via outcome tracking (not mutation scores). Training mode is the default for every new repo and after every revocation.

## 9. Provider policy risk register

As v3 (OpenAI endorsed; Anthropic internally tense — support says subscription pools currently cover Agent SDK/`claude -p`, legal directs third-party products to API keys, billing separation announced-then-paused; xAI/GLM verified at onboarding; funded API fallback as continuity prerequisite) with the corrected credential claim: **subscription auth is never extracted, proxied, or handled outside official vendor harnesses; API keys and test secrets, when used, are custodied in Camino's local OS-keychain-backed vault.** Personal use is the low-risk end; open-source release requires a compliance pass and ships with subscription handling unchanged (each user's official CLIs, their logins).

## 10. Market position

As v3 §10, scoped to the assessed set. Factory's mission economics adopted as planning reality.

## 11. Experiments

1. Dispatch spike (mechanics). 2. PRD-to-plan probe incl. cross-family challenge. 3. Thin pilot mission in training mode (failure catalog; completion-rate instrumentation). 4. Gate calibration replay (screen). 5. **Injection red-team before any unattended mission** — now explicitly calibrates the §5.3 threat-model tiers. 6. Validation-environment egress and scrubbing tests. 7. Quarantine tests: smuggling attempts (reachable-history, path-collision, gitattributes, submodule) against §5.1 as executable checks.

## 12. Round-4 correction map

| Round-4 blocker | Resolved in |
|---|---|
| Privileged main CI executes worker-derived code | §5.3 (post-merge honesty: supply-chain framing, containment claims scoped to pre-merge), §5.5 (main-side hardening; no persistent self-hosted runners in v1; v1 needs no privileged main workflows) |
| Pure-intent canon reverted with implementation | §3.1 (intent ledger in the control plane, user-action-only; canon text is a rendered projection — reverts cannot delete intent) |
| Exact-SHA evidence lacks a compatible merge operation | §4.2 (merge-by-push: Camino constructs, validates, and fast-forward pushes the exact merge commit) |
| Workflow dispatch non-idempotent | §4.4 (reclassified at-most-once; correlation-only run-name; duplicates tolerable because worker-ref CI is advisory) |
| PAT cannot enforce Camino-only pushes | §4.2 (integrity by detection + reconciliation + merge-by-push; **GitHub App identity required before any autonomy unlock**, §8.3) |
| Tier-4 plan approval vs user-only intent | §8.3 + §1 (tier 4 restricted to no-new-intent plans; new-intent confirmation is the permanent human role) |

Round-4 deferrables: §5.1 (fetch/archive quotas), §3.1+§4.5 (`suspected-absent`, polling limits stated), §4.4 (table refinements), §4.6 (lease generations/fencing, added states), §3.7 (promotion authority, sibling-attempt visibility, revision validity), §8.3 (statistical claim withdrawn; joint-distribution guards), §7.2 (evidence ordering; gating evidence only on Camino-authored candidates), §6 (per-issue delivered flags; provisional penalty), §13 (registry completed).

## 13. PRD registry (explicitly deferred specification detail)

Exact revalidation retry bounds; the user-observable path-heuristic list; final attention-budget numbers; full mission/issue/attempt transition table incl. kill-confirm sequencing; lease-generation implementation; knowledge promotion rule-classes; probe-authorship tooling; evidence-packet schema and viewer design; gap-register UI; webhook migration (closing the transient-transition polling gap); worker/archive resource quota values; multi-repo scheduling; per-provider quota-window models; xAI/GLM adapter specifics; sequential-analysis-grade autonomy statistics if numeric claims are ever wanted; deployment and post-deployment validation as explicit future scope from the founding brief.

**Added by round 5 (deferrables, all accepted):** the temporary-ref + commit-status attestation protocol for merge-by-push; a **non-creative tier-4 eligibility check** (proposal: tier 4 applies only to missions whose plans reference exclusively pre-existing accepted requirement IDs and propose no ledger additions — deterministically checkable — plus an escalation class for "consequential architectural decisions" per the founding brief's human role); onboarding handling for private repos where environment required-reviewers are unavailable on the user's GitHub plan (warn, require secret relocation, or record accepted risk); Camino-side closure of issue PRs with linkage metadata (GitHub only auto-recognizes indirect merges to the default branch); and canon projection freshness between folds (render-on-read in the GUI is already ledger-fresh; the repo file gains a rendered-at marker, and a standalone intent-only fold triggers when ledger-vs-text divergence exceeds a threshold).
