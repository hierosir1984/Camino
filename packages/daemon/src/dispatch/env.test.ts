import { describe, expect, it } from "vitest";
import { composeWorkerEnv } from "./env.js";

// Worker env posture (CAM-SEC-06 / CAM-EXEC-02): enforcement, not detection —
// the composed env can never carry a credential-shaped key, a git env-config
// override, or an SSH agent reference, no matter what an adapter supplies.

describe("composeWorkerEnv", () => {
  it("inherits ONLY the allowlist; parent credential-shaped vars never leak in", () => {
    const { env, posture } = composeWorkerEnv({
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
    });
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
