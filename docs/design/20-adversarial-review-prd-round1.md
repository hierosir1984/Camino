# Camino — Adversarial Review of the PRD, Round 1 (raw, verbatim)

> Reviewer: Codex `gpt-5.6-sol`, xhigh, read-only sandbox + web search. Run 2026-07-16 against docs/PRD.md v1.1 (frozen copy: [../prd-history/PRD-v1.1.md](../prd-history/PRD-v1.1.md)). Verbatim and unedited. Verification: [21-review-prd-round1-dispositions.md](21-review-prd-round1-dispositions.md). Verdict: **safe to build from: no** — 10 blockers, 8 deferrables; resolved in PRD v1.2.

---

No. The PRD has 10 blockers and 8 deferrables.

## Findings

1. **Phase 1 cannot satisfy its own merge or completion gate.**  
   **Attack:** `CAM-MERGE-05 [P1]` requires “full probe suite green” and “cross-family mission review (risk-tiered),” and Phase 1 must deliver a real mission to main ([PRD:103](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:103), [PRD:208](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:208)). But probe authoring, semantic review, verification-method mapping, and requirements-based mission completion are respectively `[P2]` in `CAM-PLAN-08`, `CAM-VAL-06`, `CAM-VAL-12`, and `CAM-CANON-10` ([PRD:64](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:64), [PRD:89](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:89), [PRD:95](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:95), [PRD:123](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:123)). The skeleton’s gap-register table is also moved to P2, despite design v5 placing it in v0 ([PRD:52](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:52)).  
   **Receipt:** Design v5 requires plan-time probes for every user-observable change, full probes at mission merge, requirements capped at implementation-state before requirement-mapped checks exist, and a register table in the skeleton ([design v5:54](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:54), [design v5:61](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:61), [design v5:76](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:76), [design v5:162](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:162)). Phase 1 must either implement P2, accept an empty suite, or claim completion without the designed proof semantics.  
   **Severity: BLOCKER. Verdict: FALSIFIED.**

2. **Temporary candidate refs reopen the privileged-CI path.**  
   **Attack:** `CAM-MERGE-02` pushes worker-derived candidates to `camino/candidates/<uuid>`, while `CAM-SEC-03` restricts Actions only on `mission/*` and issue branches ([PRD:100](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:100), [PRD:151](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:151)).  
   **Receipt:** Design v5 treats GitHub Actions as untrusted on worker-derived refs and requires those refs to be disabled or restricted to no-secret/read-only workflows ([design v5:140](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:140)). A pre-existing `push` workflow can therefore run candidate code on an uncovered namespace before main, recreating the secret-bearing CI path the threat model was built to contain.  
   **Severity: BLOCKER. Verdict: FALSIFIED.**

3. **The evidence schema cannot identify which evidence licenses the merge.**  
   **Attack:** Registry item 8 gives only packet-level `candidate_sha`, `base_sha`, and `worker_head_sha`; commands, artifacts, and reviews have no per-item commit/base identity, checks have no base, and exclusions/waivers are absent ([PRD:185](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:185)).  
   **Receipt:** Design v5 requires “every packet item” to carry its own `(SHA, base)` identity, explicitly distinguishes advisory worker-head evidence from gating candidate evidence, and requires requirement maps, exclusions, and waivers ([design v5:154](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:154)). The promoted P1 evidence viewer can display a packet but cannot prove that its contents describe the bits being approved.  
   **Severity: BLOCKER. Verdict: FALSIFIED.**

4. **Quick tasks bypass the cleared direct-to-main eligibility gates.**  
   **Attack:** `CAM-MERGE-01` states unconditionally that “quick tasks PR directly to main” ([PRD:99](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:99)).  
   **Receipt:** Design v5 permits that route only when the quick task is “single-issue, neutral-agreed, non-sensitive” ([design v5:82](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:82)). `CAM-PLAN-06` governs fold suppression but never establishes all three as merge-route eligibility gates. A sensitive, canon-affecting, or multi-issue quick task can therefore take a path the design forbids.  
   **Severity: BLOCKER. Verdict: FALSIFIED.**

5. **The full transition-table registry item is circularly deferred again.**  
   **Attack:** Registry item 4 says “Transition table: per CAM-STATE-05”; `CAM-STATE-05` merely promises that the table will ship later “as code + doc together” ([PRD:181](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:181), [PRD:143](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:143)).  
   **Receipt:** Design v5 labels its state machine only a sketch and explicitly says the full mission/issue/attempt table is PRD work ([design v5:110](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:110), [design v5:199](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:199)). Legal transitions, guards, interrupt behavior, and terminal preconditions remain unspecified.  
   **Severity: BLOCKER. Verdict: FALSIFIED.**

6. **The Grok adapter requirements are mutually inconsistent.**  
   **Attack:** §2 calls “xAI/GLM adapters” a v1 non-goal; `CAM-EXEC-01` and registry item 14 put Grok Build in v1; acceptance requires all three adapters to pass while also permitting Grok to be disabled; Phase 0 sends work through “each adapter” but exits when “both harnesses” pass; the quota registry covers only Claude and Codex ([PRD:25](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:25), [PRD:70](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:70), [PRD:190](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:190), [PRD:191](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:191), [PRD:203](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:203)).  
   **Receipt:** These branches cannot govern one build. The vendor capability itself survives attack: xAI officially offers Grok Build to subscribers, documents headless `-p` operation, and expressly supports scripts, bots, ACP, and integration into other apps ([xAI announcement](https://x.ai/news/grok-build-cli), [official Grok Build documentation](https://docs.x.ai/build/overview)). Thus “currently unverified” is stale for technical/headless use, although contractual onboarding checks remain reasonable.  
   **Severity: BLOCKER. Verdict: FALSIFIED.**

7. **The mission PR review/audit surface is missing.**  
   **Attack:** `CAM-MERGE-01/02/05` define branches and push mechanics; `CAM-MERGE-07` handles only issue-PR closure. Nothing requires creating, retaining, or verifying the merged state of a mission→main PR ([PRD:99](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:99), [PRD:105](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:105)).  
   **Receipt:** Design v5 explicitly requires PRs to remain the review/audit surface, mission PRs to be marked merged when their heads land, and issue PRs to be closed by Camino ([design v5:76](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:76)). A PRD-compliant implementation could push main with no mission PR.  
   **Severity: BLOCKER. Verdict: FALSIFIED.**

8. **The executable plan has no dependency or readiness contract.**  
   **Attack:** `CAM-PLAN-01` specifies issues with acceptance criteria; `CAM-PLAN-05` nevertheless assumes “dependent issues” exist ([PRD:57](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:57), [PRD:61](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:61)). No requirement defines dependency representation, ready-work selection, concurrency constraints, downstream reconciliation, or contract fields beyond acceptance criteria.  
   **Receipt:** The founding brief requires slice boundaries, dependencies, concurrency safety, architectural interfaces, rollback, tests, observable flows, and evidence; its execution loop compiles a dependency graph, chooses a ready slice, and reconciles downstream work ([brief:119](/Users/davidtoniolo/Projects/Camino/docs/design/00-context-brief.md:119), [brief:231](/Users/davidtoniolo/Projects/Camino/docs/design/00-context-brief.md:231)). A 3–6 issue P1 mission cannot be scheduled from the governing requirements without re-deriving the product.  
   **Severity: BLOCKER. Verdict: FALSIFIED.**

9. **“Risk-tiered” gates have no implementable policy.**  
   **Attack:** `CAM-VAL-06` invokes “medium+ risk,” `CAM-MERGE-05` requires a “risk-tiered” mission review, and `CAM-AUTON-02` requires a `risk × area × template` joint-distribution guard ([PRD:89](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:89), [PRD:103](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:103), [PRD:162](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:162)).  
   **Receipt:** No requirement defines tier values, area categories, assignment authority, criteria, overrides, persistence, or reclassification. Neither the P1 review gate nor the P3 autonomy gate can be reproduced or tested.  
   **Severity: BLOCKER. Verdict: UNTESTABLE.**

10. **User-observable probe adjudication lost its reviewer lock.**  
    **Attack:** `CAM-PLAN-06` supplies deterministic classification triggers; `CAM-PLAN-08` assumes criteria have already been classified as user-observable; registry item 2 supplies only path heuristics ([PRD:62](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:62), [PRD:64](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:64), [PRD:179](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:179)).  
    **Receipt:** Design v5 requires deterministic heuristics **plus reviewer judgment**, independent of canon-affecting classification, and a probe for every observable change ([design v5:52](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:52)). A paths-only implementation can silently omit proof for observable behavior outside the initial list.  
    **Severity: BLOCKER. Verdict: FALSIFIED.**

11. **The worker-question/orchestrator channel is not bound to the cleared T2 controls.**  
    **Attack:** `CAM-EXEC-10/11` let an orchestrator answer from repo text, prior attempts, knowledge, canon, and the live ledger, but require neither source provenance nor binding to the attempt’s contract/context snapshot; `CAM-SEC-07` red-teams planners and workers, not the new orchestrator ([PRD:79](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:79), [PRD:155](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:155)). Its acceptance claim that every scope-weakening question “provably routes” is a universal semantic claim with no specified gate.  
    **Receipt:** Design v5’s T2 defense relies on provenance-tagged context and fixed contract versions ([design v5:132](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:132), [design v5:69](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:69)). No direct invariant-2 violation is confirmed—the orchestrator has no repository credential and cannot formally alter a contract—but the new ingress is outside the specified defense.  
    **Severity: DEFERRABLE. Verdict: OVERSTATED.**

12. **Temporal history claims unknowable external history.**  
    **Attack:** `CAM-CANON-11` promises canon/status “as it stood then” at any past date ([PRD:124](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:124)).  
    **Receipt:** Invariant 3 makes external systems authoritative for external facts, while snapshot polling expressly cannot observe A→B→A changes between polls ([design v5:19](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:19), [design v5:104](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:104)). Replay can reconstruct Camino’s recorded projection, not objective repository state at an arbitrary time.  
    **Severity: DEFERRABLE. Verdict: OVERSTATED.**

13. **The `[F]` API adapter is load-bearing in a P1 continuity claim.**  
    **Attack:** `CAM-EXEC-01` makes API-key adapter implementation future, while `CAM-ROUTE-08 [P1]` requires funded API fallback “for continuity,” and §9 cites that fallback as current provider-policy mitigation ([PRD:70](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:70), [PRD:135](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:135), [PRD:225](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:225)).  
    **Receipt:** Funding an account cannot provide automated Camino continuity without a defined implemented path. If fallback is manual or exercised through the same official CLI adapters, the PRD does not say so.  
    **Severity: DEFERRABLE. Verdict: OVERSTATED.**

14. **Several explicit v5 mechanisms are incompletely carried.**  
    **Attack and receipts:**

    - `CAM-EXEC-04` omits reserved-name alias rejection and the worker-attribution trailer required by v5 §5.1 ([PRD:73](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:73), [design v5:119](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:119)).
    - `CAM-CANON-09` omits knowledge-entry scope, expiry, and contradiction→curation behavior ([PRD:122](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:122), [design v5:65](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:65)).
    - No requirement covers plan-time declaration of validation resources ([design v5:134](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:134)).
    - `CAM-STATE-04` has per-environment fencing but does not require the single fenced validation-environment owner mandated by v5 ([PRD:142](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:142), [design v5:112](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:112)).
    - `CAM-CANON-03` omits the exact canon enums, `resolved-accepted`, branch verification non-inheritance, and reverse-transition rules ([PRD:116](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:116), [design v5:28](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:28)).

    These are bounded additions, but an implementation following only the PRD may omit them.  
    **Severity: DEFERRABLE. Verdict: FALSIFIED.**

15. **Acceptance clauses frequently test something smaller than the requirement.**  
    **Attack:** Examples include:

    - `CAM-CORE-01`: tests token rejection and remote access, not 0600 permissions or CSRF.
    - `CAM-CORE-02`: “common doc formats” is undefined; acceptance tests only Markdown rendering.
    - `CAM-CORE-04`: tests event logging, not whether actions have their required effects.
    - `CAM-CORE-07`: does not test artifact previews.
    - `CAM-PLAN-01`: one ambiguous fixture cannot verify “every assumption.”
    - `CAM-PLAN-05`: tests only immutable versioning, not compatibility handling, cancellation, revalidation, or dependent impact.
    - `CAM-EXEC-10`: tests only canon retrieval, not read-only authorization, prior summaries, knowledge, or orchestrator behavior.

    Receipts: [PRD:44–61](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:44), [PRD:79](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:79).  
    **Severity: DEFERRABLE. Verdict: OVERSTATED.**

16. **Critical safety requirements have no defined acceptance path.**  
    **Attack:** Only 23 of 101 `CAM-*` requirements have an `Accept:` clause. Missing proof is material for validation egress/scrubbing, validation-config review, mission gates, ExternalEdit reconciliation, idempotency, CI posture, tier unlock, and revocation.  
    **Receipt:** Design v5 explicitly includes validation-environment egress and scrubbing experiments, but Phase 0 omits them ([design v5:182](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:182), [PRD:202](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:202)).  
    **Severity: DEFERRABLE. Verdict: UNTESTABLE.**

17. **The chaos test and phase exits cannot establish their claims.**  
    **Attack:** `CAM-STATE-06` claims kill-9 recovery “at any point” but accepts random kills that “never” duplicate or lose state; finite random sampling cannot prove all idempotency windows ([PRD:144](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:144)). Phase exits additionally rely on “question quality rated,” “no gross failure mode,” and “injection findings hardened” without rubrics or thresholds ([PRD:204](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:204), [PRD:212](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:212), [PRD:215](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:215)).  
    **Receipt:** Since v1 completion is defined solely by Phase 3 exit, these qualitative labels permit arbitrary gate decisions ([PRD:217](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:217)).  
    **Severity: DEFERRABLE. Verdict: UNTESTABLE.**

18. **Several references and test-suite definitions are broken or incomplete.**  
    **Attack:** `CAM-EXEC-04/09` cite nonexistent PRD §7.3; `CAM-EXEC-05` and `CAM-SEC-08` cite nonexistent §5.7; `CAM-EXEC-06` cites nonexistent §5.6 ([PRD:73](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:73), [PRD:74](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:74), [PRD:75](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:75), [PRD:78](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:78), [PRD:156](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:156)). Phase 0’s quarantine suite omits explicit symlink-target, reserved-name, CI-definition, scope, worker-merge, and candidate-ref workflow cases ([PRD:205](/Users/davidtoniolo/Projects/Camino/docs/PRD.md:205)).  
    **Severity: DEFERRABLE. Verdict: UNTESTABLE.**

## Design-v5 coverage check

Load-bearing mechanisms with no adequate covering requirement:

- Full mission/issue/attempt transition and guard table.
- Dependency graph, ready-work selection, and downstream reconciliation.
- Stable risk/area taxonomy and classification policy.
- Mission→main PR creation and audit lifecycle.
- Quick-task direct-to-main eligibility enforcement.
- Reviewer adjudication of user observability.
- Candidate-ref CI restrictions.
- Plan-time validation-resource declaration.
- Per-item evidence identity, advisory/gating classification, exclusions, and waivers.
- Knowledge scope, expiry, and contradiction curation.
- Reserved-name alias rejection and rebuilt-commit attribution trailer.
- Explicit single fenced validation-environment owner.
- Orchestrator provenance/snapshot binding and red-team coverage.

Mechanisms covered only in the wrong phase: probe authoring, semantic review, verification methods, honest mission completion, and the skeleton gap-register table.

## Founding-brief drift

The substantive silent loss is dependency-aware planning/readiness and downstream reconciliation. Deployment/post-deployment validation, multi-repo execution, learned routing, and API/self-hosted expansion are explicitly deferred; those are not findings. The evidence-viewer promotion and adversarial-review framing are faithful. File attachment is compatible but underspecified. The temporal view and orchestrator do not inherently violate invariant 2 when read narrowly, subject to findings 11–12.

safe to build from: no — blockers: repair the P1 probe/review/completion phase chain; secure candidate refs; restore per-item evidence identity; enforce quick-task gates; specify the full transition table; reconcile Grok scope, spike, policy, and quota requirements; require the mission PR audit lifecycle; define dependency/readiness and risk policies; and restore reviewer-based observability classification; deferrables: bind and red-team the orchestrator channel, narrow temporal history to recorded state, make API fallback honest, restore omitted v5 details, complete acceptance criteria and experiments, replace random/qualitative phase gates with executable thresholds, and repair references and attack suites.

