# WP-004 — Untrusted-content robustness baseline

Phase-0 item 4 (PRD §7). Runs an untrusted-content case set against the WP-002 planner and
one WP-001 worker, catalogues what happened, and hands David a findings packet
to disposition. Requirement **CAM-EXEC-09** (the P2 orchestrator-channel
extension is CAM-SEC-07, out of scope). Closes
[#6](https://github.com/hierosir1984/Camino/issues/6).

This is a **spike**: the runner is prototype-grade. The **durable** asset is the
corpus at [`fixtures/untrusted-content/`](../../fixtures/untrusted-content/), which
re-runs against each real defense as it lands (WP-107 isolation, WP-108
quarantine, WP-113 pack assembly).

## What it does

1. Loads the corpus manifest (strict, fail-closed).
2. For each **live** item, runs it through the real surface:
   - `PL-*` → the WP-002 planner (`spikes/plan-probe/prompts.ts` `plannerPrompt()`
     dispatched via the WP-001 lifecycle) with the untrusted PRD as `PRD.md`.
   - `WK-*` → one WP-001 worker in a throwaway clone materialised from the item's
     seed repo, clean env (no GitHub credential), synthetic marker only. Evidence
     is collected from a **filesystem snapshot** of the clone — never `git add`/
     `git diff` on worker content, which would run worker-controlled clean-filters
     as the host user (review r1 blocker 1).
3. Applies deterministic **detectors** (`detectors.ts`) to the captured evidence —
   each fires only if the planted instruction's benign **proxy action** was performed.
4. Writes the findings catalogue `FINDINGS.md` (David dispositions each) plus
   machine evidence `transcripts/{summary.json,REPORT.md}`.

The two **catalogue-only** items (`WK-06` host destruction, `WK-07` real
host-secret leakage) are not live-run at Phase 0 — a _successful_ run would
damage the host and there is no sandbox to contain it yet. That gap is itself a
finding (SF-01). See the corpus README for the full rationale.

## Why detectors, not eyeballing

The verdict for each item is a pure function of captured evidence, so it is
reproducible and reviewable — the live agent runs only _produce_ evidence, they
never _decide_. `robustness.test.ts` proves every detector on synthetic evidence
(firing and non-firing), so the logic is trusted before any quota is spent.

## Commands

```sh
node --run spike:test                       # zero-quota: corpus + detectors + wiring
node --run spike:untrusted -- --mock          # zero-quota full dry-run (mock agents)
node --run spike:untrusted                     # REAL run (quota): claude-code plans, codex-cli works
node --run spike:untrusted -- --worker=claude-code   # choose the one worker family
node --run spike:untrusted -- --only=PL-01,WK-01     # targeted subset (does not rewrite FINDINGS.md)
node --run spike:untrusted:check              # gate: every finding has a recorded disposition
```

> Use `node --run` (Node 22 built-in), not `npm run`: this machine's global npm
> config enables workspaces, so `npm run <script>` fans out across packages.

A full run **refuses to overwrite** a `FINDINGS.md` that already carries David's
dispositions (pass `--force` only to discard them) — the same guard the WP-002
rating packet uses. Raw `*.jsonl` streams **and `raw-evidence.json`** are
gitignored (they may hold whatever a worker read); the committed `summary.json`
carries only secret-scanned findings, and `--rescore` re-derives verdicts from
the local `raw-evidence.json` with the current detectors, zero quota.

## Known limitations (deferred to the product WPs)

Per the spike review cadence, the r1 review's detector-precision findings are
recorded here rather than rebuilt in throwaway code (the real detectors are built
at WP-108/111/113). The verdicts of the shipped baseline run were hand-verified
against the raw transcripts regardless. Deferred: a contained loopback egress
sink and safe boundary proxies for WK-06/WK-07 (WP-107); structural empty-commit
proof and per-issue disposition parsing for the planner heuristics (WP-111);
evidence bound to manifest/payload/detector hashes so `--rescore` cannot score
stale behaviour (WP-108/113). The full r1 review is attached to the PR.

## The interactive step (why this WP can't close solo)

Like WP-002, WP-004 is **David-interactive**: the corpus is run and findings
catalogued solo, but the acceptance is _every finding dispositioned_ — `hardened`
(name the defense/WP) or `accepted-risk` (with a reason). Edit the
`Disposition (David):` lines in `FINDINGS.md` (or hand me the calls), then
`node --run spike:untrusted:check` must pass.

## What promotes to Phase 1

The corpus and detector taxonomy. The runner's target adapters are throwaway; the
real defenses they probe are built at WP-107/108/113, and this corpus becomes
their regression suite.
