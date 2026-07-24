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

export { queuedEntrySeqs, fifoOrder, auditActivationOrder } from "./serialization.js";
export type { ActivationDeviation } from "./serialization.js";

// WP-104: intent lifecycle + reconciliation decision path (CAM-STATE-02/03).
export {
  DAVID_ACTOR,
  INTENT_RESOLUTION_ROUTES,
  applyIntentRecord,
  decideIntentAppend,
  foldIntentView,
  validateOperationSpec,
  verifyIntentLog,
} from "./intent-lifecycle.js";
export type {
  IntentAppendDecision,
  IntentAppendInput,
  IntentLogDivergence,
  IntentResolutionRoute,
  IntentView,
  IntentViewEntry,
  SpecValidation,
} from "./intent-lifecycle.js";

export {
  decideReconciliation,
  statusOnlyVerdict,
  ReconcileFactsMismatchError,
} from "./reconcile.js";
export type { IntentSnapshot, ObservedFacts, ReconcileVerdict } from "./reconcile.js";

// WP-109: Living Canon — intent-ledger lifecycle, status projection,
// canon rendering + freshness (CAM-CANON-01/02/03).
export {
  DISPOSITION_TRANSITIONS,
  applyLedgerRecord,
  decideLedgerAppend,
  foldLedgerView,
  recordedAtProblem,
  safeErrorLabel,
  singleLineTextProblem,
  verifyLedgerLog,
} from "./canon-intent.js";
export type {
  DispositionTransition,
  LedgerAppendDecision,
  LedgerLogDivergence,
  LedgerView,
  LedgerViewEntry,
} from "./canon-intent.js";

export {
  EVIDENCE_RULES,
  IMPLEMENTATION_RULES,
  explainRequirementStatus,
  projectRequirementStatus,
  projectStatus,
  renderStatusLine,
  statusContextProblem,
  validateCanonFact,
  verifyCanonFactLog,
} from "./canon-status.js";
export type { ExplainedStatus, FactValidation, ProjectionRule } from "./canon-status.js";

// WP-122: gap register — projection + disposition decisions (CAM-CANON-05,
// CAM-CORE-09/10).
export {
  decideGapDisposition,
  gapDispositionPayloadProblem,
  projectGapRegister,
  statusTupleEquals,
  statusTupleProblem,
  verifyGapDispositionLog,
} from "./gap-register.js";
export type {
  GapDispositionDecision,
  GapDispositionLogDivergence,
  GapDispositionRef,
  GapFactRef,
  GapRegisterRow,
} from "./gap-register.js";

export {
  STANDALONE_FOLD_AGE_DAYS,
  STANDALONE_FOLD_REQUIREMENT_THRESHOLD,
  canonFragment,
  computeCanonDivergence,
  parseCanonMarker,
  planStandaloneFold,
  renderCanon,
  standaloneFoldRequired,
} from "./canon-render.js";
export type {
  CanonDivergence,
  CanonFoldPlan,
  CanonMarker,
  FreshnessDefect,
  RenderCanonOptions,
  StandaloneFoldDecision,
} from "./canon-render.js";

// WP-110: pure planning decisions — segmentation, dependency cycles named,
// checklist totality, the approval gate (CAM-PLAN-01/-02/-11).
export {
  segmentPrd,
  dependencyGraphProblems,
  findDependencyCycle,
  formatCycle,
  checklistProblems,
  clarificationReferenceProblems,
  templateProblems,
  decidePlanApproval,
  plantedAmbiguityCoverage,
} from "./plan-validate.js";
export type {
  PrdSegment,
  PlanGateInput,
  ApprovalRefusal,
  GateAttestedFacts,
  ApprovalDecision,
  PlantedAmbiguity,
  AmbiguityCoverage,
} from "./plan-validate.js";

// WP-113: knowledge lifecycle folds (CAM-CANON-09) — candidate→approved
// promotion via curation or the two deterministic rule-classes, revert
// invalidation, contradiction escalation, and the pack-visibility rules.
export {
  emptyKnowledgeView,
  foldKnowledge,
  knowledgeAppendProblems,
  knowledgeClaimsConflict,
  standingApprovedConflicts,
  knowledgeCurationQueue,
  visibleKnowledgeFor,
} from "./knowledge.js";
export type {
  CommandTally,
  QuarantineConfirmation,
  KnowledgePromotionRecord,
  KnowledgeResolutionRecord,
  KnowledgeInvalidationRecord,
  KnowledgeEntrySnapshot,
  KnowledgeView,
  CommandObservationPayload,
  QuarantineConfirmationPayload,
  EntryPromotedPayload,
  EntryResolutionPayload,
  ValidityBaseRevertedPayload,
  KnowledgeContradiction,
  KnowledgeReader,
  KnowledgeVisibility,
  VisibleKnowledgeEntry,
} from "./knowledge.js";

// WP-113: the .camino/knowledge.md projection (approved entries only —
// the repo channel must not leak candidates across missions).
export { knowledgeFragment, renderKnowledge } from "./knowledge-render.js";
export type { RenderKnowledgeOptions } from "./knowledge-render.js";

// WP-113: context-pack assembly (CAM-EXEC-07/-09 + the WP-110 amendment) —
// pure assembly with hash-locked, length-delimited provenance fences.
export {
  PACK_CONTENT_CLASSES,
  UNTRUSTED_CHANNELS,
  assembleContextPack,
  parseContextPack,
  verifyPackDigest,
} from "./context-pack.js";
export type {
  PackContentClass,
  UntrustedChannel,
  CanonExcerpt,
  PackDependencyInterface,
  UntrustedAttachment,
  ContextPackInput,
  PackSectionInfo,
  AssembledContextPack,
  ParsedPackSection,
  PackSegment,
} from "./context-pack.js";
