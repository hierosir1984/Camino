# WP-001 dispatch spike — run report

Real dispatches on live subscriptions. Mechanics (kill-confirm escalation,
quota classification, env posture) are proven quota-free in `lifecycle.test.ts`;
this report is the real-CLI evidence for CAM-EXEC-01 / CAM-EXEC-06 / CAM-SEC-06.
Per-parsed-event samples and repo-relative transcript paths are in `summary.json`.

| Adapter | Enabled | Solve outcome | Stream events | Local commit | Env: GH creds | Cancel outcome | Kill-confirm |
|---|---|---|---|---|---|---|---|
| claude-code | yes | succeeded | 11 | 92a754c9 | none ✓ | cancelled | treeGone=true |
| codex-cli | yes | succeeded | 14 | 1b997623 | none ✓ | cancelled | treeGone=true |
| grok-build | yes | succeeded | 54 | ec10d3fe | none ✓ | cancelled | treeGone=true |

