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
  INTENT_ID_PATTERN,
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

// WP-105: the worker-adapter dispatch contract (CAM-EXEC-01/06, CAM-SEC-06).
export { GITHUB_CREDENTIAL_MARKERS, isGithubCredentialShapedKey } from "./adapter.js";
export type {
  StreamEvent,
  DispatchOutcome,
  SpawnPlan,
  AdapterContext,
  AdapterSpec,
  KillConfirmRecord,
  EnvPostureRecord,
  LeaseReleaseContext,
  LeaseHandle,
  LeaseDisposition,
  DispatchRecord,
} from "./adapter.js";

// WP-105: the API-key adapter interface — typed contract + conformance
// skeleton, implementation [F] (CAM-EXEC-01 interface clause).
export {
  CREDENTIAL_ENV_VAR_PATTERN,
  checkApiKeyAdapterSpec,
  checkPlanCredentialCustody,
  checkAdapterPlanCustody,
  API_KEY_ADAPTER_DISPATCH_OBLIGATIONS,
} from "./api-key-adapter.js";
export type { ApiKeyAdapterSpec, ConformanceViolation } from "./api-key-adapter.js";

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
