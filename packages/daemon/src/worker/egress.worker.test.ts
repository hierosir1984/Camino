// WP-107 worker-isolation suite — CAM-EXEC-02/03, run against the PRODUCT
// composer (renderWorkerRunArgs) and the product worker-profile image.
//
// It builds on the WP-005 validation-egress suite rather than duplicating it,
// and closes that suite's two stated deferrals:
//   - the inbound two-container round-trip (WP-005 finding 4 was closed
//     structurally there; here it is exercised end-to-end);
//   - a packet-level IPv6 proof (WP-005 asserted rule presence only).
// Plus the worker-specific claims WP-005 did not make:
//   - zero GitHub credentials asserted from INSIDE the container (env + fs);
//   - provider auth mounted READ-ONLY (a write from the workspace fails while
//     the workspace itself is writable — CAM-EXEC-02);
//   - the hardened container shape (cap-drop ALL, no-new-privileges) actually
//     produces an unprivileged workload that cannot alter its own rules.
//
// The probe workload only PRODUCES evidence (raw exit codes); this file
// decides (WP-004 convention). Requires the Docker daemon and refuses to skip.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { docker, dockerOrThrow, requireDockerDaemon } from "./docker.js";
import { renderWorkerRunArgs, WORKER_WORKSPACE_MOUNT } from "./egress.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(HERE, "worker-profile");
const IMAGE = "camino-worker-profile:wp107";
const RUN_ID = randomUUID().slice(0, 8);
const NET = `camino-wrk-${RUN_ID}`;
const ALLOWED = `camino-wrk-${RUN_ID}-allowed`;
const DENIED = `camino-wrk-${RUN_ID}-denied`;
const ALLOWED_BODY = "camino-worker-allowed-ok";
const DENIED_BODY = "camino-worker-denied-ok";
const ENDPOINT_PORT = 8080;
const WRONG_PORT = 8081;
const LISTEN_PORT = 9000; // inbound round-trip target

const SETUP_TIMEOUT = 300_000;
const TEST_TIMEOUT = 120_000;

const PROVIDER_TOKEN_BODY = "provider-subscription-token-DO-NOT-WRITE";
const AUTH_MOUNT = "/auth/provider";
// The probe script is injected via a mount too; it must sit under a Camino mount
// root (the allowlist refuses everything else — round-10 findings 2/4). Under
// /auth but OUTSIDE the provider-auth dir, so the content cred-scan (scoped to
// the provider-auth dir) never scans the probe script itself.
const PROBE_MOUNT = "/auth/worker-probes.sh";

let allowedIp = "";
let deniedIp = "";
let allowedV6 = "";
/** True only once an UNRESTRICTED container has reached the endpoint over v6 —
 * so the profiled v6 block is provably attributable, and the whole v6 proof is
 * skipped cleanly on a runner without working container IPv6. */
let v6Proven = false;
/** A rw workspace dir and a ro provider-auth dir on the host, per run. */
let workspaceHostDir = "";
let providerAuthHostDir = "";
const scratch: string[] = [];

interface ProbeLine {
  probe: string;
  exit: number;
  out: string;
}

function parseProbes(stdout: string): Map<string, ProbeLine> {
  const out = new Map<string, ProbeLine>();
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // non-probe diagnostic lines are ignored; missing probes fail below
    }
    const p = parsed as Partial<ProbeLine>;
    if (typeof p.probe !== "string" || typeof p.exit !== "number" || typeof p.out !== "string") {
      continue;
    }
    if (out.has(p.probe)) throw new Error(`duplicate probe record: ${p.probe}`);
    out.set(p.probe, { probe: p.probe, exit: p.exit, out: p.out });
  }
  return out;
}

function probeOf(probes: Map<string, ProbeLine>, name: string): ProbeLine {
  const p = probes.get(name);
  if (!p) {
    throw new Error(`probe '${name}' missing (${[...probes.keys()].join(", ")})`);
  }
  return p;
}

function outputRules(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-A OUTPUT"));
}

/** DNS closed before loopback accept; allow before the catch-all; REJECT last. */
function assertRuleOrder(stderr: string, allowedPort: number): void {
  const rules = outputRules(stderr);
  const idx = (pred: (r: string) => boolean): number => rules.findIndex(pred);
  const dnsResolver = idx((r) => r.includes("127.0.0.11") && r.includes("REJECT"));
  const loAccept = idx((r) => /-o lo -j ACCEPT$/.test(r));
  const allowAccept = idx(
    (r) => r.includes(`--dport ${String(allowedPort)}`) && r.includes("ACCEPT"),
  );
  const finalReject = rules.length - 1;
  expect(dnsResolver, "resolver-address reject present").toBeGreaterThanOrEqual(0);
  expect(loAccept, "loopback accept present").toBeGreaterThan(dnsResolver);
  expect(allowAccept, "allowlist accept present").toBeGreaterThan(loAccept);
  expect(rules[finalReject], "catch-all REJECT is the last OUTPUT rule").toContain("-j REJECT");
  expect(allowAccept, "allow precedes the catch-all reject").toBeLessThan(finalReject);
}

async function startEndpoint(name: string, body: string, secondPort?: number): Promise<void> {
  const second = secondPort ? `httpd -p ${secondPort} -h /www && ` : "";
  await dockerOrThrow([
    "run",
    "-d",
    "--name",
    name,
    "--network",
    NET,
    "--entrypoint",
    "/bin/sh",
    IMAGE,
    "-c",
    `mkdir -p /www && echo ${body} > /www/index.html && ${second}exec httpd -f -p ${ENDPOINT_PORT} -h /www`,
  ]);
}

async function unrestrictedGet(host: string): Promise<{ code: number; body: string }> {
  const r = await docker([
    "run",
    "--rm",
    "--network",
    NET,
    "--entrypoint",
    "/bin/sh",
    IMAGE,
    "-c",
    `wget -T 5 -q -O - http://${host}:${ENDPOINT_PORT}/`,
  ]);
  return { code: r.code, body: r.stdout.trim() };
}

/** Run the profiled worker workload with a per-repo allowlist + full mounts. */
async function profiledWorkerRun(allowlist: { host: string; port: number }[]) {
  const args = renderWorkerRunArgs(
    {
      image: IMAGE,
      network: NET,
      allowlist,
      workspaceHostPath: workspaceHostDir,
      providerAuthMounts: [
        { hostPath: providerAuthHostDir, containerPath: AUTH_MOUNT },
        { hostPath: path.join(PROFILE_DIR, "worker-probes.sh"), containerPath: PROBE_MOUNT },
      ],
      env: {
        CAMINO_PROBE_ALLOWED_HOST: ALLOWED,
        CAMINO_PROBE_ALLOWED_PORT: String(ENDPOINT_PORT),
        CAMINO_PROBE_ALLOWED_IP: allowedIp,
        CAMINO_PROBE_DENIED_HOST: DENIED,
        CAMINO_PROBE_DENIED_IP: deniedIp,
        CAMINO_PROBE_DENIED_PORT: String(ENDPOINT_PORT),
        CAMINO_PROBE_WRONG_PORT: String(WRONG_PORT),
        CAMINO_WORKSPACE_DIR: WORKER_WORKSPACE_MOUNT,
        CAMINO_PROVIDER_AUTH_DIR: AUTH_MOUNT,
        // The allowed endpoint's OWN IPv6 address (in-network): the v6 leg to
        // it must fail while the v4 leg is allowlisted — a packet-level proof
        // IPv6 is closed, not merely absent (round-1 finding 12).
        ...(allowedV6 ? { CAMINO_PROBE_ALLOWED_V6: allowedV6 } : {}),
        // A GitHub-credential-shaped env key the container MUST strip is not
        // injected here: the composer now REFUSES credential-shaped keys
        // (asserted in egress.test.ts), and this suite asserts the in-container
        // RESULT (github-cred-env: clean).
      },
    },
    ["/bin/sh", PROBE_MOUNT],
  );
  return docker(args);
}

beforeAll(async () => {
  await requireDockerDaemon();
  await dockerOrThrow(["build", "-t", IMAGE, PROFILE_DIR]);
  // An IPv6-enabled network so the IPv6 block is proven at the packet level
  // (round-1 finding 12): containers get v6 addresses and reach each other over
  // v6, so the profile's ip6tables DROP is testable without host v6 egress.
  // The ULA subnet is DERIVED FROM RUN_ID so concurrent suite runs do not
  // collide on the address pool (round-2 finding 10, widened round-3 finding
  // 11 to use the FULL 8 hex of RUN_ID across two 16-bit groups — a 4-hex
  // prefix aliased runs whose ids shared their first 4 hex).
  const g1 = RUN_ID.slice(0, 4);
  const g2 = RUN_ID.slice(4, 8);
  await dockerOrThrow(["network", "create", "--ipv6", "--subnet", `fd00:${g1}:${g2}::/64`, NET]);
  await startEndpoint(ALLOWED, ALLOWED_BODY, WRONG_PORT);
  await startEndpoint(DENIED, DENIED_BODY);
  const ipOf = async (name: string): Promise<string> => {
    const ip = (
      await dockerOrThrow([
        "inspect",
        "-f",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        name,
      ])
    ).stdout.trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      throw new Error(`could not determine ${name} endpoint IPv4 (got '${ip}')`);
    }
    return ip;
  };
  const v6Of = async (name: string): Promise<string> =>
    (
      await dockerOrThrow([
        "inspect",
        "-f",
        "{{range .NetworkSettings.Networks}}{{.GlobalIPv6Address}}{{end}}",
        name,
      ])
    ).stdout.trim();
  allowedIp = await ipOf(ALLOWED);
  deniedIp = await ipOf(DENIED);
  allowedV6 = await v6Of(ALLOWED); // may be "" if the host lacks container IPv6

  // Host-side scratch: a world-writable workspace (so the in-container uid
  // 1000 can write regardless of host uid mapping) and a provider-auth dir
  // holding a token, mounted read-only.
  const base = mkdtempSync(path.join(tmpdir(), "camino-wp107-docker-"));
  scratch.push(base);
  workspaceHostDir = path.join(base, "workspace");
  providerAuthHostDir = path.join(base, "auth");
  mkdirSync(workspaceHostDir, { recursive: true });
  mkdirSync(providerAuthHostDir, { recursive: true });
  writeFileSync(path.join(providerAuthHostDir, "token"), PROVIDER_TOKEN_BODY + "\n");
  chmodSync(workspaceHostDir, 0o777);
  chmodSync(providerAuthHostDir, 0o755);
  chmodSync(path.join(providerAuthHostDir, "token"), 0o644);

  for (let attempt = 0; ; attempt++) {
    const [a, d] = await Promise.all([unrestrictedGet(ALLOWED), unrestrictedGet(DENIED)]);
    if (a.code === 0 && d.code === 0) break;
    if (attempt >= 30) throw new Error("endpoints failed to become ready");
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Positively confirm the IPv6 SUBSTRATE: an unrestricted container reaches
  // the allowed endpoint over its raw v6 address (no name resolution). Only if
  // this holds do we assert the profiled v6 BLOCK — so the block is provably
  // the profile's, and the whole v6 proof skips cleanly on a runner where
  // container IPv6 is absent or non-forwarding.
  if (allowedV6) {
    const v6 = await docker([
      "run",
      "--rm",
      "--network",
      NET,
      "--entrypoint",
      "/bin/sh",
      IMAGE,
      "-c",
      `nc -w 5 ${allowedV6} ${ENDPOINT_PORT} </dev/null && echo REACHED || echo failed`,
    ]);
    v6Proven = v6.stdout.trim() === "REACHED";
  }
}, SETUP_TIMEOUT);

afterAll(async () => {
  await docker(["rm", "-f", ALLOWED, DENIED]);
  await docker(["rm", "-f", `${DENIED}-listen`, `${ALLOWED}-listen`]);
  await docker(["network", "rm", NET]);
  const { rmSync } = await import("node:fs");
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("control — the environment substrate works without the profile", () => {
  it(
    "both endpoints are alive, so later denials are attributable to the profile",
    async () => {
      const a = await unrestrictedGet(ALLOWED);
      const d = await unrestrictedGet(DENIED);
      expect(a.code).toBe(0);
      expect(a.body).toBe(ALLOWED_BODY);
      expect(d.code).toBe(0);
      expect(d.body).toBe(DENIED_BODY);
    },
    TEST_TIMEOUT,
  );

  it("confirms whether the IPv6 substrate is available for the v6 block proof", () => {
    // Not an assertion on the profile — it records, for the reader, whether the
    // v6 block proof below runs (v6Proven) or is skipped on this runner. The
    // profiled-v6-block assertion in the main test gates on v6Proven. Unrestricted
    // name resolution (which attributes the profiled resolver/dns-lookup failures)
    // is already proven by "both endpoints are alive" (wget-by-name).
    expect(typeof v6Proven).toBe("boolean");
  });
});

describe("CAM-EXEC-03 — worker egress is allowlist-positive (per-repo config)", () => {
  it(
    "allowlisted endpoint reachable WHILE non-allowlisted connections fail (total denial cannot pass)",
    async () => {
      const r = await profiledWorkerRun([{ host: ALLOWED, port: ENDPOINT_PORT }]);
      expect(r.code, `workload run failed: ${r.stderr}`).toBe(0);

      expect(r.stderr).toContain("worker-profile: rules installed");
      expect(r.stderr).toContain("-P OUTPUT DROP");
      expect(r.stderr).toContain("-P INPUT DROP");
      expect(r.stderr).toContain(`--dport ${ENDPOINT_PORT} -j ACCEPT`);
      assertRuleOrder(r.stderr, ENDPOINT_PORT);

      const probes = parseProbes(r.stdout);
      // Hardened shape produced an unprivileged workload that cannot alter rules.
      expect(probeOf(probes, "uid").out).toBe("1000");
      expect(probeOf(probes, "rules-locked").exit).not.toBe(0);

      // Instrumentation health: the positive nc control MUST succeed.
      expect(probeOf(probes, "allowed-endpoint-tcp").exit).toBe(0);

      // SELECTIVE ALLOW: a full HTTP round trip to the allowlisted endpoint.
      const allowed = probeOf(probes, "allowed-endpoint-http");
      expect(allowed.exit).toBe(0);
      expect(allowed.out).toContain(ALLOWED_BODY);
      expect(probeOf(probes, "allowed-name-resolution").exit).toBe(0);

      // SELECTIVE DENY: sibling (by IP), wrong port, external all fail.
      expect(probeOf(probes, "non-allowlisted-sibling-tcp").exit).not.toBe(0);
      expect(probeOf(probes, "allowed-host-wrong-port-tcp").exit).not.toBe(0);
      expect(probeOf(probes, "non-allowlisted-external-tcp").exit).not.toBe(0);

      // RESOLVER CLOSED — the ATTRIBUTABLE proof (round-2 finding 8): a
      // non-allowlisted NAME does not resolve under the profile
      // (`getent hosts`, which queries 127.0.0.11). This is attributable
      // because the "both endpoints are alive" control proves the SAME
      // resolver resolves names by-name (wget-by-name) absent the profile —
      // so this failure is the by-address 127.0.0.11 reject, asserted present
      // and correctly ordered by assertRuleOrder above. `dns-lookup`
      // (busybox nslookup) is supplementary, NOT the sole proof (a broken
      // nslookup could pass it vacuously, so it is not load-bearing).
      expect(probeOf(probes, "non-allowlisted-name-resolution").exit).not.toBe(0);
      expect(probeOf(probes, "dns-lookup").exit).not.toBe(0); // supplementary

      // IPv6 (round-1 finding 12, round-2 finding 8). Two levels of proof:
      //   - RULE PRESENCE whenever the container has a v6 stack (allowedV6): the
      //     entrypoint installed and printed the ip6tables OUTPUT DROP. This
      //     ALWAYS runs on an --ipv6 network, so a green suite can never silently
      //     omit v6 enforcement.
      //   - PACKET BLOCK when the v6 substrate is PROVEN reachable (beforeAll
      //     reached the endpoint over v6 unrestricted): the SAME endpoint's v4
      //     leg succeeds while its v6 leg is dropped — attributably the profile.
      if (allowedV6) {
        const marker = "worker-profile: ip6 rules installed";
        expect(r.stderr).toContain(marker);
        // The v6 DROP policy, in the v6 ruleset printed AFTER the marker (the
        // marker itself only prints once verify_chain confirmed v6 OUTPUT DROP,
        // so this is belt-and-suspenders over the entrypoint's own check).
        expect(r.stderr.slice(r.stderr.indexOf(marker))).toMatch(/-P OUTPUT DROP/);
      }
      if (v6Proven) {
        expect(probeOf(probes, "allowed-endpoint-tcp").exit).toBe(0); // v4 leg alive
        expect(probeOf(probes, "ipv6-peer-tcp").exit).not.toBe(0); // v6 leg blocked
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "deny-all baseline: with an empty allowlist the SAME endpoint becomes unreachable",
    async () => {
      const r = await profiledWorkerRun([]);
      expect(r.code, `workload run failed: ${r.stderr}`).toBe(0);
      const probes = parseProbes(r.stdout);
      expect(probeOf(probes, "allowed-endpoint-http").exit).not.toBe(0);
      expect(probeOf(probes, "allowed-endpoint-tcp").exit).not.toBe(0);
      expect(probeOf(probes, "non-allowlisted-sibling-tcp").exit).not.toBe(0);
    },
    TEST_TIMEOUT,
  );
});

describe("CAM-EXEC-02 — zero GitHub credentials + provider auth read-only", () => {
  it(
    "no credential env key and no credential material on disk, asserted in-container",
    async () => {
      const r = await profiledWorkerRun([{ host: ALLOWED, port: ENDPOINT_PORT }]);
      const probes = parseProbes(r.stdout);
      expect(probeOf(probes, "github-cred-env").out).toBe("clean");
      expect(probeOf(probes, "github-cred-fs").out).toBe("clean");
    },
    TEST_TIMEOUT,
  );

  it(
    "the fs credential probe actually TRAVERSES the workspace mount (discriminating — round-5 finding 5)",
    async () => {
      // Plant a .git-credentials in the workspace (a separate bind-mount
      // filesystem). If the probe truly traverses /workspace, it must REPORT
      // it (not "clean"); a probe that only scanned the rootfs would miss it,
      // so this proves the -xdev mount-root traversal fix is load-bearing.
      const planted = path.join(workspaceHostDir, ".git-credentials");
      writeFileSync(planted, "https://x:tok@github.invalid\n");
      try {
        const r = await profiledWorkerRun([{ host: ALLOWED, port: ENDPOINT_PORT }]);
        const probes = parseProbes(r.stdout);
        expect(probeOf(probes, "github-cred-fs").out).not.toBe("clean");
        expect(probeOf(probes, "github-cred-fs").out).toContain(".git-credentials");
      } finally {
        const { rmSync } = await import("node:fs");
        rmSync(planted, { force: true });
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "provider auth is read-only: a write from the workspace FAILS while the workspace itself is writable",
    async () => {
      const r = await profiledWorkerRun([{ host: ALLOWED, port: ENDPOINT_PORT }]);
      const probes = parseProbes(r.stdout);
      // Control: the workspace mount IS writable (so the failure below is
      // attributable to :ro, not to a generally read-only filesystem).
      expect(probeOf(probes, "workspace-write").exit).toBe(0);
      // The read-only provider-auth mount rejects the write…
      expect(probeOf(probes, "provider-auth-write").exit).not.toBe(0);
      // …but the workload can still READ it (read-only, not inaccessible).
      const read = probeOf(probes, "provider-auth-read");
      expect(read.exit).toBe(0);
      expect(read.out).toContain(PROVIDER_TOKEN_BODY);
    },
    TEST_TIMEOUT,
  );
});

describe("CAM-EXEC-03 — inbound default-deny closes the established-egress bypass (WP-005 finding 4, exercised)", () => {
  /** Start a profiled worker container that listens on LISTEN_PORT. */
  async function startListener(name: string, profiled: boolean): Promise<void> {
    const listenCmd = `while true; do echo listening | nc -l -p ${LISTEN_PORT}; done`;
    if (profiled) {
      const args = renderWorkerRunArgs({ image: IMAGE, network: NET, allowlist: [], name }, [
        "/bin/sh",
        "-c",
        listenCmd,
      ]);
      // Detach so the listener stays up; strip --rm's interaction with -d by
      // running detached (docker keeps --rm containers we remove in afterAll).
      await dockerOrThrow([args[0]!, "-d", ...args.slice(1)]);
    } else {
      await dockerOrThrow([
        "run",
        "-d",
        "--name",
        name,
        "--network",
        NET,
        "--entrypoint",
        "/bin/sh",
        IMAGE,
        "-c",
        listenCmd,
      ]);
    }
  }

  async function ipOf(name: string): Promise<string> {
    const ip = (
      await dockerOrThrow([
        "inspect",
        "-f",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        name,
      ])
    ).stdout.trim();
    return ip;
  }

  async function peerConnect(ip: string): Promise<number> {
    const r = await docker([
      "run",
      "--rm",
      "--network",
      NET,
      "--entrypoint",
      "/bin/sh",
      IMAGE,
      "-c",
      `nc -w 4 ${ip} ${LISTEN_PORT}`,
    ]);
    return r.code;
  }

  /**
   * Is the listener inside `name` actually UP? Probe it over LOOPBACK from
   * INSIDE the container (docker exec, same netns): loopback is allowed, so a
   * success proves the listener is bound and serving — attributing the
   * external peer failure to INPUT drop, not a dead listener (round-1 finding
   * 12). exec runs as the image default (root), which still only sees the
   * container's own rules.
   */
  async function loopbackAlive(name: string): Promise<boolean> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const r = await docker([
        "exec",
        name,
        "/bin/sh",
        "-c",
        `nc -w 3 127.0.0.1 ${LISTEN_PORT} </dev/null`,
      ]);
      if (r.code === 0) return true;
      await new Promise((res) => setTimeout(res, 1000));
    }
    return false;
  }

  it(
    "a peer can reach an UNRESTRICTED listener but NOT a profiled worker listener that is PROVEN up",
    async () => {
      const controlName = `${ALLOWED}-listen`;
      const workerName = `${DENIED}-listen`;
      await startListener(controlName, false);
      await startListener(workerName, true);
      const controlIp = await ipOf(controlName);
      const workerIp = await ipOf(workerName);

      // Substrate: an unrestricted listener is reachable from a peer.
      let controlCode = 1;
      for (let attempt = 0; attempt < 30; attempt++) {
        controlCode = await peerConnect(controlIp);
        if (controlCode === 0) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      expect(controlCode, "unrestricted listener reachable (substrate works)").toBe(0);

      // ATTRIBUTION: the profiled worker's listener is genuinely UP — proven by
      // a loopback connect from inside its own netns — so the peer failure
      // below is the INPUT drop, not a listener that never started (the flaw
      // round-1 finding 12 called out: /bin/false would also "deny").
      expect(await loopbackAlive(workerName), "profiled listener is up on loopback").toBe(true);

      // The profiled worker's INPUT default-deny drops the inbound SYN, so a
      // peer cannot reach the (proven-live) listener — closing the
      // inbound-reply egress bypass at the packet level.
      const workerCode = await peerConnect(workerIp);
      expect(workerCode, "profiled worker listener is unreachable from a peer").not.toBe(0);
    },
    TEST_TIMEOUT,
  );
});

describe("fail-closed setup — no workload runs under a broken profile", () => {
  it(
    "an unresolvable allowlist host aborts before the workload starts",
    async () => {
      const args = renderWorkerRunArgs(
        {
          image: IMAGE,
          network: NET,
          allowlist: [{ host: `no-such-host-${RUN_ID}`, port: 8080 }],
        },
        ["/bin/sh", "-c", "echo WORKLOAD-RAN"],
      );
      const r = await docker(args);
      expect(r.code).toBe(65);
      expect(r.stderr).toContain("refusing to start (fail-closed)");
      expect(r.stdout).not.toContain("WORKLOAD-RAN");
    },
    TEST_TIMEOUT,
  );
});
