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
import { delimiter, isAbsolute } from "node:path";
import type { EnvPostureRecord, OfficialAdapterName } from "@camino/shared";
import {
  WORKER_ENV_ALLOWLIST,
  OFFICIAL_CLI_CONFIG_ROOTS,
  isCredentialRootEnvKey,
  isGithubCredentialShapedKey,
  isStrippedWorkerEnvKey,
  isWorkerEnvAllowlistKey,
} from "@camino/shared";

/**
 * Adapter identity for credential-root scoping (round-6 finding 2). An
 * official CLI receives HOME + its OWN config root; any other worker receives
 * NO credential roots (CAM-SEC-06: composition references host credential
 * state for official CLIs only — enforced here, not merely stated).
 */
export interface WorkerEnvScope {
  officialCli?: OfficialAdapterName;
}

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
  scope: WorkerEnvScope = {},
): { env: Record<string, string>; posture: EnvPostureRecord } {
  const env: Record<string, string> = {};

  // 1. Inherit the host allowlist, credential roots SCOPED per adapter
  //    identity (round-6 finding 2): an official CLI gets HOME + its OWN
  //    config root; every other worker gets the base keys only.
  const grantedRoots = new Set<string>(
    scope.officialCli ? ["HOME", OFFICIAL_CLI_CONFIG_ROOTS[scope.officialCli]] : [],
  );
  const inherited: Record<string, string> = {};
  for (const key of WORKER_ENV_ALLOWLIST) {
    if (isCredentialRootEnvKey(key) && !grantedRoots.has(key)) continue;
    const v = source[key];
    if (typeof v === "string") inherited[key] = v;
  }
  // Drop empty (=cwd) and relative PATH entries so a worker cannot resolve a
  // bare command against its untrusted workspace (round-8 finding 1). The
  // official CLI itself is spawned by its gate-resolved ABSOLUTE path; this
  // also denies a cwd-relative shadow to the CLI's OWN child processes
  // (git/node). A tool that hardcodes a relative exec is the named container
  // boundary (WP-107). Same rationale as the registry's absolute-only scan.
  if (typeof inherited["PATH"] === "string") {
    inherited["PATH"] = inherited["PATH"]
      .split(delimiter)
      .filter((d) => d && isAbsolute(d))
      .join(delimiter);
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
      // Which credential roots this worker was actually granted AND the host
      // had set (names only) — [] for every non-official worker.
      credentialRootKeys: [...grantedRoots].filter((k) => k in inherited).sort(),
    },
  };
}
