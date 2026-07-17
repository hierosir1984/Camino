import { homedir } from "node:os";
import { join } from "node:path";

/** The daemon binds loopback only — never a routable interface (CAM-CORE-01). */
export const BIND_HOST = "127.0.0.1";

export const DEFAULT_PORT = 4670;

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
