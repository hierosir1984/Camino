import type { EnvPostureRecord } from "./types.js";

// GitHub-credential-shaped env keys a worker must never carry (CAM-SEC-06,
// CAM-EXEC-02): the control plane holds the sole GitHub credential; workers
// hold zero. Matched case-insensitively as substrings.
const GITHUB_CREDENTIAL_MARKERS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_PAT",
  "GIT_ASKPASS",
  "GIT_TOKEN",
];

// Env keys safe to inherit for a headless CLI worker. HOME is included on
// purpose: the official vendor CLIs read their OWN subscription auth from
// under HOME (the sanctioned path — CAM-SEC-06). Camino never reads, copies,
// or proxies that credential; it only lets the official harness use its own.
const INHERIT_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR"];

/**
 * Compose a clean worker environment: an allowlist of inherited keys, git's
 * global/system config neutralized so a stored GitHub credential is
 * unreachable, plus adapter-specified extras. Never carries a GitHub credential.
 *
 * NOTE (spike scope): this isolates the ENV. Full filesystem isolation — so a
 * worker cannot read ~/.config/gh or ~/.gitconfig off disk — is container-level
 * and lands in WP-107. The posture demonstrated here is env composition, which
 * is exactly what CAM-SEC-06's spike acceptance asks for.
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
  // overridden by them (WP-001 review finding #3): an untrusted or buggy adapter
  // must not be able to restore a GitHub credential or un-neutralize git.
  for (const [k, v] of Object.entries(extra)) env[k] = v;

  // ENFORCE, don't merely report: drop every GitHub-credential-shaped key…
  for (const k of Object.keys(env)) {
    if (GITHUB_CREDENTIAL_MARKERS.some((m) => k.toUpperCase().includes(m))) delete env[k];
  }
  // …and neutralize git's global + system config LAST so nothing can override
  // it: no user gitconfig, no credential helper, no stored token is visible.
  env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  env["GIT_CONFIG_SYSTEM"] = "/dev/null";
  env["GIT_TERMINAL_PROMPT"] = "0";

  const keys = Object.keys(env).sort();
  const githubCredentialKeys = keys.filter((k) =>
    GITHUB_CREDENTIAL_MARKERS.some((m) => k.toUpperCase().includes(m)),
  );

  return {
    env,
    posture: {
      keys,
      githubCredentialKeys, // now empty BY CONSTRUCTION, not by luck
      gitGlobalNeutralized:
        env["GIT_CONFIG_GLOBAL"] === "/dev/null" && env["GIT_CONFIG_SYSTEM"] === "/dev/null",
    },
  };
}

export { GITHUB_CREDENTIAL_MARKERS };
