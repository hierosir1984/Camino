import { describe, expect, it } from "vitest";
import { BIND_HOST, caminoHome, tokenFilePath } from "./config.js";

describe("daemon config", () => {
  it("binds loopback only", () => {
    expect(BIND_HOST).toBe("127.0.0.1");
  });

  it("defaults state under the user home, not the repo", () => {
    const home = caminoHome({});
    expect(home.endsWith("/.camino")).toBe(true);
  });

  it("honours CAMINO_HOME for tests", () => {
    expect(caminoHome({ CAMINO_HOME: "/tmp/camino-test" })).toBe("/tmp/camino-test");
    expect(tokenFilePath({ CAMINO_HOME: "/tmp/camino-test" })).toBe("/tmp/camino-test/auth-token");
  });
});
