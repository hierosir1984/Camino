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

Confirm on the printed console line: `outcome=succeeded` and a `committed=`
SHA. The env posture (`githubCredentialKeys: []`, git neutralized) is written
to `packages/daemon/dispatch-smoke/REPORT.md` and `summary.json` — check the
`Env: GH creds` column there reads `none ✓`. Then check the provider's console
shows the usage landed on the **API account** (that is the proof the fallback
path, not the subscription, served the dispatch).

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
   `~/.claude/settings.json`. Subscription auth stored under `HOME` by
   `claude auth login` resumes (the CLI reads its own stored credential — the
   sanctioned path). **Note:** `claude setup-token` is a *different* mechanism —
   it prints a long-lived token the caller must supply as the
   `CLAUDE_CODE_OAUTH_TOKEN` environment variable, and Camino's worker-env
   composer deliberately STRIPS that (it is `TOKEN`-shaped), so a setup-token
   credential does not reach a dispatched worker. Use `claude auth login`
   (stored under HOME) for a subscription that must survive a dispatch, not
   `setup-token`. Optionally delete the keychain item:
   `security delete-generic-password -a "$USER" -s anthropic-fallback`.

## OpenAI — Codex CLI re-authenticated with an API key

Codex stores auth in its own state under `~/.codex/`; the login subcommand has
a first-class API-key mode that reads the key from stdin (never argv).

Codex stores auth under `CODEX_HOME` (default `~/.codex/`); its storage mode
is configurable (`file` → `~/.codex/auth.json`, `keyring`, or `auto`), so do
not assume a specific file — treat `codex login status` as the source of truth
for which mode/identity is active.

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
   subscription auth in Codex's own auth store). Confirm with
   `codex login status`.

## xAI — Grok Build CLI

Grok Build supports two API-key mechanisms: the `XAI_API_KEY` environment
variable, and a persistent `model.api_key` setting in its own config file
`~/.grok/config.toml` (per xAI's documented configuration; the config-file key
takes precedence over session auth). Its stored login (`grok login`, cached
under `~/.grok/`) is the **subscription** flow.

- **Fallback that works through Camino dispatch:** set the API key in grok's
  own config file under `HOME` (`~/.grok/config.toml`, `model.api_key`, per
  xAI's current docs). This is the same custody model as the other two
  providers — the vendor's own CLI reading its own config under `HOME`, the
  sanctioned path (CAM-SEC-06). Because `HOME` is preserved for the worker, the
  official CLI loads that config; Camino never reads or proxies the key.
- **The env-var route does not reach a worker:** Camino's worker-env composer
  deliberately strips `XAI_API_KEY` (and every credential-shaped var), so
  exporting it in your shell has no effect on a dispatch. Use the config-file
  route above for a grok API-key fallback through Camino. (A future [F] API-key
  adapter could instead declare `XAI_API_KEY` as a passed-through credential
  var; the config-file route needs no such adapter.)
- **Revert:** remove `model.api_key` from `~/.grok/config.toml`; the stored
  `grok login` subscription resumes.
- xAI is **not** in CAM-ROUTE-08's critical set (its Accept names Anthropic and
  OpenAI), so Phase 2's exercise does not depend on this — it is documented
  here for completeness.

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
