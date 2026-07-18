# WP-003 · Quarantine attack suite (Phase-0 item 3)

Prototype evidence toward **CAM-EXEC-04**; the product-grade module is WP-108, and this attack
corpus is designed to run against it unchanged (closes
[#5](https://github.com/hierosir1984/Camino/issues/5)).

## What it proves

A **squash-and-rebuild quarantine intake** (design §5.1) defeats every enumerated attack a
hostile worker can put in the head it hands back. The intake:

1. owns a **pristine, hooks-disabled repo** and **shallow-fetches only the worker's final head**
   (`--depth=1`) into it — worker history and any objects reachable only through it never cross
   the boundary;
2. runs **policy checks on the final tree** (collect-all, so one run reports every violation);
3. for a clean tree, **re-authors a fresh Camino commit** applying that tree onto the assigned
   base, with a `Camino-Worker-Attribution:` trailer — a rejected intake produces no candidate.

Everything is built with **git plumbing** (`hash-object` / scratch-index `write-tree` /
`commit-tree`), never working-tree files, because the host macOS filesystem is case-insensitive
and Unicode-normalizing and literally cannot hold most of these trees. The fixture repos also
disable `core.precomposeunicode` / `protectHFS` / `protectNTFS` so the adversarial bytes survive
to the intake — the layer that must reject them — rather than being silently munged by git.

## The attacks (each a fixture; each defeated)

| #   | Attack                                                                               | Outcome                                                                                 |
| --- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 1   | reachable-history smuggling (2 MB secret in an intermediate commit, deleted at head) | **neutralized** — the object never enters the pristine store (structural, not filtered) |
| 2   | path collision, case-fold (`Config.txt` ⇄ `config.txt`)                              | rejected `path-collision-case`                                                          |
| 3   | path collision, Unicode NFC⇄NFD (`café.txt`)                                         | rejected `path-collision-unicode`                                                       |
| 4   | reserved device name (`CON.txt`)                                                     | rejected `reserved-name`                                                                |
| 5   | trailing-dot alias (`report.`)                                                       | rejected `trailing-dot-or-space`                                                        |
| 6   | symlink target escape (`../../../../etc/passwd`, and absolute)                       | rejected `symlink-escape`                                                               |
| 7   | `.gitattributes` tampering                                                           | rejected `protected-path`                                                               |
| 8   | CI-definition edit (`.github/workflows/**`)                                          | rejected `protected-path`                                                               |
| 9   | out-of-scope diff (`config/prod.env` vs a `src/**` contract)                         | rejected `out-of-scope`                                                                 |
| 10  | worker merge commit                                                                  | rejected `worker-merge-commit`                                                          |
| 11  | submodule/gitlink introduction (mode 160000)                                         | rejected `submodule-gitlink`                                                            |
| 12  | size bomb (2 MB blob in the final tree)                                              | rejected `blob-size-budget`                                                             |
| 13  | candidate-ref workflow-trigger (a hostile workflow firing on `camino/**`)            | flagged by the static posture analyzer, workflow named                                  |

**Beyond the enumerated 13 (proactive hardening):** a `.git` directory smuggled into the tree
would let a worker rewrite repo internals on checkout. A _literal_ `.git` tree entry is already
refused by git's own object layer at write and transfer (CVE-2019-1349), so the residual cases
are the Windows 8.3 alias `GIT~1` (which git permits but resolves to `.git`) and symlinks whose
target dives into `.git` — both caught here (`dotgit-path` / `symlink-escape`), with a unit test
proving the check also covers the literal form git blocks.

A **positive control** proves a clean in-scope change is accepted and re-authored onto the base
(single assigned parent, worker-attribution trailer, worker's final tree bit-for-bit).

Attack 13 is the one case that is not about the worker tree — it is repo CI posture (CAM-SEC-03):
a static analyzer parses each workflow and flags one that _both_ fires on a Camino-managed
namespace _and_ is privileged (references secrets or holds a write token). A broad trigger that
is read-only and secret-free is intentionally **not** flagged (fires ≠ hostile).

## Run

```sh
npm run spike:quarantine     # this suite only
npm test                     # full gate; the attack suite runs here on every PR from now on
```

There are no generated evidence artifacts to commit — the executable suite **is** the deliverable,
and it persists as Camino's own CI.

## Adversarial review — 3 rounds, and what they taught (Codex Sol, cross-family)

The 13 enumerated attacks passed from round 0. Three falsification rounds then hardened the intake
well beyond the enumerated list: **8 findings (r1) → 12 (r2) → 11 (r3), all folded, each now a
regression case.** The count did not fall to zero, and the reason is the load-bearing lesson, not
a reason to keep going:

- **Two findings each round were things git's own `fsck` already catches** (literal/HFS `.git`
  equivalents, mode/type mismatches). The fix was not more hand-rolled regexes but to **delegate
  the malformed-object/path class to `git fsck`** (`intake.ts`), which is far more complete than
  anything hand-rolled. Our own checks now cover only the cross-platform aliases git _permits_
  (`GIT~1`, case-spelled protected paths, trailing-dot names).
- **The rest cluster in two inherently-unbounded surfaces**: full Unicode case-folding (an ICU
  table — we do NFKC + a few residual folds) and complete GitHub-Actions trigger/secret semantics
  (many event types and expression forms). A hand-rolled analyzer will always trail these; a
  finder will always find the next gap. That is the signal to **stop folding and name the
  boundary**, exactly as the PRD design phase did when its prose rounds hovered.

### Known limitations (accepted for the spike; product-grade in WP-108 / CAM-SEC-03 onboarding)

- **Unicode folding** is NFKC + `ß`/`ς` residuals, not a full ICU case-fold — exotic
  cross-script confusables may not collapse. (Over-rejects where it does fire; a miss is a missed
  collision, not an accept of something worse.)
- **Workflow posture** analysis is heuristic: privileged-by-nature events (`push`,
  `pull_request(_target)`, `workflow_run`), ordered branch filters over a probe set (not symbolic
  glob∩namespace intersection), and secret/permission detection (named, bracket, whole-object,
  `secrets: inherit`, per-job). A truly complete analyzer is the CAM-SEC-03 onboarding check.
- **Non-UTF-8 paths** are rejected wholesale (a genuinely U+FFFD-named file is a false reject —
  the safe direction).

## What promotes to Phase 1 (WP-108)

The policy checks (`policy.ts`), the shallow-fetch-into-pristine intake (`intake.ts`), and the
workflow posture analyzer (`workflow.ts`) are prototype-grade. WP-108 rebuilds the intake at
product grade against the issue's frozen contract (WP-110) within registry-item-11 budgets and
emits the quarantined diff for classification (WP-111) and evidence (WP-116). **This exact attack
corpus is the acceptance gate for that module** — plus the r1–r3 lessons above: keep the `git
fsck` delegation, and build the full ICU fold + symbolic workflow analysis it defers.
