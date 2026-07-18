# WP-002 rating packet — Evidence viewer v0 — render inspectable evidence packets for merge approval (CAM-CORE-07, Phase-1)

Planner: **claude-code** (anthropic) · Reviewer: **codex-cli** (openai) · Fixture: `spikes/plan-probe/fixture/evidence-viewer-v0.md`
Generated: 2026-07-17T11:27:08.030Z

> **How to rate this packet (the WP-002 / PRD §7 item 2 exit):**
> 1. Note the time you start.
> 2. Read sections A–D the way you would a plan-approval screen.
> 3. In section B, fill BOTH lines under every question:
> `RATING-Q<n>:` → `good` (genuine ambiguity — worth your time) or `obviously-fine`
> (the planner should have decided this itself, or the answer is obvious).
> `ACK-Q<n>:` → your answer, or `confirm` to accept the recorded assumption as-is.
> 4. In section C, fill `CHECKLIST-USABLE:` (`yes`/`no`) — could you confirm intent from that table?
> 5. Fill the timer block below, then run `npm run spike:plan-probe:check` (it verifies
> completeness and computes the ≥70%-good score).

## Review timer

REVIEW-START: 09:19
REVIEW-END: 09:34
REVIEW-MINUTES: 15

_Budget: 45 minutes per mission plan (CAM-OBS-02); this recording is the baseline data point._

## A. Proposed issues (5)

### I1 — Evidence-packet schema types in packages/shared `[risk: low]`

Define the v1 evidence-packet TypeScript types in packages/shared so the GUI renders a real, typed structure rather than untyped JSON.

Acceptance criteria:
1. packages/shared exports a packet type carrying every S11 field: attempt_id, issue_id, contract_hash, candidate_sha, base_sha, worker_head_sha, commands[], artifacts[], checks[], reviews[], exclusions[], waivers[], retries, failure_class, verdict, created_at.
2. Each nested item type (commands, artifacts, checks, reviews, exclusions, waivers) includes its own sha, base_sha, and a class field typed as 'advisory' | 'gating'.
3. artifacts items type includes path, type, sha256, and scrubbed.
4. tsc passes and packages/gui imports the type without violating the core/shared import fence.

Mandate: S11, S12 · Depends on: —

### I2 — Packet rendering component (sections + gating/advisory + exclusion/waiver lists) `[risk: medium]`

Build the React component that renders a packet's contents — all sections plus metadata — with each item's advisory/gating class visible and the exclusion/waiver lists shown.

Acceptance criteria:
1. Given a packet fixture, the component renders every top-level section: commands, artifacts, checks, reviews, exclusions, waivers, plus metadata (verdict, failure_class, retries, created_at).
2. Each rendered item shows its class with a visually distinct advisory-vs-gating marker.
3. exclusions render their item/reason and waivers render their register_ref/reason/actor.
4. Component renders without error when a list (e.g. exclusions or waivers) is empty.

Mandate: S1, S4, S9, S11, S12, S14 · Depends on: I1

### I3 — Artifact previews (logs inline, screenshots inline, traces open locally) `[risk: medium]`

Render artifact previews so a reviewer can inspect logs, screenshots, and traces from within the packet view.

Acceptance criteria:
1. A log-type artifact renders its text content inline.
2. A screenshot-type artifact renders as an inline image.
3. A trace-type artifact exposes an 'open locally' action rather than requiring inline rendering.
4. Each artifact displays its scrubbed status and sha256.

Mandate: S1, S4, S9, S10 · Depends on: I1

### I4 — Merge approval screen embeds packet and gates approval `[risk: medium]`

Embed the evidence viewer in a merge approval screen so approval happens against the packet, and no merge is approvable without its packet.

Acceptance criteria:
1. A merge approval screen embeds the evidence viewer showing the packet for the candidate being approved.
2. The approve control is blocked/disabled when no packet is present for the candidate.
3. The gating-vs-advisory distinction is visible on the approval screen.

Mandate: S1, S10 · Depends on: I2, I3

### I5 — Synthetic packet fixtures and Playwright probe `[risk: low]`

Provide synthetic evidence-packet fixtures (no real packets exist yet) and a Playwright probe that verifies the viewer renders and gates correctly.

Acceptance criteria:
1. Fixture packets exist covering both advisory and gating items, all three artifact types (log, screenshot, trace), and non-empty exclusions and waivers.
2. A Playwright probe loads the viewer against a fixture and asserts each packet section renders and both gating and advisory markers appear.
3. The probe asserts the approve control is not enabled when a candidate has no packet.

Mandate: S5 · Depends on: I2, I3, I4

## B. Clarifying questions — rate and acknowledge EVERY one (5)

`good` = a genuine ambiguity the PRD left open; asking was worth your attention.
`obviously-fine` = the planner could safely have decided this itself.
**≥70% rated good** is the question-quality bar (PRD §7, Phase-0 item 2); the full exit
also requires checklist usability confirmed and review time recorded.

### Q1 — Where does the GUI read evidence packets from — a daemon HTTP endpoint (Fastify) serving packet JSON from the SQLite event log, or directly from local fixture files for v0? `[blocking]`

- Why it matters: This sets the data-access architecture shared across the packet component, artifact previews, and the approval screen, and whether a daemon endpoint is part of this mission.
- Assumption if unanswered: The GUI reads packets through a daemon HTTP endpoint returning packet JSON; because no real packets exist yet (S5), v0 wires that endpoint to synthetic fixtures, and the components consume typed JSON without assuming direct filesystem/DB access.
- Related: S2, S3, S5 → I2, I3, I4, I5

RATING-Q1: Obviously-fine. 
ACK-Q1: confirm

### Q2 — What does 'render inline or open locally' mean concretely for each artifact type — specifically, must traces render inline (e.g. embedded Playwright trace viewer) or is launching them locally acceptable for v0?

- Why it matters: It sets the scope of I3: inline trace rendering is substantially more work than an 'open locally' file action.
- Assumption if unanswered: Logs and screenshots render inline; traces are offered via an 'open locally' action (open the artifact file with the OS/existing viewer) rather than inline.
- Related: S9, S10 → I3

RATING-Q2: good
ACK-Q2: confirm

### Q3 — How does the viewer access artifact bytes and treat the 'scrubbed' flag — are artifact files at a local `path` the viewer can read, and does 'scrubbed' only affect a displayed badge or gate what content is shown?

- Why it matters: It determines how I3 fetches artifact content and whether scrubbing is a display concern or a content-filtering obligation.
- Assumption if unanswered: Artifacts are addressable via their `path` (local filesystem or served by the daemon), the viewer previews the referenced content as-is, and `scrubbed` is surfaced as a badge without additional filtering by the viewer.
- Related: S10, S11 → I3

RATING-Q3: good
ACK-Q3: confirm

### Q4 — Does the v0 viewer render the mission rollup (mission_id, requirement_map, gate_record, per_issue_delivered), or only per-attempt packets?

- Why it matters: Rendering the mission-level rollup adds a distinct UI surface and typing beyond the per-attempt packet the approval screen embeds.
- Assumption if unanswered: v0 renders per-attempt packets only; rendering the mission rollup is deferred to a later mission (registry/rollup surface), and no rollup UI is built here.
- Related: S13 → I2

RATING-Q4: good
ACK-Q4: confirm

### Q5 — Does this mission build the merge approval screen itself (the GUI is an empty scaffold), or only the embeddable viewer that a separately-owned approval screen will host?

- Why it matters: It sets whether I4 delivers a minimal host screen that demonstrably gates approval, or stops at an embeddable component with no gating surface to verify.
- Assumption if unanswered: This mission builds a minimal merge approval screen sufficient to embed the viewer and demonstrate that approval is blocked without a packet; the full merge-approval workflow remains a separate mission.
- Related: S10 → I4

RATING-Q5: good
ACK-Q5: confirm

## C. Requirement checklist diff (CAM-PLAN-02)

Every fixture segment, dispositioned. Requirements map to proposed intent-ledger entries;
everything else is visibly flagged as non-requirement text.

### C1. Requirements → proposed intent-ledger entries

| Segment | Ledger entry | Statement | Implemented by |
|---|---|---|---|
| S1 | LED-1 | Deliver a v0 evidence viewer in Camino's GUI that renders evidence packets so merge approval happens against inspectable evidence (CAM-CORE-07, Phase-1 scope). | I2, I3, I4 |
| S4 | LED-2 | v0 scope is functional rendering (packet contents + artifact previews); presentation polish is out of scope and follows later. | I2, I3 |
| S9 | LED-3 | The evidence viewer renders evidence packets (v1 schema) with artifact previews for logs, screenshots, and traces. | I2, I3 |
| S10 | LED-4 | Every merge approval screen embeds the packet being approved with artifacts previewable and the gating/advisory distinction visible; no v1 merge is approvable without its packet. | I3, I4 |
| S11 | LED-5 | Represent and render the full v1 evidence-packet schema (all per-attempt fields and nested command/artifact/check/review/exclusion/waiver lists). | I1, I2 |
| S12 | LED-6 | Every packet item carries its own (sha, base_sha) identity and a class: advisory|gating marker, and the viewer surfaces that class per item. | I1, I2 |
| S14 | LED-7 | The viewer renders the advisory/gating distinction and the exclusion and waiver lists. | I2 |

### C2. Flagged as non-requirement text (the CAM-PLAN-02 visible flag)

| Segment | Planner's note |
|---|---|
| S2 | Established repo-layout context; work lands in packages/gui (and packages/shared for types), but the layout itself is not an obligation of this mission. |
| S3 | Technology defaults; constrains the stack (TypeScript/Node 22, React+Vite, Playwright) used by every issue but is a standing default, not a new obligation. |
| S5 | Context: no real packets exist, so the mission must supply synthetic fixtures to build and verify against (drives I5 and Q1). |
| S6 | Design rationale for prioritizing CAM-CORE-07; motivation, not an obligation. |
| S7 | Design rationale on (sha, base) identity and why only Camino-authored candidates are gating; informs I1/I2 typing but is context. The concrete obligation is captured in S12. |
| S8 | Motivation-section restatement that the v0 GUI includes an evidence viewer; the concrete obligation is S1/S9, so no separate ledger entry to avoid duplication. |
| S13 | Mission-rollup schema (mission-level, registry-cited). Whether the v0 viewer renders it is underdetermined (see Q4); assumed deferred to a later mission, so no issue owns it here. |
| S15 | Escalation inbox (CAM-CORE-05) is a separate mission; listed for interface awareness only. |
| S16 | Mission→main PR lifecycle (CAM-MERGE-13) is a separate mission; the viewer's packets are what such PRs link to, but the PR flow is out of scope here. |

### C3. ⚠ Requirement segments not covered by any issue

_Computed from the planner's OWN isRequirement classification — it cannot see a segment the_
_planner misclassified as non-requirement; the adversarial review in section D adjudicates_
_the classification itself._

None — every row the planner classified as a requirement maps to at least one issue.

Could you confirm mission intent from this table (accept/adjust ledger entries, spot the
flagged text) without going back to the raw PRD?

CHECKLIST-USABLE: yes
CHECKLIST-NOTE: good checklist, very suitable. I will state clearly though. 1. In Markdown format this table format gets difficult, so depending on our decisions later, such a display would be best in a GUI or with a widget... Reading tables in markdown particularly when there are 3+ columns gets messy for humans.

## D. Cross-family adversarial review (attached — CAM-PLAN-03)

Reviewer: **codex-cli** (openai, planner family: anthropic) · Verdict: **reject**

The plan drops required rollup and evidence-classification semantics and does not establish that approval is bound to the exact packet for the candidate or enforced at the authoritative approval boundary. Its schema and rendering criteria omit required S11 fields, while several probes can pass with headings, inert controls, or unverified artifact actions. The checklist and defaults also hide these gaps by misclassifying S13, narrowing S10 to a demo screen, and adding an unowned daemon endpoint.

### F1 `[blocker · dropped-requirement]` — The S13 mission-rollup obligation is dropped entirely.

- Evidence: S13 is inside the section titled 'Requirements (this mission)' and specifies mission_id, requirement_map, gate_record, and per_issue_delivered. The checklist nevertheless marks S13 isRequirement:false with no mapped issue, I1 types only the per-attempt packet, and Q4's default defers the rollup to an invented later surface. Even if Q4 legitimately resolves whether the rollup needs its own UI, no criterion delivers its schema or data model.
- Suggested fix: Mark S13 as a requirement and add an issue or criteria that type and validate every rollup field; make the rendering portion conditional on Q4 if necessary, but do not defer the schema without an explicit PRD scope change.

### F2 `[blocker · dropped-requirement]` — The plan represents advisory/gating as an unconstrained label and drops S12's classification invariant.

- Evidence: S12 requires worker-head evidence to be advisory and permits gating only for Camino-authored candidates. I1 merely types class as the union 'advisory' | 'gating', I2 displays the supplied value, and I5 only checks that both labels appear. LED-6 also truncates the segment by omitting its worker-head/Camino-candidate rule, so a worker-head item labeled gating satisfies every listed criterion.
- Suggested fix: Faithfully restate the complete S12 rule and add validation or derivation criteria that relate each item's sha, base_sha, and class to worker_head_sha and the Camino-authored candidate identity, including negative fixtures for inverted classifications.

### F3 `[major · dropped-requirement]` — S10's requirement for every merge approval screen is narrowed to a single demonstration screen.

- Evidence: S10 says 'every merge approval screen embeds the packet being approved.' I4 requires only 'A merge approval screen,' and Q5's fallback explicitly proposes a minimal host used merely to demonstrate gating while assigning the full workflow elsewhere. Those criteria can pass without integrating the viewer into the actual approval entry points that S10 quantifies over.
- Suggested fix: Identify the authoritative approval entry points and require packet embedding and gating on each. If none exists yet, record the missing approval surface as a prerequisite and make later integration an explicit owned criterion rather than treating a demo host as delivery.

### F4 `[major · dropped-requirement]` — I1 can satisfy its criteria with incomplete nested S11 types.

- Evidence: I1 AC1 enumerates collection names such as commands[] and checks[] but not their member shapes; AC2 adds only sha, base_sha, and class; AC3 completes only artifact fields. The criteria never explicitly require commands.cmd, checks.name/result/duration, reviews.model/family/verdict/summary, exclusions.item/reason, or waivers.register_ref/reason/actor, all mandated by S11.
- Suggested fix: Enumerate every required nested field and its type, or require an exact compile-time/schema conformance fixture that fails when any S11 field is absent or optional contrary to the registry schema.

### F5 `[major · dropped-requirement]` — The acceptance criteria do not deliver functional rendering of the full S11 packet contents claimed by LED-5.

- Evidence: I2 AC1 limits displayed metadata to verdict, failure_class, retries, and created_at, omitting attempt_id, issue_id, contract_hash, candidate_sha, base_sha, and worker_head_sha. No I2/I3 criterion requires rendering per-item sha/base_sha, command text, check details, review details, or artifact path. I5 asserts only section presence and class markers, and its fixture criterion does not require populated commands, checks, or reviews, so empty headings can pass despite S4, S9, and S11.
- Suggested fix: Specify the visible representation of every top-level and nested S11 field and add populated fixtures plus value-level assertions for all packet sections, including item identities.

### F6 `[blocker · criteria-defect]` — I4 and I5 do not prove an identity-bound or authoritative no-packet approval invariant and are passable by a permanently disabled or bypassable UI.

- Evidence: S10 requires the packet being approved and says no v1 merge is approvable without it; S11 provides candidate_sha and base_sha for that binding. I4 only says a viewer shows a packet 'for' the candidate and that a control is disabled when none is present, while I5 tests only the no-packet disabled state. There is no observable equality check for candidate_sha/base_sha, no mismatched-packet case, no positive case in which a valid matching packet enables approval, and no handler/API/state-transition rejection test, so an unrelated packet, a forever-disabled button, or a direct bypass can pass.
- Suggested fix: Enforce the invariant at the authoritative approval decision boundary and probe positive matching-packet approval plus absent-packet, candidate-SHA mismatch, base-SHA mismatch, and direct-bypass rejection cases; keep the disabled control as secondary UX evidence.

### F7 `[major · criteria-defect]` — I3's artifact-preview criteria can pass with hard-coded or inert UI rather than inspectable artifacts.

- Evidence: The trace criterion only requires exposing an 'open locally' action; it never requires activation to open the referenced trace. I5 does not click that action or verify any artifact bytes, and it does not assert that the displayed log text or screenshot corresponds to the fixture's path/content. A decorative button, hard-coded text, or broken image therefore satisfies the stated checks despite S9-S10 requiring previewable artifacts.
- Suggested fix: Use known fixture contents and require the probe to verify exact log text, a successfully loaded screenshot, and activation of the trace action opening the exact referenced artifact, with explicit failure behavior for missing or unreadable artifacts.

### F8 `[minor · mapping-defect]` — I5 is mapped only to contextual S5 even though it is the proposed verification for multiple requirements.

- Evidence: I5's criteria exercise packet rendering, advisory/gating markers, artifact types, exclusion/waiver content, and no-packet gating from S9, S10, S12, and S14. Its mappedSegments contains only S5, which the checklist correctly labels non-requirement; the S10 checklist note even says I5 probes the rule while S10 mappedIssues omits I5.
- Suggested fix: Map I5 to every requirement it verifies, including S9, S10, S12, and S14 as applicable, and retain S5 only as the rationale for synthetic fixtures.

### F9 `[major · scope-creep]` — Q1's default adds a daemon HTTP endpoint backed by synthetic fixtures without a PRD mandate or an issue that delivers it.

- Evidence: S2, S3, and S5 are explicitly repo facts or technology context, not mission obligations; none of S1 or S9-S14 selects a packet transport. Q1 nevertheless defaults to a Fastify endpoint and relates it to I2-I5, but no issue has acceptance criteria for the endpoint, its contract, or its behavior. Thus the default both expands scope and leaves the assumed dependency unowned.
- Suggested fix: Keep the component boundary transport-neutral unless the owner selects an endpoint. If an endpoint is selected, add a separately owned issue with an observable contract and tests; otherwise inject typed fixture data without claiming a new backend surface.

### F10 `[major · bad-premise]` — Q5 relies on the unsupported premise that the full merge-approval workflow belongs to a separate mission.

- Evidence: No segment assigns merge approval to another mission. S10 is an explicit requirement of this mission; S15 separates only the escalation inbox, and S16 separates only the mission-to-main PR lifecycle. Q5's fallback uses the unsupported boundary to justify I4 as a minimal demonstration host rather than integration with an authoritative approval flow.
- Suggested fix: Remove the separate-mission assertion. Either include the required approval integration in this plan or surface a blocking ownership/prerequisite question whose resolution creates an explicit, traceable owner for S10.

### F11 `[minor · question-quality]` — Q2 is padding because the PRD already answers whether traces may open locally.

- Evidence: Q2 asks whether traces must render inline or whether launching locally is acceptable. S10 explicitly permits logs, screenshots, and traces to 'render inline or open locally,' so local opening is already a compliant option; the question asks for an implementation preference, not missing requirement information.
- Suggested fix: Delete Q2 or record the chosen compliant presentation mode as a nonblocking implementation decision, while retaining an observable criterion that the trace is actually previewable.

---

_This packet is the spike's stand-in for the plan-approval screen: per CAM-PLAN-01 the plan_
_is not approvable while any question above is unrated or unacknowledged, and per CAM-PLAN-03_
_it could not have been rendered without section D attached._
