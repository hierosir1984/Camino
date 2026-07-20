// WP-105: worker env composition (CAM-SEC-06, CAM-EXEC-02) — the product
// promotion of the WP-001 spike composer, with the enforcement surface
// widened to the env channels the spike did not cover (git env-based config
// overrides, git repo/exec redirects, SSH agent/askpass vectors, ambient
// provider API keys) and the host allowlist RE-ASSERTED after extras so an
// adapter cannot clobber HOME/PATH (round-1 review finding 4).
//
// The reserved-name knowledge (what is stripped, what is the host allowlist)
// lives in @camino/shared so this composer and the API-key adapter contract
// check enforce ONE source of truth: a channel the composer closes cannot be
// re-opened by an API-key adapter declaring it as a "credential env var".
import type { EnvPostureRecord } from "@camino/shared";
import {
  WORKER_ENV_ALLOWLIST,
  isGithubCredentialShapedKey,
  isStrippedWorkerEnvKey,
  isWorkerEnvAllowlistKey,
} from "@camino/shared";

/**
 * Compose a clean worker environment: an allowlist of inherited keys (locked
 * to their host values), git's global/system config neutralized so a stored
 * GitHub credential is unreachable, plus adapter-specified extras. Never
 * carries a GitHub credential, a credential-shaped key, a git config/redirect
 * override, or an SSH agent reference; extras can never overwrite an
 * allowlisted key.
 *
 * BOUNDARY, stated (round-1 review finding 4; same class as the WP-102 token
 * dir / WP-003 git-fsck boundaries): the host contributes ONLY the allowlist,
 * so no host credential can reach a worker through this composer — a value in
 * `extra` is an ADAPTER-authored literal, not host state. The credential /
 * git / ssh strip below is defense-in-depth against a misbehaving adapter and
 * covers the named capability channels; complete isolation of every
 * conceivable channel (GNUPGHOME, docker config, an adapter that hard-codes a
 * secret it could equally have put in argv) is the CONTAINER's job (WP-107,
 * CAM-EXEC-02: isolated full clone, no host filesystem), not this ENV layer's.
 * This layer closes the env-inheritance and known-channel surface and names
 * the rest rather than chasing an unbounded denylist.
 */
export function composeWorkerEnv(
  source: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): { env: Record<string, string>; posture: EnvPostureRecord } {
  const env: Record<string, string> = {};

  // 1. Inherit the host allowlist.
  const inherited: Record<string, string> = {};
  for (const key of WORKER_ENV_ALLOWLIST) {
    const v = source[key];
    if (typeof v === "string") inherited[key] = v;
  }
  Object.assign(env, inherited);

  // 2. Adapter-supplied extras go on next — but an allowlist key is HOST-ONLY
  //    (round-1 review finding 4): an extra may neither override nor introduce
  //    HOME/PATH/etc. Those come from the host or not at all.
  for (const [k, v] of Object.entries(extra)) {
    if (isWorkerEnvAllowlistKey(k)) continue;
    env[k] = v;
  }

  // 3. …then ENFORCE, don't merely report: drop every credential-shaped key
  //    and every git config/redirect / SSH override channel, whatever supplied
  //    it (WP-001 review finding #3; round-1 finding 4 widened the set).
  const strippedKeys: string[] = [];
  for (const k of Object.keys(env)) {
    if (isStrippedWorkerEnvKey(k)) {
      strippedKeys.push(k);
      delete env[k];
    }
  }

  // 4. RE-ASSERT the host allowlist (belt-and-suspenders over step 2's skip):
  //    the allowlist is host-derived by contract, so nothing extras did can
  //    have changed HOME/PATH/etc. (round-1 review finding 4).
  Object.assign(env, inherited);

  // 5. Neutralize git's global + system config LAST so nothing can override
  //    it: no user gitconfig, no credential helper, no stored token is visible.
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
