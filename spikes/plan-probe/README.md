# WP-002 · PRD-to-plan probe (Phase-0 item 2)

Prototype evidence toward **CAM-PLAN-01/-02/-03**; product-grade acceptance lands in Phase 1
(closes [#4](https://github.com/hierosir1984/Camino/issues/4)).

## What it does

One real, bounded PRD goes through the prototype intake pipeline:

1. **Planner (family A, default `claude-code`)** reads the fixture PRD in an isolated workspace
   and writes `plan.json`: issues with acceptance criteria, clarifying questions (each carrying
   the precise assumption baked in if unanswered — CAM-PLAN-01's no-silent-assumptions rule),
   and a **requirement checklist diff**: exactly one row per PRD segment, mapped to a proposed
   intent-ledger entry or visibly flagged as non-requirement text (CAM-PLAN-02).
2. The harness **validates** the plan structurally (checklist totality is enforced: a silently
   dropped segment fails the run).
3. **Cross-family falsification reviewer (family B, default `codex-cli`)** gets PRD + plan and a
   falsification mandate — find dropped requirements, unstated assumptions, stub-passable
   criteria, mis-mappings, scope creep, padding questions — and writes `review.json`
   (CAM-PLAN-03). The pairing is asserted cross-provider **before** any quota is spent.
4. The harness renders **`RATING-PACKET.md`** — the spike's stand-in for the plan-approval
   screen. It cannot be rendered without the review attached, and `check-packet` refuses
   "approvable" until every question is rated AND actively acknowledged (answered or its
   assumption confirmed) — the CAM-PLAN-01 approval shape in miniature.

## The fixture

`fixture/evidence-viewer-v0.md` — assembled **verbatim** from Camino's real governing docs
(PRD v1.4 CAM-CORE-07/-05, registry item 8, §6; design v5 §7.2), segment-tagged `[S1]`–`[S16]`.
Its ambiguities are natural: the text was written for the product record before this probe
existed. David's answers double as real input to Phase-1's evidence-viewer work.

## Exit criteria (PRD §7, Phase-0 item 2 — David-interactive)

- David rates each clarifying question `good` / `obviously-fine`; **≥70% good** passes.
- Checklist usability confirmed; review time recorded against the 45-min plan budget
  (CAM-OBS-02 baseline data point).

## Commands

```sh
npm run spike:test              # zero-quota: all probe mechanics against the mock CLI
npm run spike:plan-probe -- --mock          # zero-quota full pipeline dry-run
npm run spike:plan-probe                    # REAL run (spends quota): claude plans, codex reviews
npm run spike:plan-probe -- --planner=claude-code --reviewer=grok-build
npm run spike:plan-probe -- --fixture=path/to/prd.md   # parameterized (WP-004 reuses this)
npm run spike:plan-probe:check              # verify the filled packet + compute the score
```

Committed evidence: `transcripts/{plan.json, review.json, REPORT.md, summary.json}` and
`RATING-PACKET.md`; raw `*.jsonl` streams are gitignored.

## What promotes to Phase 1

The schemas, prompts, and validators here are prototype-grade. WP-117/118 (planner, intake) and
WP-119/120 (approval enforcement) build the product versions; the checklist-totality validator,
the cross-family-before-quota assertion, and the acknowledge-before-approval packet gate are the
mechanics worth carrying forward.
