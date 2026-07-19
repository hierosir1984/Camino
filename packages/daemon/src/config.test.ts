import { describe, expect, it } from "vitest";
import {
  BIND_HOST,
  ConfigError,
  DEFAULT_PORT,
  caminoHome,
  daemonPort,
  guiDistPath,
  tokenFilePath,
} from "./config.js";

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

  it("defaults the port and honours a valid CAMINO_PORT", () => {
    expect(daemonPort({})).toBe(DEFAULT_PORT);
    expect(daemonPort({ CAMINO_PORT: "" })).toBe(DEFAULT_PORT);
    expect(daemonPort({ CAMINO_PORT: "8123" })).toBe(8123);
  });

  it("refuses a malformed CAMINO_PORT instead of silently defaulting", () => {
    for (const raw of ["nope", "-1", "0", "65536", "80x", "1e3", " 80"]) {
      expect(() => daemonPort({ CAMINO_PORT: raw }), raw).toThrow(ConfigError);
    }
  });

  it("resolves the GUI build dir with CAMINO_GUI_DIST override", () => {
    expect(guiDistPath({ CAMINO_GUI_DIST: "/tmp/gui-dist" })).toBe("/tmp/gui-dist");
    expect(guiDistPath({}).endsWith("/packages/gui/dist")).toBe(true);
  });
});
