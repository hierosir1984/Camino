// @camino/core — pure domain logic only. The ESLint fence (eslint.config.mjs)
// rejects Node builtins, persistence, and other Camino packages here; the
// Appendix A state machines live behind this boundary (WP-101).
export { exhaustive } from "./exhaustive.js";

export {
  transition,
  attested,
  nonEmptyString,
  stringArray,
  RESERVED_PAYLOAD_FIELDS,
} from "./machine.js";
export type {
  EnrichmentSource,
  EnrichmentSpec,
  MachineDef,
  MachineEvent,
  TransitionResult,
  TransitionRow,
  TransitionTarget,
} from "./machine.js";

export { decideTransition, verifyReplay } from "./decide.js";
export type { Decision, DecisionInput, ReplayDivergence } from "./decide.js";

export {
  MISSION_ACTIVE_STATES,
  MISSION_TERMINAL_STATES,
  MISSION_STATES,
  MISSION_CREATION_EVENTS,
  MISSION_CONTEXT_ENRICHMENT,
  missionIntegrationMachine,
  missionQuickTaskMachine,
  missionMachineFor,
  isExecutionBearing,
} from "./mission.js";
export type { MissionEvent, MissionRoute, MissionState } from "./mission.js";

export {
  ISSUE_ACTIVE_STATES,
  ISSUE_TERMINAL_STATES,
  ISSUE_STATES,
  ISSUE_CREATION_EVENTS,
  ISSUE_CONTEXT_ENRICHMENT,
  issueMachine,
  retryPolicy,
} from "./issue.js";
export type { IssueEvent, IssueState } from "./issue.js";

export {
  ATTEMPT_ACTIVE_STATES,
  ATTEMPT_TERMINAL_STATES,
  ATTEMPT_ARCHIVED_STATE,
  ATTEMPT_STATES,
  ATTEMPT_CREATION_EVENTS,
  attemptMachine,
} from "./attempt.js";
export type { AttemptEvent, AttemptState } from "./attempt.js";

export { emptyView, applyRecord, foldView } from "./views.js";
export type { AttemptSnapshot, IssueSnapshot, MissionSnapshot, StateView } from "./views.js";

export { queuedEntrySeqs, fifoOrder } from "./serialization.js";
