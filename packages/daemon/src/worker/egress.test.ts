// WP-107 · composer unit tests (no docker): the argument vector the worker
// container is launched with, and every fail-closed refusal. The packet-level
// proof that these arguments produce the isolation they claim is
// egress.worker.test.ts (docker-backed).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKER_CONTAINER_CAPS,
  WORKER_PIDS_LIMIT,
  WORKER_PROFILE_ENTRYPOINT,
  WORKER_WORKSPACE_MOUNT,
  WorkerContainerConfigError,
  isValidAllowlistHost,
  isValidAllowlistPort,
  renderAllowlistEnv,
  renderWorkerRunArgs,
} from "./egress.js";

let tmpDirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "camino-wp107-egress-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

const BASE = {
  image: "camino-worker-profile:test",
  network: "camino-net",
  allowlist: [{ host: "registry.invalid", port: 443 }],
};

describe("renderWorkerRunArgs", () => {
  it("composes the hardened run shape: cap-drop ALL + bootstrap caps, no-new-privileges, pids-limit, init", () => {
    const args = renderWorkerRunArgs(BASE, ["/bin/true"]);
    const joined = args.join(" ");
    expect(args.slice(0, 3)).toEqual(["run", "--rm", "--init"]);
    expect(joined).toContain("--cap-drop ALL");
    for (const cap of WORKER_CONTAINER_CAPS) expect(joined).toContain(`--cap-add ${cap}`);
    expect(joined).toContain("--security-opt no-new-privileges:true");
    expect(joined).toContain(`--pids-limit ${WORKER_PIDS_LIMIT}`);
    expect(joined).toContain("--network camino-net");
    // The isolation entrypoint is PINNED (round-1 finding 1): any image runs
    // the rule-install bootstrap; the image's own ENTRYPOINT cannot skip it.
    expect(joined).toContain(`--entrypoint ${WORKER_PROFILE_ENTRYPOINT}`);
    expect(joined).toContain("-e CAMINO_EGRESS_ALLOWLIST=registry.invalid:443");
    expect(args[args.length - 2]).toBe(BASE.image);
    expect(args[args.length - 1]).toBe("/bin/true");
  });

  it("mounts the workspace rw at the fixed mount point and sets the workdir", () => {
    const args = renderWorkerRunArgs({ ...BASE, workspaceHostPath: "/tmp/ws" }, ["/bin/true"]);
    const joined = args.join(" ");
    expect(joined).toContain(`-v /tmp/ws:${WORKER_WORKSPACE_MOUNT}`);
    expect(joined).not.toContain(`-v /tmp/ws:${WORKER_WORKSPACE_MOUNT}:ro`);
    expect(joined).toContain(`-w ${WORKER_WORKSPACE_MOUNT}`);
  });

  it("composes provider-auth mounts read-only unconditionally (CAM-EXEC-02)", () => {
    const args = renderWorkerRunArgs(
      {
        ...BASE,
        providerAuthMounts: [{ hostPath: "/home/user/.claude", containerPath: "/auth/claude" }],
      },
      ["/bin/true"],
    );
    expect(args.join(" ")).toContain("-v /home/user/.claude:/auth/claude:ro");
    // There is no input shape that yields a writable auth mount: the `:ro`
    // suffix is appended by the composer, not taken from the caller.
  });

  it("refuses shared/reserved networks whose namespace the bootstrap would rewrite", () => {
    for (const network of ["host", "none", "bridge", "container:abc", ""]) {
      expect(() => renderWorkerRunArgs({ ...BASE, network }, ["/bin/true"])).toThrow(
        WorkerContainerConfigError,
      );
    }
  });

  it("refuses mounts over bootstrap paths and over the workspace", () => {
    for (const containerPath of [
      "/",
      "/usr/local/bin",
      "/etc",
      "/sbin/sub",
      WORKER_WORKSPACE_MOUNT,
      `${WORKER_WORKSPACE_MOUNT}/auth`, // inside the rw workspace mount
    ]) {
      expect(() =>
        renderWorkerRunArgs(
          { ...BASE, providerAuthMounts: [{ hostPath: "/tmp/x", containerPath }] },
          ["/bin/true"],
        ),
      ).toThrow(WorkerContainerConfigError);
    }
    // Relative or colon-carrying paths would corrupt the -v contract.
    expect(() =>
      renderWorkerRunArgs(
        { ...BASE, providerAuthMounts: [{ hostPath: "relative/path", containerPath: "/auth" }] },
        ["/bin/true"],
      ),
    ).toThrow(WorkerContainerConfigError);
    expect(() =>
      renderWorkerRunArgs({ ...BASE, workspaceHostPath: "/tmp/a:b" }, ["/bin/true"]),
    ).toThrow(WorkerContainerConfigError);
  });

  it("canonicalizes the mount target before the bootstrap-path check (round-1 finding 1)", () => {
    // `/tmp/../usr/local/bin/...` normalizes onto a protected path — Docker
    // does this, so the composer must too, or it's a bootstrap bypass.
    expect(() =>
      renderWorkerRunArgs(
        {
          ...BASE,
          providerAuthMounts: [
            { hostPath: "/tmp/x", containerPath: "/tmp/../usr/local/bin/worker" },
          ],
        },
        ["/bin/true"],
      ),
    ).toThrow(/outside Camino.s mount roots|refused/);
  });

  it("rejects ANCESTOR mounts that would shadow the entrypoint (round-2 finding 1)", () => {
    // Mounting /usr or /usr/local (parents of /usr/local/bin/…entrypoint)
    // shadows the pinned entrypoint just as surely as mounting the exact path.
    for (const containerPath of ["/usr", "/usr/local", "/usr/local/bin"]) {
      expect(() =>
        renderWorkerRunArgs(
          { ...BASE, providerAuthMounts: [{ hostPath: "/tmp/x", containerPath }] },
          ["/bin/true"],
        ),
      ).toThrow(/outside Camino.s mount roots|refused/);
    }
  });

  it("rejects mounts over EVERY bootstrap PATH dir, incl. /usr/local/sbin (round-3 finding 1)", () => {
    // The entrypoint searches these dirs (PATH) and runs unqualified tools; a
    // mount over any of them could plant a malicious grep/awk the root
    // bootstrap runs. /usr/local/sbin was previously unprotected.
    for (const containerPath of [
      "/usr/local/sbin",
      "/usr/local/bin",
      "/usr/sbin",
      "/usr/bin",
      "/sbin",
      "/bin",
    ]) {
      expect(() =>
        renderWorkerRunArgs(
          { ...BASE, providerAuthMounts: [{ hostPath: "/tmp/x", containerPath }] },
          ["/bin/true"],
        ),
      ).toThrow(/outside Camino.s mount roots|refused/);
    }
  });

  it("rejects mounts over the root-loaded LIBRARY/PLUGIN paths incl. /usr/lib/xtables AND /usr/local/lib (round-9 finding 2, round-10 finding 4)", () => {
    // A `:ro` bind blocks writes, not dlopen: a mount at a root-loaded library
    // dir shadows a .so whose constructor runs as ROOT the moment the bootstrap
    // invokes iptables — before isolation is installed. A DENYLIST kept missing
    // one (/usr/lib/xtables, then /usr/local/lib on musl's loader path); the
    // ALLOWLIST refuses all of them by construction, no enumeration.
    for (const containerPath of [
      "/usr/lib", // ancestor of the iptables plugin dir + a linker search path
      "/usr/lib/xtables", // the concrete iptables match-module dir
      "/usr/lib64",
      "/lib64",
      "/usr/local/lib", // musl's default loader path — the round-10 finding-4 miss
      "/etc/ld.so.preload", // linker preload config
    ]) {
      expect(() =>
        renderWorkerRunArgs(
          { ...BASE, providerAuthMounts: [{ hostPath: "/tmp/x", containerPath }] },
          ["/bin/true"],
        ),
      ).toThrow(/outside Camino.s mount roots|refused/);
    }
  });

  it("ACCEPTS mounts only under Camino's own roots — the workspace and the /auth subtree (round-10 findings 2/4 allowlist)", () => {
    // The structural counterpart: legitimate targets are permitted, so the
    // allowlist is not vacuously rejecting everything.
    for (const containerPath of ["/auth", "/auth/claude", "/auth/provider/nested"]) {
      expect(() =>
        renderWorkerRunArgs(
          { ...BASE, providerAuthMounts: [{ hostPath: "/tmp/x", containerPath }] },
          ["/bin/true"],
        ),
      ).not.toThrow();
    }
    // The workspace mount (the fixed /workspace) is accepted too.
    expect(() =>
      renderWorkerRunArgs({ ...BASE, workspaceHostPath: "/tmp/ws" }, ["/bin/true"]),
    ).not.toThrow();
  });

  it("rejects an OPTION-SHAPED image so the pinned --entrypoint cannot be skipped (round-11 finding 1)", () => {
    // `docker run` parses options until the first non-option arg (the image); an
    // image like `--entrypoint` is consumed as a flag and a later token becomes
    // the image, skipping the pinned entrypoint → root shell, no bootstrap.
    for (const image of ["--entrypoint", "-v", "--privileged", "", " alpine", "a b"]) {
      expect(() => renderWorkerRunArgs({ ...BASE, image }, ["/bin/true"])).toThrow(
        WorkerContainerConfigError,
      );
    }
    // Legitimate references still pass (registry, port, tag, digest).
    for (const image of [
      "alpine:3.20",
      "registry.example.com:5000/org/img:tag",
      "img@sha256:" + "a".repeat(64),
    ]) {
      expect(() => renderWorkerRunArgs({ ...BASE, image }, ["/bin/true"])).not.toThrow();
    }
  });

  it("the composer fences the network SHAPE + reserved names but does NOT infer name-vs-ID (round-11 finding 8 boundary)", () => {
    // Reserved literal names are refused.
    for (const network of ["host", "none", "bridge", "default"]) {
      expect(() => renderWorkerRunArgs({ ...BASE, network }, ["/bin/true"])).toThrow(
        WorkerContainerConfigError,
      );
    }
    // A hex-shaped value is NOT rejected on shape alone: it may be a legitimate
    // owned name, and Docker resolves any unique ID prefix, so the composer cannot
    // tell them apart — driver/ownership is the creator's attestation (WP-005/114),
    // named in assertSafeNetwork. (Round 10's hex-ID reject was both incomplete and
    // over-broad; removed.)
    for (const network of ["feedfacecafe", "camino-worker-a1b2c3"]) {
      expect(() => renderWorkerRunArgs({ ...BASE, network }, ["/bin/true"])).not.toThrow();
    }
  });

  it("refuses a provider-auth host source overlapping the rw workspace (round-1 finding 3)", () => {
    // The auth source lives INSIDE the workspace tree: its :ro mount would be
    // writable through the rw /workspace alias.
    expect(() =>
      renderWorkerRunArgs(
        {
          ...BASE,
          workspaceHostPath: "/tmp/attempt/workspace",
          providerAuthMounts: [
            { hostPath: "/tmp/attempt/workspace/auth", containerPath: "/auth/provider" },
          ],
        },
        ["/bin/true"],
      ),
    ).toThrow(/resolves into the rw workspace/);
    // The reverse (workspace inside the auth source) is equally refused.
    expect(() =>
      renderWorkerRunArgs(
        {
          ...BASE,
          workspaceHostPath: "/tmp/shared/ws",
          providerAuthMounts: [{ hostPath: "/tmp/shared", containerPath: "/auth/provider" }],
        },
        ["/bin/true"],
      ),
    ).toThrow(/resolves into the rw workspace/);
    // Disjoint sources are fine.
    expect(() =>
      renderWorkerRunArgs(
        {
          ...BASE,
          workspaceHostPath: "/tmp/attempt/workspace",
          providerAuthMounts: [{ hostPath: "/tmp/attempt/auth", containerPath: "/auth/provider" }],
        },
        ["/bin/true"],
      ),
    ).not.toThrow();
  });

  it("rejects a SYMLINK auth source that resolves into the workspace (round-2 finding 2)", () => {
    const base = tempDir();
    const ws = join(base, "workspace");
    mkdirSync(ws, { recursive: true });
    mkdirSync(join(ws, "real-auth"), { recursive: true });
    // The auth host path is a symlink OUTSIDE the workspace tree lexically, but
    // it resolves to a dir INSIDE the workspace — writable through /workspace.
    const authLink = join(base, "auth-link");
    symlinkSync(join(ws, "real-auth"), authLink);
    expect(() =>
      renderWorkerRunArgs(
        {
          ...BASE,
          workspaceHostPath: ws,
          providerAuthMounts: [{ hostPath: authLink, containerPath: "/auth/provider" }],
        },
        ["/bin/true"],
      ),
    ).toThrow(/resolves into the rw workspace/);
    // A genuinely disjoint real auth dir is accepted.
    const auth = join(base, "auth");
    mkdirSync(auth, { recursive: true });
    expect(() =>
      renderWorkerRunArgs(
        {
          ...BASE,
          workspaceHostPath: ws,
          providerAuthMounts: [{ hostPath: auth, containerPath: "/auth/provider" }],
        },
        ["/bin/true"],
      ),
    ).not.toThrow();
  });

  it("refuses caller env keys: reserved, malformed, AND credential-shaped (round-1 finding 2)", () => {
    expect(() =>
      renderWorkerRunArgs({ ...BASE, env: { CAMINO_EGRESS_ALLOWLIST: "evil:1" } }, ["/bin/true"]),
    ).toThrow(WorkerContainerConfigError);
    expect(() =>
      renderWorkerRunArgs({ ...BASE, env: { CAMINO_EGRESS_X: "y" } }, ["/bin/true"]),
    ).toThrow(WorkerContainerConfigError);
    expect(() => renderWorkerRunArgs({ ...BASE, env: { "BAD KEY": "y" } }, ["/bin/true"])).toThrow(
      WorkerContainerConfigError,
    );
    // Zero GitHub credentials at the container boundary: a credential-shaped
    // key handed as `-e` is refused (the daemon env layer strips the same set).
    for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "GIT_ASKPASS", "AWS_SECRET_ACCESS_KEY"]) {
      expect(() =>
        renderWorkerRunArgs({ ...BASE, env: { [key]: "secret" } }, ["/bin/true"]),
      ).toThrow(/credential-shaped/);
    }
    // A benign key is still allowed.
    expect(() =>
      renderWorkerRunArgs({ ...BASE, env: { CI: "true" } }, ["/bin/true"]),
    ).not.toThrow();
  });
});

describe("renderAllowlistEnv", () => {
  it("renders host:port pairs and rejects contract-corrupting shapes", () => {
    expect(
      renderAllowlistEnv([
        { host: "registry.invalid", port: 443 },
        { host: "10.0.0.7", port: 8080 },
      ]),
    ).toBe("registry.invalid:443 10.0.0.7:8080");
    expect(renderAllowlistEnv([])).toBe("");
    for (const host of ["has space", "colon:inside", "-leading", "trailing-", ""]) {
      expect(() => renderAllowlistEnv([{ host, port: 443 }])).toThrow(WorkerContainerConfigError);
    }
    for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
      expect(() => renderAllowlistEnv([{ host: "ok.invalid", port }])).toThrow(
        WorkerContainerConfigError,
      );
    }
  });
});

describe("host/port predicates", () => {
  it("accept DNS names and IPv4 literals, reject everything contract-corrupting", () => {
    expect(isValidAllowlistHost("registry.npmjs.org")).toBe(true);
    expect(isValidAllowlistHost("10.1.2.3")).toBe(true);
    expect(isValidAllowlistHost("a")).toBe(true);
    expect(isValidAllowlistHost("evil host")).toBe(false);
    expect(isValidAllowlistHost("host:443")).toBe(false);
    expect(isValidAllowlistPort(443)).toBe(true);
    expect(isValidAllowlistPort(0)).toBe(false);
  });
});

describe("worker container policy constants", () => {
  it("are frozen (barrel immutability at the source)", () => {
    expect(Object.isFrozen(WORKER_CONTAINER_CAPS)).toBe(true);
    expect(() => (WORKER_CONTAINER_CAPS as unknown as string[]).push("SYS_ADMIN")).toThrow(
      TypeError,
    );
  });
});
