# 26 · Appendix A consistency audit (WP-101)

> **Status: recorded, five amendment proposals pending David.** This is the BUILD.md standing
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

Encoding conventions, applied uniformly (items 5–7 were hardened by review round 1 — §4):

1. **Facts become attested payload fields.** Every factual clause in a row's event or guard column
   ("checklist rendered", "kill-confirm executed", "freshness holds") is a payload field the caller
   must set, and the row's named guard checks it. A transition submitted without its facts — or
   with a malformed shape; guards are total and a throwing guard counts as refusal — is refused and
   logged. The machine never absorbs an unattested precondition.
2. **Recorded context is the recorder's testimony, not the caller's claim.** Guard inputs the log
   itself must supply — the manual-resume target ("prior state **(recorded)**"), the current
   candidate **(SHA, packet hash) pair** and the bound approval SHA (A.4#4), and the failure
   counters — are declared by the machines (`MISSION_CONTEXT_ENRICHMENT` /
   `ISSUE_CONTEXT_ENRICHMENT`) and always overwritten from the derived view inside the decision
   path. This is how "approvals bind to (candidate SHA, packet hash) and never transfer" is
   enforced mechanically: gate-green records the pair, a rebuild replaces it and clears the
   binding, and a stale approval, a wrong packet hash, or a push of an unapproved SHA fails its
   guard and is logged.
3. **Cross-entity guards are attested by the caller for now.** Guards that read another entity's
   state ("mission in `executing`", "all deps merged", "sequential-per-mission slot free", FIFO
   order) arrive as caller attestations; the mission↔issue↔attempt linkage model that would let the
   recorder verify them itself lands with WP-103/104, and the schedulers that make them true are
   WP-103/119. The machine still refuses when the attestation is absent or false.
4. **Where things live** (plan §1.1): states, events, guards, the transition tables, and the whole
   decision path (`decide.ts`) are pure typed code in `core`; the envelope (actor, cause, payload)
   and the append-only store interface are `shared`; the SQLite log and the recorder are `daemon`.
   The plan's note that "event types" sit in `shared` is satisfied by the envelope record type; the
   domain event unions sit with the machines in `core`, which WP-101's own text specifies.
5. **Reserved payload fields; David rows bind to the envelope actor.** "type" and "actor" belong to
   the decision layer: a payload whose CANONICAL form carries either is refused as
   `malformed-payload` (logged). The canonical form is the single authority — see item 7; a key an
   exotic object hides from the one observation is absent from what is decided and persisted, so it
   cannot redirect anything. The envelope actor is injected into the machine event, and every row
   whose appendix event column names David ("David approves/rejects/pauses/resumes/answers/cancels/
   abandons", David-authority approvals, David-reason attempt cancels) guards `actor === "david"`.
6. **One decision path.** `decideTransition(view, input)` is the only place a request becomes an
   outcome; the recorder appends what it decides, and `verifyReplay` re-derives every recorded row
   through the same function — comparing outcome, target, source state, rejection code, and the
   recorded payload (enrichment included) — so recorder and verifier cannot drift.
7. **Guards evaluate the persisted representation — one observation.** The recorder snapshots the
   request once and observes the caller's payload object exactly once, by JSON serialization;
   everything downstream (reserved-field refusal, guards, the persisted row, every replay) derives
   from that canonical form. A time-varying object can make any multi-read protocol disagree with
   itself; with a single observation there is no second read to diverge from. A payload JSON
   cannot hold as a plain object — or whose traps throw during the observation — becomes a
   reserved-key stand-in that the decision path refuses and logs (replay-stable by construction).
   Numeric guard inputs are integer-validated (no coercion).
8. **Atomic single-writer append.** The store's append is a compare-and-swap: inside one
   `BEGIN IMMEDIATE` transaction it verifies the highest seq still equals the writer's known value
   and inserts, so a second writer cannot interleave between check and append. Detection with a
   hard refusal; the durable cross-process recovery lock remains WP-104 (CAM-STATE-03).

Acceptance mapping: every state transition is an event with actor/cause/payload and derived views
rebuild from the log alone — `views.ts` folds + `transition-recorder.test.ts` ("rebuilds the
identical view from the log alone"), store append-only enforced by schema triggers on every
connection, with tamper-evident refusal to open a version-claiming database whose table or triggers
are missing (`event-store.test.ts`). Illegal transitions rejected **and logged** — rejected rows
with codes, asserted in "rejects AND logs…". Exhaustive legal rows incl. `queued`, `paused-urgent`,
`re-routed`, budget-breach, pre-start recovery, A.4 archival — the coverage harness, the
PRD-parsing manifest anchor (`tests/appendix-manifest.test.ts`), and dedicated recorder walks. Core
dependency fence live in CI with trip fixtures — `tests/core-fence.test.ts`, including
`better-sqlite3`, `@camino/daemon`, ambient-global (fetch/WebSocket/timers), global-object-alias,
parent-traversal, and type-level `import()` probes (the dependency fence covers type-only imports
too).

## 2. Row-by-row walk

### A.1 mission, integration route (24 rows → 26 code rows)

| Appendix row | Code | Note |
|---|---|---|
| #1 creation (PRD intake / re-routed per A.1b) | `A.1#1` | `source` payload; a re-routed successor must carry `reroutedFrom` (guarded). Repeating the reference in the envelope cause is convention, not enforced. |
| #2 plan constructed + review | `A.1#2` | Review attachment + checklist rendered both attested. |
| #3 approve → approved / queued | `A.1#3a`/`3b` | "Plan + checklist": checklist approval attested alongside the DAG check; guard split on the slot; a cyclic DAG matches neither split → refused (WP-110 rejects pre-approval). |
| #4 reject/edit → draft | `A.1#4` | Shared verbatim with A.1b (same row object). |
| #5 queued → approved (FIFO) | `A.1#5` | `fifoHead` attested; FIFO ordering itself is the WP-103 scheduler's. |
| #6 branch+PR → executing | `A.1#6` | Branch created + mission PR created + onboarding checks all attested. |
| #7 gates green → awaiting | `A.1#7` | All four event-column conjuncts + A.4#2 fold-first + A.4#3 rollup + freshness attested; the candidate (SHA, packet hash) pair is recorded here. |
| #8/#9 gate red | `A.1#8`/`#9` | Split on repair-fits-scope; repair issues are created via issue row `A.2#1c`. |
| #10 approval → merging | `A.1#10` | Authority ∈ {david (actor-bound), tier-2}; binds the recorded (candidate SHA, packet hash) pair; a stale SHA or non-candidate packet hash refuses (A.4#4). |
| #11 reject → executing | `A.1#11` | Reason required (repair/replan work from it is planner behavior, WP-110/111). |
| #12/#13 rebuild green/red | `A.1#12`/`#13` | One physical event, split on the verdict; green records the new (SHA, packet hash) pair and clears the approval binding (new approval required). |
| #14 ExternalEdit → paused-external | `A.1#14` | — |
| #15 urgent claims lane → paused-urgent | `A.1#15` | — |
| #16 any active, David pauses | `A.1#16` | Includes `paused-manual` itself (literal "any active"); the view keeps the **first** pausedFrom so a re-pause cannot lose the resume target. |
| #17 resume → prior state (recorded) | `A.1#17` | Target derived from recorder-enriched `resumeTo`; absent/non-active targets refused. |
| #18 escalation → escalated | `A.1#18` | — |
| #19 blocker → blocked | `A.1#19` | — |
| #20 pause resolved → executing | `A.1#20` | One row for both real-world variants, as in the appendix. |
| #21 answered/cleared → executing | `A.1#21a`/`21b` | Disjunctive event column split onto its two sources (as A.2#21 vs #23): an escalation is answered BY DAVID (actor-bound); a blocker clears by the obstacle going away, any observer. |
| #22 push confirmed → complete(/with-residue) | `A.1#22a`/`22b` | Landed-ON-MAIN attested; split on the descoped list (validated as a string array); pushed SHA must equal the **recorded** approved SHA. |
| #23 rebuilds exhausted → escalated | `A.1#23` | Bound = 2 (registry item 1). |
| #24 abandon → abandoned | `A.1#24` | "Intent ledger untouched" is structural in core (no ledger surface); CAM-CANON-01 enforcement is WP-109. |

### A.1b mission, quick-task route (12 rows + 8 inherited → 22 code rows)

Inherited rows (`A.1#4, #5, #16, #17, #18, #19, #21, #24`) are the **same row objects** in both
tables, so "with the same guards" holds by construction. The preamble's "escalated/blocked and
their recoveries" is read as inheriting both the entry rows (#18/#19) and the recovery row (#21) —
a quick task can hit an infra blocker too (interpretation, finding F6).

Own rows: `A.1b#1` intake; `#2` contract + mini review (observability adjudicated attested); `#3a/b`
David-actor approval with the CAM-MERGE-01 gates (risk low ∧ neutral concurred ∧ single issue)
required for *either* split; `#4` single-issue execution starts (target-is-main-candidate + no-branch/no-fold attested); `#5` validation green at the main
candidate — packet populated + A.4#3 rollup + the preamble's validation scope (full contract checks
∧ repo fast suite) + freshness-vs-main attested, with the candidate (SHA, packet hash) pair
recorded; `#6a/b` validation red → executing until the 4th failure escalates (recorded counter);
`#7` approval by David (actor-bound) or tier-3 only, bound to the recorded (SHA, packet hash) pair;
`#8` reject → executing; `#9` rebuild green → awaiting with the new pair (new approval); `#10`
rebuilds exhausted (2) → escalated; `#11` push confirmed → `complete` with the landed-on-main attestation, refusing any descoped
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
exists — CAM-EXEC-03); `#11` attempt quota-blocked → queued-quota; `#12` attempt cancelled — scoped to the appendix's
preemption/pause causes (a David cancel ends the issue via `#22`; an edit cancel goes through
`#19` replanning) — summary written → ready; `#13` gates green + freshness → merge-pending; `#14` validation fails (repair
policy) → ready; `#15` infra-blocked → blocked; `#16` approval + base check → merged, **for
mission-branch targets only, every authority** — the row's own target cell says "(into mission
branch)", and A.1b denies quick-task (main-candidate) issues any merge row at all, which is
AMEND-1; David-authority approvals are actor-bound and tier-1 is the only other authority;
`#17` branch advanced → ready; `#18`
mission-level fast-subset failure → encoded as `#1c` creation (the "further merges block until
green" clause is WP-119 scheduler policy); `#19` incompatible contract edit (any active) →
replanning; `#20a/20b` replan complete under contract v(n+1) (attested) → ready / waiting-deps; `#21a/21b` escalation answered →
ready / cancelled; `#22` David cancels (any active) → cancelled; `#23` block resolved → ready;
`#24` cleanup failure (any active) → blocked, cause rides the envelope.

### A.3 attempt + A.4#5 archival (8 rows → 9 code rows)

`A.3#1` dispatch with lease granted, generation ≥ 1 (monotonicity per environment is the WP-114
lease store, registry item 5); `#2` heartbeat lapse + kill-confirm → expired; `#3` worker completes
+ final head fetched → submitted; `#4` cancel — only the four listed reasons are legal at runtime,
a David-reason cancel is actor-bound — settled by checkpoint or kill-confirm, summary written →
cancelled; `#5` budget breach + kill-confirm → killed-budget; `#6` rate limit → quota-blocked;
`#7a/7b` quarantine+validation verdict (completeness attested) → succeeded / failed (failure class required); `#8` (= A.4#5) each of the six
terminals + the single archival step → `archived`, guard enforcing quotas, the ledger row
referencing the written archive, and the strict sub-step order archive-written < ledger-row <
workspace-destroyed.
`archived` has no outgoing rows, so a second archival is an illegal transition — exactly once, by
construction, and tested through the recorder.

### A.4 ordering guarantees

| Item | Where |
|---|---|
| 1 advisory/gating evidence classes | Evidence-packet domain — WP-116. Out of WP-101 scope, recorded here. |
| 2 fold before candidate construction (A.1 only) | `foldOnBranch` attested in the `A.1#7` guard; absent on the quick route by definition. |
| 3 rollup + PR links before awaiting reachable | `rollupAndPrPopulated` attested in `A.1#7` **and** `A.1b#5` (both routes). |
| 4 packets immutable; approvals bind to (SHA, packet hash), never transfer | Pair binding mechanized end to end: gate-green/rebuild record the candidate's (SHA, packet hash), approval must match BOTH members, rebuild clears the binding, and stale approvals / wrong hashes / unapproved pushes are refused and logged (recorder test "mechanizes A.4#4"). Packet content immutability is WP-116. |
| 5 archival exactly once, strictly ordered | Row `A.3#8` as above. |
| Environment ownership (one fenced owner, CAM-STATE-04) | Lease/environment fencing — WP-114/115. Not a single-entity transition; recorded here. |

## 3. Findings

**Faithful encodings needing no decision** (conventions in §1 cover them): guard-split rows;
attested facts; recorded-context enrichment; one-event-two-outcomes rows (#12/#13, #7a/#7b);
self-pause kept legal with first-pause-wins bookkeeping (F5); A.1#24's structural ledger guard
(F13); A.2#2 partial-dependency events guard-refuse — the WP-119 scheduler should emit only at full
readiness (F11); A.2#18 encoded as creation row `A.2#1c` (F12); A.3#4's "structured summary
written" moved from the target cell into the guard (F23); A.1b#11 refuses a descoped residue
rather than landing it silently (F15); David-actioned rows actor-bound and enum payloads
runtime-validated (§1 item 5); the A.1b preamble's quick validation scope and landing-authority
clauses guarded on `A.1b#5`/`#7`; re-route references guarded on `A.1#1`; the A.4#5 "ledger row
references it" clause attested on `A.3#8`; deferred cross-entity verification (F10/F24), FIFO
(F16), lease monotonicity (F17), environment fencing (F18), evidence classes and packet-content
immutability (F19).

**F7 — minor text observation, no behavior change:** A.1b#7 says approval "binds to candidate SHA";
A.4#4 says approvals bind to **(candidate SHA, packet hash)** on both routes and the code follows
A.4#4 (both members recorded and matched). If David wants the texts aligned, adding "and packet
hash" to A.1b#7 is editorial.

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

**AMEND-5 (found by review round 3) · A.1b#12 demands branch carry-over from states that have no
branch.** The re-route row applies from "any active" with the guard "work summary + branch carried
over", but the preamble's own rationale says intake/planning states (draft/planned/queued) touch no
workspace — there is no branch to carry from them. The attestation is unsatisfiable-or-vacuous in
those source states. Code stays literal (the attestation is required from every active state).
**Proposal:** amend the A.1b#12 guard to "work summary carried over; branch carried over where the
task had entered execution".

**AMEND-4 · Validation failures have no escalation bound on the issue machine.** A.2#14 sends every
validation failure back to `ready` with no counter clause, while A.1b#6 says quick-task validation
red follows "retry policy per A.2 (family switch after 2 failures)" and escalates at 4 — implying
validation failures feed the same counter. The code takes that implication for the *counter*
(validation failures increment it, quota waits never do), so a later attempt failure escalates at
the recorded threshold — but stays literal for the *row*: validation failure #4 itself still goes
to `ready`, because no escalation target is listed from `validating`. An issue alternating
validation failures could loop unboundedly. **Proposal:** extend A.2#14 with "; 4 failures →
`escalated`" (same recorded counter), making the issue machine consistent with A.1b#6.

## 4. Falsification-review fold (round 1)

The WP-101 cross-family falsification review (Codex Sol xhigh, raw review + dispositions on
PR #44) returned "safe to build on: no" with 13 findings; all were confirmed and folded:

1. **Payload `type` override (critical):** a payload could smuggle a different event type past the
   machine while the log recorded the claimed name. Fixed by the reserved-field policy and by
   building the machine event with the discriminator last (§1 item 5); regression tests at the
   recorder.
2. **Mutable `currentView` (critical):** the recorder now hands out `structuredClone` snapshots;
   recorded context reads only the private view.
3. **A.2#16 let David merge a main-candidate issue:** the guard now scopes the row to
   mission-branch targets for every authority, matching the row's own target cell and AMEND-1.
4. **Throwing guards escaped unlogged:** guards are total (array/shape validation) and the engine
   converts a guard exception into a refusal; malformed completion payloads are refused and logged.
5. **Guards saw pre-serialization values:** payloads are JSON-canonicalized before decision
   (§1 item 7); `Infinity`-class payloads now refuse consistently with what is persisted.
6. **`verifyReplay` ignored source states and some rejection classes:** replaced by full
   re-derivation through `decideTransition` (§1 item 6), comparing outcome, target, source state,
   rejection code, and payload.
7. **Unchecked event-column facts:** David rows actor-bound; A.1b validation-scope attestations
   added; re-route reference guarded; archival ledger-reference attested; cancellation reasons
   runtime-validated (§1 item 5 and the row notes).
8. **Packet hash was caller-selected:** the candidate's packet hash is now recorded context —
   gate-green/rebuild record the pair, approval must match both members.
9. **Append-only overstated vs raw DDL:** claim narrowed to its honest scope; opening a
   version-claiming database with missing table/triggers now refuses (tamper evidence).
10. **Concurrent recorders:** a staleness check refuses to record over a store that advanced
    beyond the recorder's view (detection; the durable cross-process lock remains WP-104).
11. **Fence gaps (ambient globals, parent traversal):** `fetch`/`WebSocket`/`XMLHttpRequest`/
    `EventSource`/timers banned as globals; all `../` specifiers banned (core/src is flat by
    policy); trip probes added per class.
12. **Coverage circularity:** `tests/appendix-manifest.test.ts` parses the PRD's own tables and
    pins each machine's encoded row numbers against them (plus the exact inherited set and the
    single allowed A.2#18 gap); multi-source expansion now asserts target and ref.
13. **`seq` "gap-free" claim corrected** to strictly-increasing/never-reused.

### Round 2 (verify + fresh hunt)

Round 2 (same reviewer; raw review + dispositions on PR #44) returned "safe to build on: no" with
11 findings — six round-1 folds incomplete plus fresh defects; all confirmed and folded:

1. **Request accessor desync (critical):** an exotic request object with accessor properties could
   let the decision read one event name and the durable record another. The recorder now snapshots
   the request into locals exactly once.
2. **Check/append race:** the round-1 staleness check was not atomic with the insert. Replaced by
   compare-and-swap append (§1 item 8).
3. **A.1#21 not actor-bound:** split into `#21a` (escalated — David answers, actor-bound) and
   `#21b` (blocked — obstacle cleared, any observer), mirroring A.2#21/#23.
4. **Reserved/malformed escapes:** reserved keys with `undefined` values are preserved as `null`
   through canonicalization so the refusal cannot be dodged; payloads JSON cannot hold as a plain
   object (BigInt, toJSON tricks, non-objects) are refused AND logged via a reserved-key stand-in
   (§1 item 7); the store additionally validates the SERIALIZED payload form.
5. **Replay ignored rejected-row payloads:** `verifyReplay` now compares re-derived payloads on
   rejected rows too (forged rejected-row enrichment is reported).
6. **`jsonEqual` equated `[]` with `{}`:** array-ness must match.
7. **Numeric coercion:** `unmetDependencies` and `rebuildCount` guards integer-validate
   (failure counts already did).
8. **A.2#12 lost its causes:** the row now requires the appendix's preemption/pause reasons.
9. **Fence property/traversal escapes:** `globalThis.<io-global>` banned via AST selectors (dot
   and computed-literal forms, matching the existing getBuiltinModule pattern); every specifier
   containing a `..` segment banned (incl. `./../`); probes added. Reflected computed keys remain
   the documented lint-invisible residual.
10. **Manifest was a pipe counter:** replaced by a structural parser — contiguous table with
    validated four-column header/separator/rows — plus semantic pinning of every row's From column
    against the code row's source set (creation "—", named states, "any active"/"any terminal").
11. **Audit overstatements corrected:** A.1#1's cause claim narrowed to convention; the verdict
    below scopes the A.4 statement by §2's own deferrals.

### Round 3 (verify + fresh hunt)

Round 3 (same reviewer; raw review + dispositions on PR #44) returned "safe to build on: no" with
10 findings — four round-2 folds incomplete plus fresh defects; all confirmed and folded:

1. **Missing landed-on-main attestation (high):** A.1#22/A.1b#11 completion now requires the
   attested fact that the push landed on main, alongside the SHA binding.
2. **Other unattested event-column facts (high):** mission-PR creation (A.1#6), the quick issue's
   main-candidate/no-branch/no-fold clause (A.1b#4), contract v(n+1) on replan (A.2#20), and
   quarantine+validation completeness on the verdict (A.3#7) are now attested payload facts.
3. **Recovery adopted forged durable state:** `applyRecord` validates state membership and
   recorded-fromState agreement with the fold; recorder construction and rebuild run full replay
   verification and REFUSE divergent logs (fail-closed recovery).
4. **`verifyReplay` could throw:** the fold step is wrapped — rows the fold rejects are reported
   as divergences and skipped; verification is total.
5. **CAS option re-read + enclosing-transaction desync:** `expectedLastSeq` snapshotted once;
   append refuses to run inside an enclosing transaction (a rollback would undo a row callers
   already treated as durable).
6. **Reserved-key self-deletion + throwing property traps:** reserved-key presence is captured
   before serialization, and any exception while touching the caller's object becomes the logged
   unrepresentable-payload refusal.
7. **Store input accessors:** `append` snapshots every envelope field exactly once and builds the
   returned record from the snapshot.
8. **`globalThis` aliasing past the fence:** the global-object identifiers themselves
   (globalThis/global/window/self) are banned in core — every alias, destructuring, or chain
   escape starts with one reference; probes added.
9. **Manifest substring/false-positive matching:** From-cell comparison is exact backtick-token
   set equality; escaped pipes handled. Which SPLIT of a multi-source row owns which source is
   pinned by the per-split vectors (not derivable from the table text) — stated in the test.
10. **AMEND set incomplete:** the A.1b#12 branch-carry-over inconsistency is recorded as AMEND-5.

### Round 4 (verify + fresh hunt)

Round 4 (same reviewer; raw + dispositions on PR #44) returned "safe to build on: no" with 5
findings — convergence is visible (13 → 11 → 10 → 5; no criticals since round 1) and the reviewer
confirmed AMEND-1..5 complete. All five folded:

1. **A.1#3's "+ checklist" was unattested (high):** `checklistApproved` is now an attested guard
   input on both integration approval splits.
2. **Time-varying Proxy vs reserved keys (medium):** the two-phase capture round 3 introduced was
   itself exploitable (no multi-read protocol over an exotic object can be stable). Replaced by
   the SINGLE-OBSERVATION protocol of §1 item 7: the canonical form is the sole authority, which
   also supersedes round 2 finding 4's plain-`undefined` dodge — a key absent from the one
   observation is absent from what is decided and persisted, and cannot redirect anything.
3. **`rejectionCode` read twice in the store snapshot (low):** single local read.
4. **"Any active/terminal" manifest anchoring was cardinality-based (low):** those rows now
   compare the code's from-set as an exact unique set against the full active/terminal set, and
   the structural harness requires duplicate-free from-sets.
5. **Type-level `import("node:fs")` passed the fence (low):** `TSImportType` banned in core (the
   dependency fence covers types, not just runtime); probe added.

### Round 5 (convergence check)

Round 5 (same reviewer; raw + dispositions on PR #44) returned **"safe to build on: with
corrections"** — the first non-"no" verdict — with exactly one finding: the round-4 checklist
attestation had landed on the slot-free approval split only, leaving the queued split (`A.1#3b`)
unguarded. Folded: `checklistApproved` is attested on BOTH splits, with the queued-path refusal
vector the reviewer requested. Every other round-4 fold HOLDS, no fresh in-scope defect survived
the final sweep, and the reviewer re-confirmed AMEND-1..5 complete. With that single correction
resolved, the falsification loop is converged: five rounds, 13 → 11 → 10 → 5 → 1 findings, all
39 confirmed findings folded, raw reviews and dispositions preserved verbatim on the PR.

## 5. Verdict

With the conventions of §1, the three machines and the A.1b overlay are encoded row-for-row, and
the A.4 guarantees are encoded to the extent §2 records — items 2/3/5 and the binding half of
item 4 mechanized here; item 1, packet-content immutability (item 4), and environment ownership
explicitly deferred to WP-114/115/116 with their notes. Every row is exercised by the mechanical
coverage harness and anchored structurally and semantically to the PRD's own tables, and the five
genuine spec defects found by the walk and the review rounds are recorded above as amendment
proposals. **Appendix A remains authoritative**; on David's disposition of AMEND-1..5 this audit
is updated, the approved amendments land in the PRD appendix, and the corresponding rows/tests are
added in the same change.
