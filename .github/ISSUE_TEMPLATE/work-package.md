---
name: Work package
about: A build work package with acceptance criteria mapped to PRD requirement IDs
title: "WP-NNN · <short name>"
labels: wp
---

> **Phase:** 0|1 · **Track:** A–E · **Milestone:** <milestone>
> **Mapped requirement IDs:** CAM-…
> **Registry items (PRD §5):** —
> **Blocked by:** #NN (WP-NNN), …
> **Source:** docs/plan/phase-0-1-work-packages.md — quote the WP section verbatim below.

## Work package

<verbatim section from the approved plan: scope + Accept bullets>

## PRD _Accept_ criteria (verbatim, per mapped requirement)

> - **CAM-…** …

## Definition of done

- [ ] Every acceptance bullet in the Work package section demonstrably passes (fixtures/tests in CI where specified)
- [ ] PR carries a cross-provider falsification review (`reviewer.provider != implementer.provider`)
- [ ] David merges
