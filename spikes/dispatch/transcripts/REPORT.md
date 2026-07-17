# WP-001 dispatch spike — run report

Real dispatches on live subscriptions. Mechanics (kill-confirm escalation,
quota classification, env posture) are proven quota-free in `lifecycle.test.ts`;
this report is the real-CLI evidence for CAM-EXEC-01 / CAM-EXEC-06 / CAM-SEC-06.

| Adapter | Enabled | Solve outcome | Stream events | Local commit | Env: GH creds | Cancel outcome | Kill-confirm |
|---|---|---|---|---|---|---|---|
| claude-code | yes | succeeded | 11 | d244d44f | none ✓ | cancelled | treeGone=true |
| codex-cli | yes | succeeded | 15 | 60e49e3c | none ✓ | cancelled | treeGone=true |
| grok-build | yes | succeeded | 61 | 2d0cf17a | none ✓ | cancelled | treeGone=true |

