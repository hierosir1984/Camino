# Camino — Adversarial Review, Round 5 (raw, verbatim)

> Reviewer: Codex `gpt-5.6-sol`, xhigh, read-only sandbox + web search. Run 2026-07-16 against [17-design-v5.md](17-design-v5.md). Verbatim and unedited. Verdict: **safe to build on: with corrections — blockers: none** (five deferrables). Clearance record: [19-review-round5-clearance.md](19-review-round5-clearance.md).

---

# Round 5 falsification verdict

No architectural blocker survived. V5 is safe to carry into a PRD, with five deferrable corrections.

## Findings

1. **The merge-by-push protocol omits the required-check handshake and overstates race rejection.**

   **Claim attacked:** [§4.2](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:74): “runs the gating validation at that SHA, records the verdict against it, then fast-forward pushes it”; “A raced ref advance makes the ff-push fail.” [§4.2](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:77) simultaneously requires non-bypass status checks.

   **Receipt/failure sequence:** Camino constructs merge commit M only locally → validates M and records Camino evidence → M has no GitHub status/check → GitHub rejects the protected-branch push because required checks must already be successful. Push-triggered Actions cannot satisfy the requirement afterward because the push never occurred. GitHub does support external commit statuses from fine-grained PATs and Apps, so this is compatible with the architecture once the immutable candidate exists remotely; that missing publication/attestation step is PRD protocol detail. [GitHub protected-branch requirements](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [commit-status API permissions](https://docs.github.com/en/rest/commits/statuses).

   Separately, ff-push is not an expected-old-SHA compare-and-swap: if the ref races from base B to H, where H is already a parent of M, pushing M remains fast-forward. That counterexample does not violate exact-bit safety, but falsifies the universal race sentence.

   **Severity: DEFERRABLE. Verdict: OVERSTATED.**

2. **Tier-4’s “no new intent” eligibility is not yet a non-creative, pre-approval check.**

   **Claim attacked:** [§8.3](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:168): “plan auto-approval only for plans that introduce no new intent.”

   **Receipt/failure sequence:** a planner labels a maintenance or gap-fix plan no-new-intent → Tier 4 approves it before implementation → §3.5’s deterministic triggers cannot inspect a diff that does not yet exist → reviewer concurrence is specified only for quick-task fold suppression, while cross-family review remains creative → the document supplies no testable pre-plan gate proving that a maintenance or gap-fix plan contains no semantic addition.

   This also overstates fidelity to the founding human role: the brief separately reserves “approving consequential architectural decisions” and “reviewing material risks.” A no-new-intent persistence or authentication redesign can still be consequential. [Original human-role requirements](/Users/davidtoniolo/Projects/Camino/docs/design/00-context-brief.md:45).

   The ledger nevertheless remains user-authoritative; this is an eligibility and escalation-boundary detail, not the round-4 intent-authority blocker.

   **Severity: DEFERRABLE. Verdict: UNTESTABLE for eligibility; OVERSTATED for the claimed human-role boundary.**

3. **The main-CI hardening assumes an unavailable protection on common personal private repositories.**

   **Claim attacked:** [§5.5](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:140): onboarding verifies that privileged main workflows keep secrets behind environments “with required reviewers.”

   **Receipt/failure sequence:** a personal private repository uses GitHub Pro or Team and has an existing privileged main workflow → GitHub environment secrets are available, but required reviewers are not available for private repositories on Free, Pro, or Team → onboarding cannot establish the stated protection. [GitHub environment availability](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

   This does not reopen T3: §5.3 now honestly prices the post-merge supply-chain consequence, and v1 itself needs no privileged workflow. The remaining gap is the supported-repository/onboarding boundary.

   **Severity: DEFERRABLE. Verdict: OVERSTATED.**

4. **GitHub does not immediately mark issue PRs merged when their heads land on a non-default mission branch.**

   **Claim attacked:** [§4.2](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:74): “GitHub marks them merged when their head lands.”

   **Receipt/failure sequence:** issue PR C targets `mission/<id>` → Camino pushes a merge commit containing C to that mission branch → C is reachable from its PR base, but GitHub limits indirect automatic merge recognition to commits reaching the repository’s default branch → the issue PR remains open until the mission reaches main, and can remain open indefinitely if the mission is abandoned. Mission PRs reaching default main do receive the claimed treatment. [GitHub indirect-merge semantics](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges#indirect-merges).

   Camino’s own event log does not depend on GitHub’s merged flag, so this affects PR lifecycle, linked-issue semantics, and displayed timestamps—not the merge architecture.

   **Severity: DEFERRABLE. Verdict: FALSIFIED.**

5. **Repo Canon can remain a stale projection between folds.**

   **Claim attacked:** [§3.1](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:31): “Canon text = the rendered projection of accepted intent”; after a revert or abandonment, “the next fold re-renders” it.

   **Receipt/failure sequence:** the user accepts requirement R → the control-plane ledger records R → its fold is abandoned or later reverted → until another fold occurs, repository Canon omits R; if no later mission occurs, that divergence is indefinite. Context packs remain correct because they render from the ledger, but humans or agents reading repository Canon directly can be misled.

   No implementation event mutates intent, and ExternalEdit deltas still require a user answer. The round-4 authority defect is therefore closed; only projection freshness remains.

   **Severity: DEFERRABLE. Verdict: OVERSTATED.**

## §13 and original-intent check

[§13’s registry](/Users/davidtoniolo/Projects/Camino/docs/design/17-design-v5.md:195) is **CONFIRMED** as specification detail; no blocker is hidden there. The GitHub App was correctly elevated out of the registry. Deployment remains legitimate future scope because the founding brief made it optional and explicitly allowed no automatic deployment initially. No other founding requirement was silently dropped.

## Round-4 corrections status

1. Post-merge supply-chain honesty and main-CI hardening — **RESOLVED:** T3 is fully priced; private-repository environment-reviewer availability is a deferrable onboarding constraint.

2. Intent ledger and rendered Canon — **RESOLVED:** only user actions mutate intent; repository projection lag is deferrable.

3. Exact-SHA merge operation — **RESOLVED:** merge-by-push is architecturally compatible; required-check attestation, race wording, and issue-PR lifecycle are deferrable protocol details.

4. Workflow dispatch idempotency — **RESOLVED:** lost-response ambiguity stops automatic retry, and GitHub workflow results are advisory rather than merge-authorizing.

5. App-before-autonomy branch integrity — **RESOLVED:** PAT training mode honestly uses detection plus human approval; every autonomy unlock requires a distinct App actor.

6. No-new-intent Tier-4 approval — **PARTIALLY RESOLVED:** the authority conflict is gone, but the eligibility and consequential-risk boundary remains untestable specification detail.

safe to build on: with corrections — blockers: none; deferrables: required-check attestation and race wording, Tier-4 eligibility and human-role boundaries, private-repository CI support, issue-PR merge-state handling, and Canon projection freshness

