// Composer unit tests — no docker required. The composer is the piece
// WP-107/WP-115 consume directly, so its fail-closed input handling is
// covered independently of the container suite.
import { describe, expect, it } from "vitest";
import { renderAllowlistEnv, renderEgressRunArgs } from "./profile/egress-profile.js";

describe("renderAllowlistEnv", () => {
  it("renders host:port entries space-separated", () => {
    expect(
      renderAllowlistEnv([
        { host: "endpoint-a", port: 8080 },
        { host: "192.0.2.7", port: 443 },
      ]),
    ).toBe("endpoint-a:8080 192.0.2.7:443");
  });

  it("empty allowlist renders the explicit deny-all value", () => {
    expect(renderAllowlistEnv([])).toBe("");
  });

  it("rejects hosts that could corrupt the space-separated contract", () => {
    for (const host of ["a b", "a:b", "", " ", "a\tb", "a\nb", "$(x)", "a;b", "-lead"]) {
      expect(() => renderAllowlistEnv([{ host, port: 80 }]), JSON.stringify(host)).toThrow(
        /rejected|allowlist/,
      );
    }
  });

  it("rejects out-of-range and non-integer ports", () => {
    for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
      expect(() => renderAllowlistEnv([{ host: "ok", port }])).toThrow(/port/);
    }
  });
});

describe("renderEgressRunArgs", () => {
  it("renders the full docker run vector: NET_ADMIN, network, allowlist env, ro mounts, cmd", () => {
    const args = renderEgressRunArgs(
      {
        image: "img:tag",
        network: "netx",
        allowlist: [{ host: "ep", port: 8080 }],
        env: { CAMINO_PROBE_ALLOWED_HOST: "ep" },
        readonlyMounts: [{ hostPath: "/h/probes.sh", containerPath: "/probes.sh" }],
      },
      ["/bin/sh", "/probes.sh"],
    );
    expect(args).toEqual([
      "run",
      "--rm",
      "--cap-add",
      "NET_ADMIN",
      "--network",
      "netx",
      "-e",
      "CAMINO_EGRESS_ALLOWLIST=ep:8080",
      "-e",
      "CAMINO_PROBE_ALLOWED_HOST=ep",
      "-v",
      "/h/probes.sh:/probes.sh:ro",
      "img:tag",
      "/bin/sh",
      "/probes.sh",
    ]);
  });

  it("requires a user-defined network (embedded DNS is a setup-time dependency)", () => {
    expect(() =>
      renderEgressRunArgs({ image: "i", network: "", allowlist: [] }, ["/bin/sh"]),
    ).toThrow(/network/);
  });

  it("rejects malformed env keys", () => {
    expect(() =>
      renderEgressRunArgs({ image: "i", network: "n", allowlist: [], env: { "BAD KEY": "v" } }, [
        "/bin/sh",
      ]),
    ).toThrow(/env key/);
  });
});
