/**
 * Chaos scripts (WP-104): the seeded, deterministic workloads the
 * kill-point suite drives through a real child process.
 *
 * A script is (1) parent-side world seeding on the file-backed fakes,
 * (2) the ordered intents the child submits and executes. Specs are pure
 * fixed data — same ids, same SHAs every run — so a named kill point
 * lands in exactly the same protocol gap every time (CAM-STATE-06:
 * deterministic, seeded).
 *
 * One script per §4.4 operation class, plus `mixed`, which interleaves a
 * recorder-driven mission event with intents from three classes to prove
 * the whole daemon state (event log + intent journal) resumes together.
 */
import type { ExternalOperationSpec } from "@camino/shared";
import type { TransitionRecorder } from "../transition-recorder.js";
import type { FakeGitHub } from "./fake-github.js";
import type { FakeCatchAll, FakeTestService } from "./fake-services.js";

export const REPO = "fixture-repo";
export const BASE_SHA = "b".repeat(40);
export const FEATURE_SHA = "f".repeat(40);
export const MERGE_SHA = "e".repeat(40);
export const OTHER_SHA = "d".repeat(40);

/** Where the fakes persist inside a chaos world dir (child + parent share it). */
export const FAKE_STATE_FILES = {
  github: "github.json",
  testService: "test-service.json",
  catchAll: "catch-all.json",
} as const;

export interface ChaosFakes {
  readonly github: FakeGitHub;
  readonly testService: FakeTestService;
  readonly catchAll: FakeCatchAll;
}

export interface ChaosIntent {
  readonly intentId: string;
  readonly spec: ExternalOperationSpec;
}

export interface ChaosScript {
  readonly name: string;
  /** Parent-side world preparation (runs before the child spawns). */
  seed(fakes: ChaosFakes): void;
  /** Child-side recorder activity before the intents (mixed script only). */
  recorderSetup?(recorder: TransitionRecorder): void;
  readonly intents: readonly ChaosIntent[];
}

function seedBaseRepo(fakes: ChaosFakes): void {
  fakes.github.seedCommit(REPO, BASE_SHA);
  fakes.github.seedCommit(REPO, FEATURE_SHA, [BASE_SHA]);
  fakes.github.seedCommit(REPO, MERGE_SHA, [BASE_SHA, FEATURE_SHA]);
  fakes.github.seedRef(REPO, "main", BASE_SHA);
}

const branchCreate: ChaosScript = {
  name: "branch-create",
  seed: seedBaseRepo,
  intents: [
    {
      intentId: "intent-branch-1",
      spec: { op: "branch-create", repo: REPO, branch: "camino/issue-1", targetSha: BASE_SHA },
    },
  ],
};

const push: ChaosScript = {
  name: "push",
  seed(fakes) {
    seedBaseRepo(fakes);
    fakes.github.seedRef(REPO, "camino/issue-1", BASE_SHA);
  },
  intents: [
    {
      intentId: "intent-push-1",
      spec: {
        op: "push",
        repo: REPO,
        ref: "camino/issue-1",
        intendedSha: FEATURE_SHA,
        expectedBaseSha: BASE_SHA,
      },
    },
  ],
};

export const PR_MARKER = "camino-intent:intent-pr-1";

const prCreate: ChaosScript = {
  name: "pr-create",
  seed(fakes) {
    seedBaseRepo(fakes);
    fakes.github.seedRef(REPO, "camino/issue-1", FEATURE_SHA);
  },
  intents: [
    {
      intentId: "intent-pr-1",
      spec: {
        op: "pr-create",
        repo: REPO,
        headBranch: "camino/issue-1",
        baseBranch: "main",
        title: "Issue 1",
        bodyMarker: PR_MARKER,
        body: `Implements issue 1.\n\n<!-- ${PR_MARKER} -->`,
      },
    },
  ],
};

const mergeByPush: ChaosScript = {
  name: "merge-by-push",
  seed: seedBaseRepo,
  intents: [
    {
      intentId: "intent-merge-1",
      spec: {
        op: "merge-by-push",
        repo: REPO,
        targetRef: "main",
        mergeSha: MERGE_SHA,
        expectedBaseSha: BASE_SHA,
      },
    },
  ],
};

const labelSet: ChaosScript = {
  name: "label-set",
  seed: seedBaseRepo,
  intents: [
    {
      intentId: "intent-label-1",
      spec: {
        op: "label-set",
        repo: REPO,
        targetKind: "issue",
        targetNumber: 7,
        label: "camino:executing",
        desired: "present",
      },
    },
  ],
};

export const COMMENT_MARKER = "camino-intent:intent-comment-1";

const commentPost: ChaosScript = {
  name: "comment-post",
  seed: seedBaseRepo,
  intents: [
    {
      intentId: "intent-comment-1",
      spec: {
        op: "comment-post",
        repo: REPO,
        targetKind: "issue",
        targetNumber: 7,
        body: `Attempt started.\n\n<!-- ${COMMENT_MARKER} -->`,
        marker: COMMENT_MARKER,
      },
    },
  ],
};

const workflowDispatch: ChaosScript = {
  name: "workflow-dispatch",
  seed: seedBaseRepo,
  intents: [
    {
      intentId: "intent-dispatch-1",
      spec: {
        op: "workflow-dispatch",
        repo: REPO,
        workflow: "validation.yml",
        ref: "main",
        correlationId: "intent-dispatch-1",
      },
    },
  ],
};

const testResettable: ChaosScript = {
  name: "test-service-resettable",
  seed: () => {},
  intents: [
    {
      intentId: "intent-test-1",
      spec: {
        op: "test-service-mutation",
        environmentId: "env-alpha",
        mutation: "seed-database",
        irreversible: false,
      },
    },
  ],
};

const testIrreversible: ChaosScript = {
  name: "test-service-irreversible",
  seed: () => {},
  intents: [
    {
      intentId: "intent-test-2",
      spec: {
        op: "test-service-mutation",
        environmentId: "env-alpha",
        mutation: "send-verification-email",
        irreversible: true,
      },
    },
  ],
};

const catchAll: ChaosScript = {
  name: "catch-all",
  seed: () => {},
  intents: [
    {
      intentId: "intent-misc-1",
      spec: { op: "catch-all", description: "rotate the fixture tenant token" },
    },
  ],
};

/**
 * Mixed workload: a recorder-driven mission event plus three intent
 * classes — the "daemon resumes cleanly" composite (CAM-STATE-06). The
 * mission intake row proves the event log and the intent journal recover
 * together from the same kill.
 */
const mixed: ChaosScript = {
  name: "mixed",
  seed(fakes) {
    seedBaseRepo(fakes);
    fakes.github.seedRef(REPO, "camino/issue-1", BASE_SHA);
  },
  recorderSetup(recorder) {
    const outcome = recorder.record({
      entityKind: "mission",
      entityId: "mission-chaos",
      event: "mission-created",
      actor: "david",
      cause: "chaos: mixed script mission intake",
      payload: { source: "prd-intake" },
    });
    if (!outcome.ok) {
      throw new Error(`mixed script mission intake refused: ${outcome.code}`);
    }
  },
  intents: [
    {
      intentId: "intent-mixed-branch",
      spec: { op: "branch-create", repo: REPO, branch: "camino/issue-2", targetSha: BASE_SHA },
    },
    {
      intentId: "intent-mixed-push",
      spec: {
        op: "push",
        repo: REPO,
        ref: "camino/issue-1",
        intendedSha: FEATURE_SHA,
        expectedBaseSha: BASE_SHA,
      },
    },
    {
      intentId: "intent-mixed-test",
      spec: {
        op: "test-service-mutation",
        environmentId: "env-mixed",
        mutation: "seed-database",
        irreversible: false,
      },
    },
  ],
};

export const CHAOS_SCRIPTS: Readonly<Record<string, ChaosScript>> = {
  [branchCreate.name]: branchCreate,
  [push.name]: push,
  [prCreate.name]: prCreate,
  [mergeByPush.name]: mergeByPush,
  [labelSet.name]: labelSet,
  [commentPost.name]: commentPost,
  [workflowDispatch.name]: workflowDispatch,
  [testResettable.name]: testResettable,
  [testIrreversible.name]: testIrreversible,
  [catchAll.name]: catchAll,
  [mixed.name]: mixed,
};
