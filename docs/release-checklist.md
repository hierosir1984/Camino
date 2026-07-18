# Open-source release checklist (CAM-SEC-09)

> Exists from day one; every item must pass before any public release beyond the
> current source-visible state. Re-walked at each phase exit (WP-126 for Phase 1).

| # | Item | Owner | Status | Notes |
|---|------|-------|--------|-------|
| 1 | Permissive license in place | David | **done** | Apache-2.0, approved 2026-07-17 |
| 2 | No secrets in repo | agent + David | **recurring** | verified per release; vault material never committed; CI artifacts scrubbed (CAM-SEC-08) |
| 3 | Compliance pass on provider policies | David | **pending** | includes the xAI caveat re-check (docs/plan/xai-sanctioned-path-research.md: AUP boilerplate tension; beta = personal/non-commercial) and the Anthropic/OpenAI postures per design §9 |
| 4 | Risk-model re-pricing for distribution | David | **pending** | T3 residual and post-merge supply-chain risk re-priced for multi-user distribution (design §5.3) |
