import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The daemon binds loopback only — never a routable interface (CAM-CORE-01). */
export const BIND_HOST = "127.0.0.1";

export const DEFAULT_PORT = 4670;

/** A malformed runtime setting refuses startup rather than falling back silently. */
export class ConfigError extends Error {}

/**
 * Listen port: CAMINO_PORT override (tests, port conflicts), default 4670.
 * Malformed values are a startup refusal, not a silent default (fail closed).
 */
export function daemonPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["CAMINO_PORT"];
  if (raw === undefined || raw.length === 0) return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(raw)) {
    throw new ConfigError(`CAMINO_PORT must be an integer port number, got ${JSON.stringify(raw)}`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new ConfigError(`CAMINO_PORT must be in 1..65535, got ${port}`);
  }
  return port;
}

/**
 * Directory the daemon serves as the GUI (CAM-CORE-01 "serves the GUI build").
 * Defaults to the @camino/gui build output within this checkout; CAMINO_GUI_DIST
 * overrides for tests and packaged layouts.
 */
export function guiDistPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["CAMINO_GUI_DIST"];
  if (override && override.length > 0) return override;
  return fileURLToPath(new URL("../../gui/dist", import.meta.url));
}

/**
 * Daemon runtime state lives outside the repo (build plan §1.2):
 * `~/.camino` by default, overridable for tests via CAMINO_HOME.
 */
export function caminoHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["CAMINO_HOME"];
  return override && override.length > 0 ? override : join(homedir(), ".camino");
}

/** The GUI auth token file; must be 0600 at startup or the daemon refuses to start (CAM-CORE-01). */
export function tokenFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(caminoHome(env), "auth-token");
}
