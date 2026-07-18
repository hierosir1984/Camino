# Build-plan falsification reviews — provenance note

Reviewer: Codex `gpt-5.6-sol`, reasoning effort xhigh (the same reviewer as design rounds 1–5 and PRD rounds 1–3), invoked read-only against the repo docs (PRD v1.4, BUILD.md, design v5) and the plan draft.

- `falsification-review-round1.md` — reviewed plan v1 (2026-07-16). Verdict: "safe to build on: no", 19 findings.
- `falsification-review-round2.md` — reviewed plan v2 (2026-07-16). Verdict: "safe to build on: no", 13 findings + round-1 regression table.
- `falsification-review-round3.md` — verify-only pass over plan v3 (2026-07-16). Verdict: "safe to build on: with corrections", 4 corrections — all folded into plan v4 ([../phase-0-1-work-packages-PROPOSED.md](../phase-0-1-work-packages-PROPOSED.md)).

Provenance: the reviews were produced in the first build session's scratchpad (`/private/tmp/...` paths referenced inside rounds 2–3 point there). The OS purged that temp directory overnight on 2026-07-17; these files are verbatim reconstructions from the session context, which had read each review in full. Reviewed plan versions v1–v3 were working drafts superseded by v4; their content is recoverable from the findings quoted in the reviews themselves. (Files renamed 2026-07-18 in the repo-wide neutral-vocabulary pass — contents untouched.)

Status: APPROVED by David 2026-07-17 (all §1.3 defaults confirmed). Per the plan's §6: committed to docs/plan/, work-package issues created on GitHub, WP-000 next.
