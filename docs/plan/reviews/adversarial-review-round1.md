Independent inventory result:

```text
PRD P1 declarations: 78
Matrix IDs:           78
Missing from matrix:  <none>
Extra in matrix:      <none>
```

The matrix is complete by ID, but not by semantics. `PLAN` below means the supplied draft’s absolute path.

1. **CAM-SEC-04 is largely absent from WP-115.**

   Claim attacked: PLAN lines 318/354, `CAM-SEC-04 | 115`.

   Receipt:

   ```text
   $ nl -ba docs/PRD.md | sed -n '160p'
   CAM-SEC-04 ... storage for test-scoped credentials and ... API keys;
   injection into validation runner only; per-repo tenant isolation;
   scheduled rotation, per-mission rotation for sensitive tenants.

   $ nl -ba "$PLAN" | sed -n '229,234p'
   230 ... OS-keychain vault injecting test-scoped secrets into the runner only
   233 Worker env dumps contain no vault material; secrets reach only the runner
   ```

   WP-115 omits API-key custody, per-repo tenant isolation, scheduled rotation, and sensitive-tenant per-mission rotation.

   **Verdict: FALSIFIED**

2. **Training mode is asserted in the GUI WP, but issue and quick-task merges lack an accepted backend approval guard.**

   Claim attacked: PLAN line 359 maps CAM-AUTON-01 only to WP-122.

   Receipt:

   ```text
   $ nl -ba docs/PRD.md | sed -n '169p;281p;291p;317p'
   169 ... all merges human-approved.
   281 Quick-task landing authority: David or tier-3 autonomy only
   291 awaiting-merge-approval ... David approves ...
   317 issue merge ... approval (David in training mode ...)

   $ nl -ba "$PLAN" | sed -n '257,290p'
   260 WP-119 tests SHA identity/races, not approval authorization
   268 Eligible quick task merely "provably lands via the direct A.1b path"
   269 Issue merge only tests the post-merge fast suite
   270 Only mission→main explicitly requires David's approval event
   290 WP-122: Training mode default ... no auto-merge path exists
   ```

   WP-119, WP-120, and their quick-task/issue fixtures can pass without proving that an absent human approval event blocks the push. Worse, WP-122 is scheduled before the merge engine, so “no auto-merge path exists” can pass before that path is implemented.

   **Verdict: FALSIFIED**

3. **CAM-VAL-13’s acceptance text is dropped and mapped to a WP that cannot prove it.**

   Claim attacked: PLAN line 66 says PRD acceptance text is verbatim; line 358 maps CAM-VAL-13 only to WP-117.

   Receipt:

   ```text
   $ nl -ba docs/PRD.md | sed -n '100p'
   Accept: Phase 1's mission merges with this suite green at the exact
   candidate SHA; ... an absorption fixture ... shows the gate computing
   the union without duplication.

   $ nl -ba "$PLAN" | sed -n '244,247p'
   247 Suite authorship ... fast subset ... coverage reviewed ...
       worker diff touching the suite is rejected
       — CAM-VAL-13 (P1 rows; the P2 absorption fixture is out of scope).
   ```

   Even leaving the explicitly P2 absorption fixture deferred, WP-117 cannot demonstrate that Phase 1’s real mission merged with the suite green at the exact candidate. That proof belongs in WP-120/WP-125, but the matrix does not map them.

   **Verdict: FALSIFIED**

4. **WP-107 weakens CAM-PLAN-06’s acceptance and omits normative classification behavior.**

   Claim attacked: PLAN line 337, `CAM-PLAN-06 | 107`.

   Receipt:

   ```text
   $ nl -ba docs/PRD.md | sed -n '64p'
   classification ... provisional until the diff exists, and re-classified
   by deterministic triggers ... Fold suppression on quick tasks requires
   reviewer concurrence.
   Accept: ... receives ... a mission-gate check in P1 per CAM-VAL-13;
   a probe from P2.

   $ nl -ba "$PLAN" | sed -n '172,176p'
   173 classification with deterministic triggers ...
   176 ... gets its gating check ...
   ```

   “Gets its gating check” permits the wrong check type. The WP also drops provisional-until-diff classification, explicit final-diff reclassification, and reviewer concurrence for quick-task fold suppression.

   **Verdict: FALSIFIED**

5. **CAM-EXEC-01 requires an API-key adapter interface; neither mapped WP defines it.**

   Claim attacked: PLAN line 342, `CAM-EXEC-01 | 001, 110`.

   Receipt:

   ```text
   $ nl -ba docs/PRD.md | sed -n '74p'
   ... an API-key adapter interface is defined (implementation [F]).

   $ rg -n "API-key adapter interface" "$PLAN"
   <no output>
   ```

   WP-001 defines only `spawn / stream / cancel / cleanup / quota-classify`; WP-110 provides an API-key fallback runbook. A runbook is not the required interface definition.

   **Verdict: FALSIFIED**

6. **CAM-CORE-08’s P1 urgent lane has no implementing scope.**

   Claim attacked: PLAN line 329, `CAM-CORE-08 | 103`.

   Receipt:

   ```text
   $ nl -ba docs/PRD.md | sed -n '53p'
   Missions serialize per repo: one active mission, plus the urgent lane.

   $ nl -ba "$PLAN" | sed -n '140,145p'
   141 ... per-repo serialization with the queued state
   145 ... execution-bearing states hold at most one mission per repo
   ```

   WP-103 implements ordinary serialization only. CAM-PLAN-10 may defer the richer urgent-preemption workflow to P2, but that does not erase the urgent-lane clause from CAM-CORE-08’s P1 scope.

   **Verdict: FALSIFIED**

7. **CAM-STATE-06 recovery proof omits lease inspection and environment reset.**

   Claim attacked: PLAN line 351, `CAM-STATE-06 | 104, 125`.

   Receipt:

   ```text
   $ nl -ba docs/PRD.md | sed -n '152p'
   daemon resumes cleanly from kill -9: unconfirmed intents reconcile,
   leases inspect, environments reset-before-use.

   $ nl -ba "$PLAN" | sed -n '147,152p;307,311p'
   WP-104 ... reconciliation ... kill-point harness
   WP-125 ... side-effect classes ...
   ```

   The kill-point suite covers duplicate effects and lost state, but neither WP requires assertions that recovery inspects leases and resets validation environments before reuse.

   **Verdict: OVERSTATED**

8. **WP-125’s claimed “verbatim intent” omits Phase-1 exit clauses.**

   Claim attacked: PLAN lines 307–310.

   Receipt:

   ```text
   $ nl -ba docs/PRD.md | sed -n '218,219p'
   One repo, PAT, polling, training mode.
   ... David approving against rendered evidence packets in the viewer ...

   $ nl -ba "$PLAN" | sed -n '307,313p'
   309 Accept (PRD §7 Phase 1, verbatim intent):
   310 Plan approved ... merged ... fold rendered; gap register populated.
   ```

   WP-125’s acceptance omits one-repo/PAT/polling/training-mode proof and omits David approving in the evidence viewer. Its scope mentions rendered packets but still not the viewer.

   **Verdict: FALSIFIED**

9. **Several concrete registry resolutions have no faithful acceptance home.**

   Receipt:

   ```text
   $ nl -ba docs/PRD.md | sed -n '187,203p'
   187 exact observability globs + .camino/config.yml
   190 generations monotonic per environment in SQLite
   196 fetch ≤5,000 objects / 500 MB; workspace ≤2 GB;
       archive ... 90 days or last 10 ... whichever more
   198 Claude 5-hour/weekly, Codex, and Grok windows ...
   203 area-set derived deterministically from final diff paths;
       shipped glob→area defaults

   $ rg -n '5,000|2 GB|whichever more|monotonic|5-hour|config.yml|final diff' "$PLAN"
   <no relevant matches>
   ```

   Specific defects:

   - WP-112 says only “object/size budgets,” with no 5,000-object/500 MB limits.
   - WP-111 omits the 2 GB workspace cap and weakens “whichever more” to `90 days / last 10`.
   - WP-114 omits SQLite-persisted monotonic lease generations and janitor fencing.
   - WP-114/WP-124 omit the provider-specific quota-window models.
   - WP-107 merely persists an area-set; it does not derive it from final diff paths or ship the required configurable maps/defaults.

   **Verdict: FALSIFIED**

10. **WP-000 does not establish its claimed validatable-repo profile.**

   Claim attacked: PLAN lines 78–84.

   Receipt:

   ```text
   $ nl -ba docs/BUILD.md | sed -n '14,16p'
   validatable-repo profile ... devcontainer, one-command test, seeded fixtures

   $ nl -ba docs/PRD.md | sed -n '207p'
   ... conforms ... from day one (devcontainer, one-command test, seeded fixtures)

   $ nl -ba "$PLAN" | sed -n '78,84p'
   81 npm install && npm test green
   82 Devcontainer boots
   83 release checklist committed
   84 issue template renders
   ```

   No seeded fixture is required to exist or run. Naming `fixtures/` in the layout does not deliver one; Git does not preserve empty directories, and the actual fixtures arrive in later WPs.

   **Verdict: FALSIFIED**

11. **The plan moves “before Phase 0” prerequisites into Phase 0 or its exit.**

   Receipt:

   ```text
   $ nl -ba docs/BUILD.md | sed -n '19,25p'
   Prerequisites (before Phase 0)
   Node 22, Docker Desktop, Playwright ...
   three CLIs authenticated ...
   funded API fallback accounts ...
   xAI ... confirmation recorded ...

   $ nl -ba "$PLAN" | sed -n '86,92p;119p;376,380p'
   87 WP-001 records xAI confirmation ...
   119 Phase 0 exit: ... prerequisites checked off
   380 Start WP-000 ...
   ```

   The plan permits starting Phase 0 before its stated prerequisites and permits failed xAI confirmation to become a disabled-adapter result instead of satisfying the prerequisite.

   **Verdict: FALSIFIED**

12. **Phase 0 is scheduled out of the required order.**

   Receipt:

   ```text
   $ nl -ba docs/BUILD.md | sed -n '27,33p'
   Phase 0 — Spikes (PRD §7, in order)
   1. Dispatch
   2. PRD-to-plan
   3. Quarantine
   4. Injection
   5. Egress/scrubbing

   $ nl -ba "$PLAN" | sed -n '74,76p'
   WP-003/005 ... can run in parallel [with] WP-001/002
   ```

   This directly contradicts BUILD.md’s “in order” instruction.

   **Verdict: FALSIFIED**

13. **PRD change control is narrowed to discovered conflicts and loses architectural falsification.**

   Receipt:

   ```text
   $ nl -ba docs/PRD.md | sed -n '7p'
   material changes require David's approval and, when architectural,
   a falsification pass

   $ nl -ba "$PLAN" | sed -n '69p'
   Any WP that discovers a PRD conflict opens a prd-change issue
   for David's decision
   ```

   A material non-conflict change is uncovered, and no mechanism requires the architectural falsification pass.

   **Verdict: FALSIFIED**

14. **“PRD §6 defaults, made concrete” omits the security-relevant Git posture.**

   Receipt:

   ```text
   $ rg -n -F -e 'system git' -e 'hooks disabled' -e 'pristine clone' \
       "$PLAN" docs/PRD.md

   docs/PRD.md:207 ... system git in pristine clones
       (hooks disabled by config)
   PLAN:258 ... pristine clone
   ```

   The plan never specifies system Git or hooks-disabled configuration and records no substitution.

   **Verdict: FALSIFIED**

15. **The scaffold’s `core` boundary contradicts WP-101.**

   Claim attacked: PLAN line 11 says WPs map cleanly to package boundaries.

   Receipt:

   ```text
   $ nl -ba "$PLAN" | sed -n '23,29p;129,132p'
   25 core/ # pure domain logic, no I/O: ... event-log
   26         append/replay
   130 packages/core: append-only SQLite event log
   ```

   SQLite append/replay is I/O. `core` cannot simultaneously be pure/no-I/O and own the SQLite event store.

   **Verdict: FALSIFIED**

16. **The wave schedule contradicts its own declared dependencies and omits concrete producer/consumer dependencies.**

   Receipt:

   ```text
   $ nl -ba "$PLAN" | sed -n '366,374p'
   Wave 2 (parallel): WP-105, WP-106 ...
   Wave 4: ... WP-115, WP-116, WP-117, ... WP-123 ...
   Wave 5: WP-119, WP-120 ...
   Dependencies: 106→.../105; 117→.../115; 120→.../119
   ```

   Declared prerequisites are placed in the same apparently parallel wave as their consumers. Further undeclared dependencies include:

   - WP-113 consumes the frozen issue contract but lacks a dependency on WP-106.
   - WP-117 records verdicts in packets but lacks a dependency on WP-116.
   - WP-123 renders packets but lacks a dependency on WP-116.
   - WP-114 consumes provider quota models and ledger refinement before WP-124 owns them.

   These can block agents or lead to duplicate incompatible schemas.

   **Verdict: FALSIFIED**

17. **CAM-SEC-09 coverage checks file existence, not required checklist content.**

   Receipt:

   ```text
   $ nl -ba docs/PRD.md | sed -n '165p'
   checklist ... license (permissive), no secrets in repo,
   compliance pass on provider policies,
   threat-model re-pricing for distribution

   $ nl -ba "$PLAN" | sed -n '83p;314p'
   release-checklist.md committed
   Release checklist re-checked
   ```

   An empty or incomplete checklist satisfies both stated criteria.

   **Verdict: OVERSTATED**

18. **“Cross-family” is operationally reduced to “non-Claude.”**

   Receipt:

   ```text
   $ nl -ba "$PLAN" | sed -n '3p;66,67p'
   3  an agent implements it ...
   67 cross-family review (non-Claude model) ...
   ```

   If the implementer is Codex or Grok, a non-Claude reviewer can still be the same provider family. The process never requires `reviewer.family != implementer.family`.

   **Verdict: UNTESTABLE**

19. **WP-124 is not a clean single-agent/package-aligned work package.**

   Claim attacked: PLAN line 11 says package boundaries let WPs map cleanly.

   Receipt:

   ```text
   $ nl -ba "$PLAN" | sed -n '296,303p'
   WP-124: capability registry, editable policy table, outcome ledger,
   mission economics, attention budget, explicit GUI choice dialog
   ```

   This combines persistence/schema work, routing policy, instrumentation, scheduler inputs, and GUI interaction across `shared`, `core`/storage, `daemon`, and `gui`. It is a clear multi-subsystem branch rather than a reviewable package-aligned slice.

   **Verdict: OVERSTATED**

safe to build on: no — first expand WPs 103/104/107/110/111/112/114/115/117/119/120/122/125 to cover the missing P1 and registry clauses, make WP-000 genuinely validatable from day one, restore prerequisite/order/change-control gates, resolve the `core` I/O boundary and Git defaults, serialize and complete the dependency graph, require provider-relative reviews, and split WP-124.
