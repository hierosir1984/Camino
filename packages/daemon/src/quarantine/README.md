# Quarantine module — WP-108 (CAM-EXEC-04)

Squash-and-rebuild intake at product grade, **replacing the WP-003 prototype**
(`spikes/quarantine`, closed #5). The control plane shallow-fetches only the
worker's final head into a pristine, hooks-disabled clone; runs the full policy
check-list on the final tree within registry-item-11 fetch budgets; and, for a
clean tree, re-authors a **fresh Camino-authored commit** applying that tree
onto the assigned base with a worker-attribution trailer. Worker history never
crosses the boundary; worker merge commits are rejected outright.

The pieces:

| File                                         | What it does                                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`intake.ts`](intake.ts)                     | `runIntake` — shallow-fetch → merge-commit check → `git fsck` → fetch-budget + policy checks → squash-rebuild → emit the quarantined diff.                                                                                     |
| [`policy.ts`](policy.ts)                     | The pure policy checks (collect-all): scope vs contract, protected paths, canonical path identity (ICU fold), reserved/trailing-dot/`.git` aliases, symlink targets, submodule/gitlink block, tree + fetch budgets.            |
| [`git.ts`](git.ts)                           | Credential-free, hooks-disabled git plumbing, run only in the pristine repo (the worker repo is a fetch source, never a working dir a git command runs in).                                                                    |
| [`workflow-posture.ts`](workflow-posture.ts) | The candidate-ref CI-posture analyzer (WP-003 case 13, CAM-SEC-03) — behaviour carried forward (only readonly-param / frozen-`CANDIDATE_REFS` edits); **enforcement home is WP-118**.                                          |
| [`corpus*.ts`](corpus.test.ts)               | The WP-003 rejection corpus driving the product module — its acceptance gate. Every case and expected rejection is preserved; the sole additions are that a rejected intake emits no diff, and product tests for the r1 fixes. |

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
  Each path prefix is reduced to a fold KEY — `\`→`/`, NFKC, an ICU
  `toUpperCase().toLowerCase()` round trip, then `ß`→`ss` — and distinct paths
  whose keys are equal are a collision (grouped by exact key equality, a Map).
  The upper/lower round trip is what makes it a case FOLD rather than a mere
  lowercase: it collapses same-script pairs a plain `toLowerCase()` (and the
  WP-003 spike's hand-rolled residual list) **missed** yet a case-insensitive
  APFS/HFS+ volume aliases to one inode — the capital sharp S `ẞ`⇄`SS` and the
  combining ypogegrammeni `ͅ`⇄`ι` (review r1 finding 6) — while **preserving
  accents**, so a legitimately distinct `café.txt`/`cafe.txt` is not a false
  collision. JavaScript exposes no `u_strFoldCase`, so this is a strong
  approximation of Unicode default case folding, **not** the complete
  CaseFolding.txt table: same- or cross-script fold pairs beyond what NFKC and
  ICU's upper/lower casing collapse may still slip. It errs toward collapsing (a
  false collision over-rejects — the safe direction, e.g. the locale-dependent
  `I`⇄`ı`; a miss would be a missed collision, never an accept of something
  worse). The complete target-filesystem identity oracle (a bundled fold table)
  is deferred. This is the WP-003 "name the boundary" lesson carried forward.
- **The malformed-object/path class is delegated to `git fsck`**, far more
  complete than any hand-rolled parser (`.git` equivalents incl. HFS-ignorable
  characters, mode/type mismatches, broken links). Our own checks add only the
  cross-platform aliases git _permits_ (`GIT~1`, case-spelled protected paths,
  trailing-dot names, NTFS ADS spellings). We fsck the **tree**, not the commit,
  to avoid the shallow-graft parent boundary.
- **Credentialed git never executes in worker-touched directories.** Every
  intake git call — including the exported `objectExists` helper — runs with a
  credential-free, hooks-disabled env (no GitHub PAT; host global/system config
  neutralized to `/dev/null`; no interactive prompt), and the intake spawns git
  with cwd **only** in the Camino-owned pristine repo. It reads the worker repo
  solely by fetching from it: the local fetch spawns `git upload-pack` **as a
  host process** whose cwd is the worker repo, but it inherits the same
  credential-free, config-neutralized env. Git does **not** honour a repo-local
  `uploadpack.packObjectsHook` (that command is read only from protected system
  config), so a worker cannot use it to run code during the fetch. The residual
  git-config exec surface is unbounded in principle — the structural bound is
  that the fetch env carries no credential and no host `HOME`, the same boundary
  WP-107's `clone.ts` names.
- **The worker head and base are fetched BY EXACT OBJECT ID, never a ref
  string.** A ref string is a refspec surface: `git fetch <repo> <src>:<dst>`
  writes `<dst>` (e.g. a `refs/replace/<oid>` that would substitute the assigned
  base out from under the diff), and a wildcard imports multiple heads — neither
  stopped by `--`. An OID cannot carry a `:` or `*`, so requiring one (validated
  by `isOid`) closes refspec injection and the multi-head/over-budget wildcard
  fetch outright; the fetch writes only `FETCH_HEAD` (which can only name the
  validated oid), never an attacker-chosen destination ref (review r1 findings
  1, 2). Replacement refs are additionally disabled in the pristine store
  (`core.useReplaceRefs=false`).
- **The worker object store must be self-contained.** Before fetching, the
  intake refuses a worker repo carrying an `objects/info/alternates` (or
  `http-alternates`) file — a borrowing store whose `upload-pack` would serve
  objects from an external/shared store into the candidate (review r1 finding 4).
  This is a filesystem check (no git run in the worker dir) that re-attests
  WP-107's `noAlternates` provisioning guarantee.
- **The registry-item-11 fetch budget is a DISTINCT-footprint ADMISSION check.**
  It caps the shallow-fetch footprint at ≤5,000 objects / ≤500 MB (from the one
  `@camino/shared` source), counting **distinct** git objects — deduplicated by
  id and **including** the fetched commit, closing the off-by-one and the
  repeated-path inflation a worker could exploit (review r1 finding 8) — and the
  summed bytes of ALL those objects (blobs, trees, AND the commit), so object
  metadata cannot hide from the budget (review r2 finding 6). Worker-controlled
  commit metadata is separately bounded: a commit object over 1 MiB is rejected
  (`commit-metadata-budget`) before it is read, and the authored candidate
  message is passed on stdin (never argv) and clipped — so an unbounded worker
  message fails as a clean rejection, not an E2BIG/ENOBUFS throw. The budget is
  computed after the **local** fetch from the worker's already-bounded (≤2 GB
  workspace) isolated clone completes; a pre-transfer/network ceiling is bounded
  out-of-process by the WP-107 container + WP-114 supervisor — the same
  in-process-best-effort / out-of-process-authoritative split WP-107 states. It
  is an ADMISSION check: an over-budget candidate is refused, and the caller
  discards the returned `pristineDir`. The per-issue tree-size **policy** budget
  is a separate, materialized-entry measure, clamped so an override can only
  **tighten** it, never widen it — a non-finite or non-positive override (`NaN`,
  `0`, …) is ignored rather than silently disabling the check (findings 5, 7).
- **Protected paths are matched on the canonical FOLD, not the literal string.**
  Beyond `.gitattributes`, `.github/workflows/**`, and `.camino/**`, the intake
  protects `.github/actions/**` (local composite/JS actions execute with the
  referencing workflow's privilege) and rejects any worker change to
  `.gitmodules` (which retargets an otherwise-unchanged gitlink at an attacker
  repo). Both are compared under the same per-segment case-fold as the collision
  check, so an alias a target FS resolves to the protected identity —
  `.gitattributeſ`, `.GitModules` — is caught, not just the exact spelling
  (review r1 findings 3, 5; r2 findings 1, 4). **Named boundary / escalation:** a
  workflow may reference a local action at an ARBITRARY path (`uses: ./scripts/
foo`) or via a SYMLINK whose target the worker edits — closing that requires
  parsing each workflow's `uses: ./…` targets, which is the WP-118 onboarding
  analyzer (CAM-SEC-03). Whether WP-108 should ship a minimal `uses:`-parser or
  defer the complete local-action closure to WP-118 is a scope decision flagged
  for David.
- **The workflow-posture analyzer is heuristic and its home is WP-118.** Its
  behaviour is the WP-003 spike's analyzer (3 falsification rounds) carried
  forward — the only edits are `readonly` parameters and a frozen
  `CANDIDATE_REFS`, no logic change — so the entire corpus runs green here. Its onboarding-time **enforcement** —
  running these checks at repo onboarding and gating on them — is WP-118
  (CAM-SEC-03); a truly complete symbolic glob∩namespace / GitHub-Actions
  analyzer is that onboarding check. This module's intake does not gate on it.
- **The caller owns the pristine-repo lifecycle; checks are collect-all.** The
  intake runs every policy check and reports ALL violations (not fail-fast), so a
  rejected result may carry several codes. It does not auto-delete the pristine
  store: `runIntake` returns `pristineDir` on both accept and reject (so a caller
  can prove a carried-in object is structurally absent, and inspect a rejection),
  and the caller reclaims it with `removePristineRepo` / `cleanupPristineRepos`.
  A pristine dir created before a thrown refusal is tracked for
  `cleanupPristineRepos` (review r2 finding 11).
- **The OID identifies WHICH object was fetched, not that it is the observed
  head.** `fetchOid` verifies the fetched object is exactly the requested OID and
  is a commit — so a worker cannot substitute different content under a trusted
  OID. Binding that OID to the control-plane-**observed** final head of the
  attempt (that the caller passed the head the worker actually produced) is the
  caller's job — WP-114 dispatch resolves the worker head and hands it here.
  Likewise, the assigned `base` defaults to the worker repo only for the corpus
  fixtures; production passes a SEPARATE trusted `baseRepo` (review r2 finding
  10).
- **Canonical path identity is over-reject-safe but NOT a complete fold; a
  scope decision is flagged for David.** The fold (NFKC + ICU upper/lower +
  `ß→ss`) catches the common aliases and the round-1/round-2 examples, but ICU's
  case MAPPING is not full versioned case FOLDING, so recent-Unicode case pairs
  (e.g. the U+A7CE class) that a case-insensitive volume still aliases may slip
  (they over-reject-safely nowhere, but under-detect). Making this complete means
  bundling a versioned Unicode `CaseFolding.txt` table. Whether to fund that in
  WP-108 or accept the disclosed residual for a personal-tool v1 (the WP-003
  precedent accepted a weaker residual) is flagged for David.

## Running the suites

```sh
node --run test    # full repo gate, incl. this module's suites
```

The suites need only `git` (and `tar`/Docker are irrelevant here). Use
`node --run` (Node 22 built-in), not `npm run`: this machine's global npm config
enables workspaces, so `npm run <script>` fans out across packages.
