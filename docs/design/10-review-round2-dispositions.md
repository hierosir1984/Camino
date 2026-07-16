# Camino — Round-2 Review Dispositions (Claude's verification)

> 2026-07-16. Companion to [09-adversarial-review-round2.md](09-adversarial-review-round2.md). Verification tags as in round 1: **CONFIRMED** (reproduced by reasoning, re-derived math, or platform knowledge), **PLAUSIBLE** (post-cutoff receipt, cited, consistent). All 30 findings accepted; none dropped; two accepted with framing notes. Resolutions land in [11-design-v3.md](11-design-v3.md); the v3 section is listed per finding.

| # | Finding (short) | Sol | Mine | Resolution in v3 |
|---|---|---|---|---|
| 1 | Worker-authored code runs where test secrets are injected → exfiltration | FALSIFIED | CONFIRMED (classic pull_request_target-class defect) | §5.3: no-egress validation env, disposable rotated test-only secrets, artifact/log secret-scrubbing, validation-config changes force review; honesty note that blast-radius bounding replaces impossible perfect isolation |
| 2 | Cruise-mode auto-merge default contradicts earned autonomy | FALSIFIED | CONFIRMED | §4.2/§8.3 unified: training mode is the default; issue→branch auto-merge is the *first earned unlock*; "two approvals per mission" restated as earned steady state |
| 3 | Shared worktree .git metadata → worker hooks run under control-plane git | OVERSTATED | CONFIRMED (git worktrees share hooks/config) | §5.1: workers get isolated full clones; control plane fetches commits into a pristine hooks-disabled clone (quarantine flow), verifies ancestry + full-tree scope incl. submodule/symlink/.git-path guards, pushes from pristine clone only |
| 4 | Validated state ≠ merged state (freshness unbound) | OVERSTATED | CONFIRMED | §4.2: verdicts bind to (head SHA, base SHA); merges require branch-contains-current-main + green at exact head; GitHub required-up-to-date enforced; recursive rule for issue merges |
| 5 | "Rollback = revert one commit" false as guarantee | FALSIFIED | CONFIRMED | §4.2: revert-first *repair mission* type; canon status reversal wired (§3.1); external-state (migrations) checklist + escalation for unrevertable effects |
| 6 | No server-side idempotency for PR create / lost dispatch IDs / cleanup outside reconciliation | OVERSTATED | CONFIRMED | §4.4: intent UUIDs embedded in branch names/PR bodies as natural keys; single-writer recovery lock; reset-before-use replaces cleanup-after as primary; tenant janitor sweep |
| 7 | Canon status lacks reverse transitions (revert, stale evidence, built ambiguity, dispute dead-end) | FALSIFIED | CONFIRMED | §3.1: full state machine — verified requires live green evidence; stale evidence downgrades; revert → intended; built ≡ on main; disputed → resolved/assumed/descoped with user sign-off |
| 8 | Individually-validated issues can combine broken in the branch | OVERSTATED | CONFIRMED | §4.2/§4.3: post-merge fast suite on branch head after every issue merge; issue-merge freshness rule; final full probes; cross-family mission review retained |
| 9 | Urgent lane: boundary latency + rebase breaks evidence↔commit binding | FALSIFIED | CONFIRMED (00 required evidence bound to attempt+commit) | §4.2: merge-based sync (no rebase); evidence keyed to (attempt, SHA); urgent may cancel a looping attempt at checkpoint; semantic-impact revalidation |
| 10 | Cross-family plan challenge silently dropped | FALSIFIED | CONFIRMED (doc 02 had it; 08 lost it) | §4.1: restored — cross-family plan review before approval, risk-tiered |
| 11 | Canon-neutral label is single-point self-confirmation (+ probe contradiction) | FALSIFIED | CONFIRMED | §3.5: label provisional until diff exists; deterministic sensitive-path triggers reclassify; user-observable changes always get probes regardless of label |
| 12 | Plan-time resource declaration unenforceable | FALSIFIED | CONFIRMED (overclaim) | §5.3: declaration catches declarable subset; pre-mission environment preflight (boot + credential health); missing-resource failures classified infra-blocked |
| 13 | Interface-only invalidation misses semantic contract changes | OVERSTATED | CONFIRMED | §4.1: contract edits trigger planner semantic-impact assessment over dependents; conservative default = revalidate |
| 14 | Planners/reviewers are creative policy-definers; injection unaddressed | OVERSTATED | CONFIRMED | §2 invariant restated: no creative output becomes enforced policy without a human or deterministic gate; provenance-tagged context; red-team prioritized before hardening claims |
| 15 | Reward's terminal states wrong (reassigned isn't terminal; cancelled unpriced; penalty gameable) | FALSIFIED | CONFIRMED | §6: reward at *issue* resolution over full trajectory (merged / descoped / abandoned); edit-cancelled attempts excluded from model scorecards, included in mission economics; blocked-age tracked |
| 16 | 50-decision unlock implies unearned reliability (≤5.8% upper bound; weak labels; probe false-negatives unmeasured) | OVERSTATED | CONFIRMED (math re-derived: 1−0.05^(1/50)≈5.8%) | §8.3: bounds stated in-doc; unlocks staged (issue-tier first), post-merge outcomes as continuing labels, probe mutation testing estimates false-negatives, auto-revoke |
| 17 | Fold approval contradicts two-approval claim | FALSIFIED | CONFIRMED | §3.5: folds land as commits on the mission branch inside the mission PR (one approval covers both; revert reverts fold too); standalone fold PRs only from periodic audits |
| 18 | Attention accounting unreliable and gameable | OVERSTATED | CONFIRMED | §7: per-mission headline metric; dwell + weekly self-report correction; overrun responses include raising budget or pausing autonomy, not only tightening the classifier |
| 19 | v0 probes can't ground per-requirement `verified` | FALSIFIED | CONFIRMED | §8.1: v0 statuses cap at built + mission-checked; verified only with requirement-mapped checks; coverage metric explicitly grows with the probe suite |
| 20 | Non-behavioral requirements lack status path ("unmeasured" undefined) | OVERSTATED | CONFIRMED | §3.2: per-requirement verification-method attribute (probe / audit / planner-check / none); "must not change" constraints get diff-time guards; enforcement honesty per class |
| 21 | Fine-grained PAT sufficient for the narrow personal flow | CONFIRMED | CONFIRMED | §5.1 keeps PAT; org-policy caveats noted |
| 22 | v1 scope cut survives | CONFIRMED | — | Kept |
| 23 | Provider-policy posture survives | CONFIRMED | — | Kept |
| 24 | Retained market facts reproduce | CONFIRMED | — | Kept |
| 25 | "Integration unclaimed" still a universal negative | UNTESTABLE | CONFIRMED as caveat | §10: scoped to "within the assessed set" |
| 26 | "Never handles credentials" contradicts mounting auth into sandboxes | FALSIFIED | CONFIRMED (wording) | §9: precise claim — Camino composes sandboxes referencing host credential state; never reads, stores, or transmits secrets itself; distribution requires compliance pass |
| 27 | "Official harnesses only" dropped 00's API/self-hosted requirement | FALSIFIED | CONFIRMED (drafting error) | §5.2: worker backends are adapters — official-CLI (subscription), API-key (incl. self-hosted/OpenAI-compatible endpoints), future harnesses; subscription auth only ever via official CLIs |
| 28 | Out-of-band human edits have no lifecycle | FALSIFIED | CONFIRMED (doc 01 §3 had it; consolidation lost it) | §4.5 (new): ExternalEdit events from the poller; branch-specific policies (pause issue, impact assessment, revalidate); David's direct edits are recorded, first-class events |
| 29 | Local daemon surface has no caller authentication | UNTESTABLE | CONFIRMED as design gap | §8.1: binds 127.0.0.1 only, token-authenticated API (0600 file), CSRF protection, stated single-OS-user trust model |
| 30 | Per-repo operational knowledge silently dropped | OVERSTATED | CONFIRMED (docs 01/03 had it) | §3.7 (new): `.camino/knowledge.md` per repo — operational lessons appended post-attempt, curated at folds, included in context packs |

## Round-1 corrections status (Sol's assessment, accepted)

Resolved: scope cut (5), provider policy (8). Partially resolved: canon split (1), partial-merge prevention (2), git mediation (3), idempotency/secrets (4), demotions (7). Unresolved: error-rate measurement before auto-merge (6). All partials and the unresolved item are re-addressed in v3 as mapped above.

## Bottom line

Sol's verdict, verbatim: **"safe to build on: no — correct the validation-secret trust boundary; earned-versus-default auto-merge contradiction; Git mediation isolation; exact-tree evidence and merge freshness; Canon reverse transitions; mission rollback and urgent-rebase semantics; external idempotency and cleanup; planner challenge and canon-neutral classification; terminal-state reward and attention metrics; and the dropped human-edit, credential, and future-harness lifecycle requirements."**

All corrections accepted and folded into [11-design-v3.md](11-design-v3.md). Round 3 required before the record is cleared for a PRD.
