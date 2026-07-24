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

// WP-122: gap register — dispositions on register rows (CAM-CANON-05).
export {
  DETECTOR_ACTOR_PREFIX,
  GAP_DISPOSITIONS,
  GAP_DISPOSITION_EVENTS,
  isDetectorActor,
} from "./gap-register.js";
export type {
  GapDisposition,
  GapDispositionAppendInput,
  GapDispositionEventName,
  GapDispositionReadFilter,
  GapDispositionRecord,
} from "./gap-register.js";

// WP-106: routing foundation — capability-registry schema + per-project
// policy table (CAM-ROUTE-01/02). Every value export is deep-frozen at
// module load; DEFAULT_POLICY_TABLE is built by a constructor that throws
// on any cross-family constraint failure (defaults cannot load broken).
export {
  PROVIDER_FAMILIES,
  HARNESS_FAMILY,
  harnessFamily,
  ROUTING_ROLES,
  REASONING_TIERS,
  TASK_TEMPLATES,
  RISK_TIERS,
  QUOTA_PAUSE_THRESHOLD,
  CROSS_FAMILY_CONSTRAINTS,
  CAPABILITY_CONFIDENCE,
  DEFAULT_POLICY_TABLE,
  makeCrossFamilyDefaults,
  validatePolicyTable,
  crossFamilyViolations,
  resolveAssignment,
  deepFreeze,
} from "./routing.js";
export type {
  ProviderFamily,
  RoutingRole,
  ReasoningTier,
  TaskTemplate,
  RiskTier,
  TaskFeatures,
  PolicyAssignment,
  PolicyCells,
  PolicyTable,
  PolicyViolation,
  CrossFamilyViolation,
  RoleRotation,
  CapabilityConfidence,
  CapabilityAttribute,
  ModelInfo,
  WindowShape,
  BillingPool,
  SanctionedPathRecord,
  ProviderCapabilityRecord,
} from "./routing.js";

// WP-110: canonical JSON + content hashing (the contract-hash definition).
export { CanonicalJsonError, canonicalJson, sha256Hex } from "./canonical-json.js";

// WP-110: plan construction vocabulary + mission templates
// (CAM-PLAN-01/-02/-07/-11). Id grammars are predicates + pattern sources;
// live RegExps never cross the barrel.
export {
  MISSION_TEMPLATE_NAMES,
  MISSION_TEMPLATES,
  PLAN_ISSUE_ID_PATTERN_SOURCE,
  CLARIFICATION_ID_PATTERN_SOURCE,
  SEGMENT_ID_PATTERN_SOURCE,
  REQUIREMENT_AREA_PATTERN_SOURCE,
  isPlanIssueId,
  isClarificationId,
  isSegmentId,
  isRequirementArea,
  INTERFACE_KINDS,
  UNMAPPED_REASONS,
  PLAN_CONSTRUCTION_RECORD_KINDS,
  PLAN_STREAM_FILENAME,
  PLAN_MAX_TEXT_LENGTH,
  PLAN_MAX_LIST_LENGTH,
  planConstructionRecordProblems,
  clarificationResponseProblems,
} from "./plan.js";
export type {
  MissionTemplateName,
  MissionTemplate,
  PlanReviewClass,
  InterfaceKind,
  DeclaredInterface,
  PlannedIssueDraft,
  ClarifyingItemDraft,
  UnmappedReason,
  ChecklistRowDraft,
  PlanConstructionRecord,
  ClarificationResponse,
} from "./plan.js";

// WP-110: issue contracts — hash-referenced frozen acceptance criteria
// (CAM-PLAN-04/-11); the schema WP-108/111/112/113/114 build against.
export {
  CONTRACT_SCHEMA_VERSION,
  SHA256_HEX_PATTERN_SOURCE,
  isSha256Hex,
  contractTermsOf,
  contractHash,
  contractProblems,
  contractRefProblems,
  CONTRACT_REFERENCE_OBLIGATIONS,
} from "./contract.js";
export type { ContractTerms, IssueContract, ContractRef } from "./contract.js";

// WP-108: the quarantined final diff — the named artifact the quarantine intake
// emits (CAM-EXEC-04); schema + total validator here, produced in `daemon`,
// consumed by WP-111 (re-classification) and WP-116 (evidence).
export {
  CHANGED_PATH_KINDS,
  GIT_OBJECT_NAME_PATTERN_SOURCE,
  MAX_CHANGED_PATHS,
  WORKER_ATTRIBUTION_TRAILER_KEY,
  isGitObjectName,
  workerAttributionTrailer,
  quarantinedDiffProblems,
} from "./quarantine-diff.js";
export type { ChangedPath, ChangedPathKind, QuarantinedDiff } from "./quarantine-diff.js";

// WP-114: the attempt-lease / environment-fencing interface (CAM-STATE-04;
// PRD §5 registry item 5). The NAMED durable seam WP-115's validation
// runner and any future janitor (CAM-STATE-07) present generations through.
export {
  LEASE_HEARTBEAT_MS,
  LEASE_TTL_MS,
  LEASE_STATES,
  KILL_CONFIRM_SOURCES,
  leaseLapsed,
  environmentIdProblems,
  validationEnvironmentId,
} from "./lease.js";
export type {
  LeaseState,
  KillConfirmSource,
  LeaseGrant,
  EnvironmentLeaseView,
  GrantResult,
  FenceResult,
  SettleResult,
  LapsedLease,
  LeaseRecoveryReport,
  EnvironmentLeaseStore,
} from "./lease.js";

// WP-114: structured attempt-failure handoff (CAM-PLAN-09 — summaries,
// never raw transcripts; the schema is closed so a transcript has no
// field to ride in).
export {
  ATTEMPT_SUMMARY_SCHEMA_VERSION,
  HEADLINE_MAX_CHARS,
  SUMMARY_ATTEMPT_TERMINALS,
  TOKEN_LITERAL_PATTERN_SOURCE,
  attemptSummaryProblems,
  summaryHeadline,
} from "./attempt-summary.js";
export type { AttemptSummary, SummaryAttemptTerminal } from "./attempt-summary.js";

// WP-113: per-repo operational knowledge (CAM-CANON-09; design §3.7) —
// entry vocabulary, event vocabulary, promotion rule-class constants, and
// the total entry validator. Lifecycle folds live in @camino/core.
export {
  KNOWLEDGE_ENTRY_CLASSES,
  COMMAND_CLAIMS,
  FLAKY_TEST_CLAIMS,
  KNOWLEDGE_ENTRY_STATES,
  KNOWLEDGE_EVENTS,
  COMMAND_RULE_MIN_SUCCESSES,
  COMMAND_RULE_MIN_MISSIONS,
  KNOWLEDGE_MAX_TEXT_LENGTH,
  isGitSha,
  knowledgeEntryProblems,
} from "./knowledge.js";
export type {
  KnowledgeEntryClass,
  CommandClaim,
  FlakyTestClaim,
  KnowledgeEntryState,
  KnowledgeScope,
  KnowledgeProvenance,
  KnowledgeValidity,
  KnowledgeEntryInput,
  KnowledgePromotionAuthority,
  KnowledgeEventName,
  KnowledgeAppendInput,
  KnowledgeEventRecord,
  KnowledgeReadFilter,
} from "./knowledge.js";

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
