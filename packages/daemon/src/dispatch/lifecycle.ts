// WP-105: the shared dispatch lifecycle (CAM-EXEC-06) — product promotion of
// the WP-001 spike. One tested lifecycle drives every adapter: spawn (detached
// → own process group), line-by-line stream parsing, cancellation with
// kill-confirm (SIGTERM → grace → SIGKILL → group-gone), post-exit group
// sweep, centralized outcome classification, and lease release sequenced
// strictly after the GROUP is confirmed gone (PRD §5 registry item 4).
//
// Containment boundary (round-1 review finding 1; scope widened per round-2
// finding 2): "gone" is the worker's process GROUP. A descendant that changes
// its own process group — setpgid(0,0) (same session) OR setsid (new session)
// — escapes both the group signal and the group-liveness probe. Complete
// process-tree containment is WP-107's container (PID namespace / cgroup),
// where the whole worker tree is killable as a unit regardless of group. This
// layer owns the group-scoped ordering guarantee and says so. The PRD's
// "process-tree-gone" (registry item 4, CAM-EXEC-06) is scoped per AMEND-10
// (approved 2026-07-20, PR #50): this layer delivers group-gone; WP-107's
// container completes full-tree containment.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  AdapterContext,
  AdapterSpec,
  AttemptBudget,
  BudgetBreachRecord,
  DispatchRecord,
  KillConfirmRecord,
  LeaseDisposition,
  LeaseHandle,
  DispatchOutcome,
  EnvPostureRecord,
  StreamEvent,
} from "@camino/shared";
import { OFFICIAL_ADAPTER_NAMES } from "@camino/shared";
import type { OfficialAdapterName } from "@camino/shared";
import { composeWorkerEnv } from "./env.js";
import { hasRegistryProvenance } from "./registry.js";

/** Kill-confirm timings. Production defaults (PRD §5 registry item 4): 30s grace. */
export interface KillConfirmTimings {
  graceMs: number;
  sigkillWaitMs: number;
}
// Frozen (round-9 finding 2): a mutable exported production-timing object let
// a package-root importer set graceMs/sigkillWaitMs to 0/NaN and break
// kill-confirm + the drain cap. Caller-supplied timings still go through
// clampMs; drainCapMs additionally guards non-finite values.
export const PRODUCTION_KILL_CONFIRM: KillConfirmTimings = Object.freeze({
  graceMs: 30_000,
  sigkillWaitMs: 5_000,
});

/**
 * Dispatching a disabled adapter is a policy violation, not an outcome
 * (CAM-EXEC-01: a failed sanctioned-path check means installable but never
 * dispatched). The lifecycle refuses with this typed error BEFORE calling
 * plan(), so no caller can forget to check.
 */
export class DisabledAdapterError extends Error {
  readonly adapter: string;
  readonly disabledReason: string;
  constructor(adapter: string, disabledReason: string | undefined) {
    const reason = disabledReason ?? "no reason recorded";
    super(`adapter "${adapter}" is disabled and cannot be dispatched: ${reason}`);
    this.name = "DisabledAdapterError";
    this.adapter = adapter;
    this.disabledReason = reason;
  }
}

export interface DispatchOptions {
  /**
   * External cancellation (the product path): aborting requests the
   * kill-confirm sequence. A signal already aborted at dispatch time means
   * nothing is spawned at all; an abort during the plan()/spawn window is
   * honored the instant the child exists (round-1 review finding 3).
   */
  signal?: AbortSignal;
  /**
   * Cancel this long after the first parsed event — a conformance/evidence
   * harness affordance (deterministic mid-run cancel); product callers use
   * `signal`.
   */
  cancelAfterFirstEventMs?: number;
  /** Hard cap so a real dispatch can never run away. Classified `killed`, never `cancelled`. */
  timeoutMs?: number;
  /**
   * Per-attempt budget (CAM-EXEC-03, WP-107): wall-clock ALWAYS enforced;
   * tokens enforced where the vendor stream reports usage
   * (StreamEvent.tokensTotal). A breach runs kill-confirm and classifies
   * `killed-budget` — distinct from `cancelled` (user decision) and `killed`
   * (harness runaway cap) so the state machine's kill-and-escalate row
   * (A.2#10/A.3#5) fires on exactly the budget case, never an auto-retry.
   * Classification stays HERE, centralized, per the WP-105 principle.
   */
  budget?: AttemptBudget;
  killConfirm?: KillConfirmTimings;
  /** Sink for live transcript lines (raw). Guarded: a throwing sink cannot crash the dispatch. */
  onLine?: (channel: "stdout" | "stderr", line: string) => void;
  /**
   * Attempt lease seam (PRD §5 registry item 4). Released at most once, only
   * after the process GROUP is confirmed gone; deliberately HELD (recorded in
   * the DispatchRecord) when the group cannot be confirmed gone; always
   * settled even if the dispatch body throws.
   */
  lease?: LeaseHandle;
}

/** Is ANY process in group `pgid` still alive? (leader OR any descendant in the group) */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    // ESRCH = gone; EPERM = exists but not ours (still alive, conservative).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Bound how many parsed events are retained so a noisy/misbehaving worker
// cannot grow harness memory (WP-001 review #4): keep the first HEAD + last
// TAIL, plus a total count. The head/tail window preserves both the opening
// context and the trailing result run that finalText needs.
const EVENT_HEAD_CAP = 200;
const EVENT_TAIL_CAP = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait up to `ms` for the whole group to disappear, polling. */
async function waitGroupGone(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return true;
    await sleep(20);
  }
  return !groupAlive(pgid);
}

/**
 * Kill-confirm sequence (CAM-EXEC-06, PRD §5 registry item 4):
 * SIGTERM to the process GROUP → give the WHOLE GROUP up to `graceMs` to exit
 * → SIGKILL iff any member is still alive → verify the group is gone.
 * Waiting on the GROUP (not just the leader) means a cooperative descendant
 * gets the full grace window, while a stubborn one still forces SIGKILL — and
 * a leader that exits on SIGTERM while a descendant ignores it cannot orphan
 * (the WP-001 review's finding #1). Group scope, not full tree: a descendant
 * that changes its process group (setpgid/setsid) is WP-107's container's
 * problem (round-1 finding 1, round-2 finding 2).
 */
export async function killConfirm(
  child: ChildProcess,
  timings: KillConfirmTimings,
): Promise<KillConfirmRecord> {
  const started = Date.now();
  const pid = child.pid;
  if (pid == null) {
    return { requested: true, escalatedToSigkill: false, groupGone: true, elapsedMs: 0 };
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* group may already be gone */
  }
  await waitGroupGone(pid, timings.graceMs); // full grace for the whole group
  let escalated = false;
  if (groupAlive(pid)) {
    escalated = true;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* ignore */
    }
    await waitGroupGone(pid, timings.sigkillWaitMs);
  }
  return {
    requested: true,
    escalatedToSigkill: escalated,
    groupGone: !groupAlive(pid),
    elapsedMs: Date.now() - started,
  };
}

function assembleFinalText(events: readonly StreamEvent[]): string {
  // Prefer a single complete result message (codex agent_message, claude
  // result). Otherwise reassemble the trailing run of assistant/result
  // fragments in order (token-streaming CLIs like grok).
  const lastResult = [...events]
    .reverse()
    .find((e) => e.kind === "result" && e.text.trim().length > 0);
  if (lastResult) return lastResult.text.slice(0, 400);
  const trailing: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "assistant" || e.kind === "result") trailing.push(e.text);
    else if (trailing.length > 0) break;
  }
  return trailing.reverse().join("").slice(0, 400);
}

/**
 * Is the worker process GROUP confirmed gone, from the dispatch's own records?
 * Pure — exported so the held-lease branch is unit-testable (a genuinely
 * unkillable process cannot be manufactured in CI). The natural-exit path
 * with neither record present is confirmed-by-check: the lifecycle probes the
 * group after the leader exits and populates `postExitCleanup` whenever any
 * member survived, so "no record" means the probe found the group empty.
 *
 * Group scope, not full tree (round-1 finding 1, widened round-2 finding 2): a
 * descendant that changed its process group (setpgid/setsid) is invisible to
 * the group probe. This function is honest about what it can confirm — the
 * group — and WP-107's container closes the residual.
 */
export function processGroupConfirmedGone(rec: {
  spawned: boolean;
  killConfirm?: KillConfirmRecord;
  postExitCleanup?: KillConfirmRecord;
}): boolean {
  if (!rec.spawned) return true; // no process ever existed
  if (rec.killConfirm && !rec.killConfirm.groupGone) return false;
  if (rec.postExitCleanup && !rec.postExitCleanup.groupGone) return false;
  return true;
}

/**
 * Convert an unknown thrown value to a short string WITHOUT ever throwing —
 * a hostile error whose `toString`/`Symbol.toPrimitive` throws must not turn
 * error handling into a new crash (round-2 review findings 3, 4).
 */
function safeStringify(value: unknown): string {
  try {
    return String(value).slice(0, 400);
  } catch {
    try {
      return Object.prototype.toString.call(value).slice(0, 400);
    } catch {
      return "[unstringifiable value]";
    }
  }
}

/**
 * Kill-confirm that NEVER throws (round-2 review finding 1): on the error path
 * a sweep that itself throws must not be mistaken for "group gone". A throw
 * becomes a recorded groupGone:false so the lease is held fail-closed.
 */
async function sweepGroupSafe(
  child: ChildProcess,
  timings: KillConfirmTimings,
): Promise<KillConfirmRecord> {
  try {
    return await killConfirm(child, timings);
  } catch {
    return { requested: true, escalatedToSigkill: false, groupGone: false, elapsedMs: 0 };
  }
}

/**
 * Release the lease iff the group is confirmed gone; otherwise hold, recorded.
 * NEVER throws — a broken lease store or a hostile release error must not turn
 * settlement into a crash that re-enters settlement (round-2 findings 3, 4).
 */
async function settleLease(
  lease: LeaseHandle,
  groupGone: boolean,
  outcome: DispatchOutcome,
): Promise<LeaseDisposition> {
  if (!groupGone) return { released: false, heldReason: "process-group-unconfirmed" };
  try {
    await lease.release({ groupGone: true, outcome });
    return { released: true };
  } catch (err) {
    // The release call itself failed — the underlying lease state is unknown,
    // so the dispatch cannot claim it released. Recorded, never thrown: a
    // broken lease store must not corrupt the dispatch record.
    return {
      released: false,
      heldReason: "release-threw",
      releaseError: safeStringify(err),
    };
  }
}

/** Safely read adapter.name without ever throwing on a hostile getter (round-3 finding 1). */
function safeAdapterName(adapter: AdapterSpec): string {
  try {
    return String(adapter.name).slice(0, 200);
  } catch {
    return "unknown-adapter";
  }
}

/** Coerce a duration option to a finite non-negative number, else the fallback (round-4 finding 1). */
function clampMs(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Posture baseline used before env composition runs (or if it can't). */
const EMPTY_POSTURE: EnvPostureRecord = {
  keys: [],
  githubCredentialKeys: [],
  gitGlobalNeutralized: false,
  strippedKeys: [],
  credentialRootKeys: [],
};

/** Build a terminal record for a dispatch that never produced a running child. */
function noProcessRecord(
  adapterName: string,
  outcome: DispatchOutcome,
  posture: EnvPostureRecord,
  startedMs: number,
  extra: Partial<DispatchRecord> = {},
): DispatchRecord {
  return {
    adapter: adapterName,
    outcome,
    spawned: false,
    streamedEvents: 0,
    finalText: "",
    committedSha: null,
    envPosture: posture,
    exitCode: null,
    durationMs: Date.now() - startedMs,
    events: [],
    quotaSignalSeen: false,
    ...extra,
  };
}

/**
 * Drive one headless dispatch through an adapter: compose a clean env, spawn
 * the CLI detached (own process group), parse both streams line-by-line into
 * normalized events, and either let it finish or cancel/timeout it with
 * kill-confirm. Outcome is classified centrally; the lease (when provided) is
 * settled LAST — after the group-gone determination — and always settled on
 * every terminal path (normal return and the catch), at most once. Neither
 * settlement nor the finally can throw, so a dispatch always returns a record.
 */
export async function dispatch(
  adapter: AdapterSpec,
  ctx: AdapterContext,
  opts: DispatchOptions = {},
): Promise<DispatchRecord> {
  const started = Date.now();
  const adapterName = safeAdapterName(adapter);

  // Read the lease ONCE up front (safely) so even the disabled-refusal path can
  // settle it — a supplied lease is never stranded on any terminal path,
  // including the DisabledAdapterError throw (round-5 finding 1).
  let lease: LeaseHandle | undefined;
  try {
    lease = opts.lease;
  } catch {
    lease = undefined;
  }

  // Enablement is read fail-closed: a hostile/broken `enabled` getter is
  // treated as disabled, so the ONLY throw dispatch ever propagates is
  // DisabledAdapterError (round-3/4 finding 1). Everything else returns a record.
  let enabled = false;
  try {
    enabled = adapter.enabled === true;
  } catch {
    enabled = false;
  }
  if (!enabled) {
    // A supplied lease is released before refusing (nothing ran → group
    // trivially gone), so the disabled path never strands it (round-5 finding 1).
    if (lease) {
      try {
        await lease.release({ groupGone: true, outcome: "requirement-failed" });
      } catch {
        /* a broken lease store must not mask the refusal */
      }
    }
    let reason: string;
    try {
      reason = safeStringify(adapter.disabledReason);
    } catch {
      reason = "disabled reason unavailable";
    }
    throw new DisabledAdapterError(adapterName, reason);
  }

  // CAM-EXEC-01 registry provenance (round-6 finding 1): an ENABLED spec
  // bearing an official adapter name must be the exact object buildRegistry()
  // gated — a first-party caller that constructs (or spreads/copies) an
  // official spec without the sanctioned-path gate is refused with the same
  // typed error class, lease settled first. (See hasRegistryProvenance for the
  // named boundary: this defeats accidental gate bypass, not in-process
  // forgery — that isolation is WP-107's container.)
  const officialCli: OfficialAdapterName | undefined = (
    OFFICIAL_ADAPTER_NAMES as readonly string[]
  ).includes(adapterName)
    ? (adapterName as OfficialAdapterName)
    : undefined;
  if (officialCli && !hasRegistryProvenance(adapter)) {
    if (lease) {
      try {
        await lease.release({ groupGone: true, outcome: "requirement-failed" });
      } catch {
        /* a broken lease store must not mask the refusal */
      }
    }
    throw new DisabledAdapterError(
      adapterName,
      "official adapter spec lacks registry provenance — obtain adapters from buildRegistry() (CAM-EXEC-01 sanctioned-path gate)",
    );
  }

  // TOTAL EXCEPTION SAFETY (rounds 3–5 finding 1). dispatch's object inputs —
  // adapter, opts, signal, lease, timings — are first-party Camino code; the
  // UNTRUSTED surface is the worker's output STREAM (strings), handled totally
  // below. To ensure a buggy caller/adapter (a throwing/mutating getter on a
  // config field) can never terminate the daemon or strand a lease: EVERY
  // option is read EXACTLY ONCE into a local (a getter that returns a good
  // value then a toxic one cannot reach an async callback), and time values are
  // snapshotted as validated PLAIN NUMBERS so no async callback re-reads a
  // getter (which the lexical try could not catch) and a broken value cannot
  // stall kill-confirm.
  let signal: AbortSignal | undefined;
  let timings: KillConfirmTimings = PRODUCTION_KILL_CONFIRM;
  let cancelAfterMs: number | undefined;
  let timeoutMs: number | undefined;
  let onLine: DispatchOptions["onLine"];
  let posture: EnvPostureRecord = EMPTY_POSTURE;

  // Settle the lease AT MOST ONCE across every path (round-2 review finding 4):
  // a single guarded closure so no error path can re-enter release().
  let leaseSettled = false;
  const settleFor = async (record: DispatchRecord): Promise<void> => {
    if (!lease || leaseSettled) return;
    leaseSettled = true;
    record.lease = await settleLease(lease, processGroupConfirmedGone(record), record.outcome);
  };

  // State the whole body shares.
  let child: ChildProcess | undefined;
  let exited = false;
  let killReason: "cancel" | "timeout" | "budget" | null = null;
  let killRecord: KillConfirmRecord | undefined;
  let killPromise: Promise<void> | null = null;
  let cancelTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let budgetTimer: NodeJS.Timeout | undefined;
  // Set exactly once, by whichever budget check trips first; consulted only
  // when killReason === "budget" (evidence for the escalation record).
  let budgetBreach: BudgetBreachRecord | undefined;
  // Abort may fire during the plan()/spawn window, before a child exists
  // (round-1 review finding 3): remember it and apply it the instant we can.
  let pendingCancel = false;

  const requestKill = (reason: "cancel" | "timeout" | "budget") => {
    if (killReason) return;
    if (!child || exited) {
      // No live child yet (or already exited): remember a cancel so the
      // post-spawn check applies it; a timeout/budget kill with no child is
      // moot (a budget breach with no live process has nothing to kill; the
      // classification below still fires off budgetBreach if it was set
      // before natural exit — see the outcome ordering note there).
      if (reason === "cancel") pendingCancel = true;
      return;
    }
    killReason = reason;
    const c = child;
    // sweepGroupSafe (not killConfirm) so a broken timings value can only yield
    // a groupGone:false record, never a late unhandled rejection (round-3
    // finding 1). timings is plain validated numbers, so escalation to SIGKILL
    // always proceeds (round-4 finding 1). killPromise therefore never rejects.
    killPromise = sweepGroupSafe(c, timings).then((k) => {
      killRecord = k;
    });
  };
  const onAbort = () => requestKill("cancel");

  try {
    // Snapshot every remaining option EXACTLY ONCE into a local (lease was read
    // up front). Each getter is read a single time; time values become
    // validated plain numbers.
    signal = opts.signal;
    const km = opts.killConfirm; // one read
    timings = {
      graceMs: clampMs(km?.graceMs, PRODUCTION_KILL_CONFIRM.graceMs),
      sigkillWaitMs: clampMs(km?.sigkillWaitMs, PRODUCTION_KILL_CONFIRM.sigkillWaitMs),
    };
    const rawCancel = opts.cancelAfterFirstEventMs; // one read (round-5 finding 1)
    cancelAfterMs = typeof rawCancel === "number" ? rawCancel : undefined;
    const rawTimeout = opts.timeoutMs; // one read
    timeoutMs = typeof rawTimeout === "number" ? rawTimeout : undefined;
    // Budget snapshot (one read each, validated plain numbers — same
    // discipline as every other option). Fail-closed coercion: a budget
    // object whose wallClockMs is corrupt clamps to 0 (immediate breach),
    // never to "unenforced" — wall-clock is ALWAYS enforced when a budget is
    // supplied (CAM-EXEC-03). A corrupt tokens value likewise becomes 0
    // (breach on the first usage report) rather than silently absent.
    const rawBudget = opts.budget; // one read
    let budgetWallClockMs: number | undefined;
    let budgetTokens: number | undefined;
    if (rawBudget !== undefined && rawBudget !== null) {
      budgetWallClockMs = clampMs(rawBudget.wallClockMs, 0);
      const rawTokens = rawBudget.tokens; // one read
      if (rawTokens !== undefined) {
        const n = typeof rawTokens === "number" ? rawTokens : Number(rawTokens);
        budgetTokens = Number.isFinite(n) && n >= 0 ? n : 0;
      }
    }
    onLine = opts.onLine; // snapshot the sink once (round-5 finding 1)
    posture = composeWorkerEnv(process.env, {}, { officialCli }).posture;

    if (signal?.aborted) {
      // Cancelled before anything ran: nothing spawned, nothing to kill.
      const record = noProcessRecord(adapterName, "cancelled", posture, started);
      await settleFor(record); // spawned:false → group trivially gone → released
      return record;
    }

    // Arm the abort listener BEFORE spawn so an abort in the spawn window is not
    // lost (finding 3). An abort that fired DURING plan() — before this listener
    // existed — never re-fires (AbortSignal 'abort' is a one-shot), so also
    // sample the flag directly and remember it as a pending cancel.
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) pendingCancel = true;

    // plan() AND its env composition run inside the try: plan() is adapter code
    // and `plan.env` may be a throwing getter — both are handled as a broken
    // adapter (requirement-failed), never a leaked lease (round-1 finding 2;
    // round-2 finding 3 widened this to the env getter and the spawn call).
    const plan = adapter.plan(ctx);
    const composed = composeWorkerEnv(process.env, plan.env ?? {}, { officialCli });
    posture = composed.posture;

    child = spawn(plan.file, plan.args, {
      cwd: ctx.workdir,
      env: composed.env,
      detached: true,
      stdio: [plan.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
    });

    // Bounded event retention (head + tail ring) with a true total count.
    const headEvents: StreamEvent[] = [];
    const tailRing: StreamEvent[] = [];
    let totalEvents = 0;
    let anyEventQuota = false;
    // Highest run-cumulative token figure any event reported (CAM-EXEC-03
    // "tokens where reportable"). Streams that report nothing leave it 0 and
    // the token budget is simply not exercisable — wall-clock still is.
    let tokensObserved = 0;
    // A quota failure is "pending" (unrecovered) until a genuine SUCCESS
    // terminal clears it. A later NON-quota event (a generic error / footer
    // like codex turn.failed) is NOT recovery — only a success `result` clears
    // it, so a quota failure followed by any other failure stays quota-blocked
    // at exit 0 (round-10 finding 1). Replaces the too-weak "was the LAST event
    // a quota signal" test.
    let pendingQuota = false;
    const recordEvent = (ev: StreamEvent) => {
      totalEvents++;
      // NORMALIZE the parsed event to a plain snapshot ONCE on entry, each
      // field read in its OWN guard. A buggy/hostile first-party parser could
      // return an event with a throwing getter on ANY field; reading each
      // independently here means (a) a throw on one field never erases another
      // (a throwing terminalSuccess must not drop a valid quotaSignal —
      // CAM-EXEC-06, round-12 finding 2), and (b) every DOWNSTREAM read
      // (classification, assembleFinalText) operates on a plain object with no
      // getters, so nothing past this point can throw and override the outcome
      // (rounds 3–12 hostile-getter class, closed structurally here).
      let kind: StreamEvent["kind"] = "other";
      try {
        const k = ev.kind;
        if (k === "assistant" || k === "tool" || k === "result" || k === "error") kind = k;
      } catch {
        kind = "other";
      }
      let text = "";
      try {
        const t = ev.text;
        if (typeof t === "string") text = t;
      } catch {
        text = "";
      }
      let sig = false;
      try {
        sig = ev.quotaSignal === true;
      } catch {
        sig = false;
      }
      let terminalOk = false;
      try {
        terminalOk = ev.terminalSuccess === true;
      } catch {
        terminalOk = false;
      }
      let tokens: number | undefined;
      try {
        const t = ev.tokensTotal;
        if (typeof t === "number" && Number.isFinite(t) && t >= 0) tokens = t;
      } catch {
        tokens = undefined;
      }
      const snap: StreamEvent = {
        kind,
        text,
        ...(sig ? { quotaSignal: true } : {}),
        ...(terminalOk ? { terminalSuccess: true } : {}),
        ...(tokens !== undefined ? { tokensTotal: tokens } : {}),
      };
      if (tokens !== undefined && tokens > tokensObserved) tokensObserved = tokens;
      // Token-budget check rides event recording so a mid-stream cumulative
      // report kills the dispatch in flight. Exhaustion IS breach (>=): a
      // budget of N is spent at N. Deliberately NOT gated on `exited`: a
      // usage report parsed during the post-exit drain that exceeds the
      // budget still classifies `killed-budget` below — an over-budget
      // attempt is NEVER silently accepted as succeeded (kill-and-escalate,
      // CAM-EXEC-03); with the process already gone, the kill itself is moot.
      if (budgetTokens !== undefined && tokens !== undefined && tokensObserved >= budgetTokens) {
        budgetBreach ??= { kind: "tokens", limit: budgetTokens, observed: tokensObserved };
        requestKill("budget");
      }
      if (sig) {
        anyEventQuota = true;
        pendingQuota = true;
      } else if (terminalOk) {
        // A genuine SUCCESS TERMINAL (not a mid-turn answer) — the worker
        // recovered past the limit (round-10 finding 1, corrected round-11:
        // codex agent_message is NOT terminal; turn.completed is).
        pendingQuota = false;
      }
      if (headEvents.length < EVENT_HEAD_CAP) headEvents.push(snap);
      else {
        tailRing.push(snap);
        if (tailRing.length > EVENT_TAIL_CAP) tailRing.shift();
      }
    };
    const retainedEvents = (): StreamEvent[] => [...headEvents, ...tailRing];

    let sawFirstEvent = false;

    const spawnFailed = await new Promise<boolean>((resolve) => {
      let settled = false;
      child!.once("error", () => {
        if (!settled) {
          settled = true;
          resolve(true);
        }
      });
      child!.once("spawn", () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
    });

    if (spawnFailed) {
      const record = noProcessRecord(adapterName, "requirement-failed", posture, started);
      await settleFor(record); // no process → group trivially gone → released
      return record;
    }

    // The child exists now — apply any cancel that fired during the window.
    if (pendingCancel) requestKill("cancel");

    if (plan.stdin != null && child.stdin) {
      // A worker that closes stdin early makes the write EPIPE; swallow it (an
      // 'error' listener converts the throw into a handled event) so it cannot
      // crash the dispatch (round-1 review finding 2).
      child.stdin.on("error", () => {});
      child.stdin.end(plan.stdin);
    }

    // A stream must be fully DRAINED before outcome classification: 'exit'
    // can fire while stdout/stderr still hold buffered lines (a terminal quota
    // event among them), so classifying at 'exit' could freeze a "succeeded"
    // record before the final event is parsed (round-8 finding 3). Each
    // consumer resolves when its readline reaches EOF ('close').
    const streamsClosed: Promise<void>[] = [];
    // Keep the consumer handles so, if the drain CAP wins (a group-escaped
    // descendant still holding the pipe), we can forcibly tear them down —
    // otherwise the readline keeps parsing lines AFTER the record is
    // snapshotted and the inherited pipe pins the process (round-9 finding 3).
    const consumers: Array<{
      rl: ReturnType<typeof createInterface>;
      stream: NodeJS.ReadableStream;
    }> = [];
    const consume = (channel: "stdout" | "stderr", stream: NodeJS.ReadableStream) => {
      const rl = createInterface({ input: stream });
      consumers.push({ rl, stream });
      streamsClosed.push(
        new Promise<void>((resolve) => {
          rl.once("close", () => resolve());
          // A stream 'error' also ends the readline; never leave the drain
          // await pending on a broken pipe.
          stream.once("error", () => resolve());
        }),
      );
      rl.on("line", (line) => {
        // The transcript sink is caller code — a throwing sink must not crash
        // the dispatch (round-1 review finding 2). A SYNC throw is caught here;
        // an ASYNC sink (declared void but returning a promise) could reject
        // and become an unhandledRejection crash — swallow that too (round-2
        // review finding 3).
        try {
          const maybePromise = onLine?.(channel, line) as unknown;
          if (maybePromise && typeof (maybePromise as { then?: unknown }).then === "function") {
            void (maybePromise as Promise<unknown>).then(undefined, () => {}).catch(() => {});
          }
        } catch {
          /* a broken sink is not the worker's fault */
        }
        // Quota is decided by the PARSER (structured signatures + provider
        // exhaustion phrases in an ERROR context), NOT by a raw-line prose scan
        // — a raw scan over assistant prose manufactured false positives
        // ("issues 428, 429, 430", "too many requests for new features") and
        // was removed (round-3 finding 2). A buggy parser must never crash the
        // harness (bypassing cleanup).
        let ev: StreamEvent | null = null;
        try {
          ev = adapter.parseLine(line, channel);
        } catch {
          ev = null;
        }
        if (!ev) return;
        recordEvent(ev);
        if (!sawFirstEvent) {
          sawFirstEvent = true;
          // Use the snapshotted plain number, never re-read opts inside this
          // async callback (the lexical try can't catch a throw here) — round-4
          // finding 1.
          if (cancelAfterMs != null) {
            cancelTimer = setTimeout(() => requestKill("cancel"), cancelAfterMs);
          }
        }
      });
    };
    if (child.stdout) consume("stdout", child.stdout);
    if (child.stderr) consume("stderr", child.stderr);

    // Arm the BUDGET timer BEFORE the generic timeout timer (round-1 finding
    // 7): at an equal deadline, timers fire in insertion order, so the budget
    // callback runs first and sets killReason="budget" — a budget breach at
    // the same boundary as a runaway timeout is classified `killed-budget`
    // (kill-and-escalate), never a generic `killed`.
    if (budgetWallClockMs !== undefined) {
      // Wall-clock is measured from dispatch START (round-1 finding 5): the
      // budget covers plan()/spawn time too, so arm for the REMAINING budget,
      // clamped to 0 (an already-over-budget dispatch breaches immediately).
      const limit = budgetWallClockMs;
      const remaining = Math.max(0, limit - (Date.now() - started));
      budgetTimer = setTimeout(() => {
        if (exited || killReason) return;
        budgetBreach ??= { kind: "wall-clock", limit, observed: Date.now() - started };
        requestKill("budget");
      }, remaining);
    }
    if (timeoutMs != null) {
      timeoutTimer = setTimeout(() => requestKill("timeout"), timeoutMs);
    }

    const exitCode = await new Promise<number | null>((resolve) => {
      child!.once("exit", (code) => {
        exited = true;
        resolve(code);
      });
    });
    if (killPromise) await killPromise; // let an in-flight kill finish

    // Post-exit group sweep BEFORE the stream drain: the leader exiting does
    // not end the GROUP — a worker may leave background descendants running
    // (same group, detached spawn). A finished dispatch must not leak workers
    // (CAM-EXEC-06 process cleanup), and the lease below must not be released
    // over a live group. When no kill-confirm ran, probe the group and sweep
    // any survivors with the same SIGTERM → grace → SIGKILL sequence. Sweeping
    // FIRST also frees an in-group descendant that inherited (and is holding)
    // the stdout/stderr pipe, so the drain below can reach EOF.
    // (A descendant that changes its own process group — setpgid/setsid —
    // escapes even this sweep; that residual is WP-107's container's, per the
    // boundary at the top of this file.)
    let postExitCleanup: KillConfirmRecord | undefined;
    const pid = child.pid;
    if (!killRecord && pid != null && groupAlive(pid)) {
      postExitCleanup = await sweepGroupSafe(child, timings); // never throws; fail-closed
    }

    // Drain stdout/stderr to EOF so a line still buffered when 'exit' fired is
    // parsed and classified (round-8 finding 3) — but BOUNDED: a group-escaped
    // descendant (the named WP-107 boundary above) could hold a pipe open
    // forever, and the drain must never hang dispatch past cleanup. After the
    // in-group sweep, legit pipes reach EOF in milliseconds; cap the residual
    // wait and classify with whatever drained.
    const drainCapMs = Math.max(
      Number.isFinite(timings.sigkillWaitMs) && timings.sigkillWaitMs > 0
        ? timings.sigkillWaitMs
        : 0,
      1000,
    );
    const CAP = Symbol("drain-cap");
    const drainResult = await Promise.race([
      Promise.all(streamsClosed).then(() => "eof" as const),
      new Promise<typeof CAP>((resolve) => {
        const t = setTimeout(() => resolve(CAP), drainCapMs);
        t.unref?.(); // a dangling cap timer must not keep the loop alive
      }),
    ]);
    if (drainResult === CAP) {
      // The cap won: a pipe is still held (a group-escaped descendant). Tear
      // the consumers down so no line is parsed after this snapshot and the
      // inherited pipe stops pinning the process (round-9 finding 3). The
      // residual descendant is the named WP-107 container boundary.
      for (const { rl, stream } of consumers) {
        try {
          rl.close();
        } catch {
          /* already closed */
        }
        try {
          (stream as { destroy?: () => void }).destroy?.();
        } catch {
          /* best-effort teardown */
        }
      }
    }

    const events = retainedEvents();

    // Quota classification comes from the PARSER only (CAM-EXEC-06): each
    // adapter flags quotaSignal on error-context events via
    // classifyErrorTextForQuota. anyEventQuota is tracked over ALL events, not
    // just retained. No raw-line scan (round-3 finding 2 — it false-positived
    // on prose); an adapter that could drop a rate-limit line handles it in its
    // own error/stderr branch instead.
    const quotaBlocked = anyEventQuota;

    // A cancel/timeout is authoritative from `killReason`, set only by
    // requestKill. A process that had already exited never gets a killReason
    // and is classified on its exit code.
    //
    // Accepted residual (WP-001 review #3; scope corrected per round-1 finding
    // 11 and round-2 finding 10 — stated without an absolute no-mislabel
    // claim): the exit event is asynchronous, so a cancel/timeout that fires in
    // the same event-loop turn as a natural exit-0 that Node has not yet
    // delivered CAN be recorded as cancelled/killed even though the OS process
    // already exited 0 (a zombie answers kill(pid,0)). The window is bounded by
    // event-loop scheduling, not a hard sub-millisecond bound, and the mislabel
    // is ledger-safe (a cancelled attempt is excluded from scorecards, not
    // falsely credited). The attempt state machine (Appendix A) records
    // cancel-requested and exited as separate events and reconciles them rather
    // than forcing a synchronous label; WP-105 keeps the conservative
    // synchronous label at the seam.
    let outcome: DispatchOutcome;
    if (budgetBreach) {
      // A budget breach outranks every other classification (CAM-EXEC-03:
      // kill-and-escalate, never a retry, never silent acceptance). This
      // covers both the in-flight kill (killReason === "budget") and a
      // breach detected from a usage report parsed after natural exit —
      // exit code 0 with an over-budget usage figure is `killed-budget`,
      // not `succeeded`.
      outcome = "killed-budget";
    } else if (killReason === "timeout") {
      outcome = "killed";
    } else if (killReason === "cancel") {
      outcome = "cancelled";
    } else if (exitCode === 0) {
      // A quota failure not cleared by a later SUCCESS result is terminal — a
      // refusal even at exit 0 (CLIs report error results with zero exits), and
      // a subsequent generic error/footer does NOT count as recovery (round-10
      // finding 1). A quota signal cleared by a genuine success is a recovered
      // transient limit → "succeeded", with the pressure still exposed via
      // quotaSignalSeen for the WP-106 quota-aware scheduler (round-7 finding 2).
      outcome = pendingQuota ? "quota-blocked" : "succeeded";
    } else if (quotaBlocked) {
      outcome = "quota-blocked";
    } else {
      outcome = "requirement-failed";
    }

    const record: DispatchRecord = {
      adapter: adapterName,
      outcome,
      spawned: true,
      streamedEvents: totalEvents,
      finalText: assembleFinalText(events),
      committedSha: null, // filled by the caller after inspecting the workspace
      ...(killRecord ? { killConfirm: killRecord } : {}),
      ...(postExitCleanup ? { postExitCleanup } : {}),
      envPosture: posture,
      exitCode,
      durationMs: Date.now() - started,
      events,
      quotaSignalSeen: anyEventQuota,
      ...(budgetBreach ? { budgetBreach } : {}),
    };

    // Lease settlement is LAST, strictly after the group-gone determination
    // (PRD §5 registry item 4: … → group-gone → lease release).
    await settleFor(record);
    return record;
  } catch (err) {
    // Anything unexpected in the body (a stream/API error, a throwing plan()
    // or its env getter) still cleans up and settles the lease exactly once
    // (round-1 finding 2). FAIL-CLOSED cleanup evidence (round-2 finding 1): a
    // sweep is recorded whenever a child exists — if the group is still alive
    // and the sweep can't confirm it gone, that is a groupGone:false record, so
    // the lease is HELD, never released over a possibly-live group.
    let postExitCleanup: KillConfirmRecord | undefined;
    const pid = child?.pid;
    if (!killRecord && pid != null && groupAlive(pid)) {
      postExitCleanup = await sweepGroupSafe(child!, timings);
    }
    const record: DispatchRecord = {
      adapter: adapterName,
      outcome: "requirement-failed",
      spawned: child != null,
      streamedEvents: 0,
      finalText: "",
      committedSha: null,
      ...(killRecord ? { killConfirm: killRecord } : {}),
      ...(postExitCleanup ? { postExitCleanup } : {}),
      envPosture: posture,
      exitCode: null,
      durationMs: Date.now() - started,
      events: [],
      quotaSignalSeen: false, // exception path makes no stream claims (events: [])
      // Evidence only: the exception path keeps requirement-failed as its
      // outcome (it makes no stream claims), but a breach already recorded
      // before the throw is preserved for the escalation record.
      ...(budgetBreach ? { budgetBreach } : {}),
      unexpectedError: safeStringify(err),
    };
    await settleFor(record);
    return record;
  } finally {
    if (cancelTimer) clearTimeout(cancelTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (budgetTimer) clearTimeout(budgetTimer);
    // Even removeEventListener can throw on a hostile duck-typed signal
    // (round-2 finding 11) — the finally must never replace the returned record
    // with a throw.
    try {
      signal?.removeEventListener("abort", onAbort);
    } catch {
      /* a hostile signal must not break the return */
    }
  }
}
