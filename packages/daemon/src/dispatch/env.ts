// WP-105: worker env composition (CAM-SEC-06, CAM-EXEC-02) — the product
// promotion of the WP-001 spike composer, with the enforcement surface
// widened to the env channels the spike did not cover (git env-based config
// overrides, SSH agent/askpass vectors, ambient provider API keys).
import type { EnvPostureRecord } from "@camino/shared";
import { isGithubCredentialShapedKey } from "@camino/shared";

// Env keys safe to inherit for a headless CLI worker. HOME is included on
// purpose: the official vendor CLIs read their OWN subscription auth from
// under HOME (the sanctioned path — CAM-SEC-06). Camino never reads, copies,
// or proxies that credential; it only lets the official harness use its own.
const INHERIT_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR"];

// Credential-shaped key names (beyond the GitHub markers): a subscription
// dispatch must not carry loose API keys or secrets. In particular, an ambient
// provider key (ANTHROPIC_API_KEY / OPENAI_API_KEY / XAI_API_KEY) would
// silently re-bill a subscription dispatch to an API account — the API-key
// path is a deliberate, documented fallback (docs/runbooks/
// api-key-fallback.md), never an accident of the parent env. Matched on key
// NAMES; word-ish fragments chosen to avoid benign keys (GIT_AUTHOR_NAME must
// survive).
const CREDENTIAL_SHAPED_PATTERN =
  /API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|CREDENTIAL|PASSWORD|PASSPHRASE/i;

// Env channels that would re-open what GIT_CONFIG_GLOBAL/SYSTEM neutralization
// closes, or hand the worker ambient signing/authentication capability:
//   - GIT_CONFIG_COUNT + GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n and
//     GIT_CONFIG_PARAMETERS inject arbitrary git config (credential.helper,
//     core.sshCommand, …) ahead of any config file — they bypass the /dev/null
//     neutralization entirely.
//   - GIT_SSH / GIT_SSH_COMMAND / GIT_PROXY_COMMAND point git at arbitrary
//     transport commands (and at the user's keys).
//   - SSH_AUTH_SOCK / SSH_ASKPASS hand out the user's SSH agent (possession =
//     the ability to authenticate as the user to any git remote).
const EXACT_STRIP = new Set([
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  "SSH_AUTH_SOCK",
  "SSH_ASKPASS",
]);
const PREFIX_STRIP = ["GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"];

function mustStrip(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    isGithubCredentialShapedKey(upper) ||
    CREDENTIAL_SHAPED_PATTERN.test(upper) ||
    EXACT_STRIP.has(upper) ||
    PREFIX_STRIP.some((p) => upper.startsWith(p))
  );
}

/**
 * Compose a clean worker environment: an allowlist of inherited keys, git's
 * global/system config neutralized so a stored GitHub credential is
 * unreachable, plus adapter-specified extras. Never carries a GitHub
 * credential, a credential-shaped key, a git env-config override, or an SSH
 * agent reference.
 *
 * NOTE (same boundary as the spike, WP-107 closes it): this isolates the ENV.
 * Full filesystem isolation — so a worker cannot read ~/.config/gh or
 * ~/.gitconfig off disk — is container-level and lands in WP-107. What this
 * composer enforces is exactly CAM-SEC-06's composition clause: host
 * credential state is referenced only through HOME for the official CLIs'
 * own auth; nothing credential-shaped is injected or forwarded.
 */
export function composeWorkerEnv(
  source: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): { env: Record<string, string>; posture: EnvPostureRecord } {
  const env: Record<string, string> = {};
  for (const key of INHERIT_ALLOWLIST) {
    const v = source[key];
    if (typeof v === "string") env[key] = v;
  }

  // Adapter-supplied extras go on FIRST, so the enforcement below cannot be
  // overridden by them (WP-001 review finding #3): a misbehaving or buggy
  // adapter must not be able to restore a credential, re-open a git config
  // channel, or un-neutralize git.
  for (const [k, v] of Object.entries(extra)) env[k] = v;

  // ENFORCE, don't merely report: drop every credential-shaped key and every
  // git/SSH override channel…
  const strippedKeys: string[] = [];
  for (const k of Object.keys(env)) {
    if (mustStrip(k)) {
      strippedKeys.push(k);
      delete env[k];
    }
  }
  // …and neutralize git's global + system config LAST so nothing can override
  // it: no user gitconfig, no credential helper, no stored token is visible.
  env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  env["GIT_CONFIG_SYSTEM"] = "/dev/null";
  env["GIT_TERMINAL_PROMPT"] = "0";

  const keys = Object.keys(env).sort();
  const githubCredentialKeys = keys.filter((k) => isGithubCredentialShapedKey(k));

  return {
    env,
    posture: {
      keys,
      githubCredentialKeys, // empty BY CONSTRUCTION, not by luck
      gitGlobalNeutralized:
        env["GIT_CONFIG_GLOBAL"] === "/dev/null" && env["GIT_CONFIG_SYSTEM"] === "/dev/null",
      strippedKeys: strippedKeys.sort(),
    },
  };
}
