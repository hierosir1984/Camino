/**
 * Quota-window tracker (WP-106, CAM-ROUTE-01 / PRD §5 registry item 13):
 * per-provider usage windows tracked from adapter rate-limit signals, with
 * shapes and capacity estimates refined from ledger observation.
 *
 * What this component claims — and, deliberately, what it does not:
 *
 *   - It RECORDS one observation per dispatch (append-only): when it ran,
 *     how long, how it classified (CAM-EXEC-06 outcome), and whether any
 *     rate-limit signal was seen — including a transient signal the worker
 *     recovered from (the WP-105 round-7 pressure channel,
 *     quotaSignalSeen).
 *   - It ESTIMATES window consumption from those observations alone.
 *     Providers do not publish per-plan window capacities, so capacity is
 *     inferred from the ledger: each observed exhaustion contributes a
 *     sample — the dispatch time that preceded it inside one window.
 *     Every sample UNDER-measures true capacity (usage outside Camino is
 *     invisible, and the window may not have been empty when the sample
 *     started), so the largest sample is the tightest available lower
 *     bound, and dividing observed usage by a lower bound OVER-states
 *     consumption — the safe direction (PRD registry item 13:
 *     "conservative default; refined from ledger data" — the scheduler
 *     pauses early, never late). With no sample yet, the estimate is
 *     honestly `null` — never a guessed fraction.
 *   - After an observed exhaustion, consumption reports 1.0 until one full
 *     window duration has passed (a rolling window has fully freed at most
 *     one duration later) — the conservative reset bound.
 *
 * The 85% dispatch-pause rule that consumes these estimates is the WP-114
 * scheduler's (CAM-ROUTE-06); the shared threshold value lives in
 * @camino/shared (QUOTA_PAUSE_THRESHOLD). A provider with no recorded
 * window shape (Grok Build) still gets exhaustion tracking and
 * recovery-gap evidence — the raw material registry item 13 names for
 * refining the shape.
 */
import Database from "better-sqlite3";
import { PROVIDER_FAMILIES } from "@camino/shared";
import type { DispatchOutcome, ProviderFamily, WindowShape } from "@camino/shared";
import { CAPABILITY_SEED } from "./capability-seed.js";

const SCHEMA_VERSION = 1;

const OUTCOMES: readonly DispatchOutcome[] = [
  "succeeded",
  "requirement-failed",
  "quota-blocked",
  "cancelled",
  "killed",
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS window_observations (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  family       TEXT    NOT NULL CHECK (family IN ('anthropic', 'openai', 'xai')),
  observed_at  TEXT    NOT NULL,
  duration_ms  INTEGER NOT NULL CHECK (duration_ms >= 0),
  outcome      TEXT    NOT NULL CHECK (outcome IN ('succeeded', 'requirement-failed', 'quota-blocked', 'cancelled', 'killed')),
  quota_signal INTEGER NOT NULL CHECK (quota_signal IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_window_obs_family ON window_observations (family, observed_at);

CREATE TRIGGER IF NOT EXISTS window_obs_append_only_update
BEFORE UPDATE ON window_observations
BEGIN
  SELECT RAISE(ABORT, 'window observations are append-only: UPDATE rejected');
END;

CREATE TRIGGER IF NOT EXISTS window_obs_append_only_delete
BEFORE DELETE ON window_observations
BEGIN
  SELECT RAISE(ABORT, 'window observations are append-only: DELETE rejected');
END;
`;

interface ObservationRow {
  seq: number;
  family: string;
  observed_at: string;
  duration_ms: number;
  outcome: string;
  quota_signal: number;
}

/** One dispatch observation as recorded (and as read back). */
export interface WindowObservation {
  readonly seq: number;
  readonly family: ProviderFamily;
  /** ISO-8601 UTC instant the dispatch ENDED (signals classify at the end). */
  readonly observedAt: string;
  readonly durationMs: number;
  readonly outcome: DispatchOutcome;
  /** Any rate-limit signal on the stream, including recovered transients. */
  readonly quotaSignalSeen: boolean;
}

/** What the caller supplies per finished dispatch (a DispatchRecord slice). */
export interface DispatchObservationInput {
  readonly outcome: DispatchOutcome;
  readonly durationMs: number;
  readonly quotaSignalSeen: boolean;
  /** Override the observation instant (tests / backfill); defaults to the clock. */
  readonly at?: Date;
}

/** Consumption estimate for one recorded window shape. */
export interface WindowConsumptionEstimate {
  readonly shape: WindowShape;
  /**
   * Estimated fraction of the window consumed, in [0, 1] — or null when no
   * capacity evidence exists yet (basis "no-capacity-estimate").
   */
  readonly estimatedConsumption: number | null;
  readonly basis: "exhaustion-observed" | "usage-fraction" | "no-capacity-estimate";
  /** Dispatch time observed inside the current window. */
  readonly observedUsageMs: number;
  /** Largest observed pre-exhaustion usage — a lower bound of true capacity, if any. */
  readonly capacityEstimateMs: number | null;
  /** Present iff basis is "exhaustion-observed": the conservative reset bound. */
  readonly estimatedResetAt?: string;
}

/** Live window state for one provider family. */
export interface ProviderWindowState {
  readonly family: ProviderFamily;
  readonly windows: readonly WindowConsumptionEstimate[];
  /** Last terminal exhaustion (outcome quota-blocked), if any. */
  readonly lastQuotaBlockedAt: string | null;
  /** Last rate-limit signal of any kind, including recovered transients. */
  readonly lastQuotaSignalAt: string | null;
}

export interface QuotaWindowTrackerOptions {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  /**
   * Window shapes per family; defaults to the seeded capability registry
   * (CAPABILITY_SEED quotaWindows). Injectable so tests can exercise
   * shapes independently of the seed.
   */
  readonly windowShapes?: (family: ProviderFamily) => readonly WindowShape[];
}

function validFamily(value: string): ProviderFamily {
  if (!(PROVIDER_FAMILIES as readonly string[]).includes(value)) {
    throw new TypeError(`Unknown provider family: ${JSON.stringify(value)}`);
  }
  return value as ProviderFamily;
}

function validInstant(label: string, value: Date): string {
  const ms = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new TypeError(`${label} must be a valid Date`);
  }
  return value.toISOString();
}

export class QuotaWindowTracker {
  readonly #db: Database.Database;
  readonly #now: () => Date;
  readonly #shapes: (family: ProviderFamily) => readonly WindowShape[];
  readonly #insert: Database.Statement;

  constructor(path: string, options: QuotaWindowTrackerOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#shapes = options.windowShapes ?? ((family) => CAPABILITY_SEED[family].quotaWindows.value);
    this.#db = new Database(path);
    // Every refusal path closes the native handle (WP-104 store pattern).
    try {
      this.#db.pragma("journal_mode = WAL");
      const encoding = this.#db.pragma("encoding", { simple: true }) as string;
      if (encoding !== "UTF-8") {
        throw new Error(
          `window-observation store ${path} uses encoding ${encoding}; expected UTF-8 — refusing to open`,
        );
      }
      const version = this.#db.pragma("user_version", { simple: true }) as number;
      if (version === 0) {
        this.#db.exec(SCHEMA);
        this.#db.pragma(`user_version = ${SCHEMA_VERSION}`);
      } else if (version !== SCHEMA_VERSION) {
        throw new Error(
          `window-observation store ${path} has schema version ${version}; this daemon expects ${SCHEMA_VERSION}`,
        );
      }
      this.#insert = this.#db.prepare(
        `INSERT INTO window_observations (family, observed_at, duration_ms, outcome, quota_signal)
         VALUES (@family, @observedAt, @durationMs, @outcome, @quotaSignal)`,
      );
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  /**
   * Record one finished dispatch for a provider family. The scheduler
   * (WP-114) feeds every DispatchRecord through this; nothing here blocks
   * or classifies — classification is the adapter layer's (CAM-EXEC-06).
   */
  recordDispatch(family: ProviderFamily, input: DispatchObservationInput): WindowObservation {
    const checkedFamily = validFamily(family);
    if (!OUTCOMES.includes(input.outcome)) {
      throw new TypeError(`Unknown dispatch outcome: ${JSON.stringify(input.outcome)}`);
    }
    if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
      throw new TypeError("durationMs must be a finite non-negative number");
    }
    const observedAt = validInstant("observation instant", input.at ?? this.#now());
    const quotaSignalSeen = input.quotaSignalSeen === true || input.outcome === "quota-blocked";
    const result = this.#insert.run({
      family: checkedFamily,
      observedAt,
      durationMs: Math.round(input.durationMs),
      outcome: input.outcome,
      quotaSignal: quotaSignalSeen ? 1 : 0,
    });
    return {
      seq: Number(result.lastInsertRowid),
      family: checkedFamily,
      observedAt,
      durationMs: Math.round(input.durationMs),
      outcome: input.outcome,
      quotaSignalSeen,
    };
  }

  /** All observations for a family, oldest first. */
  observations(family: ProviderFamily): WindowObservation[] {
    const rows = this.#db
      .prepare("SELECT * FROM window_observations WHERE family = ? ORDER BY seq")
      .all(validFamily(family)) as ObservationRow[];
    return rows.map((row) => ({
      seq: row.seq,
      family: row.family as ProviderFamily,
      observedAt: row.observed_at,
      durationMs: row.duration_ms,
      outcome: row.outcome as DispatchOutcome,
      quotaSignalSeen: row.quota_signal === 1,
    }));
  }

  /**
   * Exhaustion→recovery gaps in milliseconds: for each quota-blocked
   * observation, the time until the next SUCCEEDED dispatch. This is the
   * ledger evidence registry item 13 names for refining window shapes —
   * most useful for a provider with no recorded shape yet (Grok Build).
   */
  recoveryGapsMs(family: ProviderFamily): number[] {
    const all = this.observations(family);
    const gaps: number[] = [];
    for (let i = 0; i < all.length; i++) {
      if (all[i]!.outcome !== "quota-blocked") continue;
      const blockedAt = Date.parse(all[i]!.observedAt);
      for (let j = i + 1; j < all.length; j++) {
        if (all[j]!.outcome === "succeeded") {
          gaps.push(Date.parse(all[j]!.observedAt) - blockedAt);
          break;
        }
      }
    }
    return gaps;
  }

  /**
   * Live window state for one provider family: per recorded window shape,
   * the estimated consumption with its basis stated. The WP-114 scheduler
   * pauses dispatch when any window's estimate reaches
   * QUOTA_PAUSE_THRESHOLD (CAM-ROUTE-06); quota-blocked outcomes queue
   * work regardless of estimates (CAM-EXEC-06).
   */
  windowState(family: ProviderFamily, options: { now?: Date } = {}): ProviderWindowState {
    const checkedFamily = validFamily(family);
    const nowMs = (options.now ?? this.#now()).getTime();
    if (!Number.isFinite(nowMs)) {
      throw new TypeError("windowState clock must yield a valid Date");
    }
    const all = this.observations(checkedFamily);
    const blocked = all.filter((o) => o.outcome === "quota-blocked");
    const signals = all.filter((o) => o.quotaSignalSeen);
    const lastQuotaBlockedAt = blocked.at(-1)?.observedAt ?? null;
    const lastQuotaSignalAt = signals.at(-1)?.observedAt ?? null;

    const windows = this.#shapes(checkedFamily).map((shape): WindowConsumptionEstimate => {
      const usageIn = (endMs: number): number =>
        all
          .filter((o) => {
            const t = Date.parse(o.observedAt);
            return t > endMs - shape.durationMs && t <= endMs;
          })
          .reduce((sum, o) => sum + o.durationMs, 0);

      // Conservative reset bound: after an exhaustion, the rolling window
      // has fully freed at most one duration later.
      if (lastQuotaBlockedAt !== null) {
        const blockedMs = Date.parse(lastQuotaBlockedAt);
        if (nowMs < blockedMs + shape.durationMs) {
          return {
            shape,
            estimatedConsumption: 1,
            basis: "exhaustion-observed",
            observedUsageMs: usageIn(nowMs),
            capacityEstimateMs: null,
            estimatedResetAt: new Date(blockedMs + shape.durationMs).toISOString(),
          };
        }
      }

      // Capacity refinement from the ledger: each exhaustion contributes
      // the usage that preceded it inside one window. Samples are lower
      // bounds of true capacity (see the module header), so the LARGEST
      // sample is the tightest safe estimate — and it still over-states
      // consumption, never under-states it.
      const samples = blocked
        .map((b) => usageIn(Date.parse(b.observedAt)))
        .filter((sample) => sample > 0);
      const capacityEstimateMs = samples.length > 0 ? Math.max(...samples) : null;
      const observedUsageMs = usageIn(nowMs);
      if (capacityEstimateMs === null) {
        return {
          shape,
          estimatedConsumption: null,
          basis: "no-capacity-estimate",
          observedUsageMs,
          capacityEstimateMs: null,
        };
      }
      return {
        shape,
        estimatedConsumption: Math.min(1, observedUsageMs / capacityEstimateMs),
        basis: "usage-fraction",
        observedUsageMs,
        capacityEstimateMs,
      };
    });

    return { family: checkedFamily, windows, lastQuotaBlockedAt, lastQuotaSignalAt };
  }
}
