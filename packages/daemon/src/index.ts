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

// WP-104: durable single-writer lock, intent journal, executor, recovery
// (CAM-STATE-02/03/06).
export { WriterLock, WriterLockHeldError } from "./writer-lock.js";
export type { HeldWriterLock } from "./writer-lock.js";
export { IntentJournal } from "./intent-journal.js";
export type { IntentJournalOptions, IntentReadFilter } from "./intent-journal.js";
export { IntentExecutor } from "./intent-executor.js";
export type { ExecutionOutcome, IntentExecutorOptions, ProtocolHook } from "./intent-executor.js";
export { openRecoveredState, reconcileIntents, STATE_FILES } from "./recovery.js";
export type {
  QueryTransports,
  ReconciledIntent,
  RecoveredState,
  RecoveryOptions,
  RecoveryReport,
} from "./recovery.js";

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
  INTAKE_MAX_TITLE_CODE_POINTS,
} from "./intake.js";
export type { CreationConflict, RouteConflict, SeamDivergences } from "./intake.js";
export { renderMissionContent, RENDER_MAX_INPUT_BYTES } from "./render.js";
export { SerializationScheduler, SCHEDULER_ACTOR } from "./serialization-scheduler.js";
export type {
  ActivationOutcome,
  IntegrationApprovalFacts,
  LaneHolder,
  LaneOccupancy,
  QueuedEntry,
  QuickTaskApprovalFacts,
  RepoQueueView,
  SchedulingLane,
  SerializationViolation,
} from "./serialization-scheduler.js";

// WP-105: the product adapter/dispatch layer (CAM-EXEC-01/06, CAM-SEC-06).
export {
  dispatch,
  killConfirm,
  processGroupConfirmedGone,
  DisabledAdapterError,
  PRODUCTION_KILL_CONFIRM,
} from "./dispatch/lifecycle.js";
export type { DispatchOptions, KillConfirmTimings } from "./dispatch/lifecycle.js";
export { composeWorkerEnv } from "./dispatch/env.js";
export { classifyByQuotaSignal } from "./dispatch/quota.js";
export { buildRegistry, cliOnPath, DEFAULT_ATTESTATIONS_PATH } from "./dispatch/registry.js";
export type { RegistryOptions } from "./dispatch/registry.js";
export { claudeAdapter } from "./dispatch/adapters/claude.js";
export { codexAdapter } from "./dispatch/adapters/codex.js";
export { grokAdapter } from "./dispatch/adapters/grok.js";
export { committedSince, headSha, makeWorkspace } from "./dispatch/workspace.js";
