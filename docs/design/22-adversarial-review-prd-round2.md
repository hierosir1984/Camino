# Camino — Adversarial Review of the PRD, Round 2 (raw, verbatim)

> Reviewer: Codex `gpt-5.6-sol`, xhigh, read-only sandbox + web search. Run 2026-07-16 against docs/PRD.md v1.2 (frozen: [../prd-history/PRD-v1.2.md](../prd-history/PRD-v1.2.md)). Verbatim and unedited. Dispositions: [23-review-prd-round2-dispositions.md](23-review-prd-round2-dispositions.md). Verdict: **safe to build from: no** — 9 blockers (6 round-1 residues + Appendix A defects), 6 deferrables; resolved in PRD v1.3.

---

No. v1.2 still contains 9 blocker-class findings; 6 of the 10 round‑1 blockers are only partially resolved.

## Findings

1. **The P1 merge chain still depends on P2 probes.**

   **Attack:** `CAM-MERGE-02 [P1]` still requires “full probes + review for mission→main,” while probe authoring remains `CAM-PLAN-08 [P2]`; `CAM-VAL-13` is explicitly only the P1 “probe stand-in” ([PRD:64](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:64), [PRD:98](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:98), [PRD:105](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:105)). From P2 onward, VAL-13 says probes “supersede” its suite, but `CAM-MERGE-05` requires that suite “plus” probes ([PRD:108](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:108)).

   **Receipt:** A P1 mission reaches its exact merge candidate. MERGE-02 demands full probes that P1 does not author. At P2, a build must either retire VAL-13 and violate MERGE-05 or retain it despite “supersedes.”

   **Severity: BLOCKER. Verdict: CONFIRMED — round‑1 failure survives.**

2. **P1 completion invents statuses and can declare unproven requirements demonstrated.**

   **Attack:** `CAM-CANON-10` says P1 statuses cap at “`built` + mission-checked” and that “the mission’s requirements [are] demonstrated” by VAL-13, review, and approval ([PRD:129](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:129)). Neither status exists in `CAM-CANON-03`’s normative tuple ([PRD:122](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:122)); VAL-13 covers only “key user-observable outcomes,” not every requirement.

   **Receipt:** Omit a non-key requirement from the mission suite; obtain green checks, review, and approval; CANON-10 permits completion and demands a status CANON-03 cannot represent. Design v5 instead caps v0 at implementation-state until requirement-mapped checks exist ([design v5:162](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:162)).

   **Severity: BLOCKER. Verdict: FALSIFIED.**

3. **Per-item evidence identity remains incomplete.**

   **Attack:** Registry item 8 claims “every item carries its own `(sha, base_sha)` identity,” but `artifacts[]` has no `base_sha`; `exclusions[]` is untyped; and `waivers[]` lacks SHA, base, and advisory/gating class ([PRD:191](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:191)). That contradicts design v5’s every-item rule ([design v5:156](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:156)).

   **Receipt:** After a candidate rebuild or base movement, an artifact, exclusion, or waiver can remain in the packet without identifying which candidate/base it applies to. The viewer still cannot prove every displayed licensing item describes the landing bits.

   **Severity: BLOCKER. Verdict: CONFIRMED — round‑1 failure survives.**

4. **Appendix A permits mission landing without the required merge approval.**

   **Attack:** `CAM-MERGE-05`, `CAM-CANON-10`, and `CAM-CORE-04` require David’s mission approval. A.1 instead allows `executing → merging` after “all issues terminal ∧ mission checks green ∧ review pass,” then `merging → complete` on push; no approval event or guard exists ([PRD:47](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:47), [PRD:257](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:257), [PRD:264](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:264)).

   **Receipt:** Checks and review pass; the state machine enters `merging`; the push completes the mission without David. Conversely, pressing the promised mission-approval action has no legal transition.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

5. **Appendix A re-breaks eligible quick-task routing.**

   **Attack:** `CAM-MERGE-01` permits an eligible quick task to PR directly to main ([PRD:104](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:104)). A.1 explicitly includes quick-task intake but invariably creates an integration branch and mission PR; A.2 invariably lands approved issues “into mission branch” ([PRD:252](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:252), [PRD:256](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:256), [PRD:281](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:281)).

   **Receipt:** A single-issue, neutral-agreed, low-risk quick task must either take the integration route that MERGE-01 says it bypasses or attempt an unlisted—and therefore illegal—transition.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

6. **Mandatory validation-failure repair paths deadlock.**

   **Attack:** A.1 handles only green mission checks and review pass. It has no handler for a red VAL-13 suite or a `CAM-VAL-06a` review failure. A.2 creates issues only at plan approval. Separately, `CAM-MERGE-04` requires a post-merge fast-suite failure to block the next merge and open a repair issue, but A.2 handles that failure only on a sibling already in `merge-pending` and merely requeues that sibling ([PRD:107](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:107), [PRD:257](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:257), [PRD:272](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:272), [PRD:282](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:282)).

   **Receipt:** All planned issues merge; the full mission check fails—or the just-merged issue’s fast suite fails. No legal transition creates the required repair work, so the mission stalls permanently.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

7. **Appendix interrupt/resume pairs are incomplete.**

   **Attack:** `CAM-CORE-04` promises pause/resume and answer-escalation actions, but A.1 has no manual pause/resume rows. A.2 can place an issue in `escalated` after four failures but supplies no exit. Urgent preemption cancels the attempt in A.3 while leaving its issue `implementing`, with no legal requeue transition ([PRD:47](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:47), [PRD:259](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:259), [PRD:277](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:277), [PRD:295](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:295)).

   **Receipt:** David pauses a mission: illegal transition. A fourth failure is answered: mission resumes but issue remains escalated. An urgent task cancels an attempt: the issue cannot reach the requeued state required to resume the mission.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

8. **The autonomy joint-distribution guard still has no `area` policy.**

   **Attack:** `CAM-AUTON-02` requires representation of each `risk × area × template` combination ([PRD:168](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:168)). Registry item 18 defines risk tiers, but no requirement defines area categories, assignment authority, persistence, or matching rules ([PRD:201](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:201)).

   **Receipt:** Identical work can be called `ui`, `frontend`, or `product`, changing whether the historical cell is represented and whether Tier 1 unlocks. Phase 3 cannot reproducibly exit.

   **Severity: BLOCKER. Verdict: UNTESTABLE.**

9. **Reviewer-locked observability was not restored.**

   **Attack:** `CAM-PLAN-06` makes an unflagged criterion observable when “the planner judges it observable”; reviewer concurrence is required only to suppress a heuristic hit ([PRD:62](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:62)). Design v5 requires surface heuristics plus the reviewer’s judgment ([design v5:56](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:56)).

   **Receipt:** An observable change lies outside the path list; the planner misses it; no heuristic fires; reviewer adjudication is not mandatory; PLAN-08 authors no probe. The paths-only omission variant survives with planner-only judgment added.

   **Severity: BLOCKER. Verdict: CONFIRMED — round‑1 failure survives.**

10. **Appendix conflates quota blocking with model failure.**

    **Attack:** A.2 groups `quota-blocked` with attempt failure and permits family switching after two and escalation after four ([PRD:277](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:277)). `CAM-EXEC-06` says quota blocking is never requirement failure, and `CAM-ROUTE-06` says exhausted work queues ([PRD:77](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:77), [PRD:139](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:139)).

    **Receipt:** Four rate-limit outcomes change families and escalate instead of waiting for quota.

    **Severity: DEFERRABLE. Verdict: FALSIFIED.**

11. **Appendix A remains non-atomic and omits load-bearing emission ordering.**

    **Attack:** `CAM-STATE-05` claims normative states, events, guards, and interrupts. Yet `replanning → ready` is collapsed into one cell; `active` and `terminal` sets are undefined; A.3 transitions to unnamed `(final)`; and no event/guard establishes that folds, evidence packets, mission rollup, and PR evidence links exist before approval and exact-SHA validation ([PRD:149](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:149), [PRD:283](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:283), [PRD:298](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:298)).

    **Receipt:** Implementers must invent state membership, event boundaries, and artifact ordering; a contract edit can also reach `ready` without a stated dependency-readiness recheck.

    **Severity: DEFERRABLE. Verdict: UNTESTABLE.**

12. **Several new acceptance clauses still license less than their requirements.**

    **Attack and receipt:**

    - `CAM-PLAN-01` requires every invented assumption to become a question, while Accept permits a merely recorded assumption.
    - `CAM-MERGE-01` tests only the sensitive-path gate, not single-issue or neutral-concurrence gates.
    - `CAM-PLAN-11/12` omit interface persistence, sequential scheduling, and reconciliation checks.
    - `CAM-VAL-13` omits authorship separation, key-outcome coverage, and the fast subset.
    - `CAM-MERGE-13` omits creation timing, merged marking, and retention.
    - `CAM-EXEC-10` omits context-snapshot binding.
    - `CAM-ROUTE-08` exercises one unspecified provider, not every critical provider.

    A build can pass these Accept clauses while violating the governing requirement.

    **Severity: DEFERRABLE. Verdict: OVERSTATED.**

13. **Mission intake still contradicts itself on accepted formats.**

    **Attack:** `CAM-CORE-02` promises “common doc formats accepted,” then defines only `.md` and `.txt` and permits all others to reject ([PRD:45](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:45)).

    **Receipt:** A `.docx` can simultaneously be a promised common format and a permitted rejection.

    **Severity: DEFERRABLE. Verdict: FALSIFIED.**

14. **The deterministic chaos and calibration gates remain underpowered.**

    **Attack:** `CAM-STATE-06` requires only one kill point somewhere between intent and confirmation per side-effect class ([PRD:150](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:150)). Phase 2 requires zero seeded-defect approvals but specifies neither seed count nor defect classes ([PRD:220](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:220)).

    **Receipt:** A kill before the external request can pass while never exercising the dangerous post-side-effect/pre-confirm ambiguity. One trivial seeded defect can satisfy the Phase-2 gate.

    **Severity: DEFERRABLE. Verdict: UNTESTABLE.**

15. **The claimed attack-suite/reference sweep is incomplete.**

    **Attack:** Phase 0’s quarantine suite still omits the required symlink-target case and the newly added trailing-dot alias case ([PRD:212](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:212)). `CAM-VAL-08` still cites nonexistent “schema §5.3 resolution below”; the schema is registry item 8 ([PRD:94](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:94)).

    **Receipt:** Both mechanisms can ship without their promised executable cases, and the evidence requirement still points implementers to the wrong location.

    **Severity: DEFERRABLE. Verdict: FALSIFIED.**

## Round-1 corrections status

1. **Phase-1 chain — PARTIALLY RESOLVED:** VAL-13/06a/CORE-09 were added, but MERGE-02 still demands P2 probes and CANON-10 contradicts the status model.
2. **Candidate-ref CI — RESOLVED:** `camino/**` covers candidate branches; GitHub evaluates branch globs against ref names and documents `**` matching nested branch names ([GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)).
3. **Per-item evidence identity — PARTIALLY RESOLVED:** commands/checks/reviews repaired; artifacts, exclusions, and waivers remain incomplete.
4. **Quick-task gates — PARTIALLY RESOLVED:** MERGE-01 is corrected, but Appendix A provides no direct-to-main path.
5. **Transition table — PARTIALLY RESOLVED:** the circular deferral is gone, but required approval, failure, interrupt, and recovery transitions are absent or contradictory.
6. **Grok consistency — RESOLVED:** non-goal, enabled-adapter spike, policy gate, and quota wording now align.
7. **Mission PR lifecycle — RESOLVED:** creation, checklist/evidence population, audit role, merged marking, and retention are required.
8. **Dependency/readiness — RESOLVED:** DAG, interfaces, readiness, sequential execution, and reconciliation meaning are now specified.
9. **Risk-tier policy — PARTIALLY RESOLVED:** risk is defined; the load-bearing `area` dimension is not.
10. **Reviewer-locked observability — PARTIALLY RESOLVED:** heuristic suppression is reviewer-locked, but non-heuristic observability remains planner-only.

safe to build from: no — blockers: P1 gate/status contradictions, incomplete evidence identity, Appendix approval/routing/repair/interrupt defects, undefined autonomy area, and the missing reviewer observability lock; deferrables: quota semantics, Appendix atomicity and artifact ordering, weak acceptance probes, format scope, chaos/calibration coverage, and attack-suite/reference omissions.

