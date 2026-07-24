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
// buildRegistry is the zero-argument PRODUCTION gate (round-7 finding 1): the
// injectable-probe variant (buildRegistryForTest) is deliberately NOT exported
// here, so the public surface cannot substitute the CLI-presence/attestation
// gates that mint registry provenance.
export { buildRegistry, cliOnPath, DEFAULT_ATTESTATIONS_PATH } from "./dispatch/registry.js";
// The raw adapter factories are deliberately NOT exported (round-6 finding 1):
// the package's only path to a dispatchable official adapter is buildRegistry()
// — its sanctioned-path gate stamps registry provenance, which dispatch()
// requires for official adapter names. (package.json "exports" confines deep
// imports, so this is a real package-boundary constraint, not advice.)
export { committedSince, headSha, makeWorkspace } from "./dispatch/workspace.js";

// WP-106: routing foundation (CAM-ROUTE-01/02) — seeded capability
// registry, live registry assembly, quota-window tracker, per-project
// policy store.
export { CAPABILITY_SEED, XAI_SANCTIONED_PATH_MEMO } from "./routing/capability-seed.js";
export { buildCapabilityRegistry } from "./routing/capability-registry.js";
export type {
  BuildCapabilityRegistryOptions,
  CapabilityRegistryView,
  EnablementView,
  ProviderCapabilityView,
} from "./routing/capability-registry.js";
export { QuotaWindowTracker } from "./routing/window-tracker.js";
export type {
  DispatchObservationInput,
  ProviderWindowState,
  QuotaWindowTrackerOptions,
  WindowConsumptionEstimate,
  WindowObservation,
} from "./routing/window-tracker.js";
export { RoutingPolicyStore } from "./routing/policy-store.js";
export type {
  EffectivePolicy,
  RoutingPolicyStoreOptions,
  SetPolicyResult,
} from "./routing/policy-store.js";

// WP-109: Living Canon durable stores (CAM-CANON-01/02/03).
export { CanonLedgerStore } from "./canon-ledger.js";
export type {
  CanonLedgerStoreOptions,
  DescopeRequirementInput,
  DisputeRequirementInput,
  ProposeRequirementInput,
  ResolveDisputeAcceptedInput,
  ResolveDisputeAssumedInput,
} from "./canon-ledger.js";
export { CanonFactsStore } from "./canon-facts.js";
export type { CanonFactsStoreOptions } from "./canon-facts.js";

// WP-107: worker isolation — clone provisioning, container egress, per-repo
// config, per-attempt budgets, single archival step (CAM-EXEC-02/03/05).
export {
  WorkerCloneError,
  WORKER_CLONE_HOOKS_PATH,
  provisionWorkerClone,
  assertWorkerCloneIsolation,
  scanForGithubCredentialMaterial,
  urlCarriesUserinfo,
} from "./worker/clone.js";
export type { WorkerCloneIsolationRecord, ProvisionWorkerCloneOptions } from "./worker/clone.js";
export {
  WorkerContainerConfigError,
  WORKER_CONTAINER_CAPS,
  WORKER_PIDS_LIMIT,
  WORKER_PROFILE_ENTRYPOINT,
  WORKER_WORKSPACE_MOUNT,
  isValidAllowlistHost,
  isValidAllowlistPort,
  renderAllowlistEnv,
  renderWorkerRunArgs,
} from "./worker/egress.js";
export type { EgressAllowlistEntry, WorkerContainerRun } from "./worker/egress.js";
export {
  RepoConfigError,
  REPO_CONFIG_PATH,
  MAX_EGRESS_ALLOWLIST_ENTRIES,
  parseRepoEgressConfig,
  loadRepoEgressConfig,
} from "./worker/repo-config.js";
export type { WorkerEgressConfig } from "./worker/repo-config.js";
export { BudgetConfigError, validateAttemptBudget, dispatchWithBudget } from "./worker/budget.js";
export type { BudgetBreachEscalation, BudgetedDispatchResult } from "./worker/budget.js";
export {
  ArchivalError,
  DEFAULT_ARCHIVE_QUOTAS,
  effectiveArchiveQuotas,
  archiveAttempt,
  pruneArchives,
  workspaceSizeBytes,
} from "./worker/archive.js";
export type {
  ArchivalStage,
  ArchiveQuotas,
  ArchiveLedgerRow,
  ArchiveSidecar,
  ArchiveAttemptOptions,
  ArchivalRecord,
  PruneReport,
  PruneOptions,
} from "./worker/archive.js";

// WP-108: quarantine module — squash-and-rebuild intake (CAM-EXEC-04). Runs
// against the issue's frozen WP-110 contract within registry-item-11 fetch
// budgets; emits the @camino/shared QuarantinedDiff for WP-111 / WP-116.
export {
  runIntake,
  objectExists,
  cleanupPristineRepos,
  removePristineRepo,
} from "./quarantine/intake.js";
export type { IntakeOptions } from "./quarantine/intake.js";
export { DEFAULT_BUDGETS, effectiveBudgets, MAX_STORED_PATH_LENGTH } from "./quarantine/types.js";
export {
  checkFetchBudget,
  checkScopeAndProtected,
  checkChangedPathValidity,
  checkPathCollisions,
  checkNameAliases,
  checkPathLength,
  checkDotGitPaths,
  checkSubmodules,
  checkSymlinks,
  checkBudgets,
  isProtectedPath,
  matchesAnyGlob,
  symlinkEscapes,
  symlinkTargetDanger,
  SYMLINK_TARGET_MAX_BYTES,
  REGISTRY_ITEM_11_FETCH_BUDGET,
} from "./quarantine/policy.js";
export { QuarantineGitError } from "./quarantine/git.js";
export {
  analyzeWorkflow,
  scanWorkflowPosture,
  CANDIDATE_REFS,
} from "./quarantine/workflow-posture.js";
export type { WorkflowFinding } from "./quarantine/workflow-posture.js";
export type {
  Budgets,
  FetchBudget,
  QuarantineAssignment,
  QuarantineResult,
  RebuiltCandidate,
  Rejection,
  RejectionCode,
  TreeEntry,
} from "./quarantine/types.js";

// WP-122: gap register — disposition log, service, HTTP surface
// (CAM-CANON-05, CAM-CORE-09/10).
export { GapDispositionsStore } from "./gap-dispositions.js";
export type { GapDispositionsStoreOptions, GapDispositionWriteInput } from "./gap-dispositions.js";
export { REGISTER_ACTIONS, RegisterActionError, RegisterService } from "./register-service.js";
export type {
  RegisterAction,
  RegisterActionInput,
  RegisterActionResult,
  RegisterAsOf,
  RegisterContextSource,
  RegisterDescopeResult,
  RegisterErrorCode,
  RegisterServiceDeps,
  RegisterSnapshot,
} from "./register-service.js";

// WP-114: the attempt scheduler — readiness, leases, quota-aware dispatch,
// failure handoff (CAM-PLAN-09/-12, CAM-STATE-04/-06, CAM-ROUTE-06), plus
// the WP-107 handoff surfaces (out-of-process budget supervision, image
// provenance, network attestation, container-input composition, retained-
// workspace reconciliation).
export { SqliteLeaseStore } from "./scheduler/lease-store.js";
export type { SqliteLeaseStoreOptions } from "./scheduler/lease-store.js";
export { AttemptSummaryStore } from "./scheduler/summary-store.js";
export type { AttemptSummaryStoreOptions } from "./scheduler/summary-store.js";
export { ArchiveLedgerStore } from "./scheduler/archive-ledger.js";
export type { ArchiveLedgerStoreOptions } from "./scheduler/archive-ledger.js";
export {
  dependencyOrder,
  dependentsOf,
  latestContracts,
  selectNextDispatch,
  unmetDependencies,
} from "./scheduler/readiness.js";
export type { DispatchHold, DispatchSelection, IssueStateSnapshot } from "./scheduler/readiness.js";
export { AttemptScheduler, QUOTA_PROBE_BACKOFF_MS } from "./scheduler/attempt-scheduler.js";
export type {
  AttemptDispatchPlan,
  AttemptSchedulerDeps,
  DispatchDecision,
  InterruptedAttempt,
  OutcomeRouting,
  QuotaPause,
  RecordOutcomeOptions,
  SchedulerRecoveryReport,
  WindowStateReader,
} from "./scheduler/attempt-scheduler.js";
export {
  SupervisorError,
  armContainerSupervisor,
  confirmContainerGone,
  killContainerAndConfirm,
} from "./scheduler/supervisor.js";
export type { ArmedSupervisor, ArmSupervisorOptions } from "./scheduler/supervisor.js";
export {
  CAMINO_IMAGE_LABEL,
  TRUSTED_TOOL_DIRS,
  ToolchainError,
  WORKER_PROFILE_DIR,
  assertCaminoBuiltImage,
  buildWorkerImage,
  resolveTrustedTool,
} from "./scheduler/image-provenance.js";
export type {
  BuildWorkerImageOptions,
  WorkerImageProvenance,
} from "./scheduler/image-provenance.js";
export {
  CAMINO_NETWORK_LABEL,
  WorkerNetworkError,
  attestWorkerNetwork,
  createAttestedWorkerNetwork,
  destroyWorkerNetwork,
} from "./scheduler/worker-network.js";
export type { AttestedWorkerNetwork } from "./scheduler/worker-network.js";
export { ContainerInputError, composeContainerRun } from "./scheduler/container-inputs.js";
export type {
  ComposeContainerRunOptions,
  ComposedContainerRun,
} from "./scheduler/container-inputs.js";
export {
  recordArchivalEvent,
  reconcileRetainedWorkspace,
} from "./scheduler/workspace-reconciler.js";
export type {
  ReconcilerDeps,
  ReconciliationOutcome,
  RetainedWorkspaceRef,
} from "./scheduler/workspace-reconciler.js";

// WP-110: planning — the plan store, the planning service, and the contract
// freeze (CAM-PLAN-01/-02/-04/-07/-11).
export { PlanStore, PLAN_STREAM_KINDS, reviewArtifactProblems } from "./plan-store.js";
export type {
  ConfirmationRow,
  PlanSessionRow,
  PlanStoreOptions,
  PlanStreamKind,
  PlanStreamRecord,
  UserActRow,
} from "./plan-store.js";
export { PlanningService, PlanningError, PLANNER_ACTOR } from "./planning.js";
export type {
  ApprovePlanOutcome,
  ChecklistRowView,
  ClarificationView,
  DependencyInterfaceView,
  PlanningServiceOptions,
  PlanView,
  ResumeReport,
  ServiceApprovalRefusal,
} from "./planning.js";
export { runPlannerCompile, plannerPrompt } from "./plan-runner.js";
export type { PlannerRunOptions, PlannerRunRecord, RefusedLine } from "./plan-runner.js";

// WP-113: the knowledge event store (CAM-CANON-09) — append-only lifecycle
// events validated by @camino/core's fold at write AND at adoption.
export { KnowledgeStore } from "./knowledge-store.js";
export type { KnowledgeStoreOptions } from "./knowledge-store.js";

// WP-113: context-pack composition (CAM-EXEC-07/-09 + the WP-110
// amendment) — store-sourced inputs into the pure core assembler.
export {
  ContextPackService,
  materializeContextPack,
  CONTEXT_PACK_FILENAME,
} from "./context-pack-service.js";
export type {
  AssemblePackRequest,
  ContextPackServiceOptions,
  PackPlanSource,
  PackCanonSource,
  PackFactsSource,
  PackKnowledgeSource,
} from "./context-pack-service.js";
