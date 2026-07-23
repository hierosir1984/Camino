// WP-114: network-attestation shape fences — the non-Docker half. The
// create/attest/destroy lifecycle proof lives in
// container-obligations.test.ts against a real Docker daemon.
import { describe, expect, it } from "vitest";
import { WorkerNetworkError, attestWorkerNetwork } from "./worker-network.js";

describe("attestWorkerNetwork input fences", () => {
  it("inspects hex network IDs only — names can alias, IDs cannot", () => {
    for (const bad of ["bridge", "host", "none", "my-net", "container:abc", "", "ABC-123"]) {
      expect(() => attestWorkerNetwork(bad, { dockerPath: "/usr/bin/true" })).toThrow(
        WorkerNetworkError,
      );
    }
  });
});
