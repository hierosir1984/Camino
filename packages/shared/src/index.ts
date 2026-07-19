export {
  REQUIREMENT_ID_PATTERN,
  isRequirementId,
  parseRequirementId,
  formatRequirementId,
} from "./requirement-id.js";
export type { RequirementId } from "./requirement-id.js";

export { MISSION_SOURCE_KINDS, MISSION_CONTENT_FORMATS, MISSION_ROUTES } from "./domain.js";
export type {
  Project,
  Repo,
  MissionRecord,
  MissionSourceKind,
  MissionContentFormat,
  MissionRouteName,
  PastedIntakeRequest,
  FileIntakeRequest,
  QuickTaskIntakeRequest,
  IntakeRejectionCode,
  IntakeResult,
} from "./domain.js";

// WP-104: the §4.4 idempotency contract as code (CAM-STATE-02).
export {
  OPERATION_CLASSES,
  OPERATION_TARGET_KINDS,
  LABEL_DESIRED_STATES,
  INTENT_EVENTS,
  INTENT_STATUSES,
  DefinitiveRefusalError,
  IndeterminateOutcomeError,
  intentMarkerToken,
  correlationToken,
} from "./external-ops.js";
export type {
  OperationClass,
  OperationTargetKind,
  LabelDesiredState,
  BranchCreateSpec,
  PushSpec,
  PrCreateSpec,
  MergeByPushSpec,
  LabelSetSpec,
  CommentPostSpec,
  WorkflowDispatchSpec,
  TestServiceMutationSpec,
  CatchAllSpec,
  ExternalOperationSpec,
  OperationResult,
  IntentEventName,
  IntentStatus,
  IntentEventRecord,
  GitHubMutationTransport,
  TestServiceMutationTransport,
  CatchAllMutationTransport,
  MutationTransports,
  ObservedPullRequest,
  ObservedRef,
  ObservedWorkflowRun,
  GitHubQueryTransport,
} from "./external-ops.js";

export { ENTITY_KINDS } from "./event-log.js";
export type {
  AppendOptions,
  EntityKind,
  EventOutcome,
  RejectionCode,
  EventInput,
  EventRecord,
  EventFilter,
  EventStore,
} from "./event-log.js";
