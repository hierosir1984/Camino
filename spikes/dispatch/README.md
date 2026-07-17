# WP-001 — Dispatch spike

Phase-0 item 1 (PRD §7). De-risks the mechanics of driving each v1 vendor CLI
**headless** through one uniform adapter interface: **spawn → stream → cancel →
cleanup → quota-classify**. Closes issue #3.

## What it proves

| Requirement                                                                                                                                                                                          | Evidence                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CAM-EXEC-01** — every _enabled_ adapter passes the dispatch spike; disabled adapters are installable-but-disabled with a recorded reason                                                           | `REPORT.md` (all three enabled adapters succeed on a real dispatch); `registry.test.ts` (the disabled negative path)                                                                  |
| **CAM-EXEC-06** — adapters own spawn, stream parsing, cancellation with kill-confirm (SIGTERM → grace → SIGKILL → tree-gone), and quota classification (`quota-blocked`, never `requirement-failed`) | `lifecycle.test.ts` proves every mechanic on a fake CLI with **zero quota**, incl. SIGKILL escalation + full process-tree teardown; `REPORT.md` confirms real-CLI spawn/stream/cancel |
| **CAM-SEC-06 / CAM-EXEC-02** — the worker environment carries no GitHub credential and no extracted subscription credential                                                                          | `lifecycle.test.ts` env-posture test; `summary.json` shows `githubCredentialKeys: []` + git global neutralized on every real dispatch                                                 |

## Design

- **`types.ts`** — the adapter interface. An adapter is pure _configuration +
  parsing_; every adapter shares one tested lifecycle, so cancellation semantics
  are identical everywhere.
- **`lifecycle.ts`** — spawn (detached → own process group), line-by-line stream
  parsing, and `killConfirm` (group-targeted SIGTERM → grace → SIGKILL →
  verify the whole tree is gone). Production grace is 30 s (registry item 4);
  tests use a short grace.
- **`env.ts`** — composes a clean worker env from an allowlist, neutralizes
  git's global/system config, and asserts no GitHub-credential-shaped keys.
  `HOME` is preserved on purpose: the official CLIs read their _own_ subscription
  auth from under it (the sanctioned path — Camino never reads or proxies it).
- **`adapters/{claude,codex,grok}.ts`** — per-CLI spawn plan + stream parser,
  refined against each CLI's _observed_ JSONL schema (codex wraps payloads in
  `item.completed`; grok token-streams `{type:"text",data}`).
- **`adapters/mock*.ts`** — a fake CLI so the whole lifecycle runs in CI with no
  quota, including the SIGTERM-ignoring "hang" mode that forces SIGKILL.

**Spike scope, stated honestly:** isolation here is env-level + a throwaway
clone. Container-level filesystem isolation (so a worker cannot read
`~/.config/gh` off disk) and the durable adapter layer land at **WP-105/WP-107**;
this spike's machinery promotes into them.

## Run it

```sh
# Mechanics only, zero quota (also runs inside `npm test` / CI):
npm run spike:test

# Real dispatches on live subscriptions (spends quota):
npm run spike:dispatch                  # one trivial issue per enabled adapter
npm run spike:dispatch -- --cancel      # + a real mid-run cancel per adapter
npm run spike:dispatch -- --only=codex  # restrict to named adapters
```

Real dispatches record `transcripts/REPORT.md` + `transcripts/summary.json`
(committed evidence); raw `*.jsonl` streams are gitignored.

## Latest run

See [`transcripts/REPORT.md`](transcripts/REPORT.md). Most recent: all three
adapters (claude-code, codex-cli, grok-build) **succeeded** — each spawned,
streamed events, produced a real local commit in an isolated clone, showed a
clean env posture, and cancelled mid-run with the process tree confirmed gone.
Per-provider quota classification is exercised on the mock; no real rate limit
was hit during the run.
