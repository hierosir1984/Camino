/**
 * Planning service (WP-110): the seam between the pure planning decisions
 * (@camino/core plan-validate) and the daemon's stores — the construction
 * stream, David's acknowledgment acts, the intent ledger, the event log,
 * and the contract freeze (CAM-PLAN-01/-02/-04/-07/-11).
 *
 * Flow, in order:
 *   1. startSession — a mission in `draft` opens one planning session.
 *   2. ingest — the planner streams construction records; each lands in the
 *      plan store the moment it arrives, so the plan VIEW shows issues as
 *      constructed (CAM-PLAN-01 "streaming to the board").
 *   3. attachReview — WP-111's cross-family critique fills the review slot;
 *      construction completion + review together record the A.1#2 /
 *      A.1b#2 mission transition (draft → planned).
 *   4. David's acts — acknowledgeClarification (answer or confirm the
 *      recorded assumption; there is no passive variant), confirmMappedRows
 *      (each confirmation writes the propose+accept pair into the intent
 *      ledger — CAM-PLAN-02 "confirmations create accepted ledger
 *      entries"), acknowledgeFlaggedRows (must match the CURRENT unmapped
 *      set exactly).
 *   5. approvePlan — the pure gate decides; every refusal is returned with
 *      names (unacknowledged items, the dependency cycle spelled out).
 *      On ok: the approval act is recorded durably FIRST, then the freeze
 *      runs as idempotent steps — contracts written (hash-referenced),
 *      the mission's plan-approved event via the scheduler (slot fact
 *      computed there), one issue-created event per contract carrying
 *      { contractVersion, contractHash } (CAM-PLAN-04's first obligation),
 *      then the completion marker. resumePendingWork() re-runs any freeze
 *      or ledger write a crash interrupted; every step checks before it
 *      writes, so replay is safe (the WP-104 idempotency posture).
 *
 * Requirement-id minting: a confirmed row proposes `CAM-<AREA>-NN` where
 * NN is the next free number for that area across the ledger and this
 * store. If an accepted ledger entry with the IDENTICAL statement already
 * exists (a re-planned mission re-confirming the same intent), that
 * requirement id is REUSED and no ledger write happens — intent is not
 * duplicated, and nothing but user action ever mutates the ledger
 * (CAM-CANON-01).
 */
import {
  DAVID_ACTOR,
  decidePlanApproval,
  dependencyGraphProblems,
  checklistProblems,
  clarificationReferenceProblems,
  segmentPrd,
  templateProblems,
} from "@camino/core";
import type { ApprovalRefusal, GateAttestedFacts, PlanGateInput, PrdSegment } from "@camino/core";
import {
  ACCEPTED_FAMILY,
  CONTRACT_SCHEMA_VERSION,
  MISSION_TEMPLATES,
  clarificationResponseProblems,
  contractHash,
  formatRequirementId,
  isRequirementArea,
  parseRequirementId,
  planConstructionRecordProblems,
} from "@camino/shared";
import type {
  ChecklistRowDraft,
  ClarificationResponse,
  ClarifyingItemDraft,
  ContractTerms,
  EventStore,
  IssueContract,
  MissionRecord,
  MissionTemplateName,
  PlanConstructionRecord,
  PlannedIssueDraft,
} from "@camino/shared";
import type { SqliteDomainStore } from "./domain-store.js";
import type { CanonLedgerStore } from "./canon-ledger.js";
import type { SerializationScheduler } from "./serialization-scheduler.js";
import type { TransitionRecorder } from "./transition-recorder.js";
import { reviewArtifactProblems, PlanStore } from "./plan-store.js";
import type { PlanSessionRow, PlanStreamRecord } from "./plan-store.js";

/** Actor recorded on planner-caused events (issue creation at freeze). */
export const PLANNER_ACTOR = "camino:planner";

/** A named refusal from an operation the caller can repair and retry. */
export class PlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningError";
  }
}

export interface PlanningServiceOptions {
  readonly now?: () => Date;
}

/** The assembled in-memory shape of one session's plan (derived from the stream). */
interface PlanState {
  readonly session: PlanSessionRow;
  readonly mission: MissionRecord;
  readonly segments: readonly PrdSegment[];
  readonly issues: PlannedIssueDraft[];
  readonly clarifications: ClarifyingItemDraft[];
  readonly checklist: ChecklistRowDraft[];
  readonly constructionComplete: boolean;
  readonly reviewArtifacts: Array<Record<string, unknown>>;
}

/** One clarification with its acknowledgment state, for the approval screen. */
export interface ClarificationView extends ClarifyingItemDraft {
  readonly acknowledgment: ClarificationResponse | null;
}

/** One checklist row with confirmation/flag state, for the approval screen. */
export type ChecklistRowView =
  | {
      readonly segmentId: string;
      readonly segmentText: string;
      readonly disposition: "mapped";
      readonly proposedStatement: string;
      readonly proposedArea: string;
      readonly mappedPlanIssueIds: readonly string[];
      readonly note?: string;
      readonly confirmed: boolean;
      /** Present once confirmed: the minted (or reused) requirement id. */
      readonly requirementId: string | null;
    }
  | {
      readonly segmentId: string;
      readonly segmentText: string;
      readonly disposition: "unmapped";
      /** Visibly flagged (CAM-PLAN-02): the stated reason travels with the flag. */
      readonly flagged: true;
      readonly reason: string;
      readonly note?: string;
    };

export interface PlanView {
  readonly sessionId: string;
  readonly missionId: string;
  readonly template: MissionTemplateName;
  readonly status: "constructing" | "constructed" | "approved" | "rejected";
  readonly segments: readonly PrdSegment[];
  readonly issues: readonly PlannedIssueDraft[];
  readonly clarifications: readonly ClarificationView[];
  readonly checklist: readonly ChecklistRowView[];
  /** The unmapped segment ids, surfaced separately so no reader can miss them. */
  readonly flaggedSegmentIds: readonly string[];
  readonly reviewAttached: boolean;
  /** The gate's current decision — the approval screen renders these refusals. */
  readonly approvalPreview: ReturnType<typeof decidePlanApproval>;
}

export type ServiceApprovalRefusal =
  | ApprovalRefusal
  | { readonly kind: "quick-task-review-facts-missing"; readonly missing: readonly string[] };

export type ApprovePlanOutcome =
  | { readonly ok: true; readonly contracts: readonly IssueContract[] }
  | { readonly ok: false; readonly refusals: readonly ServiceApprovalRefusal[] };

export interface ResumeReport {
  readonly completedApprovals: string[];
  readonly completedLedgerWrites: string[];
  readonly recordedConstructedTransitions: string[];
  readonly completedRejections: string[];
}

export interface DependencyInterfaceView {
  readonly issueId: string;
  readonly title: string;
  readonly contractVersion: number;
  readonly contractHash: string;
  readonly interfaces: IssueContract["interfaces"];
}

export class PlanningService {
  readonly #store: PlanStore;
  readonly #domain: SqliteDomainStore;
  readonly #recorder: TransitionRecorder;
  readonly #events: EventStore;
  readonly #ledger: CanonLedgerStore;
  readonly #scheduler: SerializationScheduler;
  readonly #now: () => Date;

  constructor(
    store: PlanStore,
    domain: SqliteDomainStore,
    recorder: TransitionRecorder,
    events: EventStore,
    ledger: CanonLedgerStore,
    scheduler: SerializationScheduler,
    options: PlanningServiceOptions = {},
  ) {
    this.#store = store;
    this.#domain = domain;
    this.#recorder = recorder;
    this.#events = events;
    this.#ledger = ledger;
    this.#scheduler = scheduler;
    this.#now = options.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  startSession(missionId: string, template: MissionTemplateName): PlanSessionRow {
    const mission = this.#domain.getMission(missionId);
    if (mission === undefined) {
      throw new PlanningError(`mission ${missionId} does not exist`);
    }
    if (!Object.hasOwn(MISSION_TEMPLATES, template)) {
      throw new PlanningError(`unknown template ${JSON.stringify(template)}`);
    }
    const templateDef = MISSION_TEMPLATES[template];
    if (templateDef.route !== mission.route) {
      throw new PlanningError(
        `template ${template} runs the ${templateDef.route} route but mission ${missionId} ` +
          `is on the ${mission.route} route`,
      );
    }
    const state = this.#recorder.currentState("mission", missionId);
    if (state !== "draft") {
      throw new PlanningError(
        `mission ${missionId} is ${state ?? "unrecorded"}; planning starts only from draft`,
      );
    }
    const open = this.#store.openSessionsForMission(missionId);
    if (open.length > 0) {
      throw new PlanningError(
        `mission ${missionId} already has open planning session ${(open[0] as PlanSessionRow).sessionId}`,
      );
    }
    const ordinal = this.#store.sessionsForMission(missionId).length + 1;
    return this.#store.createSession({
      sessionId: `plan-${missionId}-${ordinal}`,
      missionId,
      template,
      prdSha256: mission.contentSha256,
    });
  }

  // -------------------------------------------------------------------------
  // Streaming ingest (CAM-PLAN-01: visible as constructed)
  // -------------------------------------------------------------------------

  /**
   * Ingest one construction record. Validates structurally (shared total
   * validator) and cross-record (duplicates, segment references against
   * the mission's segmentation); forward references to not-yet-constructed
   * issues are allowed mid-stream and re-checked at completion and at the
   * gate. Each accepted record is durable and immediately visible in
   * planView — there is no buffering until "the plan is done".
   */
  ingest(sessionId: string, record: unknown): PlanStreamRecord {
    const state = this.#planState(sessionId);
    this.#assertSessionOpen(state);
    const problems = planConstructionRecordProblems(record);
    if (problems.length > 0) {
      throw new PlanningError(`construction record refused: ${problems.join("; ")}`);
    }
    const typed = record as PlanConstructionRecord;
    if (state.constructionComplete) {
      throw new PlanningError(
        "construction is complete; only review-attached records may follow (attachReview)",
      );
    }
    switch (typed.kind) {
      case "issue": {
        if (state.issues.some((i) => i.planIssueId === typed.issue.planIssueId)) {
          throw new PlanningError(`duplicate issue id ${typed.issue.planIssueId}`);
        }
        break;
      }
      case "clarification": {
        if (
          state.clarifications.some(
            (c) => c.clarificationId === typed.clarification.clarificationId,
          )
        ) {
          throw new PlanningError(
            `duplicate clarification id ${typed.clarification.clarificationId}`,
          );
        }
        const segmentIds = new Set(state.segments.map((s) => s.segmentId));
        for (const segmentId of typed.clarification.relatedSegmentIds) {
          if (!segmentIds.has(segmentId)) {
            throw new PlanningError(
              `clarification ${typed.clarification.clarificationId} references unknown segment ${segmentId}`,
            );
          }
        }
        break;
      }
      case "checklist-row": {
        const segmentIds = new Set(state.segments.map((s) => s.segmentId));
        if (!segmentIds.has(typed.row.segmentId)) {
          throw new PlanningError(
            `checklist row references unknown segment ${typed.row.segmentId}`,
          );
        }
        if (state.checklist.some((r) => r.segmentId === typed.row.segmentId)) {
          throw new PlanningError(`segment ${typed.row.segmentId} already has a checklist row`);
        }
        break;
      }
      case "construction-complete": {
        const completionProblems = [
          ...templateProblems(MISSION_TEMPLATES[state.session.template], state.issues),
          ...checklistProblems(state.segments, state.checklist, state.issues),
          ...clarificationReferenceProblems(state.clarifications, state.segments, state.issues),
          ...dependencyGraphProblems(state.issues),
        ];
        // A dependency CYCLE is deliberately not a completion problem: the
        // constructed plan reaches the approval screen where the gate
        // refuses with the cycle named (CAM-PLAN-11) — David sees it there.
        if (completionProblems.length > 0) {
          throw new PlanningError(
            `construction-complete refused; the plan is not coherent: ${completionProblems.join("; ")}`,
          );
        }
        break;
      }
    }
    const appended = this.#store.appendStream(sessionId, typed.kind, typed);
    if (typed.kind === "construction-complete") {
      this.#maybeRecordConstructed(this.#planState(sessionId));
    }
    return appended;
  }

  /**
   * Attach a falsification-review artifact (CAM-PLAN-03 slot; WP-111
   * supplies the real reviewer). Recording it may complete the draft →
   * planned transition when construction is already complete.
   */
  attachReview(sessionId: string, artifact: Record<string, unknown>): PlanStreamRecord {
    const state = this.#planState(sessionId);
    this.#assertSessionOpen(state);
    const problems = reviewArtifactProblems(artifact);
    if (problems.length > 0) {
      throw new PlanningError(`review artifact refused: ${problems.join("; ")}`);
    }
    const expectedClass = MISSION_TEMPLATES[state.session.template].reviewClass;
    if (artifact["reviewClass"] !== expectedClass) {
      throw new PlanningError(
        `review artifact class ${JSON.stringify(artifact["reviewClass"])} does not match the ` +
          `${state.session.template} template's required ${expectedClass}`,
      );
    }
    const appended = this.#store.appendStream(sessionId, "review-attached", artifact);
    this.#maybeRecordConstructed(this.#planState(sessionId));
    return appended;
  }

  /**
   * Record the A.1#2 (integration) or A.1b#2 (quick-task) transition once
   * BOTH construction completion and the review artifact exist and the
   * mission is still in draft. Idempotent by state check; re-run by
   * resumePendingWork after a crash between store write and event append.
   */
  #maybeRecordConstructed(state: PlanState): void {
    if (!state.constructionComplete || state.reviewArtifacts.length === 0) return;
    if (this.#recorder.currentState("mission", state.mission.id) !== "draft") return;
    if (state.session.template === "feature") {
      const outcome = this.#recorder.record({
        entityKind: "mission",
        entityId: state.mission.id,
        event: "plan-constructed",
        actor: PLANNER_ACTOR,
        cause: `plan session ${state.session.sessionId}: construction complete, review attached`,
        payload: { reviewAttached: true, checklistRendered: true },
      });
      if (!outcome.ok) {
        throw new PlanningError(`plan-constructed was refused: ${outcome.code}`);
      }
      return;
    }
    const artifact = state.reviewArtifacts.at(-1) as Record<string, unknown>;
    if (artifact["observabilityAdjudicated"] !== true) {
      // A.1b#2 requires observability adjudicated per criterion; without it
      // the mission stays draft and the view says why (WP-111 supplies it).
      return;
    }
    const outcome = this.#recorder.record({
      entityKind: "mission",
      entityId: state.mission.id,
      event: "contract-attached",
      actor: PLANNER_ACTOR,
      cause: `plan session ${state.session.sessionId}: quick-task contract + mini review attached`,
      payload: { miniReviewAttached: true, observabilityAdjudicated: true },
    });
    if (!outcome.ok) {
      throw new PlanningError(`contract-attached was refused: ${outcome.code}`);
    }
  }

  // -------------------------------------------------------------------------
  // David's acts
  // -------------------------------------------------------------------------

  /** Answer a clarifying question, or confirm its recorded assumption (CAM-PLAN-01). */
  acknowledgeClarification(
    sessionId: string,
    clarificationId: string,
    response: ClarificationResponse,
    actor: string = DAVID_ACTOR,
  ): void {
    const state = this.#planState(sessionId);
    this.#assertSessionOpen(state);
    const problems = clarificationResponseProblems(response);
    if (problems.length > 0) {
      throw new PlanningError(`acknowledgment refused: ${problems.join("; ")}`);
    }
    if (!state.clarifications.some((c) => c.clarificationId === clarificationId)) {
      throw new PlanningError(`clarification ${clarificationId} does not exist in ${sessionId}`);
    }
    if (this.#store.acknowledgments(sessionId).has(clarificationId)) {
      throw new PlanningError(
        `clarification ${clarificationId} is already acknowledged (acts are recorded once)`,
      );
    }
    this.#store.recordAcknowledgment(sessionId, clarificationId, response, actor);
  }

  /**
   * Confirm mapped checklist rows (CAM-PLAN-02). Each confirmation is
   * David's act: it durably records the row with its minted (or reused)
   * requirement id, then writes the propose + accept pair into the intent
   * ledger — the `accepted` entry the acceptance criterion names.
   */
  confirmMappedRows(
    sessionId: string,
    segmentIds: readonly string[],
    actor: string = DAVID_ACTOR,
  ): void {
    const state = this.#planState(sessionId);
    this.#assertSessionOpen(state);
    const confirmed = new Set(this.#store.confirmations(sessionId).map((c) => c.segmentId));
    for (const segmentId of segmentIds) {
      const row = state.checklist.find((r) => r.segmentId === segmentId);
      if (row === undefined) {
        throw new PlanningError(`segment ${segmentId} has no checklist row`);
      }
      if (row.disposition !== "mapped") {
        throw new PlanningError(
          `segment ${segmentId} is flagged unmapped; flagged rows are acknowledged, not confirmed`,
        );
      }
      if (confirmed.has(segmentId)) {
        throw new PlanningError(`segment ${segmentId} is already confirmed`);
      }
      const requirementId = this.#requirementIdFor(row.proposedArea, row.proposedStatement);
      this.#store.recordConfirmation(
        sessionId,
        { segmentId, requirementId, statement: row.proposedStatement },
        actor,
      );
      confirmed.add(segmentId);
      this.#writeLedgerEntries(requirementId, row.proposedStatement, state.mission.id);
    }
  }

  /**
   * Acknowledge the flagged (unmapped) rows. The act must name the CURRENT
   * unmapped set exactly — naming a stale or partial set refuses, so the
   * acknowledgment can never cover a flag David has not seen.
   */
  acknowledgeFlaggedRows(
    sessionId: string,
    segmentIds: readonly string[],
    actor: string = DAVID_ACTOR,
  ): void {
    const state = this.#planState(sessionId);
    this.#assertSessionOpen(state);
    const flagged = state.checklist
      .filter((r) => r.disposition === "unmapped")
      .map((r) => r.segmentId)
      .sort();
    const named = [...segmentIds].sort();
    if (JSON.stringify(named) !== JSON.stringify(flagged)) {
      throw new PlanningError(
        `flagged-rows acknowledgment must name the current unmapped set exactly ` +
          `[${flagged.join(", ")}], got [${named.join(", ")}]`,
      );
    }
    this.#store.recordFlagAcknowledgment(sessionId, flagged, actor);
  }

  /**
   * David rejects the plan: the session closes and the mission returns to
   * draft. ORDER MATTERS (r1 finding 4): the rejection ROW lands first —
   * it is the durable record of David's act — and the mission event
   * second; a crash between the two leaves a closed session that
   * resumePendingWork completes with the missing event. The reverse order
   * left a window where recovery re-recorded plan-constructed and
   * resurrected a rejected plan.
   */
  rejectPlan(sessionId: string, actor: string = DAVID_ACTOR): void {
    const state = this.#planState(sessionId);
    this.#assertSessionOpen(state);
    if (this.#recorder.currentState("mission", state.mission.id) !== "planned") {
      throw new PlanningError(`mission ${state.mission.id} is not in planned; nothing to reject`);
    }
    this.#store.recordRejection(sessionId, actor);
    this.#completeRejection(sessionId, state.mission.id, actor);
  }

  /** The mission-event half of a rejection; idempotent by state check. */
  #completeRejection(sessionId: string, missionId: string, actor: string): void {
    if (this.#recorder.currentState("mission", missionId) !== "planned") return;
    const outcome = this.#recorder.record({
      entityKind: "mission",
      entityId: missionId,
      event: "plan-rejected",
      actor,
      cause: `plan session ${sessionId} rejected`,
      payload: {},
    });
    if (!outcome.ok) {
      throw new PlanningError(`plan-rejected was refused: ${outcome.code}`);
    }
  }

  // -------------------------------------------------------------------------
  // Approval (the CAM-PLAN-01 gate) and the contract freeze (CAM-PLAN-04)
  // -------------------------------------------------------------------------

  /**
   * Decide approval and, on ok, run the freeze. Every refusal is returned
   * as data for the approval screen; nothing is thrown for a refusable
   * plan. Approval COMPLETES only when the freeze completes — a caller
   * that sees {ok: true} holds the frozen, hash-referenced contracts.
   */
  approvePlan(sessionId: string, actor: string = DAVID_ACTOR): ApprovePlanOutcome {
    const state = this.#planState(sessionId);
    this.#assertSessionOpen(state);
    if (this.#store.approval(sessionId) !== undefined) {
      throw new PlanningError(
        `session ${sessionId} already has a recorded approval; resumePendingWork completes it`,
      );
    }
    const decision = decidePlanApproval(this.#gateInput(state));
    if (!decision.ok) {
      return { ok: false, refusals: decision.refusals };
    }
    let facts: Parameters<SerializationScheduler["approvePlan"]>[2];
    if (state.session.template === "quick-task") {
      const artifact = state.reviewArtifacts.at(-1) ?? {};
      const missing = ["riskTierLow", "neutralConcurred"].filter(
        (field) => typeof artifact[field] !== "boolean",
      );
      if (missing.length > 0) {
        return {
          ok: false,
          refusals: [{ kind: "quick-task-review-facts-missing", missing }],
        };
      }
      facts = {
        riskTierLow: artifact["riskTierLow"] === true,
        neutralConcurred: artifact["neutralConcurred"] === true,
        singleIssue: state.issues.length === 1,
      };
    } else {
      facts = decision.attested;
    }
    this.#store.recordApproval(sessionId, actor);
    const contracts = this.#completeApproval(state, actor, facts);
    return { ok: true, contracts };
  }

  /**
   * The idempotent freeze: every step checks state before writing, so a
   * crash at any point is completed by re-running (resumePendingWork).
   * Order: ledger heal → contracts → mission plan-approved (scheduler
   * computes the slot fact) → issue-created per contract with its
   * ContractRef fields → completion marker.
   */
  #completeApproval(
    state: PlanState,
    actor: string,
    facts: Parameters<SerializationScheduler["approvePlan"]>[2],
  ): IssueContract[] {
    // Step 0 (r1 finding 3): approval never completes over confirmations
    // whose accepted ledger entries are missing — a confirmation whose
    // ledger pair an in-process failure interrupted is healed HERE, before
    // anything freezes, so "confirmed" and "accepted in the ledger" cannot
    // diverge past this point.
    for (const confirmation of this.#store.confirmations(state.session.sessionId)) {
      this.#writeLedgerEntries(
        confirmation.requirementId,
        confirmation.statement,
        state.mission.id,
      );
    }
    const contracts = this.#buildContracts(state, actor);
    for (const contract of contracts) {
      this.#store.insertContract(contract, state.session.sessionId);
    }
    const missionState = this.#recorder.currentState("mission", state.mission.id);
    if (missionState === "planned") {
      const outcome = this.#scheduler.approvePlan(state.mission.id, actor, facts);
      if (!outcome.ok) {
        throw new PlanningError(`plan-approved was refused: ${outcome.code}`);
      }
    } else if (
      missionState !== "approved" &&
      missionState !== "queued" &&
      missionState !== "executing"
    ) {
      throw new PlanningError(
        `mission ${state.mission.id} is ${missionState ?? "unrecorded"}; cannot complete approval`,
      );
    }
    for (const contract of contracts) {
      if (this.#recorder.currentState("issue", contract.issueId) !== undefined) {
        // A pre-existing issue is only the resume no-op if its creation
        // record carries THIS contract's reference — an issue created some
        // other way is refused, never blessed (r1 finding 5).
        const created = this.#events
          .read({ entityKind: "issue", entityId: contract.issueId })
          .find((r) => r.event === "issue-created" && r.outcome === "applied");
        const payload = created?.payload ?? {};
        if (
          payload["contractVersion"] !== contract.version ||
          payload["contractHash"] !== contract.contractHash
        ) {
          throw new PlanningError(
            `issue ${contract.issueId} already exists but its creation record does not ` +
              `reference contract ${contract.contractHash} v${contract.version} — refusing ` +
              "to complete approval over a foreign issue record",
          );
        }
        continue;
      }
      const outcome = this.#recorder.record({
        entityKind: "issue",
        entityId: contract.issueId,
        event: "issue-created",
        actor: PLANNER_ACTOR,
        cause:
          `plan approval froze contract ${contract.contractHash} v${contract.version} ` +
          `(session ${state.session.sessionId})`,
        payload: {
          origin: "plan-approval",
          unmetDependencies: contract.dependsOn.length,
          contractVersion: contract.version,
          contractHash: contract.contractHash,
        },
      });
      if (!outcome.ok) {
        throw new PlanningError(
          `issue-created for ${contract.issueId} was refused: ${outcome.code}`,
        );
      }
    }
    this.#store.recordApprovalCompletion(state.session.sessionId);
    return contracts;
  }

  /** Deterministic contract construction from the approved plan state. */
  #buildContracts(state: PlanState, approvedBy: string): IssueContract[] {
    const frozenAt = this.#now().toISOString();
    const requirementIdsByIssue = new Map<string, Set<string>>();
    const confirmations = this.#store.confirmations(state.session.sessionId);
    const confirmedBySegment = new Map(confirmations.map((c) => [c.segmentId, c]));
    for (const row of state.checklist) {
      if (row.disposition !== "mapped") continue;
      const confirmation = confirmedBySegment.get(row.segmentId);
      if (confirmation === undefined) continue; // unreachable post-gate; belt over braces
      for (const planIssueId of row.mappedPlanIssueIds) {
        const set = requirementIdsByIssue.get(planIssueId) ?? new Set<string>();
        set.add(confirmation.requirementId);
        requirementIdsByIssue.set(planIssueId, set);
      }
    }
    return state.issues.map((issue) => {
      const issueId = `${state.mission.id}.${issue.planIssueId}`;
      const terms: ContractTerms = {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        missionId: state.mission.id,
        issueId,
        version: 1,
        template: state.session.template,
        title: issue.title,
        goal: issue.goal,
        acceptanceCriteria: [...issue.acceptanceCriteria],
        requirementIds: [...(requirementIdsByIssue.get(issue.planIssueId) ?? [])].sort(),
        dependsOn: issue.dependsOn.map((dep) => `${state.mission.id}.${dep}`).sort(),
        interfaces: issue.interfaces.map((i) => ({ ...i })),
      };
      return { ...terms, contractHash: contractHash(terms), frozenAt, approvedBy };
    });
  }

  // -------------------------------------------------------------------------
  // Crash resume (the WP-104 posture: re-run idempotent steps)
  // -------------------------------------------------------------------------

  resumePendingWork(): ResumeReport {
    const report: ResumeReport = {
      completedApprovals: [],
      completedLedgerWrites: [],
      recordedConstructedTransitions: [],
      completedRejections: [],
    };
    // 1. Confirmations whose ledger pair a crash interrupted.
    const view = this.#ledger.currentView();
    for (const confirmation of this.#store.allConfirmations()) {
      const entry = view.get(confirmation.requirementId);
      if (entry !== undefined && entry.disposition !== "proposed") continue;
      const session = this.#store.session(confirmation.sessionId) as PlanSessionRow;
      this.#writeLedgerEntries(
        confirmation.requirementId,
        confirmation.statement,
        session.missionId,
      );
      report.completedLedgerWrites.push(confirmation.requirementId);
    }
    // 2. Rejection acts whose mission event a crash interrupted — completed
    // BEFORE the constructed-transition sweep, which already excludes
    // rejected sessions, so a rejected plan can never be resurrected
    // (r1 finding 4).
    for (const mission of this.#domain.listAllMissions()) {
      for (const sessionRow of this.#store.sessionsForMission(mission.id)) {
        const rejection = this.#store.rejection(sessionRow.sessionId);
        if (rejection === undefined) continue;
        if (this.#recorder.currentState("mission", mission.id) === "planned") {
          this.#completeRejection(sessionRow.sessionId, mission.id, rejection.actor);
          report.completedRejections.push(sessionRow.sessionId);
        }
      }
    }
    // 3. Constructed-but-unrecorded mission transitions.
    for (const sessionRow of this.#allOpenSessions()) {
      const state = this.#planState(sessionRow.sessionId);
      if (
        state.constructionComplete &&
        state.reviewArtifacts.length > 0 &&
        this.#recorder.currentState("mission", state.mission.id) === "draft"
      ) {
        this.#maybeRecordConstructed(state);
        report.recordedConstructedTransitions.push(sessionRow.sessionId);
      }
    }
    // 4. Approval acts whose freeze never completed. The gate is RE-RUN
    // over the durable state before anything is blessed (r1 finding 1): a
    // legitimately interrupted approval always re-passes (its inputs are
    // durable and the gate is deterministic), so a recorded approval the
    // gate now refuses means the store's rows are not the rows that
    // approval was granted over — refused loudly, never adopted.
    for (const sessionRow of this.#store.pendingApprovalSessions()) {
      const state = this.#planState(sessionRow.sessionId);
      const approval = this.#store.approval(sessionRow.sessionId) as { actor: string };
      const decision = decidePlanApproval(this.#gateInput(state));
      if (!decision.ok) {
        throw new PlanningError(
          `session ${sessionRow.sessionId} has a recorded approval the gate refuses ` +
            `(${decision.refusals.map((r) => r.kind).join(", ")}) — refusing to complete ` +
            "an approval the durable state does not support",
        );
      }
      const facts = this.#resumeFacts(state, decision.attested);
      this.#completeApproval(state, approval.actor, facts);
      report.completedApprovals.push(sessionRow.sessionId);
    }
    return report;
  }

  /** Rebuild the approval facts for a resume run (the gate re-passed above). */
  #resumeFacts(
    state: PlanState,
    attested: GateAttestedFacts,
  ): Parameters<SerializationScheduler["approvePlan"]>[2] {
    if (state.session.template === "quick-task") {
      const artifact = state.reviewArtifacts.at(-1) ?? {};
      const missing = ["riskTierLow", "neutralConcurred"].filter(
        (field) => typeof artifact[field] !== "boolean",
      );
      if (missing.length > 0) {
        throw new PlanningError(
          `session ${state.session.sessionId} has a recorded approval but its review ` +
            `artifact lacks ${missing.join(", ")} — refusing to complete`,
        );
      }
      return {
        riskTierLow: artifact["riskTierLow"] === true,
        neutralConcurred: artifact["neutralConcurred"] === true,
        singleIssue: state.issues.length === 1,
      };
    }
    return attested;
  }

  #allOpenSessions(): PlanSessionRow[] {
    const missions = this.#domain.listAllMissions();
    const out: PlanSessionRow[] = [];
    for (const mission of missions) {
      out.push(...this.#store.openSessionsForMission(mission.id));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  planView(sessionId: string): PlanView {
    const state = this.#planState(sessionId);
    const acknowledgments = this.#store.acknowledgments(sessionId);
    const confirmations = new Map(
      this.#store.confirmations(sessionId).map((c) => [c.segmentId, c]),
    );
    const segmentText = new Map(state.segments.map((s) => [s.segmentId, s.text]));
    const flagged = state.checklist
      .filter((r) => r.disposition === "unmapped")
      .map((r) => r.segmentId)
      .sort();
    const status = this.#status(state);
    return {
      sessionId,
      missionId: state.mission.id,
      template: state.session.template,
      status,
      segments: state.segments,
      issues: state.issues,
      clarifications: state.clarifications.map((c) => ({
        ...c,
        acknowledgment: acknowledgments.get(c.clarificationId) ?? null,
      })),
      checklist: state.checklist.map((row): ChecklistRowView => {
        const text = segmentText.get(row.segmentId) ?? "";
        if (row.disposition === "mapped") {
          const confirmation = confirmations.get(row.segmentId);
          return {
            segmentId: row.segmentId,
            segmentText: text,
            disposition: "mapped",
            proposedStatement: row.proposedStatement,
            proposedArea: row.proposedArea,
            mappedPlanIssueIds: row.mappedPlanIssueIds,
            ...(row.note !== undefined ? { note: row.note } : {}),
            confirmed: confirmation !== undefined,
            requirementId: confirmation?.requirementId ?? null,
          };
        }
        return {
          segmentId: row.segmentId,
          segmentText: text,
          disposition: "unmapped",
          flagged: true,
          reason: row.reason,
          ...(row.note !== undefined ? { note: row.note } : {}),
        };
      }),
      flaggedSegmentIds: flagged,
      reviewAttached: state.reviewArtifacts.length > 0,
      approvalPreview: decidePlanApproval(this.#gateInput(state)),
    };
  }

  /** What the planner runner writes into the worker's workspace inputs. */
  sessionBrief(sessionId: string): {
    missionId: string;
    missionTitle: string;
    template: MissionTemplateName;
    content: string;
    segments: readonly PrdSegment[];
  } {
    const state = this.#planState(sessionId);
    return {
      missionId: state.mission.id,
      missionTitle: state.mission.title,
      template: state.session.template,
      content: state.mission.content,
      segments: state.segments,
    };
  }

  /**
   * The declared interfaces of an issue's dependencies — what WP-113
   * renders into the dependent's context pack (CAM-PLAN-11 "declared
   * interfaces … visible to dependents' context packs").
   *
   * The DEPENDENT side is version-pinned: pass the contract version the
   * attempt executes (WP-113 binds packs to the attempt's contract) or
   * omit it for the latest. Each dependency resolves to ITS latest
   * contract by design — which dependency version an in-flight dependent
   * should see after an edit is WP-112's change-control decision
   * (conservative default: revalidate), so this query reports the current
   * truth with each dependency's own (version, hash) identity attached
   * for the pack to cite (r1 finding 12).
   */
  dependencyInterfacesFor(issueId: string, contractVersion?: number): DependencyInterfaceView[] {
    const contract =
      contractVersion === undefined
        ? this.#store.latestContract(issueId)
        : this.#store.contract(issueId, contractVersion);
    if (contract === undefined) {
      throw new PlanningError(
        contractVersion === undefined
          ? `issue ${issueId} has no contract`
          : `issue ${issueId} has no contract v${contractVersion}`,
      );
    }
    return contract.dependsOn.map((depId) => {
      const dep = this.#store.latestContract(depId);
      if (dep === undefined) {
        throw new PlanningError(`dependency ${depId} of ${issueId} has no contract`);
      }
      return {
        issueId: dep.issueId,
        title: dep.title,
        contractVersion: dep.version,
        contractHash: dep.contractHash,
        interfaces: dep.interfaces,
      };
    });
  }

  /** Store accessors WP-108/112/114 consume via the service seam. */
  contractByHash(hash: string): IssueContract | undefined {
    return this.#store.contractByHash(hash);
  }

  contractsForMission(missionId: string): IssueContract[] {
    return this.#store.contractsForMission(missionId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #planState(sessionId: string): PlanState {
    const session = this.#store.session(sessionId);
    if (session === undefined) {
      throw new PlanningError(`plan session ${sessionId} does not exist`);
    }
    const mission = this.#domain.getMission(session.missionId);
    if (mission === undefined) {
      throw new PlanningError(`mission ${session.missionId} vanished from the domain store`);
    }
    if (mission.contentSha256 !== session.prdSha256) {
      throw new PlanningError(
        `mission ${mission.id} content hash ${mission.contentSha256} no longer matches the ` +
          `session's pinned ${session.prdSha256} — refusing to plan over changed content`,
      );
    }
    const issues: PlannedIssueDraft[] = [];
    const clarifications: ClarifyingItemDraft[] = [];
    const checklist: ChecklistRowDraft[] = [];
    const reviewArtifacts: Array<Record<string, unknown>> = [];
    let constructionComplete = false;
    for (const record of this.#store.streamRecords(sessionId)) {
      switch (record.kind) {
        case "issue":
          issues.push((record.payload as unknown as { issue: PlannedIssueDraft }).issue);
          break;
        case "clarification":
          clarifications.push(
            (record.payload as unknown as { clarification: ClarifyingItemDraft }).clarification,
          );
          break;
        case "checklist-row":
          checklist.push((record.payload as unknown as { row: ChecklistRowDraft }).row);
          break;
        case "construction-complete":
          constructionComplete = true;
          break;
        case "review-attached":
          reviewArtifacts.push(record.payload);
          break;
      }
    }
    return {
      session,
      mission,
      segments: segmentPrd(mission.content),
      issues,
      clarifications,
      checklist,
      constructionComplete,
      reviewArtifacts,
    };
  }

  #status(state: PlanState): PlanView["status"] {
    if (this.#store.rejection(state.session.sessionId) !== undefined) return "rejected";
    if (this.#store.approvalCompletion(state.session.sessionId) !== undefined) return "approved";
    return state.constructionComplete ? "constructed" : "constructing";
  }

  #assertSessionOpen(state: PlanState): void {
    const sessionId = state.session.sessionId;
    if (this.#store.rejection(sessionId) !== undefined) {
      throw new PlanningError(`plan session ${sessionId} was rejected; start a new session`);
    }
    if (this.#store.approvalCompletion(sessionId) !== undefined) {
      throw new PlanningError(`plan session ${sessionId} is approved and frozen`);
    }
  }

  #gateInput(state: PlanState): PlanGateInput {
    const acknowledgments = this.#store.acknowledgments(state.session.sessionId);
    const confirmations = this.#store.confirmations(state.session.sessionId);
    const latestFlags = this.#store.latestFlagAcknowledgment(state.session.sessionId);
    return {
      template: MISSION_TEMPLATES[state.session.template],
      segments: state.segments,
      issues: state.issues,
      clarifications: state.clarifications,
      checklist: state.checklist,
      constructionComplete: state.constructionComplete,
      reviewAttached: state.reviewArtifacts.length > 0,
      acknowledgedClarificationIds: new Set(acknowledgments.keys()),
      confirmedMappedSegmentIds: new Set(confirmations.map((c) => c.segmentId)),
      flaggedRowsAcknowledged: latestFlags === null ? null : new Set(latestFlags.segmentIds),
    };
  }

  /**
   * Mint (or reuse) the requirement id for a confirmed row. Reuse: an
   * existing ledger entry in the accepted family with the IDENTICAL
   * statement — a re-planned mission re-confirming intent David already
   * accepted. Otherwise: next free CAM-<AREA>-NN across the ledger and
   * this store; the two-digit grammar bounds an area at 99 ids, refused
   * with a stated reason rather than overflowed.
   */
  #requirementIdFor(area: string, statement: string): string {
    if (!isRequirementArea(area)) {
      throw new PlanningError(`proposed area ${JSON.stringify(area)} is not a valid AREA token`);
    }
    const view = this.#ledger.currentView();
    for (const entry of view.values()) {
      if (entry.statement !== statement) continue;
      if (!(ACCEPTED_FAMILY as readonly string[]).includes(entry.disposition)) continue;
      // The whole accepted family reuses — `assumed` included (r1 finding
      // 11): a signed-off assumption IS accepted intent, and minting a
      // sibling id would duplicate it. A cross-AREA statement match is
      // REFUSED rather than silently reused or duplicated: David decides
      // whether to re-confirm under the existing area or revise the
      // statement — either way an active choice, never an aliased id.
      const existingArea = parseRequirementId(entry.requirementId).area;
      if (existingArea !== area) {
        throw new PlanningError(
          `statement already exists in the ledger as ${entry.requirementId} ` +
            `(area ${existingArea}, disposition ${entry.disposition}); confirm this row under ` +
            `area ${existingArea} or revise the statement — refusing to alias intent across areas`,
        );
      }
      return entry.requirementId;
    }
    const used = new Set<number>();
    for (const requirementId of view.keys()) {
      const parsed = parseRequirementId(requirementId);
      if (parsed.area === area) used.add(parsed.number);
    }
    for (const confirmation of this.#store.allConfirmations()) {
      const parsed = parseRequirementId(confirmation.requirementId);
      if (parsed.area === area) used.add(parsed.number);
    }
    let number = 1;
    while (used.has(number)) number += 1;
    if (number > 99) {
      throw new PlanningError(
        `area ${area} has exhausted its 99 requirement ids (two-digit grammar); ` +
          "confirm this row under a different area",
      );
    }
    return formatRequirementId({ area, number, suffix: undefined });
  }

  /**
   * The propose + accept pair one confirmation act writes (CAM-PLAN-02).
   * Idempotent for resume: skips whatever the ledger already holds. A
   * requirement id holding a DIFFERENT statement is refused, never
   * silently rebound.
   */
  #writeLedgerEntries(requirementId: string, statement: string, missionId: string): void {
    const entry = this.#ledger.entry(requirementId);
    if (entry === undefined) {
      this.#ledger.proposeRequirement(requirementId, {
        statement,
        sourceMissionId: missionId,
      });
      this.#ledger.acceptRequirement(requirementId);
      return;
    }
    if (entry.statement !== statement) {
      throw new PlanningError(
        `requirement ${requirementId} already holds a different statement in the ledger; ` +
          "refusing to rebind it",
      );
    }
    if (entry.disposition === "proposed") {
      this.#ledger.acceptRequirement(requirementId);
    }
    // accepted / resolved-accepted: nothing to write (resume no-op).
  }
}
