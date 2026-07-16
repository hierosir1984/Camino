# Camino — Round-1 Review Dispositions (Claude's verification)

> 2026-07-15. Companion to [06-adversarial-review-round1.md](06-adversarial-review-round1.md) (Sol's raw output — read that first). Each finding was independently verified before acceptance: **CONFIRMED** = I reproduced the defect by re-reading the docs, re-deriving the math (all six statistical receipts re-derived and correct), or from established platform knowledge; **PLAUSIBLE** = post-January-2026 external receipt I could not independently reproduce, cited URL consistent with priors; **PARTIAL** = accepted with a stated disagreement. Nothing was dropped.

## Disposition table

| # | Finding (short) | Sol's verdict | My verification | Disposition |
|---|---|---|---|---|
| 1 | Living Canon means both desired state and current truth | FALSIFIED | CONFIRMED | Accept — split canon into intent layer + per-requirement build status; context packs carry status |
| 2 | Per-issue merges can land unwired frameworks on main | FALSIFIED | CONFIRMED | Accept — mission integration strategy required (integration branch recommended); revert path designed, not named |
| 3 | Branch-scoped GitHub tokens don't exist | FALSIFIED | CONFIRMED (platform knowledge) | Accept — control-plane-mediated git: workers commit locally, control plane pushes after policy checks (restores doc 00's original intent) |
| 4 | "Nothing creative has credentials" contradicts authenticated CLIs | FALSIFIED | CONFIRMED | Accept — restate invariant precisely: workers hold provider auth only; repo-write/merge stays control-plane; credential broker or mediated ops to be designed |
| 5 | Event log ≠ crash-safe GitHub side effects | FALSIFIED | CONFIRMED | Accept — idempotency keys + reconcile-against-GitHub-state on resume; GitHub is source of truth for GitHub facts |
| 6 | No secrets / test-environment model | FALSIFIED | CONFIRMED | Accept — PRD must include secrets vault, per-repo test-env config, validation-runner injection, workers get none |
| 7 | Walking skeleton is a platform mislabeled thin | OVERSTATED | CONFIRMED | Accept — cut v1: PAT before GitHub App, polling before webhooks, minimal GUI; drop "week one" language |
| 8 | One spike can't establish worker completion rates (0.9⁶=53%) | OVERSTATED | CONFIRMED (math re-derived) | Accept — spike de-risks mechanics only; rates need instrumented pilot missions |
| 9 | 20–30 PR calibration can't justify auto-merge (rule of three) | OVERSTATED | CONFIRMED (math re-derived) | Accept — calibration screens gross failure; autonomy earns on months of production decisions |
| 10 | Live issue editing vs frozen contracts | FALSIFIED | CONFIRMED | Accept — contract versioning + cancel/replan protocol + downstream invalidation |
| 11 | Per-cell learning router statistically impossible at solo volume | FALSIFIED | CONFIRMED (power math re-derived) | Accept with nuance — Stage 3 demoted to aspiration (viable only with opt-in multi-user telemetry or 10x volume); Stages 1–2 survive with coarse cells (model × role, pooled) |
| 12 | Cost-to-green censors abandoned issues | FALSIFIED | CONFIRMED | Accept — reward defined over all terminal states incl. abandonment penalty; "zero cost to record" softened |
| 13 | "Frontier effectively free" contradicts own policy evidence | OVERSTATED | CONFIRMED | Accept — quota has opportunity cost when missions queue; harmonize doc 03 with doc 05 |
| 14 | Canon/probe ceremony breaks attention budget | OVERSTATED | CONFIRMED (arithmetic plausible) | Accept — ceremony scales with mission class; batch reviews; measure attention incl. canon overhead |
| 15 | Probe flakiness becomes gap-register noise | FALSIFIED | CONFIRMED (math re-derived) | Accept — retries, quarantine, detector-health state, infra-vs-product failure separation, flake budget |
| 16 | Quick tasks have ceremony as written | FALSIFIED | CONFIRMED | Accept — no fold/probes for canon-neutral quick tasks; register updates batched |
| 17 | Deterministic wiring detection is a program-analysis project | FALSIFIED | PARTIAL | Accept the "cheap and sound" framing is wrong; keep detectors as *heuristics* emitting suspected-gaps with known false rates; probes remain gold standard |
| 18 | Canon coverage has no defined denominator | FALSIFIED | CONFIRMED | Accept — coverage over probeable requirements only; other canon classes verified differently or explicitly unmeasured |
| 19 | Brownfield induction can't infer authoritative intent day one | FALSIFIED | CONFIRMED | Accept — induction yields a *provisional* canon with confidence markers + triaged question queue; authority accretes over missions |
| 20 | Author separation can't catch shared bad premise | OVERSTATED | CONFIRMED | Accept — add PRD→canon requirement checklist confirmed by user at intake; retain PRD text as audit source |
| 21 | "Interrupted only by genuine escalations" false in v1 | FALSIFIED | CONFIRMED | Accept — state as roadmap, not v1 behavior |
| 22 | Waivers can relabel failure as completion | FALSIFIED | CONFIRMED | Accept — waived ≠ complete: missions end "complete-with-residue"; descoping is a canon edit requiring user approval |
| 23 | Serialization blocks urgent quick tasks | OVERSTATED | CONFIRMED | Accept — priority lane: pause at issue boundary, hotfix, rebase/re-validate mission work |
| 24 | Anthropic "bright line" conclusion too strong | OVERSTATED | CONFIRMED (reasoning) + PLAUSIBLE (receipts) | Accept — personal local use ≈ tolerated today; open-source distribution is the risky step; add pre-publication compliance review |
| 25 | "Agent SDK violates ToS" collapsed too crisply | FALSIFIED | PLAUSIBLE (current pages post-cutoff) | Accept — rewrite §5: sources internally tense, not a crisp prohibition; track both pages |
| 26 | Enforcement history not primary-source reproducible | UNTESTABLE | PLAUSIBLE | Accept — retain with "secondary-sourced, details contested" tag |
| 27 | API fallback ≠ "never an outage" | FALSIFIED | CONFIRMED | Accept — fallback requires pre-provisioned funded API accounts; make that an explicit prerequisite |
| 28 | Learning-router "unclaimed" flatly wrong (Not Diamond, OpenRouter Auto) | FALSIFIED | CONFIRMED (platform knowledge) | Accept — rewrite cell; differentiation narrows to delivery-outcome reward (repair loops, survival, human minutes) inside a pipeline |
| 29 | "Spec-first not spec-living" false (Spec Kit converge, Tessl, Kiro, DOORS) | OVERSTATED | PLAUSIBLE (post-cutoff receipts) | Accept — differentiation narrows to automated agent-maintained canon + behavioral gap probes as integration, not category |
| 30 | "No tooling exists" for context rot overstated | FALSIFIED | CONFIRMED (my own §1/§6 wording vs paper) | Accept — precise wording: "no purpose-built agent-config product"; DOCER-class tools exist |
| 31 | PRD-to-board intake not "unevidenced anywhere" (Rovo, Kiro) | FALSIFIED | CONFIRMED (Rovo pre-cutoff) | Accept — fix cell; the research's "within verified set" qualifier was dropped in my table |
| 32 | Vibe Kanban was YC-funded → "no funded incumbent" wrong | OVERSTATED | CONFIRMED (Bloop = YC S21) | Accept — correct claim: "not offered by current platform-billed incumbents; the funded player that did it exited" |
| 33 | Local-control-plane negative not established | UNTESTABLE | CONFIRMED as caveat | Accept — scope to "rare within assessed set" |
| 34 | GitHub verification not "unevidenced" (security/agentic review on agent output) | FALSIFIED | PLAUSIBLE (2026 changelogs) | Accept — fix cell: GitHub ships static/security/review-agent validation; not black-box behavioral |
| 35 | Factory launch chronology doesn't reproduce (page shows 2025) | FALSIFIED | PARTIAL | Note discrepancy honestly: page displays Feb 26 "2025" while containing 2026-era model references; deep-research flagged this as a probable Factory metadata error; treat the date as ambiguous, immaterial to design. Also accept: Missions gating may have loosened (Extra Usage requirement only) |
| 36 | "OpenAI declines to productize" inference-as-fact | OVERSTATED | CONFIRMED | Accept — soften to "has not productized; frames Symphony as reference" |
| 37 | Pain-cluster stats: SO n≈31–33k not 49k; METR 2026 update supersedes 19%; GitClear observational; SpecBench 30 tasks | OVERSTATED | PLAUSIBLE | Accept all — correct figures, add recency caveats; pain conclusion stands on corrected evidence |
| 38 | Factory convergence proves feasibility, not Camino's design | OVERSTATED | CONFIRMED | Accept reframe — and adopt Sol's recovered Factory data (185 runs, 778.5M tokens, 21 fix-features/40 features, 0/6 milestones passed first validation) as planning reality |

## Stated disagreements (none dropped, all recorded)

- **#17:** Sol is right that sound reachability analysis is a research project; I retain the detectors as explicitly *heuristic* suspected-gap emitters (TODO scans, coverage-on-new-code, unimported-file checks are genuinely cheap), which doc 04 should have said. The error was ranking them above model suspicion as "deterministic."
- **#11:** the per-cell bandit at solo volume is dead as designed — accepted — but the report and advisor stages never depended on statistical significance; they present descriptive evidence for human judgment. Demote Stage 3, keep 1–2 with coarse cells.
- **#35:** the receipt is genuinely ambiguous (a page displaying 2025 while referencing 2026 models); recorded as a discrepancy rather than accepting either year as established.

## Bottom line

Sol's verdict, verbatim: **"safe to build on: with corrections — split desired-state Canon from as-built truth; prevent partial mission merges or add atomic integration and rollback; replace branch-scoped worker credentials with control-plane-mediated Git and real isolation; specify idempotent GitHub reconciliation plus secrets/test environments; cut and revalidate v1 scope; measure worker, gate, and probe error rates before auto-merge; demote learned routing, Living Canon/gap register, and market novelty claims; and treat provider permission as use-context-specific, time-varying policy rather than an official-binary safe harbor."**

All eight corrections are accepted. Next step: fold them into revised docs 01–05 (revision pass), then **round 2** re-review of the corrected record before any PRD — per protocol, the design is not cleared until a falsification pass returns "safe to build on: yes" or all corrections resolve.
