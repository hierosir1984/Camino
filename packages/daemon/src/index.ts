// @camino/daemon — the control plane process: all I/O lives here.
export {
  BIND_HOST,
  ConfigError,
  DEFAULT_PORT,
  caminoHome,
  daemonPort,
  guiDistPath,
  tokenFilePath,
} from "./config.js";

export { SqliteEventStore } from "./event-store.js";
export type { SqliteEventStoreOptions } from "./event-store.js";
export { TransitionRecorder } from "./transition-recorder.js";
export type { RecordOutcome, RecordRequest } from "./transition-recorder.js";

// WP-102 daemon shell (CAM-CORE-01).
export { buildServer, startDaemonServer } from "./server.js";
export type { BuildServerOptions, RunningDaemon, StartDaemonOptions } from "./server.js";
export { generateToken, loadOrCreateToken, TokenError, tokenStatRefusal } from "./token.js";
export type { LoadedToken } from "./token.js";
