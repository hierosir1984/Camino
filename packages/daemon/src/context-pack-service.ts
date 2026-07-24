/**
 * Context-pack service (WP-113, CAM-EXEC-07 + the WP-110 amendment): the
 * daemon-side composer that gathers a pack's inputs from the three
 * authoritative stores and hands them to @camino/core's PURE assembler.
 *
 * The composition rule IS the security property: every value below comes
 * from the plan store (the contract + dependency interfaces, via the
 * planning service seam), the intent ledger + canon facts (excerpts and
 * status projected for the attempt's branch context), or the knowledge
 * store (visibility-filtered per CAM-CANON-09). There is no repo path, no
 * doc folder, no fetch anywhere in this pipeline — a worker's pack cannot
 * contain anything the control plane did not assemble (workers never
 * wander the docs folder).
 *
 * Untrusted attachments (issue/repo/web text a later WP chooses to hand a
 * worker) enter ONLY through the request's `untrusted` list and land in
 * the pack as fenced `untrusted`-class data blocks.
 */
import { closeSync, constants as fsConstants, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CanonFactRecord, IssueContract, ContractRef, StatusContext } from "@camino/shared";
import { contractRefProblems } from "@camino/shared";
import type {
  AssembledContextPack,
  LedgerView,
  UntrustedAttachment,
  VisibleKnowledgeEntry,
  CanonExcerpt,
  KnowledgeReader,
  PackDependencyInterface,
} from "@camino/core";
import {
  assembleContextPack,
  canonFragment,
  projectRequirementStatus,
  renderStatusLine,
} from "@camino/core";

/** The pack's filename inside an attempt workspace (WP-114 materializes it). */
export const CONTEXT_PACK_FILENAME = "camino-context-pack.md";

/**
 * The narrow store seams the service composes from. Production wires the
 * real PlanningService, CanonLedgerStore, CanonFactsStore, and
 * KnowledgeStore; the seams are structural so fixtures can pin single
 * behaviors without replaying the whole planning pipeline.
 */
export interface PackPlanSource {
  contractByHash(hash: string): IssueContract | undefined;
  dependencyInterfacesFor(issueId: string, contractVersion?: number): PackDependencyInterface[];
}

export interface PackCanonSource {
  readonly lastSeq: number;
  currentView(): LedgerView;
}

export interface PackFactsSource {
  read(): CanonFactRecord[];
}

export interface PackKnowledgeSource {
  visibleFor(reader: KnowledgeReader, nowIso: string): VisibleKnowledgeEntry[];
}

export interface ContextPackServiceOptions {
  readonly planning: PackPlanSource;
  readonly canonLedger: PackCanonSource;
  readonly canonFacts: PackFactsSource;
  readonly knowledge: PackKnowledgeSource;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

export interface AssemblePackRequest {
  /** The attempt's contract reference (CAM-PLAN-04: attempts carry the hash). */
  readonly contractRef: ContractRef;
  /** The worker's branch context (canon status lines project against it). */
  readonly statusContext: StatusContext;
  /** Raw untrusted texts a caller explicitly hands the worker as data. */
  readonly untrusted?: readonly UntrustedAttachment[];
}

export class ContextPackService {
  readonly #planning: PackPlanSource;
  readonly #canonLedger: PackCanonSource;
  readonly #canonFacts: PackFactsSource;
  readonly #knowledge: PackKnowledgeSource;
  readonly #now: () => Date;

  constructor(options: ContextPackServiceOptions) {
    this.#planning = options.planning;
    this.#canonLedger = options.canonLedger;
    this.#canonFacts = options.canonFacts;
    this.#knowledge = options.knowledge;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Assemble the pack for one attempt. Throws on any inconsistency between
   * the request and the stores (a wrong ref, a foreign candidate, a
   * requirement the ledger does not know) — a pack is never silently
   * assembled around a broken premise.
   */
  assemble(rawRequest: AssemblePackRequest): AssembledContextPack {
    // Observe the request ONCE (r2 finding 10): the core assembler snapshots
    // its own input, but this service reads request fields at several points
    // (ref validation, contract lookup, status projection, and the assembler
    // call). A stateful getter could project status against one branch and
    // render it against another. Snapshotting to plain data here closes that
    // — every read below is from the getter-free snapshot.
    let request: AssemblePackRequest;
    try {
      request = JSON.parse(JSON.stringify(rawRequest)) as AssemblePackRequest;
    } catch (error) {
      throw new Error(`context pack request is not plain data: ${(error as Error).message}`);
    }
    const refIssues = contractRefProblems(request.contractRef);
    if (refIssues.length > 0) {
      throw new Error(`invalid contract ref: ${refIssues.join("; ")}`);
    }
    const contract = this.#planning.contractByHash(request.contractRef.contractHash);
    if (contract === undefined) {
      throw new Error(
        `no contract with hash ${request.contractRef.contractHash} — refusing to assemble`,
      );
    }
    if (
      contract.issueId !== request.contractRef.issueId ||
      contract.version !== request.contractRef.contractVersion
    ) {
      throw new Error(
        `contract ref names ${request.contractRef.issueId} v${request.contractRef.contractVersion} ` +
          `but hash ${request.contractRef.contractHash} resolves to ${contract.issueId} ` +
          `v${contract.version} — refusing a mismatched reference`,
      );
    }

    // The WP-110 amendment surface: the dependency interfaces for exactly
    // this contract version, with each dependency's own contract identity.
    const dependencyInterfaces = this.#planning.dependencyInterfacesFor(
      contract.issueId,
      contract.version,
    );

    // Canon excerpts + status for the branch context (CAM-EXEC-07).
    const ledgerView = this.#canonLedger.currentView();
    const facts = this.#canonFacts.read();
    const canonExcerpts: CanonExcerpt[] = contract.requirementIds.map((requirementId) => {
      const entry = ledgerView.get(requirementId);
      if (entry === undefined) {
        throw new Error(
          `contract ${contract.issueId} v${contract.version} cites requirement ${requirementId} ` +
            "which the intent ledger does not know (CAM-CANON-01: the ledger defines what exists)",
        );
      }
      const fragment = canonFragment(entry);
      const tuple = projectRequirementStatus(
        entry,
        facts.filter((fact) => fact.requirementId === requirementId),
        request.statusContext,
      );
      return {
        requirementId,
        statement:
          fragment !== ""
            ? fragment.trimEnd()
            : `(no accepted canon text — disposition ${entry.disposition})`,
        statusLine: renderStatusLine(requirementId, tuple, request.statusContext),
      };
    });

    // Knowledge per the CAM-CANON-09 visibility rules: the reader is this
    // attempt's issue; the store returns approved entries plus same-issue
    // candidates, provenance-marked. The assembler re-checks the
    // cross-mission boundary on top.
    const nowIso = this.#now().toISOString();
    const reader: KnowledgeReader = { missionId: contract.missionId, issueId: contract.issueId };
    const visible = this.#knowledge.visibleFor(reader, nowIso);

    return assembleContextPack({
      contract,
      dependencyInterfaces,
      statusContext: request.statusContext,
      canonExcerpts,
      ledgerSeq: this.#canonLedger.lastSeq,
      approvedKnowledge: visible.filter((entry) => entry.visibility === "approved"),
      candidateKnowledge: visible.filter((entry) => entry.visibility === "same-issue-candidate"),
      untrusted: request.untrusted ?? [],
      assembledAt: nowIso,
    });
  }
}

/**
 * Materialize a pack into an attempt workspace (the dispatch layer's one
 * write). The pack file is the worker's ONLY briefing input; everything
 * else in the workspace is repo content — untrusted data by posture.
 *
 * The workspace is an untrusted repo clone, so the final path component is
 * an attack surface: a repo that ships `camino-context-pack.md` as a SYMLINK
 * would, under a naive write, redirect the write through the link and
 * truncate/overwrite an accessible host file (r1 finding 1). The write
 * therefore opens with O_NOFOLLOW | O_CREAT | O_TRUNC | O_WRONLY — if the
 * final component is a symlink the open fails (ELOOP) rather than following
 * it. BOUNDARY, stated: this closes the FINAL-component vector; a symlinked
 * PARENT directory is the container's concern (WP-107 gives the worker an
 * isolated clone with no host filesystem), the same layering the assembler
 * header names.
 */
export function materializeContextPack(workdir: string, pack: AssembledContextPack): string {
  const path = join(workdir, CONTEXT_PACK_FILENAME);
  const fd = openSync(
    path,
    fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, pack.text);
  } finally {
    closeSync(fd);
  }
  return path;
}
