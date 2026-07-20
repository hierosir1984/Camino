# Runbook: API-key fallback for subscription providers (CAM-ROUTE-08)

> **What this is.** When a subscription window is exhausted (`quota-blocked`)
> or a provider's subscription path is unavailable, Camino's fallback is the
> **same official CLIs re-authenticated with API keys** — no new adapter, no
> code change, no Camino configuration. This runbook is the documented
> configuration procedure. The funded fallback accounts are a WP-000
> onboarding prerequisite (recorded in
> `docs/plan/phase-0-prereq-attestations.json`: Anthropic ✓, OpenAI ✓).
>
> **When it is exercised.** Phase 2 acceptance (PRD CAM-ROUTE-08): one mission
> issue completed under API-key auth for **each critical subscription
> provider** (Anthropic and OpenAI). Until then this runbook is the committed,
> reviewable procedure — WP-105's deliverable is the runbook itself.
>
> **What it is NOT.** The `[F]` API-key **adapter interface**
> (`packages/shared/src/api-key-adapter.ts`) covers *additional* providers
> (registry item 14, e.g. GLM-range, post-v1). The critical-provider fallback
> below deliberately requires none of it.

## Credential custody (CAM-SEC-06 — read before running)

- Camino **never reads, stores, transmits, or proxies** any credential —
  subscription or API key. Every step below configures the **vendor's own
  CLI** through the **vendor's own auth flow**; the key lives where that CLI
  keeps its own state, under `HOME`.
- Worker dispatches run with an allowlisted environment (`PATH HOME USER
  LOGNAME SHELL LANG LC_ALL TMPDIR` + git neutralization). `HOME` is preserved
  exactly so each official CLI can read **its own** auth state — that is the
  sanctioned path, for subscription auth and API-key auth alike.
- **Ambient provider key env vars do not reach workers by design.** Exporting
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY` in your shell has no
  effect on a Camino dispatch (the composer strips credential-shaped keys —
  see `packages/daemon/src/dispatch/env.ts`). This is deliberate: a
  subscription dispatch must never silently re-bill to an API account because
  a key happened to be exported; the fallback is always an explicit,
  reversible re-authentication of the CLI itself.
- Do not paste keys into files inside any Camino-managed repo or worktree. Do
  not commit any file this runbook touches.

## Verification, per provider

After each provider's switch, verify with **one minimal smoke dispatch** for
that adapter only (spends one trivial solve on the API account):

```sh
node --run dispatch:smoke -- --only=claude   # or codex / grok
```

Confirm in the printed report line: `outcome=succeeded`, a `committed=` SHA,
and `Env: GH creds = none ✓`. Then check the provider's console shows the
usage landed on the **API account** (that is the proof the fallback path, not
the subscription, served the dispatch).

---

## Anthropic — Claude Code re-authenticated with an API key

Claude Code reads API-key auth from its own settings under `HOME` via
`apiKeyHelper` (a command that prints the key), so the switch is a CLI-side
setting — nothing Camino-visible changes.

1. **Prepare the key** (funded Console account, WP-000 attestation): create an
   API key in the Anthropic Console. Store it in your keychain, e.g.:

   ```sh
   security add-generic-password -a "$USER" -s anthropic-fallback -w
   # (prompts for the key; stores it in the macOS login keychain)
   ```

2. **Point Claude Code at it** — add to `~/.claude/settings.json`:

   ```json
   {
     "apiKeyHelper": "security find-generic-password -a $USER -s anthropic-fallback -w"
   }
   ```

   The CLI runs the helper itself when it needs the key. The key never appears
   in an env var, a Camino process, or a file in plain text.

3. **Verify** (see above): `node --run dispatch:smoke -- --only=claude`, then
   confirm usage in the Anthropic Console.

4. **Revert** (back to subscription): remove the `apiKeyHelper` entry from
   `~/.claude/settings.json`. Subscription auth (from `claude auth login` /
   `claude setup-token`) resumes. Optionally delete the keychain item:
   `security delete-generic-password -a "$USER" -s anthropic-fallback`.

## OpenAI — Codex CLI re-authenticated with an API key

Codex stores auth in its own state under `~/.codex/`; the login subcommand has
a first-class API-key mode that reads the key from stdin (never argv).

1. **Prepare the key** (funded Platform account, WP-000 attestation): create an
   API key in the OpenAI console, store it in the keychain as above
   (service name `openai-fallback`).

2. **Switch the CLI to API-key auth**:

   ```sh
   security find-generic-password -a "$USER" -s openai-fallback -w | codex login --with-api-key
   codex login status   # should report API-key auth
   ```

3. **Verify**: `node --run dispatch:smoke -- --only=codex`, then confirm usage
   in the OpenAI console.

4. **Revert**: `codex logout && codex login` (browser flow restores
   subscription auth in `~/.codex/auth.json`). Confirm with
   `codex login status`.

## xAI — Grok Build CLI (recorded limitation)

Grok Build's official API-key mode is the `XAI_API_KEY` environment variable
(per the accepted sanctioned-path memo,
`docs/plan/xai-sanctioned-path-research.md`); the CLI's stored login
(`grok login`, cached under `~/.grok/`) is the **subscription** flow, and no
stored API-key login exists in the current CLI (v0.2 line).

- Because Camino's worker env deliberately strips ambient credential-shaped
  vars, `XAI_API_KEY` from your shell does **not** reach a dispatched worker.
  A grok API-key fallback **through Camino dispatch** therefore requires the
  `[F]` declared-passthrough composer (the exact clause the API-key adapter
  interface documents: named env vars passed through from host state at spawn
  time). That is future work by design, not an accident.
- xAI is **not** in CAM-ROUTE-08's critical set (its Accept names Anthropic
  and OpenAI), so Phase 2's exercise does not depend on this.
- If xAI must be exercised outside Camino in the meantime:
  `XAI_API_KEY=… grok -p "…"` in a plain shell uses the API key natively —
  same official CLI, zero Camino involvement.

## Failure notes

- A dispatch that hits the API account's own rate limit still classifies
  `quota-blocked` (CAM-EXEC-06) — the fallback changes billing, not outcome
  semantics.
- If the smoke dispatch fails with an auth error after a switch, re-run the
  provider's own status command (`claude auth status`, `codex login status`)
  before touching anything else: the failure is in CLI auth state, not in
  Camino, and must be fixed there.
- Switching back is always the provider's own revert step above; Camino needs
  no restart and holds no state about which auth mode a CLI is in (it never
  reads credential state — it only observes dispatch outcomes).
