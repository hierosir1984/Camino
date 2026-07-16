# Camino — Adversarial Review of the PRD, Round 3 (raw, verbatim)

> Reviewer: Codex `gpt-5.6-sol`, xhigh, read-only sandbox + web search. Run 2026-07-16 against docs/PRD.md v1.3 (frozen: [../prd-history/PRD-v1.3.md](../prd-history/PRD-v1.3.md)). Verbatim and unedited. Verdict: **safe to build from: no** — 9 blockers, 6 deferrables. **The pre-committed stopping rule fired: no further auto-iteration; findings fixed in v1.4 and the process halted for David's triage** ([25-review-prd-round3-dispositions.md](25-review-prd-round3-dispositions.md)).

---

Round 3 falsifies v1.3: **9 blockers and 6 deferrables**. Under the stated stopping rule, this requires human triage before build.

## Findings

1. **A.1b and A.2 define incompatible quick-task landing protocols.**

   **Attack:** A.1b says “A.2 applies with target = main candidate; no integration branch,” while A.2 authorizes David **or tier-1 autonomy** to mark the issue `merged (into mission branch; fast subset runs)`. A.1b separately reserves direct-main automation for tier 3. [A.1b](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:280), [A.2](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:303), [CAM-AUTON-04](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:170).

   **Failure sequence:** tier 1 active, tier 3 locked → eligible quick task validates → A.2 either lets tier 1 merge toward main, violating the cleared tier containment, or targets a nonexistent mission branch. Ignoring A.2 violates A.1b’s normative delegation. CAM-MERGE-02 also defines validation only for issue→branch and mission→main, leaving quick-task→main ambiguous between the fast and full gates.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

2. **A.1b is not a closed state machine.**

   **Attack:** The standalone quick-task table omits plan rejection/edit, merge rejection, pause/resume, blocker/escalation recovery, retry exhaustion, and abandonment. Its reclassification destination—“re-routed: mission created per A.1, work carried over”—is not a state and does not terminate the original mission. [A.1b](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:273), [reroute row](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:284).

   **Failure sequence:** pause an eligible quick task, reject its merge, or exhaust rebuild retries: no listed transition exists, so the action is illegal. Variant: a sensitive-path trigger creates a second A.1 mission while leaving the original quick-task mission active, contradicting one-active-mission serialization.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

3. **Approval is not rebound after candidate reconstruction.**

   **Attack:** David’s approval moves the mission to `merging`; base movement then requires rebuilding and revalidating, and A.4 gives the new candidate new evidence items. No transition returns the mission to `awaiting-merge-approval`. [CAM-MERGE-02](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:105), [approval row](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:259), [A.4](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:331).

   **Failure sequence:** candidate C1/packet P1 green → David approves P1 → main moves → Camino constructs C2/packet P2 → C2 lands using C1’s approval. If C2 is red, the repair transition is available only from `executing`, so the mission instead deadlocks in `merging`.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

4. **CAM-CANON-10 still declares completion and `on-main` before landing is established.**

   **Attack:** CAM-CANON-10 equates completion with VAL-13 green + review + approval and says implementation-state “becomes `on-main`.” Appendix A places approval before the push; exhausted races instead transition from `merging` to `escalated`. [CAM-CANON-10](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:129), [landing rows](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:269).

   **Failure sequence:** gate green → review passes → David approves → rebuild limit is exhausted → Appendix says `escalated`, main unchanged; CANON-10 already says complete/`on-main`.

   **Variant:** `cancelled` counts as issue-terminal, and A.1 requires only “all issues terminal.” Cancel an issue implementing a non-observable accepted requirement without descoping it; remaining mission checks can pass, yet CANON-10 assigns `on-main` to implementation that does not exist. This contradicts the derived CAM-CANON-03 tuple.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

5. **Scope-exceeding gate repairs are unreachable.**

   **Attack:** The red-gate row is guarded by “repair within approved scope,” but its destination claims “scope-exceeding repair → `escalated`.” [A.1 red-gate row](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:258).

   **Failure sequence:** review discovers a repair requiring scope expansion → the guard is false → the row cannot execute → no separate scope-exceeding transition exists → the mandatory escalation is illegal.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

6. **An attempt can terminate while its issue remains permanently `claimed`.**

   **Attack:** Dispatch moves the issue to `claimed` and creates a `running` attempt. Before “worker starts,” that attempt may expire, be cancelled, exceed budget, or hit quota; A.2 has corresponding recovery rows only from `implementing`. [A.2 dispatch](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:292), [A.3 dispatch/expiry](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:317), [A.2 recovery rows](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:297).

   **Failure sequence:** dispatch → issue `claimed`/attempt `running` → worker never starts → heartbeat expires → attempt becomes `expired` → issue remains `claimed` with no live lease and no legal requeue.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

7. **Budget-breach behavior directly contradicts CAM-EXEC-03.**

   **Attack:** CAM-EXEC-03 requires a budget breach to “kill-and-escalate.” A.2 instead retries immediately and escalates only after four failures. [CAM-EXEC-03](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:74), [A.2](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:297).

   **Failure sequence:** first wall-clock breach occurs → requirement demands escalation → normative state machine demands `ready` and another attempt.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

8. **The mission state set cannot represent the required visible queue.**

   **Attack:** CAM-CORE-08 requires a second mission to wait visibly. Appendix A classifies `draft` as active and sends every newly created mission directly to `draft`; it defines no queued mission state. [CAM-CORE-08](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:51), [state sets](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:246), [creation row](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:252).

   **Failure sequence:** M1 is active → create M2 → M2 either becomes active `draft`, violating serialization, or waits outside the normative state machine and cannot expose its promised state.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

9. **The evidence schema still contradicts its universal class rule.**

   **Attack:** Registry item 8 says every packet item carries `class: advisory|gating`, but `exclusions[{item, reason, sha, base_sha}]` has no `class`. [Registry item 8](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:191).

   **Failure sequence:** a packet contains an exclusion → following the object schema omits its evidence class → following the universal rule requires a field the schema does not permit → implementations diverge, and the viewer cannot reliably distinguish advisory from gating exclusions.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

10. **A.3 and A.4 disagree about expiry archival order.**

   **Attack:** The expiry row says the workspace is already “archived, cleaned” when the attempt enters `expired`; a later terminal transition performs “archive + ledger row.” A.4 says archival completes before workspace destruction. [A.3](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:318), [A.4](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:332).

   **Receipt:** the implementation must invent whether archival happens before `expired`, during the terminal→`archived` transition, or twice.

   **Severity: DEFERRABLE. Verdict: FALSIFIED.**

11. **Appendix completeness remains under-specified.**

   **Attack and receipts:**

   - A.4 applies by heading to A.1b but unconditionally requires a fold on a mission branch; A.1b forbids both.
   - Attempt active states and `archived` membership remain undefined.
   - Pause/preemption moves an issue directly to `ready`, whose dispatch guard does not require the mission to have resumed; legal redispatch can occur while paused.

   [A.4](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:326), [state sets](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:246), [requeue/dispatch](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:292).

   **Severity: DEFERRABLE. Verdict: UNTESTABLE.**

12. **Several strengthened acceptance clauses still license non-conforming builds.**

   **Attack and receipts:**

   - CAM-PLAN-01 requires every invented assumption to become a question; Accept still permits a passive recorded assumption.
   - CAM-MERGE-01 has no eligible positive fixture, so routing every quick task through integration passes.
   - CAM-PLAN-06 does not test reviewer adjudication for every criterion and says a P1 fixture “receives a probe” despite formal probes being P2.
   - CAM-VAL-13 does not test coverage review or progressive absorption/union behavior.
   - CAM-EXEC-10 freezes the contract fixture but not the full canon/knowledge/summary context snapshot.

   [PLAN-01](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:57), [MERGE-01](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:104), [PLAN-06](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:62), [VAL-13](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:98), [EXEC-10](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:81).

   PLAN-11/12 and MERGE-13 are materially strengthened and testable.

   **Severity: DEFERRABLE. Verdict: OVERSTATED.**

13. **The CAM-CORE-02 correction is cosmetic and leaves the same format contradiction.**

   **Attack:** It still promises “common doc formats accepted,” then says v1 accepts only `.md` and `.txt` and rejects `.docx`. [CAM-CORE-02](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:45).

   **Receipt:** `.docx` remains simultaneously a commonly accepted document format and an explicitly rejected fixture.

   **Severity: DEFERRABLE. Verdict: FALSIFIED.**

14. **Phase 2 weakens CAM-ROUTE-08’s per-provider acceptance.**

   **Attack:** CAM-ROUTE-08 requires one API-key-auth issue for each critical subscription provider, while the Phase-2 text says the runbook is exercised “once.” [CAM-ROUTE-08](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:141), [Phase 2](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:220).

   **Receipt:** exercise Anthropic once, skip OpenAI, and the phase narrative passes while the requirement fails.

   **Severity: DEFERRABLE. Verdict: FALSIFIED.**

15. **The version-status repair is stale metadata.**

   **Attack:** The title says v1.3, but the status paragraph still says “draft v1.2.” [PRD header](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:1), [status](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:7).

   **Severity: DEFERRABLE. Verdict: FALSIFIED.**

The progressive absorption rule itself survives: VAL-13, MERGE-02, and MERGE-05 now use one consistent union and remain faithful to design §3.6. The area-set taxonomy is a faithful, conservative concretization of design §8.3. Reviewer-locked observability is also restored semantically. A.1b is not faithful to design §4.2 for the reasons above.

## Round-2 corrections status

1. **P1 probe/gate chain — RESOLVED:** the P2-probe dependency and `supersedes`/`plus` contradiction are closed; later chain failures are under corrections 2 and 4.
2. **CAM-CANON-10 statuses — PARTIALLY RESOLVED:** invented labels and per-requirement evidence overclaim are gone, but completion/`on-main` still precedes proven landing and mishandles cancelled requirements.
3. **Per-item evidence identity — PARTIALLY RESOLVED:** SHA/base identity is repaired, but exclusions still violate the universal evidence-class schema.
4. **Mission approval — PARTIALLY RESOLVED:** an explicit approval state exists, but rebuilt candidates can land under a superseded packet approval.
5. **Quick-task routing — PARTIALLY RESOLVED:** a direct-main table exists, but conflicts with A.2, the autonomy tiers, negative exits, and reclassification.
6. **Repair paths — PARTIALLY RESOLVED:** in-scope red gates and fast-suite failures create repairs; scope-exceeding and rebuilt-candidate failures still deadlock.
7. **Interrupt/resume pairs — PARTIALLY RESOLVED:** the named integration-route rows exist, but quick tasks and pre-start attempt termination remain uncovered.
8. **Area taxonomy — RESOLVED:** deterministic final-diff area-set and exact joint-combination matching are defined.
9. **Reviewer-locked observability — RESOLVED:** the reviewer adjudicates every criterion and must concur with every not-observable classification.

safe to build from: no — blockers: contradictory quick-task landing/authority and incomplete A.1b transitions, stale candidate approval, false completion/on-main semantics, unreachable scope-expansion repair, claimed-issue deadlock, budget-breach conflict, missing mission queue state, and incomplete evidence classification; deferrables: archival/order and state-membership cleanup, scheduler pause guard, underpowered Accept clauses, format wording, Phase-2 fallback count, and stale version metadata.

