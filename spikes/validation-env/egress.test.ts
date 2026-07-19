// WP-005 egress suite — CAM-VAL-03 (egress half), PRD §7 Phase-0 item 5.
//
// Proves SELECTIVE allow, not total network denial: two sibling endpoints run
// on the same docker network; exactly one is allowlisted. From inside the
// profiled environment the allowlisted endpoint answers a full HTTP round
// trip while the sibling, external addresses, and the DNS resolver channel
// all fail. An unrestricted control run first proves BOTH endpoints are alive
// and reachable absent the profile, so every later denial is attributable to
// the profile rather than to a dead endpoint.
//
//   - a total-network-denial implementation fails the allowed leg;
//   - an allow-everything implementation fails the sibling/external legs;
//   - the deny-all baseline run shows the allowlist entry is precisely what
//     opens the one permitted path.
//
// The probe workload only PRODUCES evidence (raw exit codes + output); this
// file decides (WP-004 convention). Rides the standard vitest CI glob, so it
// runs on every PR from this WP forward.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { docker, dockerOrThrow, requireDockerDaemon } from "./docker.js";
import { renderEgressRunArgs } from "./profile/egress-profile.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = "camino-validation-egress:wp005";
const RUN_ID = randomUUID().slice(0, 8);
const NET = `camino-val-${RUN_ID}`;
const ALLOWED = `camino-val-${RUN_ID}-allowed`;
const DENIED = `camino-val-${RUN_ID}-denied`;
const ALLOWED_BODY = "camino-endpoint-allowed-ok";
const DENIED_BODY = "camino-endpoint-denied-ok";
const ENDPOINT_PORT = 8080;
// The allowed endpoint ALSO listens here; this port is never allowlisted, so a
// connection failure to it is attributable to the firewall (something IS
// listening) — proving the allow rule is host+port, not host-wide.
const WRONG_PORT = 8081;

const SETUP_TIMEOUT = 300_000; // image build on a cold cache
const TEST_TIMEOUT = 120_000;

let allowedIp = "";
let deniedIp = "";

interface ProbeLine {
  probe: string;
  exit: number;
  out: string;
}

/** Strict parse: every stdout line must be a probe record; duplicates rejected. */
function parseProbes(stdout: string): Map<string, ProbeLine> {
  const out = new Map<string, ProbeLine>();
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`non-probe line on workload stdout (fail-closed parse): ${line}`);
    }
    const p = parsed as Partial<ProbeLine>;
    if (typeof p.probe !== "string" || typeof p.exit !== "number" || typeof p.out !== "string") {
      throw new Error(`malformed probe record: ${line}`);
    }
    if (out.has(p.probe)) throw new Error(`duplicate probe record: ${p.probe}`);
    out.set(p.probe, { probe: p.probe, exit: p.exit, out: p.out });
  }
  return out;
}

function probeOf(probes: Map<string, ProbeLine>, name: string): ProbeLine {
  const p = probes.get(name);
  if (!p) {
    throw new Error(
      `probe '${name}' missing from workload output (${[...probes.keys()].join(", ")})`,
    );
  }
  return p;
}

/** Ordered `-A OUTPUT …` rule lines the entrypoint printed to stderr. */
function outputRules(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-A OUTPUT"));
}

/**
 * Assert the deny-before-allow ordering that makes the profile sound: DNS
 * closed before the loopback accept, the allowlist accept present, and the
 * catch-all REJECT LAST — so no early exception can slip a packet past the
 * allowlist. Catches a ruleset that appends an exception after the final
 * reject, or opens loopback DNS before closing the resolver.
 */
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
  // Optionally serve a second port (busybox httpd daemonizes without -f); the
  // foreground instance on ENDPOINT_PORT keeps the container alive.
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

/** HTTP GET from an UNRESTRICTED container (entrypoint overridden — no profile). */
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

/** Run the profiled workload with the given allowlist and the standard probe env. */
async function profiledProbeRun(allowlist: { host: string; port: number }[]) {
  const args = renderEgressRunArgs(
    {
      image: IMAGE,
      network: NET,
      allowlist,
      env: {
        CAMINO_PROBE_ALLOWED_HOST: ALLOWED,
        CAMINO_PROBE_ALLOWED_PORT: String(ENDPOINT_PORT),
        CAMINO_PROBE_ALLOWED_IP: allowedIp,
        CAMINO_PROBE_DENIED_HOST: DENIED,
        CAMINO_PROBE_DENIED_IP: deniedIp,
        CAMINO_PROBE_DENIED_PORT: String(ENDPOINT_PORT),
        CAMINO_PROBE_WRONG_PORT: String(WRONG_PORT),
      },
      readonlyMounts: [{ hostPath: path.join(HERE, "probes.sh"), containerPath: "/probes.sh" }],
    },
    ["/bin/sh", "/probes.sh"],
  );
  return docker(args);
}

beforeAll(async () => {
  await requireDockerDaemon();
  await dockerOrThrow(["build", "-t", IMAGE, path.join(HERE, "profile")]);
  await dockerOrThrow(["network", "create", NET]);
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
  allowedIp = await ipOf(ALLOWED);
  deniedIp = await ipOf(DENIED);
  // Readiness: wait until both endpoints serve.
  for (let attempt = 0; ; attempt++) {
    const [a, d] = await Promise.all([unrestrictedGet(ALLOWED), unrestrictedGet(DENIED)]);
    if (a.code === 0 && d.code === 0) break;
    if (attempt >= 30) throw new Error("endpoints failed to become ready");
    await new Promise((r) => setTimeout(r, 1000));
  }
}, SETUP_TIMEOUT);

afterAll(async () => {
  await docker(["rm", "-f", ALLOWED, DENIED]);
  await docker(["network", "rm", NET]);
});

describe("control — the environment substrate works without the profile", () => {
  it(
    "both endpoints are alive and reachable, so later denials are attributable to the profile",
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
});

describe("CAM-VAL-03 egress half — selective allow from inside the environment", () => {
  it(
    "allowlisted endpoint reachable WHILE non-allowlisted connections fail (total denial cannot pass)",
    async () => {
      const r = await profiledProbeRun([{ host: ALLOWED, port: ENDPOINT_PORT }]);
      expect(r.code, `workload run failed: ${r.stderr}`).toBe(0);

      // Setup evidence: the rules the workload ran under, incl. the deny
      // backstop and the exact deny-before-allow ordering.
      expect(r.stderr).toContain("egress-profile: rules installed");
      expect(r.stderr).toContain("-P OUTPUT DROP");
      // INPUT default-deny: closes the established-egress bypass (an inbound
      // connection from a non-allowlisted peer can never reach ESTABLISHED, so
      // the OUTPUT established-accept only matches connections we initiated).
      expect(r.stderr).toContain("-P INPUT DROP");
      expect(r.stderr).toContain(`--dport ${ENDPOINT_PORT} -j ACCEPT`);
      assertRuleOrder(r.stderr, ENDPOINT_PORT);

      const probes = parseProbes(r.stdout);
      // The workload is unprivileged…
      expect(probeOf(probes, "uid").out).toBe("1000");
      // …and cannot alter the rules it runs under.
      expect(probeOf(probes, "rules-locked").exit).not.toBe(0);

      // INSTRUMENTATION HEALTH: the nc positive control to the allowed endpoint
      // (by IP) must SUCCEED. If nc were missing/broken, every denial probe
      // would exit nonzero for the wrong reason and masquerade as denial — this
      // assertion is what makes the nc-based denial probes below trustworthy.
      expect(probeOf(probes, "allowed-endpoint-tcp").exit).toBe(0);

      // SELECTIVE ALLOW: full HTTP round trip, by name, to the allowlisted
      // endpoint. A total-network-denial implementation fails RIGHT HERE.
      const allowed = probeOf(probes, "allowed-endpoint-http");
      expect(allowed.exit).toBe(0);
      expect(allowed.out).toContain(ALLOWED_BODY);
      expect(probeOf(probes, "allowed-name-resolution").exit).toBe(0);

      // SELECTIVE DENY: the sibling endpoint on the same network — proven
      // alive by the control — is rejected at the packet level (probed by IP,
      // independent of name resolution).
      expect(probeOf(probes, "non-allowlisted-sibling-tcp").exit).not.toBe(0);

      // PORT SPECIFICITY: a non-allowlisted port ON the allowed host — where
      // something IS listening (8081) — is blocked, so the accept is host+port,
      // not host-wide.
      expect(probeOf(probes, "allowed-host-wrong-port-tcp").exit).not.toBe(0);

      // Non-allowlisted names neither resolve nor is the resolver channel
      // open (the embedded resolver forwards upstream — it must be closed).
      expect(probeOf(probes, "non-allowlisted-name-resolution").exit).not.toBe(0);
      expect(probeOf(probes, "dns-lookup").exit).not.toBe(0);

      // External addresses are rejected in-container (works offline too).
      expect(probeOf(probes, "non-allowlisted-external-tcp").exit).not.toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "deny-all baseline: with an empty allowlist the SAME endpoint becomes unreachable — the allowlist entry is precisely what opens it",
    async () => {
      const r = await profiledProbeRun([]);
      expect(r.code, `workload run failed: ${r.stderr}`).toBe(0);
      const probes = parseProbes(r.stdout);
      expect(probeOf(probes, "uid").out).toBe("1000");
      // By NAME (HTTP) and by IP (TCP): the by-IP leg proves the packet path is
      // closed, so a DNS failure alone cannot satisfy the baseline.
      expect(probeOf(probes, "allowed-endpoint-http").exit).not.toBe(0);
      expect(probeOf(probes, "allowed-endpoint-tcp").exit).not.toBe(0);
      expect(probeOf(probes, "non-allowlisted-sibling-tcp").exit).not.toBe(0);
      expect(probeOf(probes, "non-allowlisted-external-tcp").exit).not.toBe(0);
    },
    TEST_TIMEOUT,
  );
});

describe("fail-closed setup — no workload runs under a broken profile", () => {
  it(
    "an unresolvable allowlist host aborts before the workload starts",
    async () => {
      const args = renderEgressRunArgs(
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

  it(
    "a malformed allowlist entry aborts (container-side validation, composer bypassed)",
    async () => {
      const r = await docker([
        "run",
        "--rm",
        "--cap-add",
        "NET_ADMIN",
        "--network",
        NET,
        "-e",
        "CAMINO_EGRESS_ALLOWLIST=justahost",
        IMAGE,
        "/bin/sh",
        "-c",
        "echo WORKLOAD-RAN",
      ]);
      expect(r.code).toBe(64);
      expect(r.stdout).not.toContain("WORKLOAD-RAN");
    },
    TEST_TIMEOUT,
  );

  it(
    "an unset allowlist refuses to start (deny-all must be chosen explicitly, not defaulted into)",
    async () => {
      const r = await docker([
        "run",
        "--rm",
        "--cap-add",
        "NET_ADMIN",
        "--network",
        NET,
        IMAGE,
        "/bin/sh",
        "-c",
        "echo WORKLOAD-RAN",
      ]);
      expect(r.code).not.toBe(0);
      expect(r.stdout).not.toContain("WORKLOAD-RAN");
    },
    TEST_TIMEOUT,
  );
});
