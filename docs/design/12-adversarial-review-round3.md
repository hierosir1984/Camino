# Camino — Adversarial Review, Round 3 (raw, verbatim)

> Reviewer: Codex `gpt-5.6-sol`, xhigh, read-only sandbox + web search. Run 2026-07-16 against [11-design-v3.md](11-design-v3.md) (frozen as reviewed). Verbatim and unedited. Claude's verification: [13-review-round3-dispositions.md](13-review-round3-dispositions.md). Verdict: **safe to build on: no** — 7 blockers, 10 deferrables; resolved in [14-design-v4.md](14-design-v4.md).

---

## Findings

1. **Remote CI restores repository credentials to worker-authored code.**

   **Claim attacked:** §2 says “no creative process … holds repository credentials,” and §5.1 says “Credentialed git never executes inside anything a worker has touched.” [§2](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:16), [§5.1](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:102)

   **Receipt/failure sequence:** the worker changes an allowed `Makefile`, test helper, package script, build plugin, or checked-in action → the pristine clone accepts and pushes it → unchanged same-repository GitHub Actions checks out and executes it. `actions/checkout` persists `${{ github.token }}` by default specifically so later scripts can run authenticated Git commands. This happens before issue-merge approval. Protecting workflow YAML does not protect every file the workflow executes. GitHub also warns that executing untrusted checked-out code in a privileged workflow can expose tokens and secrets. [actions/checkout](https://github.com/actions/checkout), [GitHub secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use#mitigating-the-risks-of-untrusted-code-checkout)

   **Severity: BLOCKER. Verdict: FALSIFIED.**

2. **The quarantine’s final-tree check permits forbidden history and object smuggling.**

   **Claim attacked:** §5.1 verifies ancestry and “full-tree diff scope” before pushing. [§5.1](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:101)

   **Receipt/failure sequence:** from assigned base `B`, the worker creates commit `U` containing a credential, forbidden CI file, or gigabytes of blobs → creates head `H` that deletes those entries and leaves one permitted tree change → `B` is an ancestor of `H`, and the final `B..H` tree diff is clean → fetching `H` nevertheless imports `U` and its objects; pushing `H` makes that history reachable remotely. A merge commit whose second parent contains arbitrary foreign history is the same attack.

   Git fetch downloads objects needed to complete the requested history; Git’s reachability model follows all parent edges. [Git fetch](https://git-scm.com/docs/git-fetch), [Git rev-list](https://git-scm.com/docs/git-rev-list.html)

   This enables credential publication, repository-history pollution, and disk/CPU denial of service before the stated tree checks can reject anything.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

3. **“Disposable test secrets” do not contain corruption of the proof oracle.**

   **Claim attacked:** §5.3 says the design “bounds and detects,” calls a leaked test credential “contained … by construction,” and says scrubbing, no-egress, and config-diff review protect validation. [§5.3](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:111)

   **Receipt/failure sequence:** ordinary allowed application code—not a boot/config/manifest change—reads secret `S` during validation → emits Base64, reversed, chunked, encrypted, or derived forms into repair output or retained evidence → literal secret-pattern scrubbing misses it. GitHub explicitly says automatic redaction is not guaranteed under transformations and transformed values must be registered separately. [GitHub secret-redaction guidance](https://docs.github.com/en/actions/reference/security/secure-use#use-secrets-for-sensitive-information)

   Alternatively, the code writes the value or destructive state through an explicitly allowlisted test-service endpoint. Destination allowlisting does not constrain legal operations or data fields at that destination, and local artifact scrubbing does not cover remote tenant state or logs.

   Production access is genuinely excluded, but the leaked credential remains usable until scheduled rotation and can poison shared fixtures, exhaust quota, race later probes, or manufacture false-green/false-red evidence. Human review of validation-config diffs does not catch the ordinary source-code path.

   **Severity: BLOCKER. Verdict: OVERSTATED.**

4. **The Canon state model still cannot represent the truth it promises agents.**

   **Claim attacked:** §3.1 defines one status enum, a separate “present on this mission branch” flag, and concludes that agents are “never fed an unbuilt or no-longer-verified feature as an existing, working one.” [§3.1](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:27)

   **Receipt/failure sequences:**

   - Requirement R is `verified` on main → issue A changes R on a mission branch → only the fast suite runs after A merges → issue B receives `verified + present-on-branch`, although the branch version of R has never passed R’s full probe.
   - The single enum cannot represent “intent disputed but implementation verified,” or “descoped from intent but code still present.” Intent disposition and implementation/evidence state are orthogonal.
   - `assumed` and `resolved` are named as exits from `disputed` but are not statuses and have no subsequent transition or coverage semantics.
   - Reverting a mission that changed an already-verified requirement blindly moves it to `intended`, rather than restoring the prior requirement version and status.
   - Fold timing is internally impossible: if the fold commits `built`/`verified` before the mission reaches main, the status is false on the branch; if status changes only after merge, that Canon update is not inside the mission PR as §3.5 claims. An external status overlay would require a separate reversal lifecycle that v3 does not specify.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

5. **`ExternalEdit` detects commits but does not reconcile intent or Canon truth.**

   **Claim attacked:** §4.5 says interactive changes are first-class, normal, auditable interventions. [§4.5](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:94)

   **Receipt/failure sequence:** David interactively adds or removes user-visible behavior on main → the poller records the commit and syncs active mission branches → no PRD delta, requirement checklist, contract, probe ownership, fold, or Canon transition is created. Leaving the Canon untouched makes it stale; deriving a fold from the diff violates invariant 6, which says Canon updates never derive from implementation diffs. [Invariant 6](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:20)

   A deletion is worse: a `verified` requirement eventually downgrades only to `built`, while a v0 requirement without a mapped probe may remain `built` indefinitely even though its implementation disappeared.

   “All interventions are recorded” also exceeds the detector: PR retargeting, PR-body edits that remove UUIDs, branch deletion, force-pushes, CI cancellation, manual merges, and protection-rule changes are not non-Camino commits.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

6. **Embedded UUIDs still do not reconcile every external side effect.**

   **Claim attacked:** §4.4 says side-effecting operations embed their UUID in the external artifact and recovery finds that artifact under a single-writer lock. [§4.4](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:90)

   **Receipt/failure sequence:** Camino dispatches a workflow → GitHub accepts it and creates a run → the response containing the run ID is lost → recovery acquires the lock. A workflow dispatch accepts only `ref` and inputs predefined by that repository’s workflow; v3 does not require a UUID input or UUID-bearing run name. Recovery therefore cannot distinguish the accepted run from other runs on the same ref, and a retry can duplicate it. [GitHub workflow-dispatch API](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10#create-a-workflow-dispatch-event)

   The single-writer lock serializes recovery processes; it cannot serialize recovery against an already accepted remote request. Branch names and PR bodies are real natural keys for those artifact classes, but PR bodies are mutable and the mechanism does not generalize to workflow dispatch, opaque test-service mutations, or other APIs without client metadata.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

7. **API-key backends contradict the provider-secret boundary.**

   **Claims attacked:** §5.2 promises “API-key backends,” including OpenAI-compatible and self-hosted endpoints, while §9 says Camino “never reads, stores, or transmits provider secrets itself.” [§5.2](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:107), [§9](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:151)

   **Receipt/failure sequence:** configure the promised API-key adapter → the adapter must obtain the key and inject it into a process or transmit it in an authenticated request → Camino reads or transmits a provider secret. If an unstated external secret broker performs those actions, that is a missing architectural boundary, not support for the current absolute claim.

   **Severity: BLOCKER. Verdict: FALSIFIED.**

8. **Freshness is safe only under unstated GitHub configuration and has no liveness policy.**

   **Claim attacked:** §4.2 says recursive freshness plus required-up-to-date protection guarantees “What was validated is what merges,” and that post-merge fast suites surface cross-issue breakage at the causative merge. [§4.2](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:77)

   **Receipt/failure sequences:**

   - The GitHub merge API can require the PR head SHA but has no expected-base-SHA parameter. A control-plane check against base `M0` can race main advancing to `M1`. [GitHub merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)
   - Strict required-up-to-date protection closes that race only when configured on every relevant target branch and made non-bypassable. GitHub protections do not apply to administrators by default—the natural identity behind a personal-repo PAT. V3 does not require non-bypass rules or strict protection on ephemeral `mission/*` branches. [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
   - If main or the mission branch advances faster than full validation completes, recursive exact-base validation starves indefinitely. GitHub itself notes strict checks require more builds and provides merge queues for busy targets; v3 defines neither a queue nor a quiescence/starvation rule.
   - “Scoped revalidation” after a main sync cannot preserve an old verdict’s `(commit SHA, base SHA)` binding. Either the old evidence is stale or it is being rebound without execution.
   - Build/unit/smoke cannot guarantee that authorization, migration, performance, or end-to-end semantic breakage surfaces immediately. Such failures can still wait for the final full probe suite.

   **Severity: DEFERRABLE. Verdict: OVERSTATED.**

9. **Protected-path semantics are undefined across filesystem normalization and tracked Git attributes.**

   **Claim attacked:** §5.1 says full-tree checking protects `.git*`, CI, and `.camino/` validation paths. [§5.1](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:101)

   **Receipt/failure sequence:** Git’s tree is case-sensitive, while the default macOS filesystem is case-insensitive and Unicode-normalizing → `.CAMINO/validation.yml` or normalization-colliding paths are distinct to a raw matcher but collide when checked out through a host-backed container volume. Windows reserved-name and trailing-dot aliases are the distribution variant.

   A changed `.gitattributes` can also assign existing clean/smudge filters or working-tree encodings to new paths, making the pristine clone’s view differ from the user’s configured checkout. V3 neither protects `.gitattributes` nor defines canonical path identity or collision rejection. Without implementation, exploitability is not probeable.

   **Severity: DEFERRABLE. Verdict: UNTESTABLE.**

10. **Canon-neutral classification still controls folds through an unguarded semantic judgment.**

   **Claim attacked:** §3.5 says deterministic path triggers prevent classification self-confirmation and that “any user-observable change gets a probe” independently of the label. [§3.5](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:55)

   **Receipt/failure sequence:** a quick task changes a visible default, timeout, ordering rule, or error response in an ordinary source file → the planner calls it internal/canon-neutral → no sensitive-path trigger fires → a small task may skip the risk-tiered cross-family challenge → no probe is authored if the same planner failed to recognize observability → the PR goes directly to main.

   Even if a probe is created, the neutral label still suppresses the fold, leaving the Canon stale for genuinely new behavior. The correction removed dependence on one label for probes but retained a creative semantic judgment for observability and fold necessity.

   **Severity: DEFERRABLE. Verdict: OVERSTATED.**

11. **The stated 50-agreement bound does not apply to future repo work.**

   **Claim attacked:** §8.3 says 50 consecutive human agreements bound the “true failure rate” to ≤5.8% and justify repo-wide tier-1 auto-merge through containment. [§8.3](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:146)

   **Receipt:** the arithmetic is correct only for stationary, identically distributed Bernoulli trials with meaningful failure labels: \(1-0.05^{1/50}=5.82\%\). The workload is selected, heterogeneous, version-changing, and labeled by human agreement—which v3 itself admits is weak. Fifty easy changes do not bound failure on the next auth, migration, concurrency, or architectural issue.

   **Failure sequence:** easy work fills the window → tier 1 unlocks repo-wide → a distributionally different issue false-approves into the mission branch → later issues build on and rationalize the poisoned premise → the final failure is no longer cleanly attributable to the originating issue. Main is contained, but mission work, quota, calibration data, and human attention are not.

   **Severity: DEFERRABLE. Verdict: OVERSTATED.**

12. **Mutation score is not a probe false-negative-rate estimator.**

   **Claim attacked:** §3.6 says mutation testing “doubles as the probe false-negative estimator”; §8.3 makes that estimate a tier-2 prerequisite. [§3.6](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:60), [§8.3](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:146)

   **Receipt/failure sequence:** probes kill all generated branch/arithmetic mutants → the selected mutation score is high → the operators never generate authorization-role interactions, stale-cache behavior, migration-state faults, or third-party protocol errors → probes still false-approve those real defects.

   Empirical research finds mutation score useful for improving tests but weakly correlated with real-fault detection after controlling for test-suite size; it is not a calibrated estimate of future false-negative probability. [ICSE empirical study](https://pure.kaist.ac.kr/en/publications/are-mutation-scores-correlated-with-real-fault-detection-a-large-/)

   **Severity: DEFERRABLE. Verdict: FALSIFIED.**

13. **`.camino/knowledge.md` is a filename, not yet a trust lifecycle.**

   **Claim attacked:** §3.7 says discoveries are “appended by attempts,” “curated at folds,” and included in every context pack. [§3.7](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:64)

   **Receipt/failure sequence:** a failed or prompt-injected attempt records that an important auth test is flaky or a required directory is forbidden. If the entry becomes immediately readable, unapproved worker-authored instruction poisons later context packs, contradicting invariant 2. If it waits for a fold, failed and abandoned attempts lose the lesson. If it remains only in the worker clone, it is not persistent.

   No candidate/approved distinction, provenance, confidence, scope, expiry, contradiction handling, revert semantics, or stale-entry lifecycle selects among those outcomes.

   **Severity: DEFERRABLE. Verdict: OVERSTATED.**

14. **Mission, issue, and attempt durability still lack an authoritative transition model.**

   **Claim attacked:** v3 names durability as one of five load-bearing failure points, yet its “real state machine” covers Canon requirements only. [§1](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:9), [§3.1](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:25)

   **Receipt/failure sequence:** the daemon crashes while a worker is claimed/running, while an ExternalEdit pause races validation completion, or after a gate passes but before an issue transition records → restart has no specified attempt lease, process/container identity, legal transition, or rule determining resume versus duplicate versus cancel. The UUID protocol for external artifacts does not define internal workflow state.

   V3 also silently drops the earlier v1 serialization posture. Concurrent validators can therefore reset or clean the same per-repo test tenant while another probe is running, and the janitor can race an active attempt. The founding brief explicitly required durable issue states and auditable transitions. [Original durable-state requirement](/Users/davidtoniolo/Projects/Camino/docs/design/00-context-brief.md:299)

   **Severity: DEFERRABLE. Verdict: OVERSTATED.**

15. **The router still rewards intermediate branch success as terminal delivery.**

   **Claim attacked:** §6 resolves an issue trajectory when it reaches `merged`, `descoped`, or `abandoned`, and says tracking blocked age prevents hopeless work hiding from the abandonment penalty. [§6](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:126)

   **Receipt/failure sequence:** issue A merges into the mission branch → router records terminal success → another issue exposes A’s incompatibility → the mission is abandoned or A is reverted → A remains a successful `merged` trajectory even though it never delivered to main and helped sink the mission.

   Separately, merely recording blocked age does not charge the abandonment penalty or force termination. Hopeless work can still remain blocked indefinitely without the stated penalty.

   **Severity: DEFERRABLE. Verdict: FALSIFIED.**

16. **The claimed autonomy end state has no path through the defined tiers.**

   **Claim attacked:** §1 says “Interrupted only by genuine escalations” is the roadmap’s end. [§1](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:11)

   **Receipt:** §8.3 defines autonomy only for issue→branch and mission→main merges. Plans still require user approval, quick tasks always require approval, validation-config diffs require review above training mode, disputed Canon entries require answers, and periodic audits generate standalone fold PRs. [§4.1](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:70), [§4.2](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:81), [§7](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:130)

   Unlock both documented tiers → submit an ordinary mission or quick task → routine approval still interrupts. The “two approvals” count also excludes disputed-Canon, config-diff, and periodic-audit approvals.

   The attention system calls something a “budget overrun” but defines no budget threshold, cumulative training ceiling, or experiment stop condition.

   **Severity: DEFERRABLE. Verdict: OVERSTATED.**

17. **The original evidence packet has been reduced to scattered references.**

   **Claim attacked:** §1 claims demonstrable satisfaction and invariant 7 binds evidence to SHAs, but v3 specifies no evidence-packet lifecycle or operator surface. [§1](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:7), [Invariant 7](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:21)

   **Receipt/failure sequence:** several checks and reviewers produce a gate verdict → the GUI shows merge approval → no designed object binds contract version, requirement mapping, commands, artifacts, exclusions, retries, and verdict into one inspectable record. The v0 GUI contains a board, approvals, and escalation inbox, but no evidence viewer. [§8.1](/Users/davidtoniolo/Projects/Camino/docs/design/11-design-v3.md:136)

   The founding brief explicitly placed evidence-packet generation in the execution loop and associated it with mission, slice, attempt, commit, and PR. [Original evidence requirement](/Users/davidtoniolo/Projects/Camino/docs/design/00-context-brief.md:225)

   **Severity: DEFERRABLE. Verdict: OVERSTATED.**

## Round-2 corrections status

1. **Validation-secret trust boundary — PARTIALLY RESOLVED.** Production credentials are honestly excluded, but transformed exfiltration, allowlisted dead drops, shared-tenant corruption, and false proof remain.

2. **Earned-vs-default auto-merge contradiction — PARTIALLY RESOLVED.** Training mode is now consistently the default; the 50-label inference and tier-1 containment rationale remain unsound.

3. **Git mediation isolation — PARTIALLY RESOLVED.** Shared-worktree hooks are genuinely closed; reachable-history smuggling and credentialed remote CI remain open.

4. **Exact-tree evidence and merge freshness — PARTIALLY RESOLVED.** SHA/base binding is real, but non-bypass protection, issue-target protection, scoped-revalidation semantics, and liveness are missing.

5. **Canon reverse transitions — PARTIALLY RESOLVED.** Stale probes and simple new-feature reverts gained transitions; branch-relative truth, orthogonal states, prior-version restoration, ExternalEdits, and `assumed` remain unresolved.

6. **Mission rollback and urgent-rebase semantics — RESOLVED.** Rebase-based proof breakage is removed, and rollback is now honestly a repair mission with explicit escalation for unrevertable effects.

7. **External idempotency and cleanup — PARTIALLY RESOLVED.** Branch/PR keys and reset-before-use are substantive; workflow dispatch, mutable keys, opaque external mutations, and concurrent environment ownership remain unreconciled.

8. **Planner challenge and canon-neutral classification — PARTIALLY RESOLVED.** Cross-family challenge is restored and path triggers help, but small-task challenge selection, user-observable classification, and fold suppression remain creative bypasses.

9. **Terminal-state reward and attention metrics — PARTIALLY RESOLVED.** Per-mission proxy accounting is more honest, but branch merge is still treated as terminal delivery, blocked-age does not impose a penalty, and no attention threshold exists.

10. **Dropped human-edit, credential, and future-harness lifecycles — PARTIALLY RESOLVED.** Adapters and commit detection exist; API-key custody contradicts the secret claim, and ExternalEdit lacks intent/Canon reconciliation. Repository knowledge and evidence persistence remain only named.

safe to build on: no — blockers: remote-CI credential re-entry, reachable-object quarantine smuggling, validation-oracle corruption, the Canon branch/fold state model, ExternalEdit intent reconciliation, operation-specific idempotency, and API-key secret custody; deferrables: freshness configuration/liveness, path normalization and attributes, semantic classification, autonomy statistics and mutation calibration, knowledge and execution-state lifecycles, router/attention semantics, and evidence packets.

