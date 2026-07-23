# Quarantine module — WP-108 (CAM-EXEC-04)

Squash-and-rebuild intake at product grade, **replacing the WP-003 prototype**
(`spikes/quarantine`, closed #5). The control plane shallow-fetches only the
worker's final head into a pristine, hooks-disabled clone; runs the full policy
check-list on the final tree within registry-item-11 fetch budgets; and, for a
clean tree, re-authors a **fresh Camino-authored commit** applying that tree
onto the assigned base with a worker-attribution trailer. Worker history never
crosses the boundary; worker merge commits are rejected outright.

The pieces:

| File                                         | What it does                                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`intake.ts`](intake.ts)                     | `runIntake` — shallow-fetch → merge-commit check → `git fsck` → fetch-budget + policy checks → squash-rebuild → emit the quarantined diff.                                                                          |
| [`policy.ts`](policy.ts)                     | The pure policy checks (collect-all): scope vs contract, protected paths, canonical path identity (ICU fold), reserved/trailing-dot/`.git` aliases, symlink targets, submodule/gitlink block, tree + fetch budgets. |
| [`git.ts`](git.ts)                           | Credential-free, hooks-disabled git plumbing, run only in the pristine repo (the worker repo is a fetch source, never a working dir a git command runs in).                                                         |
| [`workflow-posture.ts`](workflow-posture.ts) | The candidate-ref CI-posture analyzer (WP-003 case 13, CAM-SEC-03) — carried forward verbatim; **enforcement home is WP-118**.                                                                                      |
| [`corpus*.ts`](corpus.test.ts)               | The WP-003 rejection corpus, unchanged, now driving the product module — its acceptance gate.                                                                                                                       |

The emitted **quarantined diff** schema + validator live in
[`@camino/shared`](../../../shared/src/quarantine-diff.ts) (a named cross-WP
artifact, alongside the WP-110 contract schema): produced here, consumed by
**WP-111** (deterministic re-classification on the final diff paths) and
**WP-116** (evidence bound to the candidate identity — `candidateSha`,
`baseSha`).

## Contract binding — what the frozen contract does and does not carry

The AC says checks run "against the issue's frozen contract (from WP-110)." The
frozen `IssueContract` (`ContractTerms`) is a **closed, hashed** schema — it
carries the acceptance criteria, requirement ids, dependencies, and declared
interfaces, but **neither a path-scope nor the assigned base**: those are
dispatch/assignment facts, not hashed terms. So the intake takes them as the
`QuarantineAssignment` (`base`, `allowedPaths`, tree `budgets`), and the frozen
contract binds the intake's **output**: the assignment carries a `ContractRef`
(issueId + version + hash) that is stamped onto the emitted diff (CAM-PLAN-04),
so every downstream artifact resolves to the exact approved contract without a
store lookup. The `ContractRef` never drives a policy decision — it is identity,
not scope.

## Boundaries (stated, not hidden)

- **Canonical path identity uses ICU for the case fold; the residual is named.**
  Collision keys compose NFKC + two documented compatibility folds (`ß`→`ss`,
  final sigma `ς`→`σ`) and are grouped by an ICU `Intl.Collator` at
  `sensitivity: "accent"` — case-insensitive, accent-**preserving**, so
  `Config.txt`⇄`config.txt` and `straße`⇄`STRASSE` collide while a legitimately
  distinct `café.txt` and `cafe.txt` do not. JavaScript does not expose ICU's
  full `u_strFoldCase`, so this is **not** a byte-exact model of every
  filesystem's own fold table; it errs toward collapsing (a false collision
  over-rejects — the safe direction; a miss would be a missed collision, never
  an accept of something worse). Exotic cross-script confusables a complete fold
  table would collapse may slip. This is the WP-003 "name the boundary" lesson,
  carried forward with the fold strengthened from the spike's hand-rolled list
  to ICU collation.
- **The malformed-object/path class is delegated to `git fsck`**, far more
  complete than any hand-rolled parser (`.git` equivalents incl. HFS-ignorable
  characters, mode/type mismatches, broken links). Our own checks add only the
  cross-platform aliases git _permits_ (`GIT~1`, case-spelled protected paths,
  trailing-dot names, NTFS ADS spellings). We fsck the **tree**, not the commit,
  to avoid the shallow-graft parent boundary.
- **"Credentialed git never executes in worker-touched directories" is
  structural.** Every intake git call runs with a credential-free, hooks-disabled
  env (no GitHub PAT; host global/system config neutralized to `/dev/null`; no
  interactive prompt), and git executes **only** in the Camino-owned pristine
  repo — the worker repo is read solely by fetching from it. A config-based exec
  channel a worker sets in its own clone (e.g. `uploadpack.packObjectsHook`) can,
  at most, run **credential-free** inside the worker's own already-untrusted,
  host-`HOME`-less container (WP-107); the guarantee is that no credential exists
  there to leak, not an exhaustive serving-side config denylist — the same
  unbounded-config-surface boundary WP-107's `clone.ts` names.
- **The registry-item-11 fetch budget is an ADMISSION check.** It caps the
  shallow-fetch footprint (≤5,000 objects / ≤500 MB, from the one
  `@camino/shared` source) and refuses to squash-rebuild an over-budget
  candidate, discarding the pristine store. It is computed after the **local**
  fetch from the worker's already-bounded (≤2 GB workspace) isolated clone
  completes; a pre-transfer/network ceiling is bounded out-of-process by the
  WP-107 container + WP-114 supervisor — the same in-process-best-effort /
  out-of-process-authoritative split WP-107 states. It is distinct from, and
  applied alongside, the per-issue tree-size **policy** budget.
- **The workflow-posture analyzer is heuristic and its home is WP-118.** It is
  the WP-003 spike's analyzer verbatim (3 falsification rounds), carried forward
  so the entire corpus runs green here. Its onboarding-time **enforcement** —
  running these checks at repo onboarding and gating on them — is WP-118
  (CAM-SEC-03); a truly complete symbolic glob∩namespace / GitHub-Actions
  analyzer is that onboarding check. This module's intake does not gate on it.
- **The caller owns the pristine-repo lifecycle.** `runIntake` returns
  `pristineDir` (so a test can prove a carried-in object is structurally absent,
  and so the scheduler owns teardown). Use `removePristineRepo` /
  `cleanupPristineRepos` to reclaim it.

## Running the suites

```sh
node --run test    # full repo gate, incl. this module's suites
```

The suites need only `git` (and `tar`/Docker are irrelevant here). Use
`node --run` (Node 22 built-in), not `npm run`: this machine's global npm config
enables workspaces, so `npm run <script>` fans out across packages.
