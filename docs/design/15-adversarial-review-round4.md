# Camino — Adversarial Review, Round 4 (raw, verbatim)

> Reviewer: Codex `gpt-5.6-sol`, xhigh, read-only sandbox + web search. Run 2026-07-16 against [14-design-v4.md](14-design-v4.md) (frozen as reviewed). Verbatim and unedited. Verification: [16-review-round4-dispositions.md](16-review-round4-dispositions.md). Verdict: **safe to build on: no** — 6 blockers, 10 deferrables (2 round-3 blockers fully resolved); resolved in [17-design-v5.md](17-design-v5.md).

---

Verdict: v4 closes several round-3 defects, but six architectural blockers remain. The specific reachable-history publication attack and API-key custody contradiction are resolved; the design is not yet safe to turn into a PRD.

## Findings

1. **Worker-derived code regains privileged credentials after reaching `main`.**

   **Claim attacked:** §5.5: “Existing repo workflows that need broader rights run on main after merge — where every commit is Camino-authored and gated… This closes the round-3 hole.” §5.3 says T3 damage is bounded to disposable test assets. [§5.5](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:135), [§5.3](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:122)

   **Receipt/failure sequence:** a worker inserts a covert payload into allowed application, build, test, or package-script code → Camino reproduces the tree under a fresh Camino commit → a false-green T3 gate lets the mission reach `main` → an existing main workflow executes the same worker-derived bytes with broader repository, deployment, or secret access. Commit authorship changes provenance metadata, not the author or trustworthiness of executable content. GitHub warns that privileged workflows executing untrusted code can expose secrets and take over a repository. [GitHub secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use)

   A persistent self-hosted runner adds a second route: an ostensibly read-only worker-ref job can leave persistence for a later privileged main job. Also, `persist-credentials: false` removes checkout’s stored credential; it does not remove `github.token`, which actions can access implicitly.

   The T3 consequence therefore escapes the test tenant into repository/deployment authority. Accepting T3 for a personal tool is legitimate only after pricing that full consequence.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

2. **The “pure intent” Canon is still mutated by implementation success and rollback.**

   **Claim attacked:** §3.1: “Canon text = intent only”; “reverting a mission merge reverts its intent changes with it”; “Only user actions move intent-dispositions.” §4.2 repeats that rollback reverts the fold. [§3.1](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:26), [§4.2](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:71)

   **Receipt/failure sequence:** the user accepts requirement R → R’s fold and implementation merge together → production or later proof fails → the repair mission reverts the merge → the revert removes R from Canon although the user never descoped it. Camino must now either:

   - retain `accepted` for an ID absent from authoritative Canon text, creating split intent authority; or
   - remove/restore the disposition automatically because code failed, contradicting “only user actions” move it.

   An abandoned pre-merge mission has the same problem: already-accepted intent can disappear with its branch. Moving status outside Canon fixes the old fold-timing paradox, but pure desired intent cannot remain transactionally coupled to delivery.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

3. **Exact-SHA evidence is incompatible with the unspecified GitHub PR merge operation.**

   **Claim attacked:** invariant 7 says evidence binds to `(attempt, commit SHA, base SHA)` and expires rather than rebinding; §4.2 requires validation at exact heads; §7.2 repeats the binding. [Invariant 7](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:21), [§4.2](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:74), [§7.2](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:149)

   **Receipt/failure sequence:** issue head H is validated against mission base B → GitHub merges the PR → ordinary merge creates a new no-fast-forward commit M; squash and rebase also create new commit identities → only the fast suite runs on M, leaving requirement evidence attached to H. Later, full probes validate mission head M → merging to main creates another SHA N.

   The system must either rebind H/M evidence to M/N, mark target-branch evidence stale immediately after every merge, or revalidate post-merge. GitHub documents that default PR merge uses `--no-ff`, while rebase creates new SHAs. [GitHub merge-method documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/about-merge-methods-on-github)

   A direct fast-forward protocol or a different evidence identity could work, but v4 chooses neither.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

4. **Workflow `run-name` is correlation, not idempotency.**

   **Claim attacked:** §4.4: “`camino_intent_id` workflow input, surfaced via `run-name` templating… recovery lists runs and matches.” [§4.4](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:85)

   **Receipt/failure sequence:** Camino dispatches UUID U → GitHub accepts it → the response containing the new run ID is lost → recovery cannot obtain an atomic guarantee that no U run exists → retrying creates another valid run with the same input and display name. `run-name` is documented only as the displayed name; it has no uniqueness constraint. The dispatch API accepts `ref` and workflow-defined inputs, but no client idempotency key. [Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#run-name), [workflow-dispatch API](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10#create-a-workflow-dispatch-event)

   The single-writer lock prevents two local recoveries; it cannot deduplicate an already-accepted remote request. The table’s honest “at-most-once + escalation” fallback could handle this ambiguity, but the workflow row claims something stronger.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

5. **A personal PAT cannot enforce “Camino-only” pushes as a distinct actor.**

   **Claim attacked:** §4.2: “`mission/*` branches protected against non-Camino pushes”; §§5.1/8.1 specify a fine-grained PAT, while §13 parks GitHub App migration. [§4.2](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:76), [§5.1](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:111), [§13](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:193)

   **Receipt/failure sequence:** a PAT authenticates as its user. GitHub branch restrictions and rulesets distinguish users, teams, roles, deploy keys, and Apps—not David’s Camino PAT from David’s browser, SSH key, or another PAT. Classic branch restrictions also say administrators remain able to push. [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [ruleset actor model](https://docs.github.com/en/rest/repos/rules?apiVersion=2026-03-10)

   Main’s required-check non-bypass setting is configurable and can apply to administrators. The unsatisfied claim is the distinct Camino-only mission-branch actor. V4 also states strict required-up-to-date protection only for main, so a manual mission-branch advance can race an issue merge; GitHub’s merge API accepts expected PR-head SHA, not expected base SHA. [GitHub pull-request merge API](https://docs.github.com/en/rest/pulls/pulls)

   The architecture must choose a distinct App/machine identity or a fully PR-only, strict-check protocol for mission branches. “GitHub App later” is therefore a blocker parked as implementation detail.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

6. **Tier-4 plan auto-approval conflicts with user-only intent acceptance.**

   **Claim attacked:** §3.1: “Only user actions move intent-dispositions”; §3.5: “user confirms the requirement checklist diff”; §8.3 promises “plan auto-approval”; §1 says the ladder reaches interruption only for genuine escalations. [§3.1](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:31), [§3.5](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:50), [§8.3](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:163)

   **Receipt/failure sequence:** a creative planner compiles the PRD into canon deltas and contracts → tier 4 auto-approves the plan. If checklist confirmation remains mandatory, every mission still causes a routine interruption and the claimed end state has no path. If tier 4 auto-confirms the checklist, a non-user action accepts intent, contradicting §3.1 and invariant 6.

   A deterministic eligibility check can gate whether auto-approval is allowed, but it does not turn the planner’s semantic PRD mapping into a user action. The design must decide whether user checklist authority or hands-free plan acceptance wins.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

7. **Squash-and-rebuild closes history publication, but not the stated DoS variants.**

   **Claim attacked:** §5.1’s shallow final-head fetch, transfer/tree budgets, and mandatory archive of worker history. [§5.1](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:111)

   **Receipt/failure sequence:** depth-one fetch plus a fresh Camino commit genuinely prevents intermediate worker commits from becoming remotely reachable. That round-3 attack is closed.

   DoS remains: the worker creates gigabytes of intermediate objects, leaves a tiny final tree, and the mandatory audit archive retains the gigabytes. Separately, shallow depth limits ancestry, not final-tree blob expansion; a highly compressible giant blob or huge object count consumes resources before a post-fetch tree budget rejects it. Git exposes separate partial-fetch/blob filters for avoiding blob transfer. [Git fetch documentation](https://git-scm.com/docs/git-fetch), [fetch filtering](https://git-scm.com/docs/fetch-options)

   Workspace/archive quotas, expansion/process limits, object verification, and bounded retention are PRD safeguards.

   **Severity: DEFERRABLE. Verdict: OVERSTATED.**

8. **The derived tuple can still tell a branch reader that deleted implementation is present.**

   **Claim attacked:** §3.1 says implementation state is “derived from merge events,” external changes recompute it, and “Agents cannot be misinformed.” [§3.1](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:26)

   **Receipt/failure sequence:** R is implemented and verified on main → an external ordinary-source commit deletes R without changing Canon → there is no implementation merge event to reverse. §4.5 explicitly says the deletion produces `stale` evidence and a question, but it does not define an `absent` transition. The context tuple can therefore render `on-main; stale`, even though the implementation is gone.

   Semantic presence cannot be derived from merge lineage alone. An `unknown/suspected-absent` state and conservative invalidation rule fit the current architecture.

   **Severity: DEFERRABLE. Verdict: OVERSTATED.**

9. **Several remaining idempotency rows name locators or hygiene rather than complete reconciliation keys.**

   **Claim attacked:** the complete §4.4 table. [§4.4](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:85)

   **Receipt/failure sequences:**

   - Branch name is a natural key for creation, but not for a particular push; recovery also needs intended and observed SHAs.
   - PR head branch plus UUID substantially works for the current open PR, but closed/reused branches and edited bodies fall into ambiguity.
   - “Merged-ness of exact SHA” fails for squash/rebase; reconciliation needs PR identity and the merge result.
   - A comment can contain a UUID; a label association cannot. Label presence is naturally idempotent as `(object, label, desired state)`.
   - Reset-before-use is hygiene only for resettable tenant state. Consumed quota, sent webhooks/email, and other irreversible test-service effects remain ambiguous.

   The catch-all “at-most-once with human escalation” survives, provided ambiguity is durably recorded before any retry.

   **Severity: DEFERRABLE. Verdict: OVERSTATED.**

10. **Lease expiry is not an exclusivity or fencing mechanism.**

   **Claim attacked:** §4.6: “expired lease = attempt abandoned and cleaned,” “live lease = re-attach,” and the validation environment has “exactly one owner.” [§4.6](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:105)

   **Receipt/failure sequence:** attempt A’s daemon heartbeat stalls while its container remains active → A’s lease expires → recovery grants attempt B the environment → A performs a late write while B resets or validates. The database contains one owner, but the external resource has two active writers.

   The state lists also omit `blocked`, `escalated`, `descoped`, and cleanup-failed states that §1, §3.4, and §6 require. Kill-and-confirm ordering, lease generations/fencing, and those transitions belong in the deferred full table.

   **Severity: DEFERRABLE. Verdict: OVERSTATED.**

11. **Polling cannot cover every enumerated ExternalEdit transition.**

   **Claim attacked:** §4.5 says polling covers branch create/delete, PR changes, protection changes, and force pushes. [§4.5](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:99)

   **Receipt/failure sequence:** between polls, an actor changes ref A→B, triggers a remote workflow, and restores B→A. The next snapshot still sees A. Create-then-delete, PR-change-then-restore, and protection-off-then-on have the same blind spot. The remote side effect remains while Camino records no event.

   Stable observed external commits now have a sound intent-reconciliation path through user-confirmed proposed deltas. The remaining defect is the claim that snapshot polling detects transient transitions.

   **Severity: DEFERRABLE. Verdict: OVERSTATED.**

12. **The knowledge lifecycle does not define safe promotion or revision validity.**

   **Claim attacked:** §3.7: failed attempts write candidates immediately, approved entries enter packs, and therefore “a prompt-injected worker cannot poison future packs.” [§3.7](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:61)

   **Receipt/failure sequence:** failed attempt A discovers a required workaround → it remains a candidate unavailable to repair attempt B → B repeats the failure before fold/weekly curation. Alternatively, a branch-specific candidate is approved → the branch is abandoned or reverted → the entry has attempt/context provenance but no explicit commit/base validity and continues entering packs.

   Promotion authority is also unspecified. If the weekly batch is creative and automatic, invariant 2 is violated; if human, it remains routine attention. Candidate/approved is the right structure, but authority, retry-time transfer, and revision invalidation remain open.

   **Severity: DEFERRABLE. Verdict: OVERSTATED.**

13. **The 0/50 calculation is invalid for a rolling “wait until 50 consecutive successes” rule.**

   **Claim attacked:** §8.3: a rolling window of “≥50 consecutive agreements” gives “≈≤5.8% at 95% confidence.” [§8.3](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:163)

   **Receipt:** \(1-0.05^{1/50}=5.82\%\) is a fixed-sample binomial bound under a fixed failure probability. V4 repeatedly examines a rolling stream and unlocks when it encounters a qualifying run; that is a data-dependent stopping rule requiring sequential analysis. NIST distinguishes fixed binomial inference from sequential stopping procedures and states that the binomial model assumes fixed \(p\). [NIST binomial assumptions](https://itl.nist.gov/div898/handbook/eda/section3/eda366i.htm), [NIST sequential-testing discussion](https://nvlpubs.nist.gov/nistpubs/Legacy/IR/nistir6129.pdf)

   “Observed failure rate” is also exactly 0/50; 5.8% purports to bound an underlying probability.

   Distribution guards remain coarse: an unseen `(high-risk, auth, migration)` combination may pass because each individual tier, area, and template appeared somewhere in the window.

   **Severity: DEFERRABLE. Verdict: FALSIFIED.**

14. **The evidence packet’s binding and roll-up remain untestable without ordering and item-level identity.**

   **Claim attacked:** §7.2: “Per attempt and rolled up per mission… Bound to (attempt, commit SHA, base SHA).” [§7.2](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:149)

   **Receipt/failure sequence:** worker checks execute at worker head W → squash-and-rebuild creates C → later issue merges and final mission validation produce heads M and H against different bases. A rolled-up packet now contains several incompatible tuples. Commit-dependent behavior such as `git describe`, generated version strings, or history tests can differ between W and C even when their trees match.

   The claim survives only if worker-W evidence stays explicitly bound to W, all gating runs after C exists, and every packet item retains its own candidate/base identity beneath a separate mission-gate record. V4 does not state that ordering; §13 legitimately defers the schema.

   **Severity: DEFERRABLE. Verdict: UNTESTABLE.**

15. **Mission-terminal accounting fixes branch-success inflation but still misattributes issue outcomes.**

   **Claim attacked:** §6 says issue cost lands only at mission resolution and branch-only work in a doomed mission delivered “nothing.” [§6](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:139)

   **Receipt/failure sequence:** correct issue A merges; unrelated issue B sinks the mission → A receives the same zero-delivery outcome as B. In a `complete-with-residue` mission, some issues survive and others are removed, yet a single mission outcome does not identify which delivered.

   Separately, blocked-age “charges the abandonment penalty automatically” before actual abandonment, conflicting with terminal-only scoring unless this is defined as a one-shot provisional charge.

   **Severity: DEFERRABLE. Verdict: OVERSTATED.**

16. **The PRD registry contains one architectural deferral and omits several real specification residues.**

   **Claim attacked:** §12 says deferrables 8–17 are resolved; §13 characterizes its list as PRD detail. [§12](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:179), [§13](/Users/davidtoniolo/Projects/Camino/docs/design/14-design-v4.md:193)

   **Receipt:** retry bounds, path heuristics, attention numbers, transition tables, probe tooling, evidence schema, UI, scheduling, quota models, and adapter specifics are legitimate PRD work.

   GitHub App migration is not legitimate “later” work while v0 claims a distinct Camino-only push actor; that is blocker 5. Missing deferrables include lease fencing, knowledge-promotion authority and revision binding, sequential autonomy rules and joint-distribution guards, evidence-ordering semantics, worker/archive resource limits, and deployment/post-deployment proof as explicit future scope from the founding brief.

   **Severity: DEFERRABLE for registry completeness; the App item is the blocker already identified. Verdict: OVERSTATED.**

## Confirmed survivals

- §5.1’s specific intermediate-history publication attack is resolved by depth-one intake plus a new Camino-authored commit.
- §§5.2/9 now consistently distinguish official-harness subscription authentication from vaulted API-key custody.
- §4.5’s user-confirmed proposed-delta mechanism resolves the original external-edit intent-authority paradox for observed edits.
- §3.6 correctly demotes mutation testing from a false-negative estimator to probe-improvement tooling.
- Main-branch non-bypass protection is a real configurable GitHub control; the failure is the PAT-based “Camino-only” mission actor and missing strict mission-branch protocol.
- Most §13 entries are genuine PRD details, not disguised architecture.

## Round-3 corrections status

1. Remote-CI credential re-entry — **PARTIALLY RESOLVED:** worker-ref credentials are narrowed, but privileged main workflows execute the same worker-derived code.

2. Reachable-object quarantine smuggling — **RESOLVED:** worker ancestry no longer reaches the remote; residual resource exhaustion is deferrable.

3. Validation-oracle corruption / transformed exfiltration — **PARTIALLY RESOLVED:** T3 is acknowledged, but its consequence is not bounded to disposable test assets.

4. Canon branch/fold state model — **PARTIALLY RESOLVED:** the orthogonal tuple fixes the old enum/fold paradox, but implementation rollback still removes accepted intent and merge-derived presence can misstate external deletions.

5. ExternalEdit intent reconciliation — **PARTIALLY RESOLVED:** user-confirmed deltas fix intent authority, while snapshot polling still overclaims transition coverage.

6. Operation-specific idempotency — **PARTIALLY RESOLVED:** several natural keys are substantive, but workflow dispatch is only correlated and other rows remain under-specified.

7. API-key secret custody — **RESOLVED:** subscription authentication and user-supplied API-key custody are now internally consistent.

safe to build on: no — blockers: privileged main CI executes worker-derived code; pure-intent Canon is reverted with implementation; exact-SHA evidence lacks a compatible merge operation; workflow dispatch remains non-idempotent; a personal PAT cannot enforce Camino-only mission pushes; tier-4 plan approval conflicts with user-only intent acceptance. Deferrables: resource/DoS limits, derived-state unknowns, remaining reconciliation keys, lease fencing and state completion, polling limits, knowledge promotion/versioning, sequential autonomy statistics and guards, evidence schema/order, router attribution, and registry completeness.

