# Camino

A **local-first mission control plane for autonomous software development**: a PRD
enters through a simple GUI; a planner constructs issues on an observable board;
coding agents on your existing subscriptions (Claude Code, Codex CLI, Grok Build CLI)
implement them in isolated workspaces; work flows through independent validation and
evidence-gated merges where **what was validated is bit-for-bit what lands**. Done is
observed, never declared.

**Status: Phase 0 (spikes).** The walking skeleton is being built work package by
work package — see the [build plan](docs/plan/phase-0-1-work-packages.md), the
[work-package issues](https://github.com/hierosir1984/Camino/issues), and the
[PRD](docs/PRD.md) (v1.4, build-ready). The design record (5 adversarial rounds,
cleared) lives in [docs/design/](docs/design/17-design-v5.md).

## Quickstart (development)

```sh
npm install
npm test          # one-command test: lint + typecheck + unit + fixture smoke
npm run gate      # Phase-0 entry gate: verifies BUILD.md prerequisites
```

Requires Node 22+. The repo follows the validatable-repo profile it will one day
demand of the repositories it operates on: devcontainer, one-command test, seeded
fixtures.

## Layout

| Path              | What it is                                                          |
| ----------------- | ------------------------------------------------------------------- |
| `packages/shared` | Cross-package types + schemas (requirement IDs, events, DTOs)       |
| `packages/core`   | Pure domain logic — no I/O, enforced by a CI lint fence             |
| `packages/daemon` | The control plane: server, adapters, quarantine, validation, merges |
| `packages/gui`    | React + Vite board, inbox, evidence viewer (served by the daemon)   |
| `fixtures/`       | Seeded fixtures (sample repo, attack corpora as they land)          |
| `docs/`           | PRD, design record, build plan, runbooks                            |

## How this repo is built

Proto-Camino: each work package is a GitHub Issue with acceptance criteria mapped to
PRD requirement IDs; an agent implements it on a `wp/NNN-*` branch; a reviewer from a
**different model provider** critiques the PR; David merges. The medicine applies to
the doctor.

License: [Apache-2.0](LICENSE).
