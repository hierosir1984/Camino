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

The binding is OPTIONAL by default (the WP-003 corpus fixtures have no contract
and emit the `null` no-binding form), but production dispatch (WP-114) passes
`IntakeOptions.requireContractRef`, which REFUSES an unbound candidate — so every
production artifact carries provenance (CAM-PLAN-04 / `CONTRACT_REFERENCE_OBLIGATIONS`;
review r8 finding 4). A caller-supplied `contractRef` is snapshotted through a
JSON round-trip so the emitted artifact holds owned primitives, never a live
`toJSON`/getter-backed object that could mutate after return (review r8 finding 3).

## Boundaries (stated, not hidden)

- **Canonical path identity uses ICU for the case fold; the residual is named.**
  Each path prefix is reduced to a fold KEY — `\`→`/`, strip git's HFS+
  IGNORABLE codepoints (zero-width/bidi/BOM controls a case-insensitive HFS+
  volume ignores in comparison, so `.git<U+200C>attributes` is `.gitattributes`
  there; review r6 finding 2), NFKC, an ICU `toUpperCase().toLowerCase()` round
  trip, then `ß`→`ss` — and distinct paths whose keys are equal are a collision
  (grouped by exact key equality, a Map).
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
  config), so a worker cannot use it to run code during the fetch. The intake
  ALSO refuses a worker `.git/config` that is a FIFO/special node, is over a size
  cap (bounded read, review r9 finding 2), or uses git's `[include]` /
  `[includeIf "…"]` directive (matched by git's EXACT section grammar — the bare
  `[include]` and an `[includeIf "<quoted condition>"]` only, not a
  differently-named `[include.custom]` nor a subsection-less `[includeIf]` git
  reads locally without inclusion; review r9 finding 7, r10 finding 6): an include
  `path` pointing at a FIFO makes the serving `upload-pack` BLOCK,
  orphaning a descendant even for a fully stopped worker (review r8 finding 1).
  The remaining repo-config exec/indirection surface
  (e.g. an include pointing OUTSIDE `.git`) is bounded by the fetch env carrying
  no credential and no host `HOME`, and by the daemon/container process lifecycle
  (WP-107 teardown reaps descendants) — the same boundary WP-107's `clone.ts`
  names. The `git` **binary itself** is resolved to an
  absolute path ONCE at module load (scanning the startup PATH), and every call
  invokes that pinned path — so a PATH entry that becomes worker-writable mid-run
  cannot swap it. Fail-closed properties (review r7 finding 5, r8 finding 6): only
  **ABSOLUTE** PATH entries are considered (a relative `relbin`/`.` would resolve
  against the exec-time cwd, so it is skipped, never pinned), the candidate must
  be a regular **FILE** (an `X_OK` check alone also passes a directory named
  `git`), and if NO absolute git is found at load the module **throws on first
  call** rather than falling back to a bare `"git"` re-resolved from a
  possibly-attacker-extended ambient PATH. Pinning a PATHNAME is not
  executable-identity pinning (replacing the binary at that path would run the
  replacement) — that residual is the named trusted-PATH boundary. **Named
  boundary / flagged for David (review r6 finding 10):** the
  daemon's PATH at startup is a trusted deployment input (the control plane owns
  its process env; a WP-107 worker cannot write the daemon host's PATH
  directories), the same trusted-PATH residual WP-107 states. Every git call also
  carries a wall-clock timeout bounding the DIRECT process; a serving-side
  `upload-pack` descendant can briefly orphan (review r7 finding 4) but holds no
  credential and is reaped by the daemon/container lifecycle.
- **The worker head and base are fetched BY EXACT OBJECT ID, never a ref
  string.** A ref string is a refspec surface: `git fetch <repo> <src>:<dst>`
  writes `<dst>` (e.g. a `refs/replace/<oid>` that would substitute the assigned
  base out from under the diff), and a wildcard imports multiple heads — neither
  stopped by `--`. An OID cannot carry a `:` or `*`, so requiring one (validated
  by `isOid`) closes refspec injection and the multi-head/over-budget wildcard
  fetch outright; the fetch writes only `FETCH_HEAD` (which can only name the
  validated oid), never an attacker-chosen destination ref (review r1 findings
  1, 2). Replacement refs are additionally disabled in the pristine store
  (`core.useReplaceRefs=false`). The OID grammar accepts 40-hex (sha-1) OR 64-hex
  (sha-256), and the pristine store is initialized with the TRUSTED base's object
  format — read from its config file (a section-aware, quote-tolerant parse of
  `[extensions] objectformat`, so an unrelated section's key does not mis-init and
  git's quoted value is honored; review r9 finding 4, r10 finding 5), never via a
  git-exec that would honor the repo's config — so a sha-256 intake actually
  fetches.
- **The worker object store must be self-contained — under a stopped-worker
  CUSTODY PRECONDITION.** Before fetching, the intake requires a full non-bare
  clone (a real `.git` directory), refuses a `commondir` redirect, and walks the
  WHOLE `objects` subtree no-follow (STREAMED, bounded by a scan cap) — refusing a
  symlink anywhere, an unexpected node (FIFO/socket/device — which fell through as
  "safe" and would hang the reader; review r6 finding 5), a HARDLINKED object file
  (`nlink>1` — it shares its inode with a donor a write can corrupt; review r7
  finding 3), and any `alternates` file. Each is a borrowing/serving/mutation
  hazard (review r1 finding 4, r2/r3/r5 finding 2/3, r7 #3). It **mirrors WP-107's
  authoritative `assertWorkerCloneIsolation`** exactly (my r6 "hardlinks are
  normal" carve-out was a regression — WP-107 provisions clones without them). It
  is a filesystem check (no git in the worker dir). **Named boundary / SCOPE
  DECISION flagged for David (review r6 finding 1, r7 findings 1/4):** no pair of
  filesystem scans can be proof against a source mutated DURING the fetch — a
  transient `alternates` (upload-pack serves a borrowed object) or a swapped-in
  FIFO (a serving-side `upload-pack` orphan hangs) planted only while `git fetch`
  runs and removed before either scan. This is fundamental — WP-108 is a LIBRARY
  that receives a repo PATH and cannot lock another process's directory. The
  guarantee is therefore a PRECONDITION the caller owns: **WP-107** provisions the
  clone self-contained, and **WP-114** invokes `runIntake` only against a STOPPED,
  quiescent worker. WP-108's pre-/post-fetch scans are best-effort defense in
  depth (they also refuse a config `[include]`/FIFO surface that would hang a
  serving `upload-pack`; review r8 finding 1). A DIFFERENT custody
  IMPLEMENTATION could close the race internally — a privileged filesystem
  snapshot, or a daemon-owned fd-relative copy of the objects followed by full
  object verification, converts the race into a stable closure (review r8 finding
  10); that is a heavier design, out of v1 scope. My recommendation: keep the
  caller precondition (owned by WP-107 + WP-114) rather than build that
  WP-108-internal custody mechanism now.
- **The registry-item-11 fetch budget is a DISTINCT-footprint ADMISSION check.**
  It caps the shallow-fetch footprint at ≤5,000 objects / ≤500 MB (from the one
  `@camino/shared` source), counting **distinct** git objects — deduplicated by
  id and **including** the fetched commit, closing the off-by-one and the
  repeated-path inflation a worker could exploit (review r1 finding 8). Object
  counts are read PATH-FREE (`--format=%(objectname)`) and checked BEFORE the
  leaves are read, so a pathological tree (huge count or very-long paths) is
  rejected on its count rather than overrunning a path-bearing read buffer
  (review r4 finding 3). Bytes are the EXACT summed `lstat` size of every file
  under `.git/objects`, measured by a filesystem walk (NOT `count-objects -v`,
  which rounds pack size DOWN to KiB and omits `.rev` — a real ~KiB UNDERcount
  once the before-measurement is subtracted, review r7 finding 6). The pristine
  repo sets `fetch.unpackLimit=1`, so a fetch is KEPT AS A PACK (never unpacked to
  loose objects): the delta is therefore the received `.pack` plus its locally
  generated `.idx`/`.rev` — a slight OVER-count of the wire transfer (the safe
  direction: it can conservatively false-reject a pack a hair below the limit, but
  never admit one over it), not a post-unpack store that a pack a few bytes over
  500 MB could shrink under the cap (review r8 finding 2, r9 finding 3). The walk
  **throws** (fails the intake CLOSED) past the scan cap OR on any read failure of
  an existing entry — never returns a sentinel that could cancel under the
  before/after subtraction (review r9 finding 3). Only an **ENOENT** objects dir
  is a legitimately empty 0-byte store; an inaccessible root (`EACCES`) throws
  rather than reading as empty, distinguished by errno not `existsSync` (review
  r10 finding 4). Worker-controlled
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
  (review r1 findings 3, 5; r2 findings 1, 4). **Named boundary — David RULED
  (2026-07-23): DEFERRED to WP-118.** A workflow may reference a local action at
  an ARBITRARY path (`uses: ./scripts/foo`) or via a SYMLINK whose target the
  worker edits; closing that requires parsing each workflow's `uses: ./…`
  targets, which is the WP-118 onboarding analyzer (CAM-SEC-03). WP-108 protects
  the conventional `.github/actions/**` location; the complete local-action
  closure is WP-118's.
- **The workflow-posture analyzer is heuristic and its home is WP-118.** Its
  behaviour is the WP-003 spike's analyzer (3 falsification rounds) carried
  forward — the only edits are `readonly` parameters and a frozen
  `CANDIDATE_REFS`, no logic change — so the entire corpus runs green here. Its onboarding-time **enforcement** —
  running these checks at repo onboarding and gating on them — is WP-118
  (CAM-SEC-03); a truly complete symbolic glob∩namespace / GitHub-Actions
  analyzer is that onboarding check. This module's intake does not gate on it.
- **The caller owns the pristine-repo lifecycle; checks are collect-all above
  the processing bound.** For a tree within the processing bound the intake runs
  every policy check and reports ALL violations (not fail-fast), so a rejected
  result may carry several codes. A tree that exceeds a PROCESSING bound first —
  over the object-count cap, or a path-bearing read that overruns its buffer — is
  refused EARLY on the count-only findings, WITHOUT running the leaf/path checks
  (their reads are unbounded on such a tree); that refusal is fail-closed but not
  collect-all (review r5 finding 6). It does not auto-delete the pristine store:
  `runIntake` returns `pristineDir` on both accept and reject (so a caller can
  prove a carried-in object is structurally absent, and inspect a rejection), and
  the caller reclaims it with `removePristineRepo` / `cleanupPristineRepos`. A
  pristine dir created before a thrown refusal is tracked for
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
- **The assignment is snapshotted once; integrity failures keep truthful
  evidence.** Every worker-influenced field (`base`, `allowedPaths`, `budgets`,
  and `contractRef` — the last DEEP-copied field-by-field, so a getter-backed ref
  cannot pass validation at emit yet read as malformed afterward; review r7
  finding 7) is read into an immutable local at entry, so a malformed/stateful
  assignment (a side-effecting getter) cannot return a different `base` between
  the diff and the rebuild and admit protected content under an empty-looking diff
  (review r6 finding 6). `git fsck` runs BEFORE any path-bearing read, so a
  type-confused object (a `120000` "symlink" whose object is a tree) is reported
  as the truthful `fsck-violation`, not mislabeled `path-too-long` by the
  read-overflow backstop (review r6 finding 7); the rejection is worded as an
  integrity error in the pristine STORE (fsck also checks the shared trusted base,
  so the worker is not provably the culprit; review r7 finding 12).
- **Canonical path identity is over-reject-safe but NOT a complete fold; David
  RULED (2026-07-23): residual ACCEPTED for v1.** The fold (HFS-ignorable strip +
  NFKC + ICU upper/lower + `ß→ss`) catches the common aliases and the review
  examples, but ICU's case MAPPING is not full versioned case FOLDING, so
  recent-Unicode case pairs (e.g. the U+A7CE class) OR Apple's own HFS+
  collation (e.g. Georgian U+10A0 `Ⴀ` ⇄ U+10D0 `ა`, which a case-insensitive HFS+
  volume collapses to one inode; review r7 finding 2) that these mappings miss may
  under-detect. Making this complete means bundling a versioned Unicode
  `CaseFolding.txt` AND Apple's HFS+ case table; David accepted the disclosed
  over-reject-safe residual for a personal-tool v1 (the WP-003 precedent accepted
  a weaker residual; git's own docs note its HFS helper is incomplete outside its
  `.git` purpose). Deferred follow-up (not burial): bundle the fold tables if
  Camino goes multi-user / hostile-Unicode.
- **Windows name aliases match git's own rules, not a hand list.** Reserved
  device names cover the `RtlIsDosDeviceName_U` set — CON/PRN/AUX/NUL, COM/LPT¹⁻⁹
  (incl. superscripts), and the console devices CONIN$/CONOUT$ (review r6 finding
  4). The 8.3 short-name rule refuses any `NAME~<digits>` whose base (tilde +
  digits included) is ≤8 **ASCII-non-space** chars — matching MS-FSCC's 8-char
  ASCII-no-space base limit, so it catches git's zero-prefix/hash fallback forms
  (`~1000000`, `GI7D29~1`) yet does not over-reject an impossible-as-8.3 long
  name — an 11-char base like `report~2024` (review r6 findings 3, 9), a
  non-ASCII/spaced base like `café~1` / `foo ~1` that MS-FSCC forbids in an 8.3
  name (review r7 finding 10), or a base containing punctuation forbidden in a
  short name but legal in a long name (`+ , ; = [ ]`, e.g. `FOO+~1`; review r8
  finding 8). The exact NTFS/HFS checkout algorithm is git's own
  (`core.protectNTFS`/`protectHFS`); these are the intake's bounded shape rules
  over the tree's raw bytes.
- **Portability enforcement is macOS/Linux-scoped for v1 (a named residual).**
  The intake targets the filesystems Camino runs on; it rejects `\` and `:`
  segments (Windows separator / NTFS ADS) but PERMITS other Windows-illegal
  characters (`* ? " < > |`, control bytes) because they are valid on the target
  filesystems — rejecting them would over-reject legitimate macOS/Linux names
  (review r8 finding 9). A cross-platform materialization guard belongs to a
  portability-lint layer, not this admission check; flagged as a low-severity
  scope note.
- **The durable diff validator refuses what a store round-trip cannot represent.**
  Beyond the r1–r6 checks, a changed path carrying U+FFFD (git's non-UTF-8
  substitution) or an unpaired surrogate is rejected — the intake never emits such
  a path, so a forged WP-111/WP-116 artifact bearing one is refused at adoption
  (review r7 finding 9). A LITERAL U+FFFD filename is thereby over-rejected too
  (it is indistinguishable from a decode substitution and is non-portable anyway —
  the same over-reject-safe direction the intake already takes). Contract identity
  is consistent end to end: both the `IssueContract` validator and its
  `ContractRef` require a `Number.isSafeInteger` version (review r7 finding 8),
  and BOTH validators are TOTAL over a **recursive null-prototype JSON snapshot** —
  the exact plain data a store persists — which they also HASH (never the original
  `value`). So an inherited-only record (`Object.create(valid)`), a non-enumerable
  `Object.prototype` pollution at ANY nesting level (which makes even `{}` read as
  populated), a stateful/revoked `Proxy`, and a non-serializable value are all
  normalized or refused, never accepted and never thrown on (review r7 finding 11,
  r8 finding 5, r9 finding 5, r10 findings 1–3). **Boundary:** a live object that
  serializes DIFFERENTLY across calls is a caller-trust surface — the validator
  validates ONE snapshot, and a caller that then adopts the live object rather
  than a serialized record owns that risk (the scope `quarantinedDiffProblems`
  states). The intake also snapshots a caller's `contractRef` through a JSON
  round-trip, so a `toJSON`/getter-backed ref is emitted as owned primitives that
  cannot mutate to malformed after return (review r8 finding 3).

## Running the suites

```sh
node --run test    # full repo gate, incl. this module's suites
```

The suites need only `git` (and `tar`/Docker are irrelevant here). Use
`node --run` (Node 22 built-in), not `npm run`: this machine's global npm config
enables workspaces, so `npm run <script>` fans out across packages.
