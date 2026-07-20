import { describe, expect, it } from "vitest";
import {
  WORKER_ENV_ALLOWLIST,
  OFFICIAL_ADAPTER_NAMES,
  OFFICIAL_CLI_CONFIG_ROOTS,
  CREDENTIAL_ROOT_ENV_KEYS,
  STRIPPED_ENV_EXACT,
  STRIPPED_ENV_PREFIXES,
  GITHUB_CREDENTIAL_MARKERS,
} from "@camino/shared";
import { composeWorkerEnv } from "./env.js";

// Worker env posture (CAM-SEC-06 / CAM-EXEC-02): enforcement, not detection —
// the composed env can never carry a credential-shaped key, a git env-config
// override, or an SSH agent reference, no matter what an adapter supplies.

describe("composeWorkerEnv", () => {
  it("inherits ONLY the allowlist; parent credential-shaped vars never leak in", () => {
    const { env, posture } = composeWorkerEnv(
      {
        PATH: "/usr/bin",
        HOME: "/Users/x",
        USER: "x",
        LANG: "en_US.UTF-8",
        // none of these are on the allowlist:
        GITHUB_TOKEN: "ghp_parent",
        ANTHROPIC_API_KEY: "sk-ant-parent",
        OPENAI_API_KEY: "sk-parent",
        XAI_API_KEY: "xai-parent",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        RANDOM_PARENT_VAR: "noise",
      },
      {},
      { officialCli: "claude-code" }, // official scope: HOME granted (round-6 finding 2)
    );
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["OPENAI_API_KEY"]).toBeUndefined();
    expect(env["XAI_API_KEY"]).toBeUndefined();
    expect(env["SSH_AUTH_SOCK"]).toBeUndefined();
    expect(env["RANDOM_PARENT_VAR"]).toBeUndefined();
    expect(env["HOME"]).toBe("/Users/x"); // provider auth path preserved (sanctioned)
    expect(env["PATH"]).toBe("/usr/bin");
    expect(posture.githubCredentialKeys).toEqual([]);
    expect(posture.gitGlobalNeutralized).toBe(true);
  });

  it("strips GitHub-credential-shaped keys even when the adapter injects them (WP-001 #3)", () => {
    const { env, posture } = composeWorkerEnv(
      { PATH: "/usr/bin", HOME: "/Users/x" },
      {
        GITHUB_TOKEN: "adapter-injected",
        GH_ENTERPRISE_TOKEN: "adapter-enterprise",
        MY_GITHUB_PAT_BACKUP: "smuggled-substring",
        GIT_CONFIG_GLOBAL: "/tmp/external-gitconfig",
      },
    );
    expect(posture.githubCredentialKeys).toEqual([]); // CAM-SEC-06 / CAM-EXEC-02
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
    expect(env["GH_ENTERPRISE_TOKEN"]).toBeUndefined();
    expect(env["MY_GITHUB_PAT_BACKUP"]).toBeUndefined();
    expect(env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null"); // override rejected
    expect(env["GIT_CONFIG_SYSTEM"]).toBe("/dev/null");
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(posture.gitGlobalNeutralized).toBe(true);
  });

  it("strips ambient provider API keys from extras: a subscription dispatch must not silently re-bill to an API account", () => {
    const { env, posture } = composeWorkerEnv(
      { PATH: "/usr/bin", HOME: "/Users/x" },
      {
        ANTHROPIC_API_KEY: "sk-ant-x",
        OPENAI_API_KEY: "sk-x",
        XAI_API_KEY: "xai-x",
        AWS_ACCESS_KEY_ID: "AKIA-x",
        SERVICE_SECRET: "s",
        DB_PASSWORD: "p",
        SIGNING_PASSPHRASE: "p",
        VENDOR_CREDENTIALS: "c",
      },
    );
    for (const k of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "XAI_API_KEY",
      "AWS_ACCESS_KEY_ID",
      "SERVICE_SECRET",
      "DB_PASSWORD",
      "SIGNING_PASSPHRASE",
      "VENDOR_CREDENTIALS",
    ]) {
      expect(env[k], k).toBeUndefined();
      expect(posture.strippedKeys, k).toContain(k);
    }
  });

  it("closes the git env-config override channels (GIT_CONFIG_COUNT/KEY_n/VALUE_n/PARAMETERS bypass /dev/null neutralization)", () => {
    const { env, posture } = composeWorkerEnv(
      { PATH: "/usr/bin", HOME: "/Users/x" },
      {
        GIT_CONFIG: "/tmp/cfg",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "store",
        GIT_CONFIG_PARAMETERS: "'credential.helper=store'",
        GIT_SSH: "/tmp/ssh-wrapper",
        GIT_SSH_COMMAND: "ssh -i /Users/x/.ssh/id_ed25519",
        GIT_PROXY_COMMAND: "/tmp/proxy",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        SSH_ASKPASS: "/tmp/askpass",
      },
    );
    for (const k of [
      "GIT_CONFIG",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_CONFIG_PARAMETERS",
      "GIT_SSH",
      "GIT_SSH_COMMAND",
      "GIT_PROXY_COMMAND",
      "SSH_AUTH_SOCK",
      "SSH_ASKPASS",
    ]) {
      expect(env[k], k).toBeUndefined();
      expect(posture.strippedKeys, k).toContain(k);
    }
    expect(env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
    expect(env["GIT_CONFIG_SYSTEM"]).toBe("/dev/null");
  });

  it("closes the git repo/exec REDIRECT and command-execution channels (round-1 finding 4, round-2 finding 7)", () => {
    // GIT_DIR & friends point git at attacker-chosen state; GIT_EXTERNAL_DIFF /
    // GIT_EDITOR / GIT_PAGER / GIT_SEQUENCE_EDITOR make an ordinary git
    // invocation run an attacker binary — untouched by /dev/null config
    // neutralization.
    const channels = {
      GIT_DIR: "/evil/.git",
      GIT_WORK_TREE: "/evil/tree",
      GIT_OBJECT_DIRECTORY: "/evil/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/evil/alt",
      GIT_INDEX_FILE: "/evil/index",
      GIT_NAMESPACE: "evil",
      GIT_COMMON_DIR: "/evil/common",
      GIT_EXEC_PATH: "/evil/git-core",
      GIT_EXTERNAL_DIFF: "/evil/differ",
      GIT_EDITOR: "/evil/editor",
      GIT_SEQUENCE_EDITOR: "/evil/seq",
      GIT_PAGER: "/evil/pager",
      GIT_TEMPLATE_DIR: "/evil/templates",
    };
    const { env, posture } = composeWorkerEnv({ PATH: "/usr/bin", HOME: "/Users/x" }, channels);
    for (const k of Object.keys(channels)) {
      expect(env[k], k).toBeUndefined();
      expect(posture.strippedKeys, k).toContain(k);
    }
  });

  it("each official CLI gets HOME + its OWN config root only — relocated configs authenticate, siblings' roots do not leak (round-5 finding 2, scoped per round-6 finding 2)", () => {
    const host = {
      PATH: "/usr/bin",
      HOME: "/Users/x",
      CODEX_HOME: "/custom/codex",
      CLAUDE_CONFIG_DIR: "/custom/claude",
      GROK_HOME: "/custom/grok",
    };
    const cases = [
      { officialCli: "codex-cli", own: "CODEX_HOME", value: "/custom/codex" },
      { officialCli: "claude-code", own: "CLAUDE_CONFIG_DIR", value: "/custom/claude" },
      { officialCli: "grok-build", own: "GROK_HOME", value: "/custom/grok" },
    ] as const;
    for (const { officialCli, own, value } of cases) {
      const { env, posture } = composeWorkerEnv(host, {}, { officialCli });
      expect(env[own], officialCli).toBe(value); // its own (possibly relocated) root
      expect(env["HOME"], officialCli).toBe("/Users/x");
      for (const other of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME"]) {
        if (other !== own)
          expect(env[other], `${officialCli} must not see ${other}`).toBeUndefined();
      }
      expect(posture.credentialRootKeys).toEqual([...["HOME", own]].sort());
    }
  });

  it("a NON-official worker gets no credential roots at all (round-6 finding 2, CAM-SEC-06)", () => {
    const { env, posture } = composeWorkerEnv({
      PATH: "/usr/bin",
      HOME: "/Users/x",
      USER: "x",
      CODEX_HOME: "/custom/codex",
      CLAUDE_CONFIG_DIR: "/custom/claude",
      GROK_HOME: "/custom/grok",
    });
    for (const root of ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME"]) {
      expect(env[root], root).toBeUndefined();
    }
    expect(env["PATH"]).toBe("/usr/bin"); // base keys still compose
    expect(env["USER"]).toBe("x");
    expect(posture.credentialRootKeys).toEqual([]);
  });

  it("an extra can never introduce a credential root the scope did not grant", () => {
    // Allowlist keys are host-only (round-1 finding 4), which also means an
    // adapter extra cannot smuggle in a sibling CLI's root or HOME.
    const { env } = composeWorkerEnv(
      { PATH: "/usr/bin", HOME: "/Users/x", CLAUDE_CONFIG_DIR: "/custom/claude" },
      { CODEX_HOME: "/evil/codex", GROK_HOME: "/evil/grok", HOME: "/evil/home" },
      { officialCli: "claude-code" },
    );
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/custom/claude"); // granted, host-derived
    expect(env["HOME"]).toBe("/Users/x"); // granted, host value wins
    expect(env["CODEX_HOME"]).toBeUndefined(); // not granted; extra rejected
    expect(env["GROK_HOME"]).toBeUndefined();
  });

  it("strips the whole SSH_* family by prefix, incl. SSH_SK_PROVIDER (round-3 finding 3)", () => {
    // SSH_SK_PROVIDER is a loadable library path SSH honors; the SSH_* prefix
    // closes it and any other SSH_* directive in one rule.
    const { env, posture } = composeWorkerEnv(
      { PATH: "/usr/bin", HOME: "/Users/x" },
      {
        SSH_SK_PROVIDER: "/tmp/attacker.dylib",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        SSH_ASKPASS: "/tmp/askpass",
        SSH_CONNECTION: "1.2.3.4",
      },
    );
    for (const k of ["SSH_SK_PROVIDER", "SSH_AUTH_SOCK", "SSH_ASKPASS", "SSH_CONNECTION"]) {
      expect(env[k], k).toBeUndefined();
      expect(posture.strippedKeys, k).toContain(k);
    }
  });

  it("extras can NEVER clobber a host-inherited allowlist key (round-1 finding 4)", () => {
    // An adapter extra HOME=/evil / PATH=/evil must not overwrite the sanctioned
    // host values — the allowlist is host-derived by contract.
    const { env } = composeWorkerEnv(
      { PATH: "/host/bin", HOME: "/host/home", USER: "hostuser", LANG: "en_US.UTF-8" },
      { HOME: "/evil/home", PATH: "/evil/bin", USER: "evil", LANG: "xx" },
      { officialCli: "claude-code" },
    );
    expect(env["HOME"]).toBe("/host/home");
    expect(env["PATH"]).toBe("/host/bin");
    expect(env["USER"]).toBe("hostuser");
    expect(env["LANG"]).toBe("en_US.UTF-8");
  });

  it("an allowlist key absent from the host stays absent even if an extra supplies it", () => {
    // Re-assertion copies only keys the host actually had — an extra cannot
    // introduce an allowlist key the host never set.
    const { env } = composeWorkerEnv(
      { PATH: "/host/bin" },
      { HOME: "/evil/home" },
      { officialCli: "claude-code" }, // HOME granted by scope — but the host never set it
    );
    expect(env["PATH"]).toBe("/host/bin");
    expect(env["HOME"]).toBeUndefined();
  });

  it("benign adapter extras survive (no over-stripping)", () => {
    const { env, posture } = composeWorkerEnv(
      { PATH: "/usr/bin", HOME: "/Users/x" },
      {
        MOCK_MODE: "solve",
        MOCK_FLOOD: "500",
        GIT_AUTHOR_NAME: "Worker", // "AUTHOR" must not be eaten by a credential pattern
        NO_COLOR: "1",
      },
    );
    expect(env["MOCK_MODE"]).toBe("solve");
    expect(env["MOCK_FLOOD"]).toBe("500");
    expect(env["GIT_AUTHOR_NAME"]).toBe("Worker");
    expect(env["NO_COLOR"]).toBe("1");
    expect(posture.strippedKeys).toEqual([]);
  });

  it("drops empty and relative PATH entries so a worker cannot resolve against its cwd (round-8 finding 1)", () => {
    const { env } = composeWorkerEnv(
      { PATH: `.:/usr/bin:relative/dir::${"/opt/bin"}`, HOME: "/Users/x" },
      {},
      { officialCli: "claude-code" },
    );
    expect(env["PATH"]).toBe("/usr/bin:/opt/bin"); // only absolute entries survive
    expect(env["PATH"]!.split(":")).not.toContain("."); // no cwd
    expect(env["PATH"]!.split(":")).not.toContain(""); // no empty (=cwd) slot
    expect(env["PATH"]!.split(":")).not.toContain("relative/dir");
  });

  it("never emits PATH='' — an all-relative/empty host PATH deletes the key, not a cwd-resolving empty (round-9 finding 1)", () => {
    const { env } = composeWorkerEnv(
      { PATH: ".:relative/dir::", HOME: "/Users/x" },
      {},
      { officialCli: "claude-code" },
    );
    // An empty PATH string is ONE empty entry → execvp resolves it against cwd
    // (the untrusted workspace). The key must be absent, not "".
    expect(env["PATH"]).toBeUndefined();
    expect("PATH" in env).toBe(false);
    expect(env["HOME"]).toBe("/Users/x"); // the rest of the env still composes
  });

  it("enforcement policy exports are FROZEN — a package-root importer cannot mutate them (round-8 finding 2)", () => {
    const policies = [
      WORKER_ENV_ALLOWLIST,
      OFFICIAL_ADAPTER_NAMES,
      OFFICIAL_CLI_CONFIG_ROOTS,
      CREDENTIAL_ROOT_ENV_KEYS,
      STRIPPED_ENV_EXACT,
      STRIPPED_ENV_PREFIXES,
      GITHUB_CREDENTIAL_MARKERS,
    ];
    for (const p of policies) expect(Object.isFrozen(p)).toBe(true);
    // A mutation attempt throws in strict mode (ESM is strict) — dropping
    // "claude-code" from the official set, or a key from the credential-root
    // set, would otherwise bypass provenance / root scoping.
    expect(() => (OFFICIAL_ADAPTER_NAMES as unknown as string[]).pop()).toThrow(TypeError);
    expect(() => (CREDENTIAL_ROOT_ENV_KEYS as unknown as string[]).pop()).toThrow(TypeError);
    expect(() => {
      (OFFICIAL_CLI_CONFIG_ROOTS as unknown as Record<string, string>)["codex-cli"] = "EVIL_HOME";
    }).toThrow(TypeError);
    // …and the objects are unchanged.
    expect(OFFICIAL_ADAPTER_NAMES).toContain("claude-code");
    expect(OFFICIAL_CLI_CONFIG_ROOTS["codex-cli"]).toBe("CODEX_HOME");
  });

  it("records the posture with key NAMES only and sorted", () => {
    const { posture } = composeWorkerEnv(
      { PATH: "/usr/bin", HOME: "/Users/x" },
      { ZED_TOKEN: "v", A_SECRET: "v" },
    );
    expect(posture.strippedKeys).toEqual(["A_SECRET", "ZED_TOKEN"]);
    expect(posture.keys).toEqual([...posture.keys].sort());
    // No posture field ever carries a value.
    expect(JSON.stringify(posture)).not.toContain('"v"');
  });
});
