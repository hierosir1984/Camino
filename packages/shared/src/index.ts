// NOTE: the requirement-id and intent-id GRAMMARS are deliberately absent from
// this barrel as live RegExps — reach them through their predicates. See the
// note on REQUIREMENT_ID_PATTERN_SOURCE for why freezing a RegExp is not
// enough, and barrel-immutability.test.ts for the pin.
export {
  REQUIREMENT_ID_PATTERN_SOURCE,
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
  INTENT_ID_PATTERN_SOURCE,
  isValidIntentId,
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

// WP-107: PRD §5 registry item 11 quota values (CAM-EXEC-04/05, CAM-SEC-08).
export { REGISTRY_ITEM_11_QUOTAS } from "./worker-quotas.js";
export type { RegistryItem11Quotas } from "./worker-quotas.js";

// WP-105: the worker-adapter dispatch contract (CAM-EXEC-01/06, CAM-SEC-06).
export {
  GITHUB_CREDENTIAL_MARKERS,
  isGithubCredentialShapedKey,
  CREDENTIAL_SHAPED_PATTERN_SOURCE,
  STRIPPED_ENV_EXACT,
  STRIPPED_ENV_PREFIXES,
  WORKER_ENV_ALLOWLIST,
  OFFICIAL_ADAPTER_NAMES,
  OFFICIAL_CLI_CONFIG_ROOTS,
  CREDENTIAL_ROOT_ENV_KEYS,
  isCredentialRootEnvKey,
  isStrippedWorkerEnvKey,
  isGitOrSshChannelEnvKey,
  isWorkerEnvAllowlistKey,
} from "./adapter.js";
export type { OfficialAdapterName } from "./adapter.js";
export type {
  StreamEvent,
  DispatchOutcome,
  AttemptBudget,
  BudgetBreachRecord,
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
  CREDENTIAL_ENV_VAR_PATTERN_SOURCE,
  isCredentialEnvVarNameValid,
  checkApiKeyAdapterSpec,
  checkPlanCredentialCustody,
  checkAdapterPlanCustody,
  API_KEY_ADAPTER_DISPATCH_OBLIGATIONS,
} from "./api-key-adapter.js";
export type { ApiKeyAdapterSpec, ConformanceViolation } from "./api-key-adapter.js";

// WP-109: Living Canon — intent ledger, canon facts, status tuple (CAM-CANON-01/02/03).
export {
  ACCEPTED_FAMILY,
  CANON_FACT_KINDS,
  EVIDENCE_STATES,
  INTENT_DISPOSITIONS,
  LEDGER_EVENTS,
} from "./canon.js";
export type {
  CanonFactInput,
  CanonFactKind,
  CanonFactReadFilter,
  CanonFactRecord,
  EvidenceState,
  ImplementationState,
  IntentDisposition,
  LedgerAppendInput,
  LedgerEventName,
  LedgerEventRecord,
  LedgerReadFilter,
  StatusContext,
  StatusTuple,
} from "./canon.js";

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
