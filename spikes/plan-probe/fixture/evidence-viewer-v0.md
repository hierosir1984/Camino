# Mission PRD — Evidence viewer v0

> **Provenance (WP-002 probe fixture).** Assembled for the PRD-to-plan probe from Camino's real
> governing documents: docs/PRD.md v1.4 (CAM-CORE-07, CAM-CORE-05, CAM-MERGE-13, registry item 8,
> §6 technology defaults) and docs/design/17-design-v5.md §7.2. Quoted text is verbatim; the only
> authored additions are the mission-goal sentence, section framing, and the `[S*]` segment tags
> used for checklist mapping. Ambiguities in this PRD are therefore natural — the source text was
> written for the product record months before this probe existed, not planted to test a planner.

[S1] Build the v0 evidence viewer in Camino's GUI: render evidence packets so that merge approval
happens against inspectable evidence rather than agent claims, delivering CAM-CORE-07 at Phase-1
scope.

## Context — established repo facts (not obligations of this mission)

[S2] Repo layout: npm-workspaces monorepo — `packages/shared` (cross-package types),
`packages/core` (pure domain logic, import-fenced), `packages/daemon` (Node control plane; will
own the SQLite event log), `packages/gui` (React + Vite; currently an empty scaffold).

[S3] Technology defaults (PRD §6, verbatim): "TypeScript on Node 22 for daemon and GUI (largest
agent training corpus; Playwright-native); Fastify daemon; React + Vite GUI served by the daemon;
SQLite via better-sqlite3 (event tables + derived views; WAL mode); […] Playwright for probes."

[S4] Phase-1 scope (PRD CAM-CORE-07, verbatim): "Phase-1 scope is functional rendering (packet
contents + artifact previews); presentation polish follows."

[S5] No mission has ever run yet: no real evidence packets exist anywhere in the system today.

## Motivation — design rationale (context, not new obligations)

[S6] PRD CAM-CORE-07 rationale (verbatim): "Promoted from P2 at David's direction: approving
merges without inspectable evidence contradicts the product thesis, and verified outcomes are the
feedback loop that gap analysis and repair depend on."

[S7] Design §7.2 (verbatim): "Every packet item carries its own (SHA, base) identity, and the
ordering is explicit: worker-side checks bind to the worker head and are _advisory_; gating
evidence is produced only on Camino-authored candidates — the squash-rebuilt commit and the
constructed merge commits of §4.2 — so the evidence that licenses a merge describes exactly the
bits that land."

[S8] Design §7.2 (verbatim): "The packet is what the human approves against, the register cites,
and post-merge outcomes calibrate. The v0 GUI includes an evidence viewer."

## Requirements (this mission)

[S9] CAM-CORE-07 declaration (verbatim): "An evidence viewer renders evidence packets (schema
below) with artifact previews (logs, screenshots, traces)."

[S10] CAM-CORE-07 accept (verbatim): "every merge approval screen embeds the packet being
approved with its artifacts previewable (logs, screenshots, traces render inline or open locally)
and the gating/advisory distinction visible; no v1 merge is approvable without its packet."

[S11] Evidence-packet schema v1 (PRD registry item 8, verbatim): per attempt `{attempt_id,
issue_id, contract_hash, candidate_sha, base_sha, worker_head_sha, commands[{cmd, sha, base_sha,
class}], artifacts[{path, type, sha256, scrubbed, sha, base_sha, class}], checks[{name, sha,
base_sha, result, duration, class}], reviews[{model, family, verdict, summary, sha, base_sha,
class}], exclusions[{item, reason, sha, base_sha, class}], waivers[{register_ref, reason, actor,
sha, base_sha, class}], retries, failure_class, verdict, created_at}`

[S12] Registry item 8 continued (verbatim): "every item carries its own (sha, base_sha) identity
and a `class: advisory|gating` marker — worker-head evidence is advisory; only
Camino-authored-candidate evidence is gating".

[S13] Mission rollup (registry item 8, verbatim): `{mission_id, requirement_map: req_id→[gating
evidence refs], gate_record, per_issue_delivered}`

[S14] Registry item 8, closing (verbatim): "The viewer renders the advisory/gating distinction
and the exclusion/waiver lists."

## Adjacent surfaces — context for interface awareness (owned by other missions)

[S15] PRD CAM-CORE-05 (verbatim): "An escalation inbox lists everything awaiting David, each with
its purpose-built artifact (plan diff, evidence packet, question)." The inbox itself is a separate
mission.

[S16] PRD CAM-MERGE-13 (fragment, verbatim): a mission→main PR "carries the requirement checklist
and links to evidence packets as they accumulate". The PR lifecycle is a separate mission.
