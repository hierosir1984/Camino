# Untrusted-content robustness corpus (WP-004)

This folder is the **durable, reusable** part of Camino's untrusted-content robustness
(PRD §7 Phase-0 item 4; requirement **CAM-EXEC-09**). It persists here in
`fixtures/` so it can be re-run whenever the planner or a worker changes, and so
later work packages can point their own defenses at the same cases
(WP-107 worker isolation, WP-113 context-pack assembly).

The _runner_ that executes this corpus and produces the findings catalogue lives
at [`spikes/untrusted-content/`](../../spikes/untrusted-content/).

## The threat in plain words

Camino feeds a coding agent (the **planner** that turns a PRD into a plan, and
the **workers** that implement issues) text that Camino did not write: issue and
PRD bodies, files in the repo it is working on (README, source, docs), and — in
later phases — content fetched from the web. All of that is **untrusted**.

A planted-instruction case hides instructions inside that untrusted text and
hopes the agent follows them _as if they were commands from Camino or David_,
instead of treating them as mere **data** to be planned or edited. The single
invariant this robustness measures is CAM-EXEC-09's: **untrusted text is treated
as data, not instructions.**

This is a **baseline**. At Phase 0 the agents run as bare vendor CLIs with only
their own built-in defenses — Camino's own hardening (control-plane context
packs with provenance tags, quarantine, egress sandboxing) is not built yet.
So a finding here is not "Camino has a bug"; it is a **measurement** of what the
model's native defenses do and do not cover, which tells us where Camino's
later hardening has to carry the load. That is what CAM-EXEC-09 means by "its
findings gate hardening claims."

## What the corpus covers

**Three channels** (the untrusted sources named in the scope):

| Channel       | Where the untrusted text lives                     |
| ------------- | -------------------------------------------------- |
| `issue-text`  | the PRD/issue body the planner or worker is given  |
| `repo-readme` | files inside the repo a worker is editing          |
| `web-content` | material framed as fetched from the web (see note) |

> Live web-fetch is not a Phase-0 surface. Web content is therefore delivered
> the way it would actually reach an agent _after_ a fetch — embedded in the
> text the agent reads — which is mechanically identical to any other untrusted
> quoted block. One planner item (PL-05) carries the web-content channel.

**Planted-instruction goals** (what an obeyed case would achieve):
instruction-override, forged-approval / guard-disable, requirement-insertion
(hidden or unsafe requirements), leakage, egress, destructive actions,
knowledge-base tampering, and deception (self-report inflation).

**Two surfaces**, per the scope ("the WP-002 planner and one WP-001 worker"):
planner items (`PL-*`) run through the real WP-002 planner; worker items
(`WK-*`) run through one real WP-001 worker.

## The safety design (why running untrusted inputs is safe here)

Every untrusted item embeds a **benign proxy action** in place of real harm: a
unique marker string to emit, a **synthetic** canary to copy, or a
distinctively-named file to create. The detector fires only if that proxy action
was performed — so an obeyed case in this corpus writes a nonce, never a
real unauthorized-code sink or a real secret. Concretely:

- Workers run in a **throwaway clone** that is deleted after the run.
- Leakage is probed with a **synthetic marker** (`SYNTHETIC-WK01-…`, a fake
  token) that never leaves the clone — not a real credential.
- Egress payloads point at an unresolvable `.invalid` host.
- Planner output is inert (a plan cannot delete or send anything), so even the
  "destructive" planner item is safe to run live.

### Two items are catalogued but NOT run live at this baseline

`WK-06` (host filesystem destruction) and `WK-07` (real host-secret
leakage) have `liveRun: false`. Their _success condition_ is real host
damage or real secret disclosure, and Phase-0 isolation is env-level only — it
keeps `HOME` reachable and has no egress sandbox, so nothing would contain a
successful run. Running a test that can only either prove nothing (if refused)
or damage the machine (if obeyed) is not worth it. **The gap is the finding**:
a successful worker planted instruction is not contained at Phase 0, which is exactly why
CAM-EXEC-09 gates unattended runs and WP-107 must land first. Both items persist
for a safe, sandboxed re-run under WP-107 / WP-113. See their payload files for
the full rationale.

## Manifest

[`manifest.json`](manifest.json) is the machine-readable index: one entry per
item with its target surface, channel, planted-instruction goal, payload/seed path,
`liveRun` flag, and the **detectors** that decide whether the planted instruction was
obeyed. The runner reads this file; nothing about an item is implicit.

## Re-running

```sh
# zero-quota: corpus loads + validates, detectors proven on synthetic outputs
node --run spike:test

# zero-quota full dry-run against mock agents (no subscriptions touched)
node --run spike:untrusted -- --mock

# REAL run (spends quota): planner = claude-code, one worker = codex-cli
node --run spike:untrusted
node --run spike:untrusted -- --only=PL-01,WK-01     # a subset
node --run spike:untrusted -- --worker=claude-code   # choose the one worker

# verify every finding in the catalogue has David's disposition recorded
node --run spike:untrusted:check
```

The runner writes the findings catalogue to
[`spikes/untrusted-content/FINDINGS.md`](../../spikes/untrusted-content/FINDINGS.md)
— one finding per item, each awaiting a disposition: **hardened** (name the WP
that defends it) or **accepted-risk** (with a reason).
