# Camino — PRD Round-2 Review Dispositions

> 2026-07-16. Companion to [22-adversarial-review-prd-round2.md](22-adversarial-review-prd-round2.md). All 15 findings verified by cross-reading and accepted — every one is a drafting-quality defect in v1.2's text (round-1 residues my edits didn't fully propagate, plus Appendix A receiving its first review), none architectural. Resolutions in PRD v1.3.

| # | Finding (short) | Sev | Resolution in v1.3 |
|---|---|---|---|
| 1 | CAM-MERGE-02 still says "full probes" for mission→main; VAL-13 "supersedes" vs MERGE-05 "plus" contradiction | B | MERGE-02 delegates to the MERGE-05 mission gate; VAL-13 defines **progressive absorption** (mission checks mapped to requirement IDs *become* those probes); MERGE-05 gate = union of current mission suite + accumulated probes |
| 2 | CANON-10 P1 invents statuses outside the CANON-03 tuple and overclaims "demonstrated" | B | P1 semantics re-expressed in tuple terms: implementation `on-main`; evidence stays `unverified` per requirement (mission checks record as mission-scope evidence); P1 completion = mission gate passed, explicitly **not** per-requirement demonstration |
| 3 | Evidence identity incomplete: artifacts lack base_sha; exclusions untyped; waivers lack identity | B | Registry item 8: artifacts gain `base_sha`; `exclusions[{item, reason, sha, base_sha}]`; `waivers[{register_ref, reason, actor, sha, base_sha, class}]` |
| 4 | Appendix A lands missions without David's approval | B | New A.1 state `awaiting-merge-approval` with explicit approval event/guard (or tier-2 autonomy); rejection path back to executing |
| 5 | Appendix A has no direct-to-main path for eligible quick tasks | B | New **A.1b** eligible-quick-task table (no integration branch; direct merge-by-push to main after gate + approval) |
| 6 | Red mission checks / fast-suite failures deadlock (no repair-issue transitions) | B | A.1 row: mission gate red → repair issues created within mission scope (scope-exceeding repairs escalate); A.2 row: post-merge fast-suite failure → repair issue `ready` + merges blocked until green |
| 7 | Missing interrupt/resume pairs (manual pause, escalated exit, urgent-cancel requeue) | B | A.1 `paused-manual` rows; A.2 `escalated` exits (answered → ready, or cancelled); preemption-cancelled attempt → issue `ready` for re-dispatch after resync |
| 8 | Autonomy guard's `area` dimension undefined | B | Registry item 18 gains the **area taxonomy**: per-repo glob→area map in `.camino/config.yml` (shipped defaults: frontend, backend, api, data/migrations, auth, infra/ci, docs/tests); area-set derived deterministically from the final diff; joint guard matches exact (risk, area-set, template) |
| 9 | Observability lock still planner-only for non-heuristic cases | B | CAM-PLAN-06: the cross-family reviewer **adjudicates observability per criterion on every plan and quick task**; classifying any item not-observable requires reviewer concurrence, heuristic-flagged or not |
| 10 | A.2 conflates quota-blocked with model failure | D | Quota outcomes get their own row (issue waits for the window per CAM-ROUTE-06) and never count toward family-switch or escalation counters |
| 11 | Appendix lacks state-set definitions and artifact-ordering guards | D | Active/terminal sets defined; new **A.4 ordering** block: fold before candidate construction; evidence rollup + PR links before awaiting-merge-approval; packets immutable once verdicted; contract-edit replan re-checks dependency readiness |
| 12 | Seven acceptance clauses test less than their requirements | D | Strengthened: PLAN-01 (assumptions surfaced at approval), MERGE-01 (fixtures per gate), PLAN-11/12 (interfaces, sequential dispatch, reconciliation), VAL-13 (authorship separation, coverage review, fast subset), MERGE-13 (timing, marking, retention), EXEC-10 (snapshot binding), ROUTE-08 (per critical provider) |
| 13 | CORE-02 format promise contradicts its own list | D | Promise narrowed: v1 = `.md`/`.txt`; everything else rejected with reason; converters [F] |
| 14 | Chaos/calibration gates underpowered | D | STATE-06: kill points **on both sides of each external call** per class; Phase 2: ≥5 seeded defects spanning the four done-problem classes + one security class, zero approvals |
| 15 | Attack-suite omissions (symlink-target, trailing-dot) and a stale schema reference | D | Both cases added to Phase 0 item 3; CAM-VAL-08 now cites §5 registry item 8 |

Round-1 corrections per Sol: resolved — candidate-ref CI (with a web receipt on GitHub glob semantics), Grok consistency, mission PR lifecycle, dependency/readiness; partial — the six above, all closed in v1.3.

**Sol's verdict, verbatim:** *"safe to build from: no — blockers: P1 gate/status contradictions, incomplete evidence identity, Appendix approval/routing/repair/interrupt defects, undefined autonomy area, and the missing reviewer observability lock; deferrables: quota semantics, Appendix atomicity and artifact ordering, weak acceptance probes, format scope, chaos/calibration coverage, and attack-suite/reference omissions."*

**Stopping rule restated:** if round 3 returns new blockers, iteration pauses for human triage with David.
