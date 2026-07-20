/**
 * File-backed fake external test service + catch-all effect target
 * (WP-104). Same crash-consistency contract as the fake GitHub: atomic
 * state commits, ground-truth ledgers the harness asserts against.
 *
 * The test service models the two §4.4 sub-behaviors in one place:
 *
 *  - Environment mutations land in `environments[id].mutations`, and
 *    `resetEnvironment` WIPES that list — reset-before-use makes the
 *    environment the idempotency unit, so "zero duplicates" for a
 *    resettable mutation means the final environment contains exactly one
 *    application, however many executions crashed along the way.
 *  - Irreversible effects additionally land in the `outbox`, which reset
 *    deliberately does NOT touch — a sent email stays sent. The outbox is
 *    the oracle proving an unconfirmed irreversible intent was never
 *    auto-retried (its per-key count can never exceed 1 without a human
 *    retry-authorized decision).
 */
import { IndeterminateOutcomeError } from "@camino/shared";
import type {
  CatchAllMutationTransport,
  CatchAllSpec,
  OperationResult,
  TestServiceMutationSpec,
  TestServiceMutationTransport,
} from "@camino/shared";
import { loadJsonState, saveJsonState } from "./json-state.js";

export interface FakeTestServiceState {
  environments: Record<string, { mutations: string[] }>;
  /** Irreversible effects — reset never clears these. */
  outbox: Array<{ environmentId: string; mutation: string }>;
  resetCalls: number;
  mutationCalls: number;
}

export interface FakeServiceOptions {
  readonly hook?: (point: string) => void;
  readonly loseResponses?: "before-effect" | "after-effect";
}

export class FakeTestService implements TestServiceMutationTransport {
  private readonly path: string;
  private readonly hook: (point: string) => void;
  private readonly loseResponses: "before-effect" | "after-effect" | undefined;

  constructor(statePath: string, options: FakeServiceOptions = {}) {
    this.path = statePath;
    this.hook = options.hook ?? (() => {});
    this.loseResponses = options.loseResponses;
  }

  state(): FakeTestServiceState {
    return loadJsonState(this.path, () => ({
      environments: {},
      outbox: [],
      resetCalls: 0,
      mutationCalls: 0,
    }));
  }

  /** How many times a mutation string is present in the environment now. */
  environmentCount(environmentId: string, mutation: string): number {
    return (this.state().environments[environmentId]?.mutations ?? []).filter((m) => m === mutation)
      .length;
  }

  /** How many irreversible applications of a mutation ever happened. */
  outboxCount(environmentId: string, mutation: string): number {
    return this.state().outbox.filter(
      (o) => o.environmentId === environmentId && o.mutation === mutation,
    ).length;
  }

  resetEnvironment(environmentId: string): void {
    const state = this.state();
    state.resetCalls += 1;
    state.environments[environmentId] = { mutations: [] };
    saveJsonState(this.path, state);
  }

  mutate(spec: TestServiceMutationSpec): OperationResult {
    const state = this.state();
    state.mutationCalls += 1;
    if (this.loseResponses === "before-effect") {
      saveJsonState(this.path, state);
      throw new IndeterminateOutcomeError("connection lost before the mutation was applied");
    }
    const environment = (state.environments[spec.environmentId] ??= { mutations: [] });
    environment.mutations.push(spec.mutation);
    if (spec.irreversible) {
      state.outbox.push({ environmentId: spec.environmentId, mutation: spec.mutation });
    }
    this.hook("in-transport-before-effect");
    saveJsonState(this.path, state);
    this.hook("in-transport-after-effect");
    if (this.loseResponses === "after-effect") {
      throw new IndeterminateOutcomeError("connection lost after the mutation was applied");
    }
    return { environmentId: spec.environmentId, applied: spec.mutation };
  }
}

export interface FakeCatchAllState {
  effects: string[];
  calls: number;
}

export class FakeCatchAll implements CatchAllMutationTransport {
  private readonly path: string;
  private readonly hook: (point: string) => void;
  private readonly loseResponses: "before-effect" | "after-effect" | undefined;

  constructor(statePath: string, options: FakeServiceOptions = {}) {
    this.path = statePath;
    this.hook = options.hook ?? (() => {});
    this.loseResponses = options.loseResponses;
  }

  state(): FakeCatchAllState {
    return loadJsonState(this.path, () => ({ effects: [], calls: 0 }));
  }

  effectCount(description: string): number {
    return this.state().effects.filter((e) => e === description).length;
  }

  perform(spec: CatchAllSpec): OperationResult {
    const state = this.state();
    state.calls += 1;
    if (this.loseResponses === "before-effect") {
      saveJsonState(this.path, state);
      throw new IndeterminateOutcomeError("connection lost before the effect was applied");
    }
    state.effects.push(spec.description);
    this.hook("in-transport-before-effect");
    saveJsonState(this.path, state);
    this.hook("in-transport-after-effect");
    if (this.loseResponses === "after-effect") {
      throw new IndeterminateOutcomeError("connection lost after the effect was applied");
    }
    return { performed: spec.description };
  }
}
