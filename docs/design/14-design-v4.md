# Camino — Consolidated Design v4

> **2026-07-16 (later): HISTORICAL — frozen as round 4's review target. Superseded by [17-design-v5.md](17-design-v5.md)** after round 4 returned "safe to build on: no" with 6 blockers ([15 raw](15-adversarial-review-round4.md), [16 dispositions](16-review-round4-dispositions.md)).
>
> 2026-07-16. **The authoritative current design.** Supersedes [11-design-v3.md](11-design-v3.md) (frozen as round 3's target) by resolving all 7 round-3 blockers and addressing all 10 deferrables ([12 raw](12-adversarial-review-round3.md), [13 dispositions](13-review-round3-dispositions.md)). §12 maps corrections; §13 is the registry of items explicitly deferred to the PRD. Round-4 falsification target.

## 1. What Camino is

A local-first developer tool — mission control for autonomous development. PRDs (or single quick tasks) enter through a simple GUI; the planner asks clarifying questions and constructs issues on an observable board; coding agents on the user's existing subscriptions (Claude Code, Codex CLI; API-key and self-hosted backends via adapters) implement each issue in an isolated workspace; work flows through independent validation into a mission integration branch, then to main; a **Living Canon** records intent, and a derived status layer records how much of that intent is demonstrably satisfied. Personal use first; open-source later; business model out of scope.

Five failure points: plan quality, worker completion, merge-without-a-human, durability, escalation quality.

**v1 autonomy, honestly:** everything starts in training mode — the user approves plans, issue merges, mission merges, and answers escalations. Autonomy is earned in stages (§8.3) covering, over time, issue merges, mission merges, quick-task merges, and plan approval for small missions — each with the same evidence-gated, instantly-revocable mechanics. "Interrupted only by genuine escalations" is the end of that ladder; v1 sits at its bottom.

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

### 3.1 Intent in the repo; status derived in the control plane

Round 3 proved that storing status inside canon text is self-contradictory (a fold riding the mission PR would assert `built` before reaching main). v4 separates the layers:

- **Canon text = intent only**, versioned in the repo: product intent, users, invariants, scope, architecture principles, per-feature requirements with stable IDs. Because it is pure intent, canon changes legitimately ride the mission PR (the fold), and reverting a mission merge reverts its intent changes with it.
- **Status = derived state in the control plane**, never stored in canon text. Per requirement ID, a tuple:
  - *intent-disposition:* `proposed` → `accepted` | `disputed` → (`resolved-accepted` | `assumed` — user signs off a documented assumption | `descoped`). Only user actions move intent-dispositions.
  - *implementation-state, computed per branch context:* `absent` | `present-on(<branch>)` | `on-main` — derived from merge events.
  - *evidence-state:* `unverified` | `verified-live` (a currently-green requirement-mapped check on the context branch's version) | `stale` (evidence exists but the requirement's implementation changed since, or its probe is quarantined/infra-blocked) | `blocked`.
- **Context packs render the tuple for the reader's context.** A worker on mission branch M sees "R: accepted; changed on this branch; branch version unverified" — never "verified" inherited from main for code the branch has since touched. Agents cannot be misinformed by an enum that can't represent branch-relative truth, because truth is computed per branch.
- Reverts, external edits, and probe regressions all *recompute* state rather than requiring hand-maintained reverse transitions; prior requirement versions restore naturally because canon text is versioned in git and status is derived.

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

`.camino/knowledge.md` entries carry state: attempts (including failed ones) write **candidate** entries with provenance (attempt ID, context) into the control plane immediately — nothing is lost with a failed workspace; candidates are promoted to **approved** at fold review (or a weekly curation batch), and only approved entries enter context packs — a prompt-injected worker cannot poison future packs (invariant 2). Entries carry scope and expiry; contradiction with an existing entry escalates to curation.

## 4. Mission pipeline v4

### 4.1 Intake, contracts, change control

As v3: hash-referenced contract versions; edits create v(n+1) with compatible-work completion or cancel-and-replan; planner semantic-impact assessment over dependents on every contract change (conservative default: revalidate); edit-cancelled attempts excluded from router scorecards, included in mission economics.

### 4.2 Merge strategy with freshness and liveness

- Issue PRs target `mission/<id>`; training mode approvals per §1; earned tier-1 auto-merge per §8.3.
- **Freshness:** every verdict binds to (head SHA, base SHA); an issue merges only if validated against the current mission-branch head; the mission merges only when the branch contains current main and the full probe suite is green at that exact head. **Old verdicts expire and are never rebound** — "scoped revalidation" means re-execution of the affected subset, chosen conservatively by the impact assessment.
- **Liveness by serialization (restored):** one active mission per repo, one urgent lane, and a single validation-environment owner at a time make the merge queue depth-one and starvation structurally unlikely; bounded revalidation retries (registry: exact bound) then escalate rather than spin.
- **Onboarding requirements (new):** branch protection with required-up-to-date and **non-bypass** settings on main; `mission/*` branches protected against non-Camino pushes; these are checked at repo onboarding, not assumed.
- After every issue merge: fast suite on the new branch head (build/unit/smoke — bounded early warning, not a semantic guarantee; full probes still gate the mission).
- Syncs are merges, never rebases. Rollback is a repair-mission type opening with the mission-merge revert (which reverts the fold), status recomputation, and an external-state checklist; unrevertable effects escalate.
- Quick tasks (single-issue, neutral-agreed, non-sensitive) PR to main with approval. Urgent lane as v3 (checkpoint-cancel allowed; merge-based; evidence bindings survive).

### 4.3 Validation stack

As v3, plus: the evidence packet (§7.2) is assembled per attempt and per mission — it is the object the human approves against, not scattered links.

### 4.4 Durability: the idempotency contract

Single daemon, single-writer recovery lock. Per side-effect class, a defined reconciliation key:

| Operation | Key / mechanism |
|---|---|
| Branch create/push | Branch name (natural key); state query |
| PR create | Intent UUID written into the PR body at creation + head-branch natural key (bodies are mutable — the branch key is primary, the UUID corroborates) |
| Merge | Idempotent by state: query merged-ness of the exact SHA |
| CI / workflow dispatch | `camino_intent_id` workflow input, surfaced via `run-name` templating — an onboarding requirement for any workflow Camino dispatches; recovery lists runs and matches |
| Comments/labels | Embedded UUID marker |
| External test-service mutations | Environment granularity: reset-before-use makes the environment the idempotency unit; janitor respects leases (§4.6) |
| Anything else | At-most-once with human escalation on ambiguity — stated, not hidden |

### 4.5 Out-of-band edits: detect, then reconcile intent through the user

Detection scope, stated exactly: polling covers commits on watched branches, branch creation/deletion, PR field changes, and protection-rule changes; force-pushes are detected as non-fast-forward ref moves. Claims stop at that list.

Reconciliation: implementation- and evidence-states recompute automatically (§3.1). Intent reconciliation runs through the user: a canon-impact scan of external commits produces **proposed canon deltas as questions** ("you changed X on main — record it as intended behavior?"); David's answer — not the diff — authorizes any canon change (invariant 6). A deletion that breaks a verified requirement surfaces as evidence-state `stale` plus a gap-register question. Active missions pause affected issues pending the impact assessment, as v3.

### 4.6 Execution state machine (sketch; full table is PRD work)

Missions: draft → planned → approved → executing → merging → complete / complete-with-residue / abandoned, with paused-external and paused-urgent interrupts. Issues: ready → claimed (leased) → implementing → validating → merge-pending → merged / replanning / cancelled. Attempts carry **leases** (worker identity, container ID, expiry); a crashed daemon resumes by lease inspection — expired lease = attempt abandoned and cleaned, live lease = re-attach; transitions are events; the validation environment has exactly one owner at a time.

## 5. Execution plane and security v4

### 5.1 Quarantine v2: squash-and-rebuild — worker history never leaves

- Workers work in isolated full clones (no shared `.git`), no GitHub credentials.
- The control plane **shallow-fetches only the worker's final head** into the pristine, hooks-disabled clone (with transfer size budgets), computes the base-tree↔head-tree diff, and runs policy checks on the final tree: scope, protected paths (now including `.gitattributes` and CI definitions), **canonical path identity** (case-fold and Unicode-normalization collisions rejected; reserved-name aliases rejected), submodule/gitlink introductions blocked, symlink targets checked, tree size budgeted.
- It then **authors a fresh commit applying that tree onto the assigned base** — Camino as committer, worker attribution in a trailer. Worker-authored history, intermediate commits, and their objects are never fetched deeply, never pushed, and cannot smuggle reachable content; worker merge commits are rejected outright. The worker's local history is archived from its workspace for audit before cleanup.
- Credentialed git never executes in worker-touched directories; pushes use the fine-grained PAT (org-policy caveats noted; GitHub App later).

### 5.2 Worker backends

Adapters: official vendor CLIs on user subscriptions (subscription auth is only ever exercised inside that vendor's official harness); **API-key backends** (any provider, self-hosted/OpenAI-compatible included) whose keys are custodied in Camino's local vault (§9 states this plainly); future harnesses. Adapters own stream protocols, cancellation, cleanup, quota classification.

### 5.3 Secrets and validation: an explicit threat model

Validation executes worker-authored code where test secrets live. v4 states what is and isn't defended:

- **T1 — accidental leakage** (the common case): no-egress validation environment except allowlisted test endpoints; literal secret-pattern scrubbing of retained artifacts; secrets never in worker environments. Defended.
- **T2 — prompt-injected worker with observable misbehavior:** provenance-tagged context packs, deterministic reclassification triggers, validation-config diff review, cross-family review, and the injection red-team (§11) which calibrates hardening. Defended proportionately to what the red-team finds.
- **T3 — a determined, covert adversarial model exfiltrating transformed secrets or corrupting the proof oracle: acknowledged residual risk.** No scrubbing catches Base64-of-reversed-chunks; no destination allowlist constrains legal writes to a test service. The design bounds the damage instead of claiming prevention: secrets are test-scoped only; tenants are per-repo isolated (no shared fixtures across repos), quota-capped, and disposable; sensitive tenants rotate per-mission rather than per-schedule; probes execute from the runner side with runner-captured evidence; everything is audit-logged. For a personal tool this residual is accepted and documented; it is re-priced before any multi-user distribution.
- Pre-mission preflight (boot + credential health), plan-time resource declaration for the declarable subset, `infra-blocked` classification for the rest — as v3.

### 5.4 Local daemon surface

As v3: 127.0.0.1 only, token-authenticated (0600 file), CSRF-protected, single-OS-user trust model stated.

### 5.5 CI posture (new): GitHub Actions is untrusted on worker refs

Repo onboarding configures: default workflow token permissions **read-only**; Actions on `mission/*` and issue branches either disabled or restricted to workflows with `persist-credentials: false`, no secrets, and read-only tokens; merge gating comes from **Camino's validation runner**, not repo CI, on worker-authored refs. Existing repo workflows that need broader rights run on main after merge — where every commit is Camino-authored and gated (invariant 8). This closes the round-3 hole where repo CI handed a repository token back to worker-authored code.

## 6. Router v4

As v3 with two corrections: **trajectories are terminal only at mission resolution** — an issue's merge into the mission branch is an intermediate event; the issue's cost lands when its mission reaches main / residue / abandonment, so work that "succeeded" into a doomed branch is priced by what it delivered, which is nothing. **Blocked-age past a threshold charges the abandonment penalty automatically** rather than being merely recorded. Coarse cells, report → advisor stages, conditional Stage-3 aspiration, quota opportunity-cost scheduling — unchanged.

## 7. Human surface, attention, and evidence

### 7.1 Approvals and attention

Training-mode approvals per §1; the autonomy ladder (§8.3) now covers plan approval and quick tasks as later tiers, so the claimed end state has a defined path. Attention accounting: per-mission headline, dwell-plus-weekly-self-report, and a **defined overrun trigger** — provisional budget: 15 minutes of routine (non-escalation) attention per merged issue-equivalent averaged over a trailing month; overrun forces an explicit choice among raising the budget, pausing autonomy expansion, or tightening ceremony (numbers are provisional; registry).

### 7.2 The evidence packet (restored as a first-class object)

Per attempt and rolled up per mission: contract version hash, requirement map, commands executed, artifacts (logs, screenshots, traces — scrubbed), retries and failure classifications, reviewer verdicts, probe results with SHAs, exclusions and waivers. Bound to (attempt, commit SHA, base SHA). **The packet is what the human approves against**, the register cites, and post-merge outcomes calibrate. The v0 GUI includes an evidence viewer — board, approvals with packet view, escalation inbox.

## 8. v1 scope and staging

### 8.1 Skeleton v0

As v3 (one repo, PAT, polling, SQLite, feature + quick-task templates, two subscription adapters + API-key adapter interface, integration branch with fast suite, TODO/coverage detectors, canon root + derived status, register as table) **plus**: evidence viewer in the GUI, CI-posture onboarding checks, squash-and-rebuild quarantine, serialize-per-repo, attempt leases. Status honesty: requirements cap at implementation-state until requirement-mapped checks exist; coverage labeled immature.

### 8.2 Phases

Measurement-gated: skeleton → instrumented pilot missions (training mode) → hardening. Named schedule eaters unchanged.

### 8.3 Earned autonomy, statistics stated honestly

Tiers: (1) issue→branch auto-merge; (2) mission→main auto-merge; (3) quick-task auto-merge; (4) plan auto-approval for small, low-risk missions. Each unlocks per repo on accumulated human-confirmed agreement over a **rolling window** (provisional: ≥50 consecutive agreements, zero false approvals for tier 1) — **stated plainly: such a window bounds the observed failure rate on sampled past work (≈≤5.8% at 95% confidence for 0/50) and licenses nothing about distribution-shifted future work.** Unlocks are therefore policy choices justified by containment (tier 1 cannot touch main), continuing post-merge outcome labels, distribution guards (an issue whose risk tier, area, or template differs from the window's composition does not auto-merge), and instant revocation on any disagreement, regression, or revert. Tier 2 additionally requires months of tier-1 evidence and demonstrated probe quality via outcome tracking (not mutation scores). Training mode is the default for every new repo and after every revocation.

## 9. Provider policy risk register

As v3 (OpenAI endorsed; Anthropic internally tense — support says subscription pools currently cover Agent SDK/`claude -p`, legal directs third-party products to API keys, billing separation announced-then-paused; xAI/GLM verified at onboarding; funded API fallback as continuity prerequisite) with the corrected credential claim: **subscription auth is never extracted, proxied, or handled outside official vendor harnesses; API keys and test secrets, when used, are custodied in Camino's local OS-keychain-backed vault.** Personal use is the low-risk end; open-source release requires a compliance pass and ships with subscription handling unchanged (each user's official CLIs, their logins).

## 10. Market position

As v3 §10, scoped to the assessed set. Factory's mission economics adopted as planning reality.

## 11. Experiments

1. Dispatch spike (mechanics). 2. PRD-to-plan probe incl. cross-family challenge. 3. Thin pilot mission in training mode (failure catalog; completion-rate instrumentation). 4. Gate calibration replay (screen). 5. **Injection red-team before any unattended mission** — now explicitly calibrates the §5.3 threat-model tiers. 6. Validation-environment egress and scrubbing tests. 7. Quarantine tests: smuggling attempts (reachable-history, path-collision, gitattributes, submodule) against §5.1 as executable checks.

## 12. Round-3 correction map

| Round-3 blocker | Resolved in |
|---|---|
| Remote-CI credential re-entry | §5.5 (CI posture; Camino runner gates merges on worker refs) |
| Reachable-object quarantine smuggling | §5.1 (shallow fetch + squash-and-rebuild; invariant 8) |
| Validation-oracle corruption / transformed exfiltration | §5.3 (explicit T1/T2/T3 threat model; per-repo disposable tenants; residual risk stated) |
| Canon branch/fold state model | §3.1 (intent in repo; status derived per-context in control plane) |
| ExternalEdit intent reconciliation | §4.5 (proposed deltas confirmed by the user; recomputed states) |
| Operation-specific idempotency | §4.4 (contract table incl. workflow `camino_intent_id`) |
| API-key secret custody | §9, §5.2 (claim narrowed to subscription auth; vault custody stated) |

Deferrables 8–17: resolved in §4.2 (liveness via restored serialization + onboarding protection requirements), §5.1 (path canonicalization), §3.5 (classification double-locks), §8.3 (statistics language, distribution guards), §3.6 (mutation-testing role), §3.7 (knowledge lifecycle), §4.6 (state machine + leases), §6 (terminal semantics, penalty trigger), §7.1 (autonomy path + attention trigger), §7.2 (evidence packet).

## 13. PRD registry (explicitly deferred specification detail)

Exact revalidation retry bounds; the user-observable path-heuristic list; final attention-budget numbers; full mission/issue/attempt transition table; probe-authorship tooling details; evidence-packet schema; gap-register UI; GitHub App migration; multi-repo scheduling; per-provider quota-window models; xAI/GLM adapter specifics.
