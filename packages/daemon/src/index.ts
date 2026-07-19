// @camino/daemon — the control plane process: all I/O lives here.
// The Fastify server itself lands in WP-102 (CAM-CORE-01).
export { BIND_HOST, DEFAULT_PORT, caminoHome, tokenFilePath } from "./config.js";

export { SqliteEventStore } from "./event-store.js";
export type { SqliteEventStoreOptions } from "./event-store.js";
export { TransitionRecorder } from "./transition-recorder.js";
export type { RecordOutcome, RecordRequest } from "./transition-recorder.js";
