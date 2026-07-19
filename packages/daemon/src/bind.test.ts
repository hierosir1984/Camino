/**
 * Network-posture tests (WP-102, CAM-CORE-01 "remote connection attempts
 * fail"): the daemon listens on 127.0.0.1 only. Structural proof (the bound
 * address) plus live probes — connecting to every non-loopback interface
 * address of this machine, and to the IPv6 loopback, must fail.
 */
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startDaemonServer } from "./server.js";
import type { RunningDaemon } from "./server.js";
import { generateToken } from "./token.js";

let daemon: RunningDaemon;

beforeAll(async () => {
  daemon = await startDaemonServer({ token: generateToken(), port: 0 });
});

afterAll(async () => {
  await daemon.app.close();
});

/** Resolves "connected" | "failed" — a timeout counts as failed-to-connect. */
function probeConnect(host: string, port: number): Promise<"connected" | "failed"> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 2000 });
    const finish = (outcome: "connected" | "failed") => {
      socket.destroy();
      resolve(outcome);
    };
    socket.once("connect", () => finish("connected"));
    socket.once("error", () => finish("failed"));
    socket.once("timeout", () => finish("failed"));
  });
}

function nonLoopbackIPv4Addresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => address.family === "IPv4" && !address.internal)
    .map((address) => address.address);
}

describe("loopback-only binding", () => {
  it("binds 127.0.0.1, not a routable interface", () => {
    const address = daemon.app.server.address();
    expect(address).not.toBeNull();
    expect(typeof address).not.toBe("string");
    if (address !== null && typeof address !== "string") {
      expect(address.address).toBe("127.0.0.1");
      expect(address.family).toBe("IPv4");
    }
  });

  it("loopback connections succeed (the probe method detects an open port)", async () => {
    await expect(probeConnect("127.0.0.1", daemon.port)).resolves.toBe("connected");
  });

  it("remote connection attempts fail on every non-loopback interface address", async () => {
    const addresses = nonLoopbackIPv4Addresses();
    if (addresses.length === 0) {
      // No routable interface on this machine (rare CI shape): the structural
      // binding assertion above still holds; nothing remote exists to probe.
      console.warn("bind.test: no non-loopback IPv4 interface to probe");
      return;
    }
    for (const address of addresses) {
      await expect(probeConnect(address, daemon.port), address).resolves.toBe("failed");
    }
  });

  it("IPv6 loopback is not bound either (127.0.0.1 only, verbatim)", async () => {
    await expect(probeConnect("::1", daemon.port)).resolves.toBe("failed");
  });
});
