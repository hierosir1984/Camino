# Camino — Build Kickoff

> 2026-07-16. The design record is cleared (5 falsification rounds) and [PRD v1.4](PRD.md) is **build-ready** (3 PRD rounds + triage decision: build now). This page is the entry point for the first build session.

## Governing documents

1. [docs/PRD.md](PRD.md) — the requirements, registry resolutions, phases, and Appendix A state machines. **Start here.**
2. [docs/design/17-design-v5.md](design/17-design-v5.md) — the cleared architecture (rationale behind every requirement).
3. [docs/design/00-context-brief.md](design/00-context-brief.md) — founding intent.
4. Review archaeology: docs/design/06–25 (raw adversarial reviews + dispositions, all verbatim).

## Standing obligations for the build

- **Appendix A consistency audit:** Phase 1 implements the state machines as typed code with exhaustive transition tests, then runs a recorded audit against Appendix A; every difference is resolved by fixing the code or amending the appendix. Until then, Appendix A is authoritative.
- **Camino's own repo follows the validatable-repo profile** (PRD §6): devcontainer, one-command test, seeded fixtures — it must eventually be a repo Camino can operate on.
- **The medicine applies to the doctor:** Camino's own PRs get cross-family review; the Phase-0 attack suites (quarantine, egress/scrubbing, kill-point chaos) persist as CI.
- **PRD change control:** material changes need David's approval; architectural ones get a falsification pass.

## Prerequisites (before Phase 0)

- [x] GitHub repository created — public, personal account: https://github.com/hierosir1984/Camino — initial commit pushed (commits use the repo-local noreply identity)
- [ ] Node 22, Docker Desktop, Playwright installed
- [ ] Claude Code, Codex CLI, Grok Build CLI authenticated on David's subscriptions
- [ ] Funded API fallback accounts confirmed (Anthropic + OpenAI Console) — CAM-ROUTE-08 prerequisite
- [ ] xAI contractual sanctioned-path confirmation recorded at adapter onboarding (technical headless support already verified)

## Phase 0 — Spikes (PRD §7, in order)

1. Dispatch spike — one issue through each enabled adapter
2. PRD-to-plan probe — with David's review timed and question quality rated
3. Quarantine attack suite — all enumerated attacks rejected; persists as CI
4. Injection red-team baseline — every finding dispositioned
5. Validation-environment egress + scrubbing tests

Phase exits are gates, not calendars. Build sessions should read this page, then the PRD, and work the phase checklist.
