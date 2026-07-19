# 26 · Appendix A consistency audit (WP-101)

> **Status: recorded, four amendment proposals pending David.** This is the BUILD.md standing
> obligation: Phase 1 implements the Appendix A state machines as typed code with exhaustive
> transition tests, then walks a recorded code-vs-appendix diff. Every difference below is resolved
> by (a) the code encoding the appendix faithfully, with the encoding noted, or (b) a **proposed
> appendix amendment**, which per PRD change control needs David's approval before the PRD text
> changes. **Until the proposals are dispositioned, Appendix A as written stays authoritative**; the
> code encodes the literal text everywhere except where the text is internally inconsistent, and
> each such point is flagged below.
>
> Audited: [PRD v1.4 Appendix A](../PRD.md) (the normative table; design v5 §4.6 is an explicit
> sketch deferring to it). Implementation: `packages/core/src/{machine,mission,issue,attempt,views}.ts`,
> `packages/daemon/src/{event-store,transition-recorder}.ts`, `packages/shared/src/event-log.ts`.
> Date: 2026-07-19.

## 1. How the code encodes the appendix (conventions)

The audit walks rows by anchor. **Row refs** number each appendix table top to bottom: `A.1#3` is
the third data row of the A.1 table. A letter suffix (`A.1#3a`/`A.1#3b`) means one appendix row is
encoded as several guard-split code rows because the appendix row itself branches ("execution slot
free, else `queued`"); the splits are exhaustive and mutually exclusive, so together they are that
row. Every code row carries its ref as data, and the row-coverage test
(`appendix-coverage.test.ts`) fails if any row lacks a test vector or any vector names a
nonexistent row — coverage of "every legal Appendix A row" is mechanical, not curated.

Encoding conventions, applied uniformly:

1. **Facts become attested payload fields.** Every factual clause in a row's event or guard column
   ("checklist rendered", "kill-confirm executed", "freshness holds") is a payload field the caller
   must set, and the row's named guard checks it. A transition submitted without its facts is
   refused and logged — the machine never absorbs an unattested precondition.
2. **Recorded context is the recorder's testimony, not the caller's claim.** Four guard inputs are
   facts the log itself must supply: the manual-resume target ("prior state **(recorded)**"), the
   current candidate SHA and the bound approval SHA (A.4#4), and the failure counters. The machines
   declare these (`MISSION_CONTEXT_ENRICHMENT` / `ISSUE_CONTEXT_ENRICHMENT`) and the daemon
   recorder always overwrites them from its derived view before running the transition. This is how
   "approvals never transfer between SHAs" is enforced mechanically: a rebuild clears the recorded
   binding, so a stale approval or a push of an unapproved SHA fails its guard and is logged.
3. **Cross-entity guards are attested by the caller for now.** Guards that read another entity's
   state ("mission in `executing`", "all deps merged", "sequential-per-mission slot free", FIFO
   order) arrive as caller attestations; the mission↔issue↔attempt linkage model that would let the
   recorder verify them itself lands with WP-103/104, and the schedulers that make them true are
   WP-103/119. The machine still refuses when the attestation is absent or false.
4. **Where things live** (plan §1.1): states, events, guards, and the transition tables are pure
   typed code in `core`; the envelope (actor, cause, payload) and the append-only store interface
   are `shared`; the SQLite log and the recorder are `daemon`. The plan's note that "event types"
   sit in `shared` is satisfied by the envelope record type; the domain event unions sit with the
   machines in `core`, which WP-101's own text specifies.

Acceptance mapping: every state transition is an event with actor/cause/payload and derived views
rebuild from the log alone — `views.ts` folds + `transition-recorder.test.ts` ("rebuilds the
identical view from the log alone"), store append-only enforced by schema triggers even against raw
connections (`event-store.test.ts`). Illegal transitions rejected **and logged** — rejected rows
with codes, asserted in "rejects AND logs…". Exhaustive legal rows incl. `queued`, `paused-urgent`,
`re-routed`, budget-breach, pre-start recovery, A.4 archival — the coverage harness plus dedicated
recorder walks. Core dependency fence live in CI with trip fixtures — `tests/core-fence.test.ts`,
now including `better-sqlite3` and `@camino/daemon` probes.

## 2. Row-by-row walk

### A.1 mission, integration route (24 rows → 26 code rows)

| Appendix row | Code | Note |
|---|---|---|
| #1 creation (PRD intake / re-routed per A.1b) | `A.1#1` | `source` payload; a re-routed successor carries `reroutedFrom` + envelope cause referencing the quick-task record. |
| #2 plan constructed + review | `A.1#2` | Review attachment + checklist rendered both attested. |
| #3 approve → approved / queued | `A.1#3a`/`3b` | Guard split; a cyclic DAG matches neither split → refused (WP-110 rejects pre-approval). |
| #4 reject/edit → draft | `A.1#4` | Shared verbatim with A.1b (same row object). |
| #5 queued → approved (FIFO) | `A.1#5` | `fifoHead` attested; FIFO ordering itself is the WP-103 scheduler's. |
| #6 branch+PR → executing | `A.1#6` | Onboarding checks attested. |
| #7 gates green → awaiting | `A.1#7` | All four event-column conjuncts + A.4#2 fold-first + A.4#3 rollup + freshness attested; candidate SHA recorded here. |
| #8/#9 gate red | `A.1#8`/`#9` | Split on repair-fits-scope; repair issues are created via issue row `A.2#1c`. |
| #10 approval → merging | `A.1#10` | Authority ∈ {david, tier-2}; binds (candidate SHA, packet hash); stale-SHA approvals refused via recorded context (A.4#4). |
| #11 reject → executing | `A.1#11` | Reason required (repair/replan work from it is planner behavior, WP-110/111). |
| #12/#13 rebuild green/red | `A.1#12`/`#13` | One physical event, split on the verdict; green clears the approval binding (new approval required). |
| #14 ExternalEdit → paused-external | `A.1#14` | — |
| #15 urgent claims lane → paused-urgent | `A.1#15` | — |
| #16 any active, David pauses | `A.1#16` | Includes `paused-manual` itself (literal "any active"); the view keeps the **first** pausedFrom so a re-pause cannot lose the resume target. |
| #17 resume → prior state (recorded) | `A.1#17` | Target derived from recorder-enriched `resumeTo`; absent/non-active targets refused. |
| #18 escalation → escalated | `A.1#18` | — |
| #19 blocker → blocked | `A.1#19` | — |
| #20 pause resolved → executing | `A.1#20` | One row for both real-world variants, as in the appendix. |
| #21 answered/cleared → executing | `A.1#21` | — |
| #22 push confirmed → complete(/with-residue) | `A.1#22a`/`22b` | Split on the descoped list; pushed SHA must equal the **recorded** approved SHA. |
| #23 rebuilds exhausted → escalated | `A.1#23` | Bound = 2 (registry item 1). |
| #24 abandon → abandoned | `A.1#24` | "Intent ledger untouched" is structural in core (no ledger surface); CAM-CANON-01 enforcement is WP-109. |

### A.1b mission, quick-task route (12 rows + 8 inherited → 22 code rows)

Inherited rows (`A.1#4, #5, #16, #17, #18, #19, #21, #24`) are the **same row objects** in both
tables, so "with the same guards" holds by construction. The preamble's "escalated/blocked and
their recoveries" is read as inheriting both the entry rows (#18/#19) and the recovery row (#21) —
a quick task can hit an infra blocker too (interpretation, finding F6).

Own rows: `A.1b#1` intake; `#2` contract + mini review (observability adjudicated attested); `#3a/b`
approve with the CAM-MERGE-01 gates (risk low ∧ neutral concurred ∧ single issue) required for
*either* split; `#4` single-issue execution starts; `#5` validation green at the main candidate
(packet + A.4#3 rollup + freshness-vs-main attested); `#6a/b` validation red → executing until the
4th failure escalates (recorded counter); `#7` approval by David or tier-3 only, bound to
(SHA, packet hash); `#8` reject → executing; `#9` rebuild green → awaiting (new approval); `#10`
rebuilds exhausted (2) → escalated; `#11` push confirmed → `complete`, refusing any descoped
residue (fail-closed, F15); `#12` any active + CAM-MERGE-01 gate violated → `re-routed` (terminal),
work summary + branch carry-over attested, successor mission created via `A.1#1`.

Route reachability is tested as exact expected gaps: `re-routed` unreachable on the integration
route; `complete-with-residue`, `paused-external`, `paused-urgent` unreachable on the quick route.

### A.2 issue (24 rows → 29 code rows)

`A.2#1a/1b` creation at plan approval → ready / waiting-deps; `#1c` repair-issue creation (ready,
within mission scope — the creation half of A.1#8/A.1#11 and of the mission-level fast-subset row);
`#2` all-deps-merged → ready; `#3` dispatch (sequential slot free ∧ mission executing) → claimed;
`#4` window exhausted → queued-quota; `#5` quota frees → ready (**never counts toward failure or
family-switch counters** — enforced in the counter fold and tested); `#6` worker starts (lease
valid) → implementing; `#7a/7b` pre-start attempt terminal → ready, or queued-quota for quota; `#8`
final head + quarantine pass → validating; `#9a/9b` attempt fails → ready until the 4th failure
escalates (recorded counter; family switch after 2 = `retryPolicy` advice to the scheduler, not a
state change); `#10` budget breach + kill-confirm → escalated (kill-and-escalate, no retry row
exists — CAM-EXEC-03); `#11` attempt quota-blocked → queued-quota; `#12` attempt cancelled (summary
written) → ready; `#13` gates green + freshness → merge-pending; `#14` validation fails (repair
policy) → ready; `#15` infra-blocked → blocked; `#16` approval (David, or tier-1 **on
mission-branch targets only**) + base check → merged; `#17` branch advanced → ready; `#18`
mission-level fast-subset failure → encoded as `#1c` creation (the "further merges block until
green" clause is WP-119 scheduler policy); `#19` incompatible contract edit (any active) →
replanning; `#20a/20b` replan complete → ready / waiting-deps; `#21a/21b` escalation answered →
ready / cancelled; `#22` David cancels (any active) → cancelled; `#23` block resolved → ready;
`#24` cleanup failure (any active) → blocked, cause rides the envelope.

### A.3 attempt + A.4#5 archival (8 rows → 9 code rows)

`A.3#1` dispatch with lease granted, generation ≥ 1 (monotonicity per environment is the WP-114
lease store, registry item 5); `#2` heartbeat lapse + kill-confirm → expired; `#3` worker completes
+ final head fetched → submitted; `#4` cancel (David/urgent/pause/edit) settled by checkpoint or
kill-confirm, summary written → cancelled; `#5` budget breach + kill-confirm → killed-budget; `#6`
rate limit → quota-blocked; `#7a/7b` verdict → succeeded / failed (failure class required); `#8`
(= A.4#5) each of the six terminals + the single archival step → `archived`, guard enforcing the
strict sub-step order archive-written < ledger-row < workspace-destroyed with quotas attested.
`archived` has no outgoing rows, so a second archival is an illegal transition — exactly once, by
construction, and tested through the recorder.

### A.4 ordering guarantees

| Item | Where |
|---|---|
| 1 advisory/gating evidence classes | Evidence-packet domain — WP-116. Out of WP-101 scope, recorded here. |
| 2 fold before candidate construction (A.1 only) | `foldOnBranch` attested in the `A.1#7` guard; absent on the quick route by definition. |
| 3 rollup + PR links before awaiting reachable | `rollupAndPrPopulated` attested in `A.1#7` **and** `A.1b#5` (both routes). |
| 4 packets immutable; approvals bind to (SHA, packet hash), never transfer | Binding half mechanized: approval records the pair, rebuild clears it, stale approvals and unapproved pushes are refused and logged (recorder test "mechanizes A.4#4"). Packet immutability is WP-116. |
| 5 archival exactly once, strictly ordered | Row `A.3#8` as above. |
| Environment ownership (one fenced owner, CAM-STATE-04) | Lease/environment fencing — WP-114/115. Not a single-entity transition; recorded here. |

## 3. Findings

**Faithful encodings needing no decision** (conventions in §1 cover them): guard-split rows;
attested facts; recorded-context enrichment; one-event-two-outcomes rows (#12/#13, #7a/#7b);
self-pause kept legal with first-pause-wins bookkeeping (F5); A.1#24's structural ledger guard
(F13); A.2#2 partial-dependency events guard-refuse — the WP-119 scheduler should emit only at full
readiness (F11); A.2#18 encoded as creation row `A.2#1c` (F12); A.3#4's "structured summary
written" moved from the target cell into the guard (F23); A.1b#11 refuses a descoped residue
rather than landing it silently (F15); deferred cross-entity verification (F10/F24), FIFO (F16),
lease monotonicity (F17), environment fencing (F18), evidence classes/immutability (F19).

**F7 — minor text observation, no behavior change:** A.1b#7 says approval "binds to candidate SHA";
A.4#4 says approvals bind to **(candidate SHA, packet hash)** on both routes and the code follows
A.4#4. If David wants the texts aligned, adding "and packet hash" to A.1b#7 is editorial.

### Proposed amendments (need David — change control)

**AMEND-1 · Quick-task issue has no terminal row.** A.1b says the single issue "executes per A.2 …
A.2's merge rows do not apply", and issue terminals are only {merged, cancelled}. So a quick task
that lands on main leaves its issue stuck in `merge-pending` forever — no row carries it to
`merged` (the A.2#16 target "(into mission branch; fast subset runs)" cannot apply; there is no
mission branch). Today the code is literal: nothing transitions that issue, and per-issue
*delivered* flags at mission resolution are flags, not states. **Proposal:** add to A.2 a row
"`merge-pending` | quick-task mission push confirmed (A.1b `merging → complete`) | — | `merged`",
scoped to quick-task issues. Until approved, the machines stay literal and the walking-skeleton
daemon must not strand on it (quick tasks land at mission level regardless).

**AMEND-2 · "Execution-bearing (approved through merging)" cannot be a bare state set.** The
serialization preamble frees the slot when a mission leaves that four-state span. But the interrupt
states are entered *from inside* the span while branches and workspaces still exist, and the
preamble's own rationale (intake/planning "touch no workspace") puts them on the slot-holding side;
if pausing freed the slot, a queued mission would activate and the paused one would resume into a
second workspace-holding mission on the same repo — contradicting "at most one". Meanwhile
`paused-manual` is also reachable from draft/planned/queued (any-active pause), where no slot is
held. So slot-holding is a function of (state, paused-from), not a set. **Code ships**
`isExecutionBearing(state, pausedFrom?)`: true for approved/executing/awaiting/merging and for
paused-external/paused-urgent/escalated/blocked (only enterable from the span), and for
paused-manual exactly when the recorded paused-from state was slot-holding. Nothing consumes it
until WP-103, so ratifying (or correcting) this reading gates nothing yet. **Proposal:** amend the
preamble parenthetical to "(approved through merging, including interrupt states entered from that
span; a manually paused mission holds the slot iff it held it when paused)".

**AMEND-3 · Quick route lacks a red-rebuild row.** A.1 has `merging | rebuilt candidate red | — |
executing` (#13). A.1b lists only the green rebuild (#9) and "rebuilds exhausted (2)" (#10) — it
does not inherit #13, so a quick-task rebuild that comes back red with fewer than 2 rebuilds has no
transition; the mission would sit in `merging` until the exhaustion event. Code is literal (no
row). **Proposal:** add "`merging` | rebuilt candidate red | — | `executing` (repair attempt)" to
A.1b, mirroring #13.

**AMEND-4 · Validation failures have no escalation bound on the issue machine.** A.2#14 sends every
validation failure back to `ready` with no counter clause, while A.1b#6 says quick-task validation
red follows "retry policy per A.2 (family switch after 2 failures)" and escalates at 4 — implying
validation failures feed the same counter. The code takes that implication for the *counter*
(validation failures increment it, quota waits never do), so a later attempt failure escalates at
the recorded threshold — but stays literal for the *row*: validation failure #4 itself still goes
to `ready`, because no escalation target is listed from `validating`. An issue alternating
validation failures could loop unboundedly. **Proposal:** extend A.2#14 with "; 4 failures →
`escalated`" (same recorded counter), making the issue machine consistent with A.1b#6.

## 4. Verdict

With the conventions of §1, the three machines, the A.1b overlay, and the A.4 guarantees are
encoded row-for-row, every row is exercised by the mechanical coverage harness, and the four
genuine spec defects found by the walk are recorded above as amendment proposals. **Appendix A
remains authoritative**; on David's disposition of AMEND-1..4 this audit is updated, the approved
amendments land in the PRD appendix, and the corresponding rows/tests are added in the same change.
