# Camino — PRD Round-3 Dispositions and Process Halt

> 2026-07-16. Companion to [24-adversarial-review-prd-round3.md](24-adversarial-review-prd-round3.md). All 15 findings verified (CONFIRMED by cross-reading) and fixed in **PRD v1.4** — and, per the pre-committed stopping rule, **no further prose review round was launched**. The path to build is David's decision (§ Triage below).

## Fix map (all 15 accepted)

| # | Finding (short) | Fixed in v1.4 |
|---|---|---|
| 1 | A.1b/A.2 quick-task landing authority conflict | A.1b defines landing (David or tier-3 only); A.2's tier-1 row scoped to mission-branch targets, never main; quick-task→main validation scope defined (contract checks + repo fast suite) |
| 2 | A.1b not a closed state machine | A.1b inherits A.1's negative/interrupt rows; adds validation-red retries, merge rejection, rebuild rows, `re-routed` terminal state (quick task ends before the replacement mission activates — serialization preserved) |
| 3 | Approval not rebound after candidate rebuild | Approvals bind to (candidate SHA, packet hash); `merging → awaiting-merge-approval` on rebuild; red-after-rebuild → `executing` repair; A.4 item 4 |
| 4 | Completion/`on-main` declared before landing; cancelled-requirement hole | Completion and `on-main` declared only on confirmed push (`merging → complete`); cancelled-requirement rule: an accepted requirement stranded by a cancelled issue blocks completion until repaired or explicitly descoped |
| 5 | Scope-exceeding repair unreachable | Split into its own row: repair-exceeds-scope → `escalated` |
| 6 | Issue stranded in `claimed` on pre-start attempt death | New recovery row: `claimed` + attempt terminal-before-start → `ready`/`queued-quota` |
| 7 | Budget breach contradicted CAM-EXEC-03 | A.2: budget breach = kill-confirm → `escalated`, never automatic retry |
| 8 | No mission queue state | `queued` state added; serialization defined over execution-bearing states; FIFO activation; CAM-CORE-08's visible wait satisfied |
| 9 | `exclusions[]` missing evidence class | Schema completed |
| 10 | Expiry/archival ordering contradiction | Single archival step at terminal→`archived` (archive → ledger row → destroy); expiry row no longer claims archival |
| 11 | A.4 scope, attempt sets, pause-dispatch guard | A.4 item 2 scoped to A.1 only; attempt active set defined; dispatch guard requires mission `executing` |
| 12 | Accept clauses licensing less than requirements | PLAN-01 (active acknowledgment), MERGE-01 (positive fixture), PLAN-06 (per-criterion adjudication recorded; P1/P2-correct check wording), VAL-13 (coverage review + absorption fixture), EXEC-10 (full snapshot consistency) |
| 13 | CORE-02 format contradiction persisted | "Common doc formats" phrase deleted; v1 = .md/.txt, rest rejected |
| 14 | Phase 2 weakened ROUTE-08 | "for each critical subscription provider" |
| 15 | Stale version metadata | Header + status consolidated |

Sol also confirmed as faithful and resolved: the progressive absorption rule, the area taxonomy, and reviewer-locked observability (round-2 corrections 1, 8, 9 fully resolved).

**Sol's verdict, verbatim:** *"safe to build from: no — blockers: contradictory quick-task landing/authority and incomplete A.1b transitions, stale candidate approval, false completion/on-main semantics, unreachable scope-expansion repair, claimed-issue deadlock, budget-breach conflict, missing mission queue state, and incomplete evidence classification; deferrables: archival/order and state-membership cleanup, scheduler pause guard, underpowered Accept clauses, format wording, Phase-2 fallback count, and stale version metadata."*

## Why the process halted here (the honest trend)

Design rounds converged 7 → 6 → 0 blockers because fixes *removed* mechanisms. PRD rounds ran 10 → 9 → 9 because each round's fixes add prose surface — and round 3's blockers were all in the newest, most detailed layer (Appendix A and its interactions), none in requirements-versus-design fidelity. The defect class has shifted from "wrong" to "hand-authored state-machine prose is hard to keep exhaustively consistent" — which is precisely the defect class that a typed implementation with exhaustive transition tests eliminates by construction, and CAM-STATE-05 already requires the state machine to ship as code + doc together.

## Triage (David's decision)

- **Option A — build (recommended):** accept PRD v1.4 as build-ready. Appendix A is declared *authoritative until superseded by the Phase-1 typed state machine and its exhaustive transition-test suite*, which must pass a recorded consistency audit against Appendix A (differences resolved explicitly, either fixing code or amending the appendix). Adversarial energy moves where Camino's own philosophy says truth lives: the code, its tests, and the Phase-0 attack suites.
- **Option B — one focused verification pass first:** a bounded review of only the 15 fixes and Appendix A/A.1b (not a full round), for a clean "yes" on paper before build. Risk: the pattern of new-surface findings recurs; benefit: a fully clean prose record.
- **Option C — full round 4:** not recommended; diminishing returns are demonstrated.

**Decision (David, 2026-07-16): Option A — build now.** PRD v1.4 is build-ready; the Appendix-A supersession mechanism is in force.
