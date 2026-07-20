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
  keeps its own state. Custody is **vendor-CLI-owned, via that CLI's active
  config root or the OS keychain** — depending on the CLI and mode that is a
  file under the CLI's config root
  (`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json`,
  `${CODEX_HOME:-$HOME/.codex}/auth.json`,
  `${GROK_HOME:-$HOME/.grok}/config.toml`) OR the OS keychain (Codex `keyring`
  mode; the `apiKeyHelper` command below stores the Anthropic key in the macOS
  Keychain). Camino references host credential STATE only through each official
  CLI's granted roots (`HOME` plus that CLI's own config-root var, passed
  through unchanged) and never touches the keychain itself — it only lets each
  official CLI use its own credential.
- Worker dispatches run with an allowlisted environment (base: `PATH USER
  LOGNAME SHELL LANG LC_ALL TMPDIR` + git neutralization), with credential
  roots granted **per adapter**: an official CLI's dispatch additionally
  inherits `HOME` plus that CLI's **own** config-root var
  (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GROK_HOME`) so it reads **its own**
  auth state — including a relocated config root — for subscription auth and
  API-key auth alike. A non-official adapter inherits no credential roots at
  all (CAM-SEC-06: composition references host credential state for official
  CLIs only).
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
SHA. For the env posture: `REPORT.md` shows the derived `Env: GH creds` column
(should read `none ✓`); the full posture — including `gitGlobalNeutralized`
and the stripped-key list — is in `packages/daemon/dispatch-smoke/summary.json`
only. Then check the provider's console shows the usage landed on the **API
account** (that is the proof the fallback path, not the subscription, served
the dispatch).

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

2. **Point Claude Code at it** — add to `settings.json` in Claude Code's
   ACTIVE config root, `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json`
   (when `CLAUDE_CONFIG_DIR` is set it relocates the whole config root, and
   the composer passes it through to claude workers):

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
   `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json`. Subscription auth from `claude auth login`
   resumes — the CLI reads its own stored credential (the sanctioned path). On
   **macOS** that credential is in the login **Keychain**, not a file under
   `HOME` (file storage applies to Linux/Windows); a dispatched worker runs as
   the same user and so the `claude` CLI can read it, and Camino never touches
   it. **Note:** `claude setup-token` is a *different* mechanism — it prints a
   long-lived token the caller must supply as the `CLAUDE_CODE_OAUTH_TOKEN`
   environment variable, which Camino's worker-env composer deliberately STRIPS
   (it is `TOKEN`-shaped), so a setup-token credential does not reach a worker.
   Use `claude auth login` for a subscription that must survive a dispatch, not
   `setup-token`. Optionally delete the keychain item:
   `security delete-generic-password -a "$USER" -s anthropic-fallback`.

## OpenAI — Codex CLI re-authenticated with an API key

Codex's login subcommand has a first-class API-key mode that reads the key from
stdin (never argv).

Codex's credential STORAGE is selected by `cli_auth_credentials_store` =
`file` (→ `$CODEX_HOME/auth.json`, default `~/.codex/auth.json`), `keyring`
(OS keychain — no file under `~/.codex`), `auto`, or `ephemeral`
(process-memory only — nothing persists). Do not assume a file path. **In
`ephemeral` mode `codex login --with-api-key` does NOT persist**, so a later
smoke process would not see it — use `file`/`keyring`/`auto` for the fallback.
`codex login status` reports the authentication METHOD/identity (e.g. "Logged
in using ChatGPT"), not the storage backend; use it to confirm which identity
is active, and check `cli_auth_credentials_store` for where the credential
lives.

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
`${GROK_HOME:-$HOME/.grok}/config.toml` (per xAI's documented configuration —
`$GROK_HOME` relocates the whole root; the config-file key takes precedence
over session auth). Its stored login (`grok login`, cached under the same
root) is the **subscription** flow.

- **Fallback that works through Camino dispatch:** set the API key in grok's
  own config file under its ACTIVE root as a PER-MODEL table (installed
  `grok 0.2.102` rejects a bare top-level `model.api_key` string — it expects
  a table). Per xAI's per-model configuration, use e.g. in
  `${GROK_HOME:-$HOME/.grok}/config.toml`:

  ```toml
  [model.grok-build]
  api_key = "<your xAI API key>"

  [models]
  default = "grok-build"
  ```

  Confirm with `grok inspect` (no `modelOverrideWarnings`). This is the same
  custody model as the other two providers — **vendor-CLI-owned custody via
  its active config root** (file-backed here; Anthropic/Codex may instead use
  the OS keychain), the sanctioned path (CAM-SEC-06). Because `HOME` and
  grok's own config root (`GROK_HOME`) are preserved for grok's workers, the
  official CLI loads that config — including a relocated root; Camino never
  reads or proxies the key. Follow xAI's current docs for the exact table name.
- **The env-var route does not reach a worker:** Camino's worker-env composer
  deliberately strips `XAI_API_KEY` (and every credential-shaped var), so
  exporting it in your shell has no effect on a dispatch. Use the config-file
  route above for a grok API-key fallback through Camino. (A future [F] API-key
  adapter could instead declare `XAI_API_KEY` as a passed-through credential
  var; the config-file route needs no such adapter.)
- **Revert:** remove `model.api_key` from
  `${GROK_HOME:-$HOME/.grok}/config.toml`; the stored `grok login`
  subscription resumes.
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
