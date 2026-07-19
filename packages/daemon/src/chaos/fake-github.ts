/**
 * File-backed fake GitHub (WP-104): the external side of every GitHub
 * operation class, crash-consistent so the kill-point suite can murder
 * the daemon process mid-protocol and still ask the "external system"
 * what really happened.
 *
 * Three roles in one object:
 *
 *  1. MUTATION transport (GitHubMutationTransport) — behaves like the
 *     real API at the level the §4.4 contract cares about: branch create
 *     refuses a name collision at a different SHA but is a no-op at the
 *     intended one; push refuses non-fast-forward; one open PR per
 *     (head, base); comments duplicate freely (the embedded marker is
 *     detection, not prevention); dispatch materializes a run whose
 *     run-name carries `camino_intent_id=<correlation>`.
 *  2. QUERY transport (GitHubQueryTransport) — the read-only surface
 *     recovery reconciles from.
 *  3. GROUND TRUTH for the harness — `effectLedger` records every applied
 *     effect under its natural key, and `mutationCalls`/`queryCalls`
 *     count surface usage, so tests can assert "zero duplicate external
 *     side effects" and "reconciliation performed zero mutations" from
 *     the fake's own books rather than from what the daemon believes.
 *
 * Ref names are plain strings ("main", "camino/issue-7") with no
 * refs/heads/ prefixing — real ref syntax belongs to the real transports
 * (WP-114/119/120). Commits must be seeded before refs can point at them
 * (seedCommit), which keeps ancestry queries honest.
 *
 * The `hook` fires INSIDE every mutation, immediately before and after
 * the atomic state commit ("in-transport-before-effect" /
 * "in-transport-after-effect") — the two halves of the lost-response
 * window the chaos suite kills in.
 */
import {
  DefinitiveRefusalError,
  IndeterminateOutcomeError,
  correlationToken,
  intentMarkerToken,
} from "@camino/shared";
import type {
  BranchCreateSpec,
  CommentPostSpec,
  GitHubMutationTransport,
  GitHubQueryTransport,
  LabelSetSpec,
  MergeByPushSpec,
  ObservedPullRequest,
  ObservedRef,
  ObservedWorkflowRun,
  OperationResult,
  OperationTargetKind,
  PrCreateSpec,
  PushSpec,
  WorkflowDispatchSpec,
} from "@camino/shared";
import { loadJsonState, saveJsonState } from "./json-state.js";

export interface FakePullRequest {
  number: number;
  headBranch: string;
  baseBranch: string;
  state: "open" | "closed";
  title: string;
  body: string;
}

interface FakeRepoState {
  /** ref name → sha (must be a seeded commit). */
  refs: Record<string, string>;
  /** sha → parent shas (ancestry for isAtOrPast). */
  commits: Record<string, string[]>;
  pulls: FakePullRequest[];
  /** `${kind}#${number}` → labels present. */
  labels: Record<string, string[]>;
  comments: Array<{
    commentId: number;
    targetKind: OperationTargetKind;
    targetNumber: number;
    body: string;
  }>;
  workflowRuns: Array<{ runId: number; runName: string; workflow: string; ref: string }>;
}

export interface FakeGitHubState {
  repos: Record<string, FakeRepoState>;
  /** Every APPLIED effect under its natural key — the zero-duplicates oracle. */
  effectLedger: Array<{ op: string; key: string }>;
  mutationCalls: number;
  queryCalls: number;
  nextPullNumber: number;
  nextCommentId: number;
  nextRunId: number;
}

function emptyRepo(): FakeRepoState {
  return { refs: {}, commits: {}, pulls: [], labels: {}, comments: [], workflowRuns: [] };
}

function emptyState(): FakeGitHubState {
  return {
    repos: {},
    effectLedger: [],
    mutationCalls: 0,
    queryCalls: 0,
    nextPullNumber: 1,
    nextCommentId: 1,
    nextRunId: 1,
  };
}

export interface FakeGitHubOptions {
  /** Chaos seam: fires around the atomic state commit inside every mutation. */
  readonly hook?: (point: string) => void;
  /**
   * When set, every mutation throws IndeterminateOutcomeError AFTER
   * committing (or not committing) per the listed behavior — the
   * lost-response-while-alive path.
   */
  readonly loseResponses?: "before-effect" | "after-effect";
}

export class FakeGitHub implements GitHubMutationTransport, GitHubQueryTransport {
  private readonly path: string;
  private readonly hook: (point: string) => void;
  private readonly loseResponses: "before-effect" | "after-effect" | undefined;

  constructor(statePath: string, options: FakeGitHubOptions = {}) {
    this.path = statePath;
    this.hook = options.hook ?? (() => {});
    this.loseResponses = options.loseResponses;
  }

  // ---------------------------------------------------------------- state

  state(): FakeGitHubState {
    return loadJsonState(this.path, emptyState);
  }

  /** Applied-effect counts grouped by natural key (assertion helper). */
  effectCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const effect of this.state().effectLedger) {
      counts.set(effect.key, (counts.get(effect.key) ?? 0) + 1);
    }
    return counts;
  }

  private save(state: FakeGitHubState): void {
    saveJsonState(this.path, state);
  }

  private repo(state: FakeGitHubState, repo: string): FakeRepoState {
    state.repos[repo] ??= emptyRepo();
    return state.repos[repo];
  }

  /**
   * The shared mutation shape: load, count the call, run `apply` (which
   * either mutates and returns the applied-effect entry, or returns null
   * for an idempotent no-op, or throws a clean refusal), then commit
   * atomically with the chaos hook on both sides.
   */
  private mutate(
    apply: (state: FakeGitHubState) => { op: string; key: string } | null,
    result: () => OperationResult,
  ): OperationResult {
    const state = this.state();
    state.mutationCalls += 1;
    if (this.loseResponses === "before-effect") {
      // The request never reached the external system: commit only the
      // call counter, then report the outcome unknown.
      this.save(state);
      throw new IndeterminateOutcomeError("connection lost before the request was applied");
    }
    let applied: { op: string; key: string } | null;
    try {
      applied = apply(state);
    } catch (refusal) {
      // Clean refusal: persist ONLY the call counter — never a partially
      // applied mutation — then let the executor record the failure.
      const fresh = this.state();
      fresh.mutationCalls += 1;
      this.save(fresh);
      throw refusal;
    }
    if (applied !== null) {
      state.effectLedger.push(applied);
    }
    this.hook("in-transport-before-effect");
    this.save(state);
    this.hook("in-transport-after-effect");
    if (this.loseResponses === "after-effect") {
      throw new IndeterminateOutcomeError("connection lost after the request was applied");
    }
    return result();
  }

  // ------------------------------------------------------ mutation surface

  createBranch(spec: BranchCreateSpec): OperationResult {
    return this.mutate(
      (state) => {
        const repo = this.repo(state, spec.repo);
        const existing = repo.refs[spec.branch];
        if (existing !== undefined) {
          if (existing === spec.targetSha) return null; // idempotent: already as intended
          throw new DefinitiveRefusalError(
            `branch ${spec.branch} already exists at ${existing} (wanted ${spec.targetSha})`,
          );
        }
        if (repo.commits[spec.targetSha] === undefined) {
          throw new DefinitiveRefusalError(
            `target commit ${spec.targetSha} does not exist in ${spec.repo}`,
          );
        }
        repo.refs[spec.branch] = spec.targetSha;
        return { op: "branch-create", key: `branch:${spec.repo}:${spec.branch}` };
      },
      () => ({ branch: spec.branch, sha: spec.targetSha }),
    );
  }

  push(spec: PushSpec): OperationResult {
    return this.mutate(
      (state) => {
        const repo = this.repo(state, spec.repo);
        const current = repo.refs[spec.ref];
        if (current === spec.intendedSha) return null; // idempotent: already there
        if (current !== spec.expectedBaseSha) {
          throw new DefinitiveRefusalError(
            `non-fast-forward: ${spec.ref} is at ${current ?? "(absent)"}, expected base ${spec.expectedBaseSha}`,
          );
        }
        if (repo.commits[spec.intendedSha] === undefined) {
          throw new DefinitiveRefusalError(
            `intended commit ${spec.intendedSha} does not exist in ${spec.repo}`,
          );
        }
        repo.refs[spec.ref] = spec.intendedSha;
        return { op: "push", key: `push:${spec.repo}:${spec.ref}:${spec.intendedSha}` };
      },
      () => ({ ref: spec.ref, sha: spec.intendedSha }),
    );
  }

  createPullRequest(spec: PrCreateSpec): OperationResult {
    let allocated: number | null = null;
    return this.mutate(
      (state) => {
        const repo = this.repo(state, spec.repo);
        const openSame = repo.pulls.find(
          (pr) =>
            pr.state === "open" &&
            pr.headBranch === spec.headBranch &&
            pr.baseBranch === spec.baseBranch,
        );
        if (openSame !== undefined) {
          throw new DefinitiveRefusalError(
            `a pull request for ${spec.headBranch} into ${spec.baseBranch} already exists (#${openSame.number})`,
          );
        }
        allocated = state.nextPullNumber;
        state.nextPullNumber += 1;
        repo.pulls.push({
          number: allocated,
          headBranch: spec.headBranch,
          baseBranch: spec.baseBranch,
          state: "open",
          title: spec.title,
          body: spec.body,
        });
        return { op: "pr-create", key: `pr:${spec.repo}:${spec.headBranch}:${spec.baseBranch}` };
      },
      () => ({ prNumber: allocated ?? -1 }),
    );
  }

  mergeByPush(spec: MergeByPushSpec): OperationResult {
    return this.mutate(
      (state) => {
        const repo = this.repo(state, spec.repo);
        if (this.shaAtOrPast(repo, repo.refs[spec.targetRef], spec.mergeSha)) {
          return null; // idempotent by ref state
        }
        const current = repo.refs[spec.targetRef];
        if (current !== spec.expectedBaseSha) {
          throw new DefinitiveRefusalError(
            `non-fast-forward: ${spec.targetRef} is at ${current ?? "(absent)"}, expected base ${spec.expectedBaseSha}`,
          );
        }
        if (repo.commits[spec.mergeSha] === undefined) {
          throw new DefinitiveRefusalError(
            `merge commit ${spec.mergeSha} does not exist in ${spec.repo}`,
          );
        }
        repo.refs[spec.targetRef] = spec.mergeSha;
        return {
          op: "merge-by-push",
          key: `merge:${spec.repo}:${spec.targetRef}:${spec.mergeSha}`,
        };
      },
      () => ({ targetRef: spec.targetRef, mergeSha: spec.mergeSha }),
    );
  }

  setLabel(spec: LabelSetSpec): OperationResult {
    return this.mutate(
      (state) => {
        const repo = this.repo(state, spec.repo);
        const key = `${spec.targetKind}#${spec.targetNumber}`;
        repo.labels[key] ??= [];
        const present = repo.labels[key].includes(spec.label);
        const wantPresent = spec.desired === "present";
        if (present === wantPresent) return null; // naturally idempotent
        if (wantPresent) {
          repo.labels[key].push(spec.label);
        } else {
          repo.labels[key] = repo.labels[key].filter((l) => l !== spec.label);
        }
        return {
          op: "label-set",
          key: `label:${spec.repo}:${key}:${spec.label}:${spec.desired}`,
        };
      },
      () => ({ label: spec.label, desired: spec.desired }),
    );
  }

  postComment(spec: CommentPostSpec): OperationResult {
    let allocated: number | null = null;
    return this.mutate(
      (state) => {
        const repo = this.repo(state, spec.repo);
        // Real comment APIs happily duplicate — the embedded marker makes
        // duplicates DETECTABLE, and the ledger key makes them visible to
        // the harness.
        allocated = state.nextCommentId;
        state.nextCommentId += 1;
        repo.comments.push({
          commentId: allocated,
          targetKind: spec.targetKind,
          targetNumber: spec.targetNumber,
          body: spec.body,
        });
        return {
          op: "comment-post",
          key: `comment:${spec.repo}:${spec.targetKind}#${spec.targetNumber}:${spec.marker}`,
        };
      },
      () => ({ commentId: allocated ?? -1 }),
    );
  }

  dispatchWorkflow(spec: WorkflowDispatchSpec): OperationResult {
    return this.mutate(
      (state) => {
        const repo = this.repo(state, spec.repo);
        const runId = state.nextRunId;
        state.nextRunId += 1;
        repo.workflowRuns.push({
          runId,
          // Correlation for observability: the delimited token rides the run-name.
          runName: `${spec.workflow} ${correlationToken(spec.correlationId)}`,
          workflow: spec.workflow,
          ref: spec.ref,
        });
        return { op: "workflow-dispatch", key: `dispatch:${spec.repo}:${spec.correlationId}` };
      },
      () => ({ dispatched: true }),
    );
  }

  // -------------------------------------------------------- query surface

  private query<T>(answer: (state: FakeGitHubState) => T): T {
    const state = this.state();
    state.queryCalls += 1;
    this.save(state);
    return answer(state);
  }

  getRef(repo: string, ref: string): string | null {
    return this.query((state) => state.repos[repo]?.refs[ref] ?? null);
  }

  observeRef(repo: string, ref: string, ancestorSha: string): ObservedRef {
    // ONE state load answers both questions — the observation can never
    // contradict itself across a concurrent ref move (round-1 finding 4).
    return this.query((state) => {
      const repoState = state.repos[repo];
      const refSha = repoState?.refs[ref] ?? null;
      return {
        refSha,
        atOrPastAncestor:
          repoState !== undefined && this.shaAtOrPast(repoState, refSha ?? undefined, ancestorSha),
      };
    });
  }

  findPullRequestsByHead(repo: string, headBranch: string): readonly ObservedPullRequest[] {
    return this.query((state) =>
      (state.repos[repo]?.pulls ?? [])
        .filter((pr) => pr.headBranch === headBranch)
        .map((pr) => ({
          number: pr.number,
          state: pr.state,
          headBranch: pr.headBranch,
          baseBranch: pr.baseBranch,
          body: pr.body,
        })),
    );
  }

  isLabelPresent(
    repo: string,
    targetKind: OperationTargetKind,
    targetNumber: number,
    label: string,
  ): boolean {
    return this.query(
      (state) =>
        state.repos[repo]?.labels[`${targetKind}#${targetNumber}`]?.includes(label) ?? false,
    );
  }

  findCommentByMarker(
    repo: string,
    targetKind: OperationTargetKind,
    targetNumber: number,
    marker: string,
  ): { readonly commentId: number } | null {
    return this.query((state) => {
      const token = intentMarkerToken(marker);
      const found = (state.repos[repo]?.comments ?? []).find(
        (c) =>
          c.targetKind === targetKind && c.targetNumber === targetNumber && c.body.includes(token),
      );
      return found === undefined ? null : { commentId: found.commentId };
    });
  }

  findWorkflowRunsByCorrelation(
    repo: string,
    correlationId: string,
  ): readonly ObservedWorkflowRun[] {
    return this.query((state) =>
      (state.repos[repo]?.workflowRuns ?? [])
        .filter((run) => run.runName.includes(correlationToken(correlationId)))
        .map((run) => ({ runId: run.runId, runName: run.runName })),
    );
  }

  // -------------------------------------------- seeding (test-side world)

  /** Seed a commit node (parents default to none). Not counted as a mutation. */
  seedCommit(repo: string, sha: string, parents: string[] = []): void {
    const state = this.state();
    this.repo(state, repo).commits[sha] = parents;
    this.save(state);
  }

  /** Point a ref at a seeded commit. Not counted as a mutation. */
  seedRef(repo: string, ref: string, sha: string): void {
    const state = this.state();
    this.repo(state, repo).refs[ref] = sha;
    this.save(state);
  }

  /** Seed a pull request (the closed/reused-branch scenarios). */
  seedPullRequest(
    repo: string,
    pull: Omit<FakePullRequest, "number"> & { number?: number },
  ): number {
    const state = this.state();
    const number = pull.number ?? state.nextPullNumber;
    state.nextPullNumber = Math.max(state.nextPullNumber, number + 1);
    this.repo(state, repo).pulls.push({ ...pull, number });
    this.save(state);
    return number;
  }

  /** An out-of-band actor moves a ref (no counters — this is not Camino acting). */
  moveRefOutOfBand(repo: string, ref: string, sha: string): void {
    const state = this.state();
    const repoState = this.repo(state, repo);
    repoState.commits[sha] ??= [];
    repoState.refs[ref] = sha;
    this.save(state);
  }

  /** An out-of-band actor edits a PR body (the mutable-body scenario). */
  setPullRequestBodyOutOfBand(repo: string, number: number, body: string): void {
    const state = this.state();
    const pull = this.repo(state, repo).pulls.find((pr) => pr.number === number);
    if (pull === undefined) throw new Error(`no PR #${number} in ${repo}`);
    pull.body = body;
    this.save(state);
  }

  // ------------------------------------------------------------- internals

  private shaAtOrPast(
    repo: FakeRepoState,
    refSha: string | undefined,
    ancestorSha: string,
  ): boolean {
    if (refSha === undefined) return false;
    const queue = [refSha];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const sha = queue.shift()!;
      if (sha === ancestorSha) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      queue.push(...(repo.commits[sha] ?? []));
    }
    return false;
  }
}
