# Camino — Round-5 Clearance Record

> 2026-07-16. Companion to [18-adversarial-review-round5.md](18-adversarial-review-round5.md). **The design record is cleared for a PRD.**

## Sol's verdict, verbatim

> **"safe to build on: with corrections — blockers: none; deferrables: required-check attestation and race wording, Tier-4 eligibility and human-role boundaries, private-repository CI support, issue-PR merge-state handling, and Canon projection freshness"**

Round-4 corrections status per Sol: five of six **RESOLVED**, one (tier-4 eligibility) **PARTIALLY RESOLVED** with the residue explicitly classified as specification detail. §13's registry confirmed as genuine PRD detail with no hidden blockers; no founding-brief requirement remains silently dropped.

## Verification of the five deferrables (all accepted)

1. **Required-check attestation + race wording** — CONFIRMED. A protected-branch push needs the required check green on the SHA *before* the push, and ff-success is not a base-equality guard. Fixed directly in [17-design-v5.md](17-design-v5.md) §4.2 (temporary-ref publication + commit-status attestation; explicit base check); protocol detail registered.
2. **Tier-4 eligibility needs a non-creative gate** — CONFIRMED. Registered with a concrete proposal: eligibility = plan references only pre-existing accepted requirement IDs and proposes no ledger additions (deterministically checkable), plus an escalation class for consequential architectural decisions, honoring the founding brief's reserved human roles.
3. **Private-repo environment required-reviewers unavailable on Free/Pro/Team** — PLAUSIBLE (platform constraint, cited). Registered as an onboarding boundary: warn, relocate secrets, or record accepted risk.
4. **Issue PRs on mission branches aren't auto-marked merged** — PLAUSIBLE (GitHub recognizes indirect merges only into the default branch). Fixed in §4.2 wording: Camino closes issue PRs itself with linkage metadata; registered.
5. **Canon text can lag the intent ledger between folds** — CONFIRMED (an accepted consequence of the projection architecture; context packs are always ledger-fresh). Registered: rendered-at marker + divergence-triggered intent-only fold; GUI renders from the ledger.

## Process summary

Five falsification rounds by a non-Claude reviewer (Codex gpt-5.6-sol, xhigh), every raw review preserved verbatim, every finding independently verified before acceptance, zero findings dropped:

| Round | Target | Findings | Verdict |
|---|---|---|---|
| 1 | docs 00–05 | 38 | with corrections |
| 2 | design v2 (08) | 30 | no |
| 3 | design v3 (11) | 17 (7 blockers) | no |
| 4 | design v4 (14) | 16 (6 blockers) | no |
| 5 | design v5 (17) | 5 (0 blockers) | **with corrections — blockers: none** |

Major architecture that exists *because* of this process: the mission integration branch with merge-by-push and SHA-bound evidence; squash-and-rebuild quarantine (invariant 8); the intent ledger with canon text and status as projections; the explicit three-tier secrets threat model with post-merge supply-chain honesty; the idempotency contract table; ExternalEdit reconciliation through user-confirmed intent deltas; fenced leases; staged, App-gated, statistically-honest earned autonomy; and the restored evidence packet.

**Status: [17-design-v5.md](17-design-v5.md) is the cleared, authoritative design. The PRD lives at [docs/PRD.md](../PRD.md) (drafted 2026-07-16).**
