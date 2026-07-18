Line references: [v3](</private/tmp/claude-501/-Users-davidtoniolo-Projects-Camino--claude-worktrees-sweet-hawking-334a29/7e0f2484-1ed2-4fe9-8998-022f1484f630/scratchpad/camino-build-plan-v3.md>), [PRD](/Users/davidtoniolo/Projects/Camino/.claude/worktrees/sweet-hawking-334a29/docs/PRD.md), and [BUILD](/Users/davidtoniolo/Projects/Camino/.claude/worktrees/sweet-hawking-334a29/docs/BUILD.md).

### (a) Round-2 regression table

| R2 finding | Verdict | One-line receipt |
|---:|---|---|
| 1 | PARTIALLY RESOLVED | v3:437–446 adds the named contract/quarantine/lease/packet edges, but new consumers remain absent from the graph: WP-114/115 add work “to the chaos matrix” (245, 259) without dependency on WP-104 (442–443), and WP-125 is “rendered via the WP-123 inbox” (336) while row 453 omits WP-123. |
| 2 | RESOLVED | v3:163 requires “Every operation class of the PRD §4.4 table as code,” including workflow dispatch’s at-most-once/correlation-only rule; v3:165 requires fixtures “for every §4.4 operation class.” |
| 3 | RESOLVED | v3:167 makes WP-104’s own acceptance fake-backed and wave-satisfiable, assigns later resume assertions to WP-114/115, and v3:346 requires final real-backend proof. |
| 4 | PARTIALLY RESOLVED | v3:95 moves xAI into the entry-gate AC but permits “David's explicit recorded deferral” to turn it green; BUILD:25 still requires the contractual confirmation itself before Phase 0. |
| 5 | RESOLVED | v3:256 requires T3 and post-merge supply-chain risk “surfaced in onboarding material”; v3:279 separately enforces that onboarding display. |
| 6 | RESOLVED | v3:290 requires a fixture proving revocation “immediately returning the repo to training mode with human approval required again.” |
| 7 | RESOLVED | v3:300 requires the mission PR to carry the checklist from creation, accumulate packet links, and block merge without “checklist + rollup + links.” |
| 8 | RESOLVED | v3:236 requires fixtures proving only approved entries cross missions and candidates remain visible to same-issue repairs with provenance. |
| 9 | RESOLVED | v3:224–225 enforce exact globs and all risk tiers; v3:316 enforces working filters; v3:382,415–416 correctly re-home CAM-ROUTE-08 and registry items 14/17. |
| 10 | RESOLVED | v3:87 says generated issues encode `000 → 001 → 002 → 003 → 004 → 005`; rows 426–431 and v3:472 require the actual issue links. |
| 11 | RESOLVED | v3:148 makes the core boundary an AC: only `shared` imports, I/O imports fail CI, and a fixture proves the fence trips. |
| 12 | PARTIALLY RESOLVED | v3:332 names “Single-package scope…all daemon-side,” but no AC enforces the package boundary; v3:336 also consumes WP-123 rendering while dependency row 453 omits WP-123. |
| 13 | RESOLVED | v3:188 requires a failed provider-auth write fixture; v3:189 requires an allowlisted endpoint to remain reachable, preventing total-denial false passes. |

### (b) Round-1 partials

| R1 finding | Verdict | One-line receipt |
|---:|---|---|
| 9 | RESOLVED | v3:224 requires the exact registry-item-2 globs plus a shipped-config comparison test; v3:225 enforces medium/low tiers and final-diff area derivation. |
| 11 | PARTIALLY RESOLVED | v3:95 fixes timing but still accepts “explicit recorded deferral” instead of BUILD:25’s contractual confirmation. |
| 12 | RESOLVED | v3:87 and 426–431 encode the strict Phase-0 issue-dependency chain, not merely prose order. |
| 15 | RESOLVED | v3:144 keeps SQLite in `daemon` behind `shared`; v3:148 enforces the pure-core boundary in CI with a failing fixture. |
| 16 | PARTIALLY RESOLVED | Most producer edges were added, but WP-123 still says it renders an “evidence packet” (320) while depending only on 101/102 (451), not packet-schema owner WP-116; the new chaos/WP-125 omissions compound the incomplete graph. |
| 19 | PARTIALLY RESOLVED | v3:332 removes the bespoke GUI deliverable in prose, but no AC/diff fence enforces daemon-only ownership, and the remaining WP-123 rendering dependency is undeclared. |

### (c) New defects introduced by v3

1. CONFIRMED — new consumers are missing from the explicit graph.

   Receipt: scheduling is controlled by listed dependencies (v3:139). WP-114 adds lease recovery “to the chaos matrix” (245), and WP-115 registers external-service fixtures into it (259), but rows 442–443 do not depend on WP-104. WP-125 requires output “rendered via the WP-123 inbox” (336), but row 453 omits WP-123. The declared waves happen to be topologically safe; the executable issue graph is not complete.

2. CONFIRMED — the strengthened CAM-STATE-06 real-backend claim lacks ownership for two operation classes.

   Receipt: v3:163 enumerates branch creation and CI/workflow dispatch; v3:346 requires “every §4.4 operation class against its real backend.” Registration ACs cover external test services (259), push/merge-by-push (291), and PR create/close, labels, and comments (303), but no WP AC owns real-backend branch-create or CI/workflow-dispatch kill-point fixtures.

Negative regression receipts:

- FALSIFIED — declared dependency/wave inconsistency: every listed Phase-1 dependency is in an earlier wave, every WP 101–126 appears once, and the Phase-0 table matches the strict chain.
- FALSIFIED — changed-row PRD misquote: CAM-SEC-01, CAM-SEC-05, CAM-ROUTE-08, and registry items 14/17 match the PRD.
- No other v3-introduced dangling reference or contradiction was found within the bounded scope.

safe to build on: with corrections — (1) make WP-000 green only after actual xAI contractual confirmation, or first approve a BUILD amendment; (2) add dependency edges `114 → 104`, `123 → 116`, and `125 → 123`, then recut waves so WP-123 follows WP-116 and WP-124/125 follow WP-123; (3) add a WP-125 AC/diff fence enforcing daemon-only changes and reuse of the existing WP-123 escalation contract; (4) assign enforcing real-backend kill-point ACs for branch creation and CI/workflow dispatch to named P1 WPs, connect them to WP-104, and include those owners in the CAM-STATE-06 matrix.
