# Camino — Adversarial Review, Round 2 (raw, verbatim)

> Reviewer: Codex `gpt-5.6-sol`, xhigh, read-only sandbox + web search. Run 2026-07-16 against [08-design-v2.md](08-design-v2.md) (frozen as reviewed). Verbatim and unedited. Claude's verification: [10-review-round2-dispositions.md](10-review-round2-dispositions.md). Verdict: **safe to build on: no** — resolved in [11-design-v3.md](11-design-v3.md).

---

## Findings

1. **Validation isolation does not protect test secrets from worker-authored code.**

   Claim attacked: §5.3 says secrets enter “**only into the validation runner’s environment, never into worker environments**” and workers use mocks ([08 §5.3](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:107)).

   Failure sequence: the worker changes an app startup script, build hook, dependency, or test helper → the validator injects secrets and executes that worker-authored tree → the code reads its environment and writes the secret to stdout, retained artifacts, evidence, repair logs, or an allowed network endpoint. The process boundary does not matter: the worker’s code executes inside the credentialed environment. GitHub documents this same “execute untrusted code with secrets” failure as a credential-compromise pattern. [GitHub security guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).

   **Verdict: FALSIFIED.**

2. **Auto-merge is simultaneously enabled by default and forbidden until earned.**

   Claims attacked: invariant 5 says merge autonomy unlocks only after demonstrated performance ([§2](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:19)); §8.3 says auto-merge unlocks only after at least 50 human-confirmed decisions ([§8.3](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:141)); but §4.2 auto-merges issue PRs and makes cruise mode the default ([§4.2](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:74)).

   Failure sequence: the first mission in a new repo starts in cruise mode → the first issue passes the uncalibrated gate → it merges unattended with zero labels. If §8.3 governs only future mission-to-main auto-merge, the document never says so, and training mode collects labels at a different gate.

   **Verdict: FALSIFIED.**

3. **Control-plane-mediated Git does not establish the claimed authority split.**

   Claim attacked: workers commit locally; the control plane pushes after diff-scope, protected-path, contract-reference, and budget checks ([§5.1](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:95)).

   Failure sequence: a worker in the permitted worktree changes shared Git configuration or installs an untracked `pre-push` hook → tracked-file checks see nothing → the credential-bearing control plane invokes Git in that repository → Git runs the worker-controlled hook. Linked worktrees share refs and repository configuration, while hooks reside in the common Git directory. [Git worktree documentation](https://git-scm.com/docs/git-worktree.html), [Git hooks documentation](https://git-scm.com/docs/githooks).

   The checks also do not establish clean ancestry, hook/config integrity, full-tree semantics, symlink behavior, or submodule contents. A semantically unrelated change inside an allowed file also passes a filename-scope policy.

   **Verdict: OVERSTATED.**

4. **Branch synchronization does not guarantee that the validated state is the state merged.**

   Claims attacked: the mission branch “syncs from main frequently,” re-running “affected validation,” and all requirements are demonstrated on that branch before merging ([§4.2](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:75)).

   Failure sequence: mission head H is green against main M0 → main advances to M1 after the last sync → the user merges H into M1 → that combined result was never probed. “Frequently” is neither a merge-time freshness invariant nor a maximum drift window. GitHub supports guarding a merge against a specific PR head SHA, but the design does not bind the verdict to the head, merge base, or resulting merge tree. [GitHub pull-request merge API](https://docs.github.com/en/rest/pulls/pulls).

   Repeated main movement can also cause unbounded revalidation; “affected” has no sound definition for semantic dependencies.

   **Verdict: OVERSTATED.**

5. **“Rollback = revert one commit” is false as a rollback guarantee.**

   Claim attacked: “Merge yields a single revertable merge commit — **rollback = revert one commit**” ([§4.2](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:76)).

   Failure sequence: mission A merges → mission B or an urgent task depends on A → reverting A conflicts with B or removes APIs B needs. A Git revert also does not undo test-tenant mutations, migrations, generated external state, or a separately merged Canon fold. Git explicitly warns that reverting a merge declares its ancestors unwanted and changes how later merges behave. [Git revert documentation](https://git-scm.com/docs/git-revert.html).

   A single commit may record an inverse tree patch in the simple case; that is not equivalent to restoring a valid system state.

   **Verdict: FALSIFIED.**

6. **Intent → act → confirm does not make every side effect crash-safe.**

   Claim attacked: “**Every side-effecting operation**” receives an idempotency key and is reconciled after restart ([§4.4](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:89)).

   Failure sequence: GitHub accepts a PR creation or CI dispatch → the response is lost → the local key is not correlated with a server-enforced idempotency key → two recovery processes both retry, or reconciliation cannot distinguish the intended object from another matching operation. GitHub PR creation exposes no generic idempotency parameter. Workflow dispatch returns a run ID, but that is precisely the response lost in this crash. [Pull-request API](https://docs.github.com/en/rest/pulls/pulls), [workflow-dispatch API](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10).

   Reconciliation is also described only against GitHub. Seed/reset operations and cleanup of external test tenants remain outside it; a crash can skip cleanup and poison the next attempt.

   **Verdict: OVERSTATED.**

7. **Canon status can again describe nonexistent behavior as verified.**

   Claim attacked: status-bearing context means an agent is “**never fed an unbuilt feature as an existing one**” ([§3.1](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:34)).

   Failure sequences:

   - A requirement becomes `verified` → the mission is reverted → no reverse Canon transition is specified → later agents still receive `verified`.
   - A previously green probe begins failing and becomes flaky, quarantined, or infra-blocked → the requirement lifecycle has no `unknown`, `stale`, or `verification-blocked` state → `verified` survives while its only evidence is ignored.
   - `built` is not defined as “merged into the mission branch” versus “merged into main,” so agent-visible availability remains ambiguous.
   - A disputed entry “forces resolution,” but no lifecycle exists for a user who cannot determine historical intent.

   This is a variant of round 1’s original false-current-truth sequence.

   **Verdict: FALSIFIED.**

8. **Two individually validated issues can still combine into a semantically broken mission branch.**

   Claim attacked: issue PRs merge unattended “once independent validation passes” ([§4.2](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:74)).

   Failure sequence: A and B branch from the same mission head → A changes authorization or API semantics → B validates against the old behavior or a mock → A merges → B’s textually clean, already-green patch merges without validation against A. The design mandates revalidation after main synchronization, not after every issue merge or base change.

   The final probes cover declared behavioral requirements, not every cross-issue structural, compatibility, performance, or security assumption. No mission-level semantic review is specified. The integration branch contains the damage before main, but it does not prevent it from passing.

   **Verdict: OVERSTATED.**

9. **The urgent lane neither guarantees urgent preemption nor preserves proof identity.**

   Claim attacked: urgent work pauses at “the next issue boundary,” then the mission branch rebases and revalidates “affected issues” ([§4.2](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:79)).

   Failure sequence: an issue is in a six-hour repair loop → the hotfix waits six hours for the next boundary. After it lands, rebasing rewrites mission commit SHAs; evidence previously associated with those commits no longer refers to objects on the branch. Revalidating only an inferred affected subset can preserve stale evidence for semantically affected issues with no overlapping files.

   The original brief explicitly associated evidence with an attempt and commit ([00 §Verification](/Users/davidtoniolo/Projects/Camino/docs/design/00-context-brief.md:225)); 08 silently loses that invariant.

   **Verdict: FALSIFIED.**

10. **The PRD checklist does not close the shared-bad-premise failure.**

    Claim attacked: the checklist is “**the defense against the planner silently narrowing intent**” ([§3.5](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:50)), while every planner-invented assumption supposedly becomes a question ([§4.1](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:65)).

    Failure sequence: every PRD sentence maps to an entry, but the planner chooses an unsafe architecture, wrong interface boundary, or narrowed interpretation → the checklist is complete → the same plan supplies issues and contracts → downstream authors share the bad premise. A model cannot prove it surfaced every latent assumption merely by reporting the assumptions it noticed.

    The founding brief required a plan criticizable by another model before implementation ([00 §Planning](/Users/davidtoniolo/Projects/Camino/docs/design/00-context-brief.md:133)), and doc 02 retained a cross-family plan challenge. That mechanism is absent from 08.

    **Verdict: FALSIFIED.**

11. **Canon-neutral classification is a single-point self-confirmation failure.**

    Claim attacked: the planner labels missions `canon-affecting` or `canon-neutral`; neutral quick tasks receive no fold or new probes and go directly to main ([§3.5](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:52), [§4.2](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:77)).

    Failure sequence: a one-line auth default, timeout, feature flag, dependency, or migration change is mislabeled neutral → the same planner’s label removes the Canon and probe checks that could expose the mistake → the change bypasses mission containment → weekly register processing or a sampled audit sees it only later, if at all.

    There is also a direct contradiction: canon-neutral quick tasks get “no new probes,” while §4.3 requires behavioral probes per user-observable issue.

    **Verdict: FALSIFIED.**

12. **Missing test resources cannot be guaranteed to escalate at plan approval.**

    Claim attacked: missing resources escalate “at plan approval, not at validation failure” ([§5.3](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:108)).

    Failure sequence: the planner omits an implicit dependency; the worker introduces another external service; or an approved credential later expires, loses consent, hits quota, or has a stale callback URL. The first observable failure occurs during validation. Plan-time declaration is an assertion, not an enforceable completeness proof.

    Cleanup hooks have the same weakness: a killed or crashed validator can prevent them from running.

    **Verdict: FALSIFIED.**

13. **Contract versioning invalidates too little downstream work.**

    Claim attacked: downstream issues are invalidated when “their interfaces changed” ([§4.1](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:67)).

    Failure sequence: a contract changes authorization semantics, ordering, consistency, latency, or error behavior without changing a type signature → downstream interfaces appear unchanged → dependent issues retain their old contracts and proof → the mission combines incompatible assumptions.

    The contract itself is versioned, but the dependency invalidation rule does not close the original stale-contract sequence for non-interface changes.

    **Verdict: OVERSTATED.**

14. **The credential threat model omits the creative actors that define policy.**

    Claim attacked: “Creative processes (workers) hold model-provider auth only,” while deterministic policy checks protect repository actions ([§2](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:16)).

    Planners and reviewers are creative processes too. They define Canon deltas, issue scope, contracts, protected behavior, and probes. Prompt-injected repository content can induce a planner to broaden scope or weaken acceptance criteria; the worker then remains inside the resulting policy and the control plane publishes the change.

    “Untrusted text … is data, never instructions” ([§5.1](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:98)) is not enforceable by the official CLI boundary and is deferred to an experiment rather than implemented as a mechanism.

    **Verdict: OVERSTATED.**

15. **The router reward still does not cover all terminal states.**

    Claim attacked: “expected total cost per issue across **all terminal states** — accepted, reassigned, abandoned” ([§6](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:116)).

    `reassigned` is not terminal. The design explicitly creates `cancelled` attempts during contract edits and also permits blocked, escalated, reverted, superseded, and residue outcomes, none of which has a reward definition. An expensive attempt cancelled after a contract edit can therefore disappear from terminal comparison.

    The user-set abandonment penalty is gameable: hopeless work can remain blocked or repeatedly reassigned rather than incur the penalty.

    **Verdict: FALSIFIED.**

16. **The 50-decision unlock does not establish the implied auto-merge reliability.**

    Claim attacked: ≥50 consecutive human-confirmed decisions with zero false approvals can unlock a risk tier ([§8.3](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:141)).

    Zero failures in 50 leaves a one-sided 95% upper failure bound of approximately 5.8%, before correlation. Human agreement at decision time is not an eventual correctness label, especially when the human and gate share the same tests and assumptions. Easy cases can fill the window before a distributionally different issue enters the same tier.

    Probe flake measurement addresses false reds, not false-green probes. No probe false-negative rate, sampling rule, or unlock threshold exists.

    **Verdict: OVERSTATED.**

17. **The document contradicts itself about routine human approvals.**

    Claim attacked: §1 says a six-issue mission needs two approvals—plan and final merge—and everything between is unattended ([§1](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:11), [§4.2](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:74)).

    §7 separately lists fold approval and disputed-Canon answers as routine v1 actions ([§7](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:122)). If the fold is a separate PR, the mission needs at least three routine approvals and “rollback one commit” does not roll back the fold. If it is inside the mission PR, “Folds are PRs” and independent fold approval are false.

    **Verdict: FALSIFIED.**

18. **Attention accounting records ceremony but does not measure it reliably.**

    Claim attacked: attention is measured against approximately 10 minutes per merged-issue equivalent and 45 minutes per mission plan ([§7](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:122)).

    Approval dwell time omits reading or investigation performed outside the approval surface, context-switching cost, disputed-Canon research, and time spent on abandoned missions. “Per merged issue” is gameable through the granularity dial: split identical work into more issues and the denominator improves.

    The only stated response to budget overrun is to tighten ceremony scaling—the same fallible neutral/affecting classifier that can suppress needed probes and folds.

    **Verdict: OVERSTATED.**

19. **The v0 probe model contradicts the completion and status model.**

    Claims attacked: every behavioral requirement has an executable probe and mission completion requires all requirements demonstrated ([§3.6](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:57), [§4.2](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:76)).

    But v0 has “mission-level integration checks only”; the per-requirement accumulating suite comes later ([§8.1](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:128)). Therefore v0 cannot assign `verified` per behavioral requirement or compute the stated verified fraction except by treating a broad mission check as evidence for requirements it may not isolate.

    **Verdict: FALSIFIED.**

20. **Non-behavioral Canon requirements still lack a coherent enforcement lifecycle.**

    Claim attacked: every requirement carries one of five statuses, while structural and policy requirements receive their own check status or “unmeasured” ([§3.1–3.2](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:26)).

    `unmeasured` is not one of the defined statuses. Policy requirements are checked only by the planner against incoming PRDs; nothing requires implementation or validation to detect that code violated an exclusion or “must not change” constraint. Structural checks exist only “where feasible.”

    Thus the Canon can label constraints as intended or built without any defined path to verified—or any explicit unknown status.

    **Verdict: OVERSTATED.**

21. **A fine-grained PAT is sufficient for only the narrow configured-repository flow.**

    Claim attacked: v1 uses a repo-scoped fine-grained PAT for pushes, PR creation, CI dispatch, and merging ([§5.1](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:96)).

    GitHub supports fine-grained PATs for PR creation, merge, and workflow dispatch with the appropriate Pull Requests, Contents, and Actions permissions. [GitHub pull-request permissions](https://docs.github.com/en/rest/pulls/pulls), [workflow permissions](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10).

    The narrow mechanism survives. It is not universal: organization policy can block or require approval of PATs; fine-grained PATs cannot call every Checks API flow, work across multiple organizations, or operate for every outside-collaborator configuration. [GitHub PAT limitations](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

    **Verdict: CONFIRMED.**

22. **The v1 scope and schedule correction genuinely survives.**

    Claim attacked: §11 says round 1’s oversized “week one” skeleton was cut and revalidated through §8.1–8.2 ([§11](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:167)).

    Receipt: GitHub App, webhooks, multi-repo execution, deployment, richer mission templates, advisor routing, and the large accumulating probe suite are deferred; calendar promises are withdrawn and later phases are measurement-gated ([§8.1–8.2](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:126)).

    The remaining loop is large, but it is no longer claimed to be thin or week-sized.

    **Verdict: CONFIRMED.**

23. **The provider-policy posture genuinely survives current receipts.**

    Claim attacked: §9 treats provider permission as contextual and time-varying rather than assuming official binaries create a safe harbor ([§9](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:143)).

    Anthropic’s legal guidance directs third-party products toward API keys, while its current support notice says Agent SDK, `claude -p`, and third-party-app usage still draw from subscription limits. That is the exact tension 08 records. [Anthropic legal guidance](https://code.claude.com/docs/en/legal-and-compliance), [Anthropic support notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

    The design also correctly distinguishes personal use from distribution and no longer calls an unfunded API account a fallback.

    **Verdict: CONFIRMED.**

24. **The retained positive market facts reproduce.**

    Claim attacked: §10’s Factory and GitHub factual receipts ([§10](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:153)).

    Factory’s official page confirms 185 runs, 778.5M tokens, 21 fix features for 40 original features, and zero of six milestones passing first validation. [Factory Missions architecture](https://factory.ai/news/missions-architecture). GitHub confirms security validation for third-party agent output and agentic code review—not black-box behavioral proof. [GitHub security validation](https://github.blog/changelog/2026-06-09-security-validation-for-third-party-coding-agents/), [GitHub agentic review](https://github.blog/changelog/2026-03-05-copilot-code-review-now-runs-on-an-agentic-architecture/).

    **Verdict: CONFIRMED.**

25. **The remaining market universal is still unsupported.**

    Claim attacked: “**the integration is unclaimed**” and “no current platform-billed incumbent offers” native BYO-subscription multi-vendor execution ([§10](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:155)).

    Historical doc 05 admitted major competitors were unassessed. Adding “platform-billed” avoids the Vibe category error but does not establish a universal negative. No bounded assessed set or exhaustive current survey supports it. Since business model is out of scope, this defect is non-load-bearing.

    **Verdict: UNTESTABLE.**

26. **The open-source credential posture contradicts the execution mechanism.**

    Claims attacked: distributed Camino “must never handle provider credentials itself” ([§9](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:151)), while provider authentication is mounted into worker workspaces where required ([§5.1](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:98)).

    Locating and mounting credential-bearing keychain/file state is handling credentials. Read-only protects integrity, not confidentiality. The official harness may own authentication, but Camino still crosses the claimed boundary when it brokers the mount.

    **Verdict: FALSIFIED.**

27. **“Official harnesses only” silently abandons an original architectural requirement.**

    Claim attacked: “Only official vendor harnesses are spawned” ([§5.2](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:102)).

    The original intent explicitly required that the architecture not remain constrained to subscription authentication and might later support provider APIs, enterprise service accounts, self-hosted models, and other harnesses ([00 §Existing tools](/Users/davidtoniolo/Projects/Camino/docs/design/00-context-brief.md:77)). A self-hosted model may have no vendor harness. §9’s funded fallback is a contingency, not an execution abstraction covering those paths.

    **Verdict: FALSIFIED.**

28. **Out-of-band human repository work has no lifecycle.**

    Claim attacked: 08 claims to consolidate docs 02–05 and support multi-day durable missions ([08 opening](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:3)).

    The original brief preserves interactive Codex/Claude work for targeted changes ([00 §Human role](/Users/davidtoniolo/Projects/Camino/docs/design/00-context-brief.md:58)). If David edits an issue branch, mission branch, or main through another tool, 08 defines no event, contract invalidation, proof invalidation, or reconciliation path. The urgent lane handles only Camino-classified quick tasks; §4.4 reconciles unconfirmed Camino GitHub intents, not external edits.

    **Verdict: FALSIFIED.**

29. **The local command surface omits an entire attacker.**

    Claim attacked: the local GUI exposes plan and merge approval while the daemon holds the sole repository credential ([§8.1](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:128)).

    No local caller authentication, command authorization, origin/CSRF boundary, or operator identity is specified. Another local process or a malicious browser origin could attempt to invoke the credentialed daemon’s approval or merge commands. Because no implementation exists, actual exploitability cannot be probed.

    **Verdict: UNTESTABLE.**

30. **Repository-specific operational learning was silently dropped.**

    Claim attacked: the system supports an ongoing stream of missions against an evolving repository ([§1](/Users/davidtoniolo/Projects/Camino/docs/design/08-design-v2.md:7)).

    Historical design made build quirks, flaky-test knowledge, forbidden areas, and mission-type lessons persistent inputs to later attempts. In 08, context packs carry Canon requirements and status, while the outcome ledger carries metrics. Neither feeds discovered operational lessons into future workers.

    Failure sequence: attempt 1 discovers a required migration order or repository-specific test race → the immediate retry receives a handoff → a later mission receives no durable lesson and repeats the failure.

    **Verdict: OVERSTATED.**

## Round-1 corrections status

1. **Split desired-state Canon from as-built truth — PARTIALLY RESOLVED.** Statuses are separated, but revert, quarantine, `built` location, and dispute transitions can still present nonexistent behavior as verified.
2. **Prevent partial mission merges / add atomic integration and rollback — PARTIALLY RESOLVED.** Ordinary partial issue changes stay off main; stale-base integration, cross-issue semantic conflict, and rollback semantics remain open.
3. **Replace branch-scoped credentials with mediated Git and real isolation — PARTIALLY RESOLVED.** Worker GitHub credentials are gone; shared Git metadata, hooks, ancestry, submodules, and semantic scope remain uncontrolled.
4. **Idempotent reconciliation plus secrets/test environments — PARTIALLY RESOLVED.** The original lost-merge confirmation is reconcilable, but external idempotency, test-resource cleanup, and secret-bearing execution remain unsafe.
5. **Cut and revalidate v1 scope — RESOLVED.** The calendar claim is gone, major components are deferred, and later phases are measurement-gated.
6. **Measure worker, gate, and probe error rates before auto-merge — UNRESOLVED.** Cruise mode auto-merges immediately; 50 agreements are weak labels; probe false-negative measurement is absent.
7. **Demote learned routing, Canon/gap register, and market novelty — PARTIALLY RESOLVED.** Router Stage 3 and category novelty were narrowed; Canon/gap remain core v0 and their claimed demotion never occurred.
8. **Treat provider permission as contextual and time-varying — RESOLVED.** The source tension, personal-versus-distributed distinction, and funded-fallback prerequisite are represented honestly.

safe to build on: no — correct the validation-secret trust boundary; earned-versus-default auto-merge contradiction; Git mediation isolation; exact-tree evidence and merge freshness; Canon reverse transitions; mission rollback and urgent-rebase semantics; external idempotency and cleanup; planner challenge and canon-neutral classification; terminal-state reward and attention metrics; and the dropped human-edit, credential, and future-harness lifecycle requirements.

