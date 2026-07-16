# Camino — Adversarial Review, Round 1 (raw, verbatim)

> Reviewer: Codex `gpt-5.6-sol`, reasoning effort xhigh, read-only sandbox with web search. Run 2026-07-15 against docs 00–05. This file is the reviewer's output verbatim and unedited — the independent record. Claude's verification and dispositions are in [07-review-round1-dispositions.md](07-review-round1-dispositions.md).

---

I read all six documents and rechecked the requested primary sources. The record is not PRD-ready as written.

1. **The Living Canon has two mutually exclusive meanings.**

   - Claim attacked: [doc 03 §4.1](/Users/davidtoniolo/Projects/Camino/docs/design/03-router-and-living-spec.md:66): “The repo carries the current state” and “The repo holds current truth.” [Doc 04 §2.5](/Users/davidtoniolo/Projects/Camino/docs/design/04-gap-reconciliation-and-done-problem.md:64): “The Living Canon is desired state,” and accepting a PRD changes it before implementation.
   - Receipt: `nl -ba ...03... | sed -n '64,72p'; nl -ba ...04... | sed -n '62,69p'` reproduces both definitions.
   - Falsifying sequence: accept a PRD → Canon says feature X should exist → implementation fails → gap is waived → later agents receive Canon excerpts describing nonexistent behavior as “current truth.” During a mission it is ahead of code; if folding waits for completion, it is behind merged code.
   - **Verdict: FALSIFIED.**

2. **Per-issue merging can land the exact disconnected framework Camino promises to prevent.**

   - Claim attacked: [doc 01 Decision 3](/Users/davidtoniolo/Projects/Camino/docs/design/01-intent-analysis-and-design-decisions.md:88): “one slice = one contract = one PR”; [doc 02 §6](/Users/davidtoniolo/Projects/Camino/docs/design/02-revised-product-definition.md:76): every issue produces a PR and the user merges each one; [doc 04 §2.4](/Users/davidtoniolo/Projects/Camino/docs/design/04-gap-reconciliation-and-done-problem.md:60): merging all issues while the assembled feature is unwired is the failure mode.
   - Receipt: `rg -n -i 'integration branch|atomic mission' docs/design` found only doc 00’s unresolved question about whether a mission needs an integration branch.
   - Falsifying sequence: backend PR merges, UI PR merges, wiring PR fails permanently. Main now contains the “beautiful parts, missing wires” state. Mission-level validation detects it only after the incomplete components have landed. Rollback is named as a need in doc 01, not designed in docs 02–05.
   - **Verdict: FALSIFIED.**

3. **The promised branch-scoped worker credential does not exist in GitHub App permissions.**

   - Claim attacked: [doc 01 Decision 6](/Users/davidtoniolo/Projects/Camino/docs/design/01-intent-analysis-and-design-decisions.md:100) and [doc 02 §4](/Users/davidtoniolo/Projects/Camino/docs/design/02-revised-product-definition.md:54): workers receive “branch-scoped tokens” that can push only their own branch.
   - Receipt: GitHub documents installation tokens as scoped by repositories and permission categories such as repository `Contents`; it documents no branch scope. Tokens can be restricted to particular repositories and expire after one hour. [GitHub App token documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app), [permissions documentation](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).
   - A write-capable installation token can write repository contents subject to branch protection; it is not intrinsically “this branch only.”
   - **Verdict: FALSIFIED.**

4. **“Nothing creative has credentials” contradicts the execution mechanism.**

   - Claim attacked: [doc 01 Decision 6](/Users/davidtoniolo/Projects/Camino/docs/design/01-intent-analysis-and-design-decisions.md:101): “nothing with credentials is creative, nothing creative has credentials.” The next sentence gives creative workers Git push capability; [doc 02 §6](/Users/davidtoniolo/Projects/Camino/docs/design/02-revised-product-definition.md:77) runs authenticated Claude/Codex CLIs inside a “worktree/container.”
   - Receipt: a worktree is only another checkout under the same host user. A container still needs provider authentication mounted or proxied into it. Anthropic now recommends `--bare` for scripted `claude -p`, but states that bare mode skips OAuth/keychain reads and requires API-key authentication. Non-bare mode loads user hooks, plugins, MCP servers, memory, and home configuration. [Anthropic headless documentation](https://code.claude.com/docs/en/headless).
   - Camino cannot simultaneously guarantee consumer-subscription OAuth, deterministic clean execution, no credential-bearing capability reachable by the agent, and ordinary local CLI behavior without a credential broker or control-plane-mediated Git operation that the record does not define.
   - **Verdict: FALSIFIED.**

5. **An append-only event log does not make GitHub side effects crash-safe.**

   - Claim attacked: [doc 01 Decision 7](/Users/davidtoniolo/Projects/Camino/docs/design/01-intent-analysis-and-design-decisions.md:103): the event log “buys audit, replay” and a simple loop “carries v1”; [doc 02 §5](/Users/davidtoniolo/Projects/Camino/docs/design/02-revised-product-definition.md:70): “The event log plus resumable pipeline stages carry” durability.
   - Receipt: `rg -n -i 'idempot|outbox|exactly.once|remote reconciliation' docs/design` returned no matches.
   - Falsifying sequence: GitHub accepts a merge, then Camino crashes before appending `MergeSucceeded`. Replaying the log may repeat downstream actions. Recording success before calling GitHub creates the inverse false state. SQLite/Postgres cannot transact atomically with GitHub, CI, or CLI subprocesses.
   - **Verdict: FALSIFIED.**

6. **The required behavioral proof has no secrets or test-environment model.**

   - Claim attacked: [doc 03 §1](/Users/davidtoniolo/Projects/Camino/docs/design/03-router-and-living-spec.md:8) includes auth/database migrations; [doc 04 §2.2](/Users/davidtoniolo/Projects/Camino/docs/design/04-gap-reconciliation-and-done-problem.md:46) requires a Playwright/API probe for each observable requirement; [doc 02 §6](/Users/davidtoniolo/Projects/Camino/docs/design/02-revised-product-definition.md:79) requires clean-environment validation.
   - Receipt: `rg -n -i 'secret broker|test tenant|test account|callback URL|consent' docs/design` returned no matches.
   - A Clerk→Auth0 migration, payment flow, email delivery, Entra consent, or hosted database migration requires test tenants, credentials, callbacks, seeded external state, and cleanup. Giving them to workers violates the invariant; withholding them makes genuine end-to-end proof impossible. Mocks do not prove live wiring.
   - **Verdict: FALSIFIED.**

7. **The “walking skeleton” is a full workflow platform mislabeled as thin.**

   - Claim attacked: [doc 02 §4](/Users/davidtoniolo/Projects/Camino/docs/design/02-revised-product-definition.md:46): “the thinnest version of every pipeline stage” exists “from week one.”
   - Receipt: [doc 02 §6](/Users/davidtoniolo/Projects/Camino/docs/design/02-revised-product-definition.md:73) includes daemon, web app, event store, GitHub App, two CLI protocols, worktrees/containers, planner, validation, evidence, merge UI, multi-project schema, and economics. Docs 03–04 add ledger/reporting, Canon folding, a gap register, detectors, and accumulating probes.
   - Schedule eaters understated:
     - GitHub App registration, private-key/JWT custody, installation-token refresh, permissions, checks, and remote-state reconciliation.
     - Webhook delivery to localhost needs a proxy/tunnel or polling; GitHub’s own tutorial uses Smee for local delivery. [GitHub webhook tutorial](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-github-app-that-responds-to-webhook-events).
     - CLI stream protocols, cancellation, process-tree cleanup, quota classification, and auth lifecycle.
     - Sandboxing and network policy.
     - Reproducible app boot, seed/reset, artifact retention, Playwright authentication, traces, and flake handling.
   - A mocked demonstration may fit a week; a trustworthy real loop does not.
   - **Verdict: OVERSTATED.**

8. **Worker completion is load-bearing, but one spike cannot establish it.**

   - Claim attacked: [doc 02 §5](/Users/davidtoniolo/Projects/Camino/docs/design/02-revised-product-definition.md:68): worker completion is “mostly mechanics” and “testable in a week”; [§7](/Users/davidtoniolo/Projects/Camino/docs/design/02-revised-product-definition.md:85): one issue “Proves” auth, sandboxing, quota behavior, and repair loops.
   - Receipt: `node` calculation → a six-issue mission with 90%-reliable issue completion succeeds only `53.1%` of the time. Reaching 90% mission completion requires `98.26%` per issue; reaching 80% requires `96.35%`.
   - A one-issue spike cannot estimate those rates, encounter representative quota-window behavior, or prove containment against hostile inputs.
   - **Verdict: OVERSTATED.**

9. **The proposed calibration set cannot justify earned auto-merge.**

   - Claim attacked: [doc 01 Decision 10](/Users/davidtoniolo/Projects/Camino/docs/design/01-intent-analysis-and-design-decisions.md:114), carried forward by doc 02: 20–30 historical PRs support claims such as ≥90% defect detection and ≤10% false rejection.
   - Receipt: rule-of-three calculation → even `0/30` observed false approvals gives only an approximate 95% upper bound of `10%`. Correlated variants from the same PR/repository reduce the effective sample further.
   - “Survives 30 days” also misses dormant defects and gives no negative label when a feature simply receives no use.
   - **Verdict: OVERSTATED.**

10. **Live issue editing conflicts with frozen, hash-bound contracts.**

    - Claim attacked: [doc 02 §2](/Users/davidtoniolo/Projects/Camino/docs/design/02-revised-product-definition.md:25): users may edit or reorder issues “before (and during) execution”; [§4](/Users/davidtoniolo/Projects/Camino/docs/design/02-revised-product-definition.md:58): acceptance criteria freeze at approval.
    - Receipt: `nl -ba ...02... | sed -n '22,26p;54,59p'` reproduces both statements.
    - If the user changes an acceptance criterion while a worker is running, either the worker continues against a stale hash, or the contract was not frozen. The record specifies no cancel/version/replan protocol or invalidation of downstream issues and probes.
    - **Verdict: FALSIFIED.**

11. **The per-cell learning router cannot become statistically honest at solo volume.**

    - Claim attacked: [doc 03 §3.4](/Users/davidtoniolo/Projects/Camino/docs/design/03-router-and-living-spec.md:58): task type × language × repo × model scorecards will capture differences despite thin data.
    - Receipt: normal two-proportion power calculation:
      - 70% vs 85% success: `121 outcomes/model`.
      - 70% vs 80%: `294 outcomes/model`.
      - At 20 issues/week, six task types × two languages × three repos × two models gives 72 cells and only `14.4 outcomes/cell/year` on average.
    - Model versions and harnesses will change before most cells reach adequate sample size. Failure-triggered switching is not free comparative data: model B receives selected hard cases plus model A’s partial work. Low-risk exploration does not identify high-risk performance.
    - METR also cautions that benchmark-to-real-world translation is difficult because benchmarks omit repository context and realistic evaluation. [METR study](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/).
    - **Verdict: FALSIFIED.**

12. **The cost-to-green reward censors the failures it most needs to learn from.**

    - Claim attacked: [doc 03 §3.3](/Users/davidtoniolo/Projects/Camino/docs/design/03-router-and-living-spec.md:48): cost-to-green is defined “for an issue that ends accepted and survives 30 days.”
    - Receipt: an issue abandoned after four expensive failed attempts never reaches “green,” so the stated reward is undefined for the worst outcomes. No-revert-in-30-days is neither a correctness label nor attribution of a later hotfix to a particular first assignment.
    - [Doc 03 §3.2](/Users/davidtoniolo/Projects/Camino/docs/design/03-router-and-living-spec.md:40) also calls tokens, dollars, quota consumed, human minutes, and post-merge outcomes “essentially zero cost” to record. Consumer subscription quota and causal repair attribution are not consistently exposed per attempt; human minutes require instrumentation or reporting.
    - **Verdict: FALSIFIED.**

13. **“Frontier calls are effectively free” is already contradicted by the policy evidence.**

    - Claim attacked: [doc 03 §3.3](/Users/davidtoniolo/Projects/Camino/docs/design/03-router-and-living-spec.md:50): under abundant quota, “best model everywhere” is optimal.
    - Receipt: doc 05 itself records quota opportunity cost and a proposed Anthropic move to separate headless work from subscription pools. Anthropic’s preserved notice confirms such a change was proposed and paused. [Anthropic billing notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
    - Even prepaid capacity has opportunity cost when missions queue, quotas reset, or an urgent task arrives. “Greedy quality” may be a temporary policy, not an economic optimum.
    - **Verdict: OVERSTATED.**

14. **Canon and probe maintenance breaks the stated attention budget.**

    - Claim attacked: [doc 01 Decision 8](/Users/davidtoniolo/Projects/Camino/docs/design/01-intent-analysis-and-design-decisions.md:106): 10 David-minutes per merged slice and 45 per mission plan; [doc 02 §6](/Users/davidtoniolo/Projects/Camino/docs/design/02-revised-product-definition.md:80): human actions are plan approval, merge clicks, and escalations.
    - Receipt: docs 03–04 add intake conflict review, a human-approved fold PR, periodic audits, reviewed per-requirement probes, suspected-gap confirmation, and waivers.
    - Conservative calculation: two observable requirements/issue, three minutes/probe review, five minutes/fold, one minute/gap disposition adds 29 minutes to a three-issue mission and 53 minutes to a six-issue mission—28–71% above the existing 75–105 minute budget.
    - **Verdict: OVERSTATED.**

15. **Accumulating probes mathematically turn flakiness into gap-register noise.**

    - Claim attacked: [doc 04 §2.2–2.4](/Users/davidtoniolo/Projects/Camino/docs/design/04-gap-reconciliation-and-done-problem.md:46): probes accumulate as the Canon’s executable shadow, and red coverage means drift.
    - Receipt: even independent probes produce:
      - Ten 98%-reliable probes: `18.3%` chance of at least one false red.
      - Twenty 99.5%-reliable probes: `9.5%`.
      - One hundred 99.5%-reliable probes: `39.4%`.
    - Playwright explicitly supports retries because tests can fail intermittently and categorizes retry-pass cases as flaky. [Playwright retries](https://playwright.dev/docs/test-retries).
    - A browser update, seed race, OAuth outage, or shared-environment failure becomes “canon coverage regressed.” The record has no detector-health state, infrastructure-failure status, quarantine, or flake budget.
    - **Verdict: FALSIFIED.**

16. **A quick task does not use the same pipeline with “no ceremony.”**

    - Claim attacked: [doc 02 §4](/Users/davidtoniolo/Projects/Camino/docs/design/02-revised-product-definition.md:50) and [doc 03 §1](/Users/davidtoniolo/Projects/Camino/docs/design/03-router-and-living-spec.md:7): one-issue missions have “no ceremony.”
    - Receipt: [doc 03 §4.3](/Users/davidtoniolo/Projects/Camino/docs/design/03-router-and-living-spec.md:77) requires a fold whose own PR is initially human-approved; [doc 04 §2.3](/Users/davidtoniolo/Projects/Camino/docs/design/04-gap-reconciliation-and-done-problem.md:51) updates the gap register every mission.
    - As written, a one-line quick fix can produce one implementation PR, one fold PR, evidence review, and gap reconciliation.
    - **Verdict: FALSIFIED.**

17. **The supposedly cheap deterministic wiring detector is a hidden program-analysis project.**

    - Claim attacked: [doc 04 §2.2](/Users/davidtoniolo/Projects/Camino/docs/design/04-gap-reconciliation-and-done-problem.md:45) and §2.5: deterministic reachability catches unregistered routes, migrations, imports, and flags; these detectors enter v1 because “they are cheap.”
    - Receipt: dynamic imports, framework file routing, reflection, dependency injection, plugin entry points, generated code, migration discovery, and deployment-only flags can all be live while naive static analysis says dead. Conversely, imported code may be semantically unreachable.
    - TODO scans are cheap. Sound cross-language/framework reachability and wiring analysis is not.
    - **Verdict: FALSIFIED.**

18. **“Canon coverage” has no defined denominator.**

    - Claim attacked: [doc 04 §2.4](/Users/davidtoniolo/Projects/Camino/docs/design/04-gap-reconciliation-and-done-problem.md:60): coverage is “the fraction of canon requirements with green probes.”
    - Receipt: [doc 04 §2.2](/Users/davidtoniolo/Projects/Camino/docs/design/04-gap-reconciliation-and-done-problem.md:46) only provides probes for user-observable requirements, while [doc 03 §4.2](/Users/davidtoniolo/Projects/Camino/docs/design/03-router-and-living-spec.md:72) puts intent, architecture principles, exclusions, glossary, conventions, and instructions in the Canon.
    - Nonfunctional invariants, exclusions, architectural principles, and glossary rules do not necessarily have Playwright/API probes. The proposed numerator therefore does not cover the stated denominator.
    - **Verdict: FALSIFIED.**

19. **Brownfield induction cannot infer authoritative intent from docs and code.**

    - Claim attacked: [doc 03 §4.3–4.4](/Users/davidtoniolo/Projects/Camino/docs/design/03-router-and-living-spec.md:79): Camino builds a coherent Canon and flags contradictions “on day one”; updates must derive from intent, “never from the implementation diff.”
    - Receipt: docs say refunds last 30 days, code and tests implement 14, and no surviving decision explains which is intended. Choosing code violates the anti-laundering rule; choosing docs may canonize stale intent; asking the user turns induction into a manual product audit.
    - Doc 01 called universal environment inference the hard 80% and excluded it; doc 03 now says induction sets up the validatable-repo profile across brownfield projects.
    - **Verdict: FALSIFIED.**

20. **Author separation cannot detect a shared bad premise.**

    - Claim attacked: [doc 04 §2.1–2.2](/Users/davidtoniolo/Projects/Camino/docs/design/04-gap-reconciliation-and-done-problem.md:41): probes come from the Canon “by a different author,” presented as the critical defense.
    - Receipt: if the planner drops a requirement while converting PRD→Canon, a different model writes probes from the already-narrowed Canon and the worker implements them perfectly. Code, probes, and register all go green while the user’s requirement is absent.
    - Cross-family authorship reduces self-confirmation; it does not create an independent source of truth.
    - **Verdict: OVERSTATED.**

21. **“Interrupted only by genuine escalations” contradicts routine v1 approval points.**

    - Claim attacked: [doc 02 §2](/Users/davidtoniolo/Projects/Camino/docs/design/02-revised-product-definition.md:27): the user is “interrupted only by genuine escalations.”
    - Receipt: [doc 02 §6](/Users/davidtoniolo/Projects/Camino/docs/design/02-revised-product-definition.md:80) requires plan approval and one merge click per issue; doc 03 initially requires another approval for the fold PR.
    - A 3–6 issue mission therefore requires at least five to eight routine human actions: one plan, three to six merges, and one fold—before genuine escalations.
    - **Verdict: FALSIFIED.**

22. **Waivers let the system call an undelivered PRD complete.**

    - Claim attacked: [doc 04 §2.4](/Users/davidtoniolo/Projects/Camino/docs/design/04-gap-reconciliation-and-done-problem.md:60): completion permits zero gaps “or explicitly waived.”
    - Receipt: [doc 01 §3](/Users/davidtoniolo/Projects/Camino/docs/design/01-intent-analysis-and-design-decisions.md:73) instead says permanent failures produce explicit residue of unmet outcomes.
    - A waived missing requirement is still missing. If it counts as complete, “PRDs delivered end-to-end” and canon coverage can improve by relabeling failure. If residue remains incomplete, doc 01’s partial-completion rule and doc 04’s completion rule conflict.
    - **Verdict: FALSIFIED.**

23. **Serialize-first makes Camino a poor primary interface for urgent quick tasks.**

    - Claim attacked: [doc 02 §4](/Users/davidtoniolo/Projects/Camino/docs/design/02-revised-product-definition.md:50): quick tasks must flow through Camino so it becomes the primary interface; [same section](/Users/davidtoniolo/Projects/Camino/docs/design/02-revised-product-definition.md:52): missions serialize per repository.
    - Receipt: a multi-day migration is running when an urgent one-issue hotfix arrives. The hotfix queues behind it unless the user leaves Camino or interrupts the mission. No preemption, priority lane, workspace release, or stale-base recovery is specified.
    - Serialization is defensible for safety, but it contradicts the primary-interface ambition without an urgent-work path.
    - **Verdict: OVERSTATED.**

24. **The Anthropic “bright-line safe” conclusion is too strong.**

    - Claim attacked: [doc 05 §5](/Users/davidtoniolo/Projects/Camino/docs/design/05-market-landscape-and-assessment.md:64): spawning the real CLI keeps Camino “on the right side of the bright line,” leaving “mainly economic risk.”
    - Receipt: Anthropic Consumer Terms prohibit automated access except through an API key or explicit permission. Claude’s headless docs explicitly permit `claude -p`, but its legal page separately says subscription OAuth is for ordinary use of native Anthropic applications and forbids third-party developers from routing subscription credentials for users. [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), [Claude Code legal guidance](https://code.claude.com/docs/en/legal-and-compliance), [headless documentation](https://code.claude.com/docs/en/headless).
    - Personal local use is materially safer than handling credentials for other users. Open-source distribution creates a distinct third-party-product risk even without monetization. “Official binary” is not by itself a policy classification.
    - **Verdict: OVERSTATED.**

25. **The categorical “Agent SDK violates ToS” claim does not survive current Anthropic guidance.**

    - Claim attacked: [doc 05 §5](/Users/davidtoniolo/Projects/Camino/docs/design/05-market-landscape-and-assessment.md:59): subscription OAuth in “any other product including the Agent SDK violates the ToS.”
    - Receipt: Anthropic’s current support page says, “For now, nothing has changed”: Agent SDK, `claude -p`, and third-party app usage still draw from subscription limits. The same company’s legal page tells third-party product developers to use API keys. [Agent SDK subscription article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [legal guidance](https://code.claude.com/docs/en/legal-and-compliance).
    - The primary sources are internally tense; the design record incorrectly collapses them into one crisp prohibition.
    - **Verdict: FALSIFIED.**

26. **The claimed Anthropic enforcement history is not primary-source reproducible.**

    - Claim attacked: [doc 05 §5](/Users/davidtoniolo/Projects/Camino/docs/design/05-market-landscape-and-assessment.md:59): countermeasures, account bans, and legal requests forced OpenCode to remove subscription support.
    - Receipt: Anthropic confirms it may enforce without notice, but no Anthropic statement or authenticated legal request was found confirming those particular events. Surfaced OpenCode reports are user allegations, not primary Anthropic evidence.
    - The preserved billing page says changes were paused June 15, not June 16; it does not establish the claimed May 14 publication date, ACP scope, or “deferred not cancelled” conclusion.
    - **Verdict: UNTESTABLE.**

27. **An API fallback cannot make policy change “never an outage.”**

    - Claim attacked: [doc 05 §5](/Users/davidtoniolo/Projects/Camino/docs/design/05-market-landscape-and-assessment.md:66): provider policy changes become cost-model changes, “never an outage.”
    - Receipt: API fallback requires separate credentials, accepted commercial terms, funded billing, model/feature parity, and provider availability. Anthropic’s own notice says pay-as-you-go credits are separate from subscriptions. [Anthropic API authentication](https://platform.claude.com/docs/en/manage-claude/authentication), [billing notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
    - A user without a funded Console account or equivalent API model plainly experiences an outage.
    - **Verdict: FALSIFIED.**

28. **The learning-router novelty claim is flatly wrong.**

    - Claim attacked: [doc 05 §3 scoreboard](/Users/davidtoniolo/Projects/Camino/docs/design/05-market-landscape-and-assessment.md:45): “Unclaimed — only static role tables shipped.”
    - Receipt: Not Diamond ships custom routers trained on private evaluation data; its documentation says the meta-model learns when to use each LLM and can be retrained with new rows. OpenRouter ships `openrouter/auto`, powered by Not Diamond, with task/capability selection and a cost-quality control. [Not Diamond custom-router documentation](https://docs.notdiamond.ai/docs/router-training-quickstart), [OpenRouter Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router).
    - Camino’s issue-level repair/human/post-merge reward is narrower differentiation. The category “learning cost-quality router” is already claimed and shipped.
    - **Verdict: FALSIFIED.**

29. **“SDD tools are spec-first, not spec-living” is false.**

    - Claim attacked: [doc 05 §3 scoreboard](/Users/davidtoniolo/Projects/Camino/docs/design/05-market-landscape-and-assessment.md:44): Living Canon + gap register is “Unclaimed.”
    - Receipt:
      - GitHub Spec Kit has a literal “Living Spec” workflow: update `spec.md`, keep artifacts aligned, run `/speckit.converge`, and generate tasks for remaining gaps. [Spec Kit evolving specs](https://github.github.com/spec-kit/guides/evolving-specs.html).
      - Tessl links requirements to tests, verifies requirements, and updates specs with implementation discoveries. [Tessl SDD](https://docs.tessl.io/use/spec-driven-development-with-tessl).
      - Kiro describes continuously refined specs and synchronization between requirements, tasks, and implementation. [Kiro best practices](https://kiro.dev/docs/specs/best-practices/).
      - Traditional requirements tools already maintain requirements→implementation→test traceability and gap/status views. [IBM DOORS Next traceability](https://www.ibm.com/docs/en/engineering-lifecycle-management-suite/doors-next/7.2.0?topic=requirements-traceability), [GitLab requirements](https://docs.gitlab.com/user/project/requirements/).
    - Camino’s exact integrated workflow may remain distinctive; the primitive and category are not unclaimed.
    - **Verdict: OVERSTATED.**

30. **The context-rot paper does not establish a tooling vacuum.**

    - Claim attacked: [doc 05 §1/§4/§6](/Users/davidtoniolo/Projects/Camino/docs/design/05-market-landscape-and-assessment.md:55): “no tooling exists,” “tooling vacuum,” and academically certified open problem.
    - Receipt: the paper confirms 23.0% stale references across 356 repositories, but its abstract says traditional documentation-consistency tools are an “immediate starting point” and that an existing README/wiki checker already surfaces context rot. [Context Rot paper](https://arxiv.org/abs/2606.09090).
    - “No purpose-built agent-config product” may be defensible. “No tooling exists” is not.
    - **Verdict: FALSIFIED.**

31. **PRD-document-to-board intake is not “unevidenced anywhere.”**

    - Claim attacked: [doc 05 §3 scoreboard](/Users/davidtoniolo/Projects/Camino/docs/design/05-market-landscape-and-assessment.md:40).
    - Receipt: Jira/Rovo can create multiple work items from a pasted Confluence page and place them into the backlog/board; Kiro imports Jira, Confluence, Word, and PRFAQ material and generates requirements, design, and discrete tasks. [Atlassian work-item creation](https://support.atlassian.com/jira-software-cloud/docs/create-a-work-item-and-a-subtask/), [Kiro Quick Plan](https://kiro.dev/docs/specs/quick-plan/).
    - These retain human review, but they directly falsify “unevidenced anywhere.”
    - **Verdict: FALSIFIED.**

32. **The funded-player BYO-subscription claim relies on an undefined carve-out.**

    - Claim attacked: [doc 05 §3 scoreboard](/Users/davidtoniolo/Projects/Camino/docs/design/05-market-landscape-and-assessment.md:42): “Natively unclaimed by any funded incumbent.”
    - Receipt: YC lists Vibe Kanban as a Summer 2021 company; its launch instructions say to authenticate Claude Code, Codex, Gemini, or Amp and then run `npx vibe-kanban`. [YC company page](https://www.ycombinator.com/companies/vibe-kanban), [Vibe Kanban repository](https://github.com/BloopAI/vibe-kanban).
    - The accurate distinction is “not offered by current platform-billed incumbents,” not “unclaimed by funded players.”
    - **Verdict: OVERSTATED.**

33. **The universal local-control-plane negative is not established.**

    - Claim attacked: [doc 05 §3 scoreboard](/Users/davidtoniolo/Projects/Camino/docs/design/05-market-landscape-and-assessment.md:46): “not shipped by any funded player.”
    - Receipt: doc 05 admits several competitors were not assessed. Vibe’s backend/web app runs locally on `127.0.0.1`, but its current board/team features can depend on cloud sign-in and a remote shared API, so it does not cleanly prove a fully offline local control plane. [Vibe repository](https://github.com/BloopAI/vibe-kanban).
    - The same evidence also weakens doc 05’s unqualified description of Vibe as “local-first kanban.”
    - **Verdict: UNTESTABLE.**

34. **GitHub verification is not “unevidenced.”**

    - Claim attacked: [doc 05 §3 scoreboard](/Users/davidtoniolo/Projects/Camino/docs/design/05-market-landscape-and-assessment.md:43): verification is “unevidenced at GitHub.”
    - Receipt: GitHub now applies CodeQL, dependency, secret, and agentic code-review validation to agent output, including third-party agents. [GitHub third-party-agent security validation](https://github.blog/changelog/2026-06-09-security-validation-for-third-party-coding-agents/), [agentic code review](https://github.blog/changelog/2026-03-05-copilot-code-review-now-runs-on-an-agentic-architecture/).
    - This does not prove Factory/Camino-grade black-box behavioral or wiring verification, but “verification unevidenced” is false.
    - **Verdict: FALSIFIED.**

35. **Factory’s launch chronology does not reproduce.**

    - Claim attacked: [doc 05 §1–2](/Users/davidtoniolo/Projects/Camino/docs/design/05-market-landscape-and-assessment.md:7): “research preview since Feb 2026”; §2 says “launch post Feb 26, 2026.”
    - Receipt: Factory’s cited page currently displays “February 26, 2025.” It confirms the architecture, customer use since mid-January, median duration, 14% over 24 hours, 16-day maximum, and 12× token usage—but not the record’s year. [Factory Introducing Missions](https://factory.ai/news/missions).
    - The page itself contains later-model references, so Factory may have a metadata error; nevertheless, the cited receipt does not support Camino’s date. The current pricing page also no longer states a Max/Enterprise-exclusive gate, only that Missions requires Extra Usage. [Factory pricing](https://docs.factory.ai/pricing).
    - **Verdict: FALSIFIED.**

36. **“OpenAI explicitly declines to productize Symphony” is an inference presented as fact.**

    - Claim attacked: [doc 05 §3](/Users/davidtoniolo/Projects/Camino/docs/design/05-market-landscape-and-assessment.md:32).
    - Receipt: Symphony calls its Elixir code an “experimental reference implementation,” encourages reimplementation, and lists rich UI/multi-tenancy as specification non-goals. It does not state that OpenAI will never productize adjacent functionality. [Symphony repository](https://github.com/openai/symphony), [SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md).
    - A component’s non-goals are not corporate strategy or proof that a market slot is vacant.
    - **Verdict: OVERSTATED.**

37. **The [JV] pain cluster mixes confirmed data with stale or causal overreach.**

    - Claim attacked: [doc 05 §4](/Users/davidtoniolo/Projects/Camino/docs/design/05-market-landscape-and-assessment.md:48), especially the presentation of all items as current evidence for one control-plane thesis.
    - Receipt:
      - Stack Overflow’s 66% “almost right,” 46% distrust, and 33% trust reproduce, but the relevant questions had roughly 31–33k responses, not 49k. [Stack Overflow 2025 survey](https://survey.stackoverflow.co/2025/ai).
      - DORA’s 90% adoption, 30% little/no trust, and throughput/instability tension reproduce. [DORA](https://dora.dev/insights/balancing-ai-tensions/).
      - METR’s 19% slowdown reproduces for 16 developers and early-2025 tools, but METR now labels it out of date and believes early-2026 developers are probably more sped up. [Original METR study](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/), [2026 update](https://metr.org/blog/2026-02-24-uplift-update/).
      - GitClear’s numerical trends reproduce, but the dataset is observational; “quantified AI-caused rot” is stronger than the evidence. [GitClear](https://www.gitclear.com/ai_assistant_code_quality_2025_research).
      - SpecBench reproduces the visible/held-out gap, but it is 30 systems tasks, not proof of prevalence in private brownfield repositories. [SpecBench](https://arxiv.org/abs/2605.21384).
    - The pain is real; the record overstates recency, causality, and generalizability.
    - **Verdict: OVERSTATED.**

38. **The core market convergence receipts survive, but they prove feasibility rather than Camino’s whole design.**

    - Claim attacked: [doc 05 §6](/Users/davidtoniolo/Projects/Camino/docs/design/05-market-landscape-and-assessment.md:72): Factory convergence is “strong evidence the design is right.”
    - Receipt: Factory does confirm orchestrator/worker/validator separation, prewritten validation contracts, fresh black-box validators, shared mission artifacts, and 37.2% validation time. Agent HQ confirms a multi-vendor mission-control surface. Symphony confirms the scheduler/runner pattern. Vibe confirms local authenticated CLI orchestration and its commercial shutdown. [Factory architecture](https://factory.ai/news/missions-architecture), [GitHub Agent HQ](https://github.blog/news-insights/company-news/welcome-home-agents/), [Symphony SPEC](https://github.com/openai/symphony/blob/main/SPEC.md), [Vibe shutdown](https://vibekanban.com/blog/shutdown).
    - Factory’s own example used 185 runs, 778.5M tokens, 21 fix features for 40 original features, and zero of six milestones passing their first validation round. That proves the loop is technically possible for a funded team; it does not prove solo maintainability, subscription economics, low attention cost, Canon usefulness, or router learnability.
    - **Verdict: OVERSTATED.**

safe to build on: with corrections — split desired-state Canon from as-built truth; prevent partial mission merges or add atomic integration and rollback; replace branch-scoped worker credentials with control-plane-mediated Git and real isolation; specify idempotent GitHub reconciliation plus secrets/test environments; cut and revalidate v1 scope; measure worker, gate, and probe error rates before auto-merge; demote learned routing, Living Canon/gap register, and market novelty claims; and treat provider permission as use-context-specific, time-varying policy rather than an official-binary safe harbor.