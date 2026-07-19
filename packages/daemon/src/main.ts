/**
 * Daemon executable entry (WP-102): `npm run daemon` from the repo root.
 * Startup is fail-closed — a token-file or config refusal prints the precise
 * reason and exits non-zero; it is never downgraded to a warning.
 */
import { pathToFileURL } from "node:url";

import { ConfigError, daemonPort, guiDistPath } from "./config.js";
import { startDaemonServer } from "./server.js";
import { loadOrCreateToken, TokenError } from "./token.js";

export async function main(): Promise<void> {
  let port: number;
  let guiRoot: string;
  let tokenLoad: ReturnType<typeof loadOrCreateToken>;
  try {
    port = daemonPort();
    guiRoot = guiDistPath();
    tokenLoad = loadOrCreateToken();
  } catch (error) {
    if (error instanceof TokenError || error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  let daemon;
  try {
    daemon = await startDaemonServer({ token: tokenLoad.token, guiRoot, port, logger: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(
        `Refusing to start: port ${port} is already in use ` +
          `(another daemon instance? — set CAMINO_PORT to use a different port).`,
      );
      process.exit(1);
    }
    throw error;
  }

  console.log(`Camino daemon listening at ${daemon.url}/`);
  console.log(
    tokenLoad.created
      ? `GUI token created at ${tokenLoad.path} (0600)`
      : `GUI token read from ${tokenLoad.path}`,
  );

  const stop = (): void => {
    void daemon.app.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void main();
}
