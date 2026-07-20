import { describe, expect, it } from "vitest";
import type { AdapterContext, SpawnPlan } from "./adapter.js";
import {
  API_KEY_ADAPTER_DISPATCH_OBLIGATIONS,
  CREDENTIAL_ENV_VAR_PATTERN,
  checkAdapterPlanCustody,
  checkApiKeyAdapterSpec,
  checkPlanCredentialCustody,
  type ApiKeyAdapterSpec,
} from "./api-key-adapter.js";

// The conformance-test SKELETON must itself discriminate: a conformant spec
// passes every check, and each contract violation trips its named check. The
// fakes below are test fixtures proving the skeleton works — no product
// API-key adapter ships in WP-105 (the implementation is [F]).

const CTX: AdapterContext = { workdir: "/tmp/ws", prompt: "solve the issue" };
const PLANTED = ["synthetic-credential-value-1", "synthetic-credential-value-2"];

function conformantFake(overrides: Partial<ApiKeyAdapterSpec> = {}): ApiKeyAdapterSpec {
  return {
    kind: "api-key",
    provider: "example",
    name: "example-api",
    enabled: false,
    disabledReason: "no implementation ships in WP-105 (interface is [F])",
    credentialEnvVars: ["EXAMPLE_API_KEY"],
    plan(ctx): SpawnPlan {
      // A conformant plan never touches credential values: the composer passes
      // the declared env var through from host state at spawn time.
      return { file: "example-cli", args: ["-p", ctx.prompt, "--headless"] };
    },
    parseLine: () => null,
    ...overrides,
  };
}

describe("checkApiKeyAdapterSpec (static declaration conformance)", () => {
  it("a conformant spec passes with zero violations", () => {
    expect(checkApiKeyAdapterSpec(conformantFake())).toEqual([]);
  });

  it("flags a wrong kind discriminator", () => {
    const v = checkApiKeyAdapterSpec(
      conformantFake({ kind: "subscription" as unknown as "api-key" }),
    );
    expect(v.map((x) => x.check)).toContain("kind");
  });

  it("flags an empty provider and an empty name", () => {
    const v = checkApiKeyAdapterSpec(conformantFake({ provider: "", name: "" }));
    expect(v.map((x) => x.check)).toEqual(expect.arrayContaining(["provider", "name"]));
  });

  it("flags an empty credential declaration", () => {
    const v = checkApiKeyAdapterSpec(conformantFake({ credentialEnvVars: [] }));
    expect(v.map((x) => x.check)).toContain("credential-env-vars");
  });

  it("flags malformed env var names (grammar is uppercase POSIX)", () => {
    for (const bad of ["example_api_key", "1KEY", "WITH-DASH", "WITH SPACE", ""]) {
      const v = checkApiKeyAdapterSpec(conformantFake({ credentialEnvVars: [bad] }));
      expect(
        v.map((x) => x.check),
        bad,
      ).toContain("credential-env-vars");
      expect(CREDENTIAL_ENV_VAR_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it("flags duplicate declarations", () => {
    const v = checkApiKeyAdapterSpec(
      conformantFake({ credentialEnvVars: ["EXAMPLE_API_KEY", "EXAMPLE_API_KEY"] }),
    );
    expect(v.some((x) => x.detail.includes("more than once"))).toBe(true);
  });

  it("REFUSES a GitHub-credential-shaped declaration: the GitHub channel stays closed", () => {
    for (const gh of ["GITHUB_TOKEN", "GH_TOKEN", "MY_GITHUB_PAT"]) {
      const v = checkApiKeyAdapterSpec(conformantFake({ credentialEnvVars: [gh] }));
      expect(
        v.some((x) => x.detail.includes("GitHub-credential-shaped")),
        gh,
      ).toBe(true);
    }
  });
});

describe("checkPlanCredentialCustody (values never reach the plan)", () => {
  it("a conformant plan passes with planted values in scope", () => {
    expect(checkAdapterPlanCustody(conformantFake(), CTX, PLANTED)).toEqual([]);
  });

  it("catches a credential value embedded in argv", () => {
    const spec = conformantFake({
      plan: () => ({ file: "example-cli", args: ["--api-key", PLANTED[0]!] }),
    });
    const v = checkAdapterPlanCustody(spec, CTX, PLANTED);
    expect(v.some((x) => x.check === "plan-custody" && x.detail.includes("plan.args"))).toBe(true);
  });

  it("catches a credential value delivered via stdin", () => {
    const spec = conformantFake({
      plan: (ctx) => ({ file: "example-cli", args: [], stdin: `${ctx.prompt}\n${PLANTED[1]!}` }),
    });
    const v = checkAdapterPlanCustody(spec, CTX, PLANTED);
    expect(v.some((x) => x.detail.includes("plan.stdin"))).toBe(true);
  });

  it("catches a credential value smuggled through a plan env value", () => {
    const spec = conformantFake({
      plan: () => ({ file: "example-cli", args: [], env: { HARMLESS_LOOKING: PLANTED[0]! } }),
    });
    const v = checkAdapterPlanCustody(spec, CTX, PLANTED);
    expect(v.some((x) => x.detail.includes('plan.env["HARMLESS_LOOKING"]'))).toBe(true);
  });

  it("REFUSES a plan that sets its own declared credential var, regardless of value", () => {
    const spec = conformantFake({
      plan: () => ({ file: "example-cli", args: [], env: { EXAMPLE_API_KEY: "anything" } }),
    });
    const v = checkAdapterPlanCustody(spec, CTX, PLANTED);
    expect(v.some((x) => x.detail.includes('declared credential var "EXAMPLE_API_KEY"'))).toBe(
      true,
    );
  });

  it("empty planted values never false-positive", () => {
    const plan: SpawnPlan = { file: "x", args: ["y"] };
    expect(checkPlanCredentialCustody(conformantFake(), plan, [""])).toEqual([]);
  });
});

describe("dispatch-level obligations (documented for the [F] implementation)", () => {
  it("names the kill-confirm sequence and the quota classification contract", () => {
    const text = API_KEY_ADAPTER_DISPATCH_OBLIGATIONS.join("\n");
    expect(API_KEY_ADAPTER_DISPATCH_OBLIGATIONS.length).toBeGreaterThan(0);
    expect(text).toContain("SIGTERM → grace → SIGKILL → tree-gone → lease release");
    expect(text).toContain("quota-blocked, never requirement-failed");
    expect(text).toContain("host env state");
  });
});
