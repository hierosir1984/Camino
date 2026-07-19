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

export { SqliteDomainStore, contentSha256 } from "./domain-store.js";
export type { CreateMissionInput, SqliteDomainStoreOptions } from "./domain-store.js";
export {
  MissionIntake,
  INTAKE_ACCEPTED_EXTENSIONS,
  INTAKE_MAX_CONTENT_BYTES,
  INTAKE_MAX_TITLE_CHARS,
} from "./intake.js";
export { renderMissionContent } from "./render.js";
export { SerializationScheduler, SCHEDULER_ACTOR } from "./serialization-scheduler.js";
export type {
  ActivationOutcome,
  LaneHolder,
  LaneOccupancy,
  QueuedEntry,
  RepoQueueView,
  SchedulingLane,
  SerializationViolation,
} from "./serialization-scheduler.js";
