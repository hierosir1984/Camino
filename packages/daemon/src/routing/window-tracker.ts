/**
 * Quota-window tracker (WP-106, CAM-ROUTE-01 / PRD §5 registry item 13):
 * per-provider usage windows tracked from adapter rate-limit signals, with
 * shapes and capacity estimates refined from ledger observation.
 *
 * What this component claims — and, deliberately, what it does not:
 *
 *   - It RECORDS one observation per dispatch (append-only): when it ended,
 *     how long it ran, how it classified (CAM-EXEC-06 outcome), and whether
 *     any rate-limit signal was seen — including a transient signal the
 *     worker recovered from (the WP-105 round-7 pressure channel,
 *     quotaSignalSeen). Observations may arrive out of insertion order
 *     (backfills); every estimate below therefore orders by TIMESTAMP, with
 *     insertion seq only as the tie-break (round-1 review findings 1–2).
 *   - It ESTIMATES window consumption from those observations alone, and
 *     the guarantee is scoped to the ledger: WITHIN the recorded
 *     observations, the estimate never under-states. Usage is measured by
 *     interval overlap — a dispatch occupies [end − duration, end] and only
 *     the part inside a window counts toward that window — and capacity is
 *     inferred from exhaustions: each contributes the overlap-measured
 *     usage that preceded it inside one window, which UNDER-measures true
 *     capacity (activity outside Camino is invisible, and the window may
 *     not have been empty at the sample's start), so the largest sample is
 *     the tightest safe lower bound and dividing by it OVER-states
 *     consumption. Activity outside Camino is explicitly out of scope: the
 *     live quota-blocked classification remains the authoritative backstop
 *     (CAM-EXEC-06 — exhaustion queues work regardless of any estimate).
 *     With no capacity evidence, the estimate is honestly `null`.
 *   - After an observed exhaustion (latest by timestamp), consumption
 *     reports 1.0 until one full window duration has passed — a rolling
 *     window has fully freed at most one duration later (conservative
 *     reset bound).
 *   - A provider with NO recorded window shape (Grok Build) is still
 *     schedulable: once a GENUINE recovery has been observed — a succeeded
 *     dispatch whose whole interval lies after an exhaustion; a success
 *     that was already in flight when the limit tripped proves nothing —
 *     the largest exhaustion→recovery gap is synthesized as an
 *     "observed-recovery" window (the ledger-refined shape registry item
 *     13 names), so the reset bound and consumption estimates apply to it
 *     like any seeded shape. Before any gap exists, `windows` stays empty and
 *     `lastQuotaBlockedAt` tells the scheduler "exhausted, reset horizon
 *     unknown" — resuming on evidence (a later successful dispatch) is the
 *     WP-114 scheduler's policy, stated here as its boundary.
 *
 * The 85% dispatch-pause rule that consumes these estimates is the WP-114
 * scheduler's (CAM-ROUTE-06); the shared threshold value lives in
 * @camino/shared (QUOTA_PAUSE_THRESHOLD).
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

// The BEFORE INSERT guard closes the `INSERT OR REPLACE` route around the
// UPDATE/DELETE triggers: REPLACE deletes a conflicting row WITHOUT firing
// the DELETE trigger unless recursive triggers are on, so an explicit-seq
// replace would silently rewrite history (the PR #45 append-only fold,
// reproduced against this store by the round-1 review, finding 4).
// Ordinary autoincrement inserts reach the trigger with NEW.seq = -1 (the
// not-yet-assigned sentinel), so the guard requires NEW.seq >= 0 — and the
// CHECK (seq > 0) refuses an explicit negative-seq row that would collide
// with the sentinel and brick every later append (round-2 review finding 3;
// both properties probed directly against better-sqlite3).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS window_observations (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT CHECK (seq > 0),
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

CREATE TRIGGER IF NOT EXISTS window_obs_append_only_replace
BEFORE INSERT ON window_observations
WHEN NEW.seq >= 0 AND EXISTS (SELECT 1 FROM window_observations WHERE seq = NEW.seq)
BEGIN
  SELECT RAISE(ABORT, 'window observations are append-only: seq replacement rejected');
END;
`;

/** Expected schema objects from a pristine in-memory creation (canon-store pattern). */
let expectedTrackerSchema: Map<string, string> | null = null;
function expectedSchemaObjects(): Map<string, string> {
  if (expectedTrackerSchema !== null) return expectedTrackerSchema;
  const mem = new Database(":memory:");
  try {
    mem.exec(SCHEMA);
    const rows = mem
      .prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; sql: string | null }>;
    expectedTrackerSchema = new Map(rows.map((r) => [r.name, r.sql ?? ""]));
    return expectedTrackerSchema;
  } finally {
    mem.close();
  }
}

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

/** Consumption estimate for one window shape (seeded, or ledger-observed). */
export interface WindowConsumptionEstimate {
  readonly shape: WindowShape;
  /**
   * Estimated fraction of the window consumed, in [0, 1] — or null when no
   * capacity evidence exists yet (basis "no-capacity-estimate").
   */
  readonly estimatedConsumption: number | null;
  readonly basis: "exhaustion-observed" | "usage-fraction" | "no-capacity-estimate";
  /** Dispatch time overlapping the current window (interval-clipped). */
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
  /** Latest terminal exhaustion by TIMESTAMP (outcome quota-blocked), if any. */
  readonly lastQuotaBlockedAt: string | null;
  /** Latest rate-limit signal by TIMESTAMP, including recovered transients. */
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

/** Timestamp order with insertion seq as the tie-break. */
function byInstantThenSeq(a: WindowObservation, b: WindowObservation): number {
  const diff = Date.parse(a.observedAt) - Date.parse(b.observedAt);
  return diff !== 0 ? diff : a.seq - b.seq;
}

/** The part of a dispatch's [end − duration, end] interval inside (winStart, winEnd]. */
function overlapMs(observation: WindowObservation, winStartMs: number, winEndMs: number): number {
  const endMs = Date.parse(observation.observedAt);
  const startMs = endMs - observation.durationMs;
  return Math.max(0, Math.min(endMs, winEndMs) - Math.max(startMs, winStartMs));
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
      // Tamper-EVIDENT adoption (round-2 review finding 2, the WP-109
      // canon-store pattern): the append-only promise rests on the triggers,
      // so a store whose schema OBJECTS — definitions, not names — differ
      // from this daemon's is refused instead of silently trusted on its
      // user_version alone. NAMED BOUNDARY: this is evidence, not proof — a
      // writer with filesystem access can delete or rebuild the whole file;
      // that perimeter is the 0700 state directory (CAM-CORE-01 posture),
      // the same boundary named for every store in this daemon.
      const expected = expectedSchemaObjects();
      const actual = new Map(
        (
          this.#db
            .prepare(
              "SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all() as Array<{ name: string; sql: string | null }>
        ).map((r) => [r.name, r.sql ?? ""]),
      );
      if (actual.size !== expected.size) {
        throw new Error(
          `window-observation store ${path} has ${actual.size} schema objects, expected ${expected.size} — ` +
            "refusing to open a tampered or foreign store",
        );
      }
      for (const [name, sql] of expected) {
        if (actual.get(name) !== sql) {
          throw new Error(
            `window-observation store ${path} schema object ${name} does not match this daemon's definition — ` +
              "refusing to open a tampered or foreign store",
          );
        }
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

  /** All observations for a family, in insertion order (seq). */
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
   * observation, the time until the end of the next GENUINE recovery — a
   * succeeded dispatch whose whole interval lies after the exhaustion
   * (start = end − duration at or past the blocked instant). A success
   * that merely ENDED after the exhaustion proves nothing about the quota
   * freeing: it was already in flight when the limit tripped (round-2
   * review finding 1; timestamp ordering per round-1 finding 2). This is
   * the ledger evidence registry item 13 names for refining window shapes
   * — most useful for a provider with no recorded shape yet (Grok Build).
   */
  recoveryGapsMs(family: ProviderFamily): number[] {
    const ordered = this.observations(family).sort(byInstantThenSeq);
    const gaps: number[] = [];
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i]!.outcome !== "quota-blocked") continue;
      const blockedAt = Date.parse(ordered[i]!.observedAt);
      for (let j = i + 1; j < ordered.length; j++) {
        const candidate = ordered[j]!;
        if (candidate.outcome !== "succeeded") continue;
        const endMs = Date.parse(candidate.observedAt);
        if (endMs - candidate.durationMs >= blockedAt) {
          gaps.push(endMs - blockedAt);
          break;
        }
      }
    }
    return gaps;
  }

  /**
   * Live window state for one provider family: per window shape (seeded,
   * or synthesized from observed recovery gaps when no shape is recorded),
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
    // Latest by TIMESTAMP, not by insertion order: a backfilled older row
    // must not displace a newer exhaustion (round-1 review finding 1).
    const latestOf = (candidates: WindowObservation[]): WindowObservation | undefined =>
      candidates.length > 0
        ? candidates.reduce((a, b) => (byInstantThenSeq(a, b) >= 0 ? a : b))
        : undefined;
    const blocked = all.filter((o) => o.outcome === "quota-blocked");
    const latestBlocked = latestOf(blocked);
    const latestSignal = latestOf(all.filter((o) => o.quotaSignalSeen));

    // A provider with no recorded shape gets the ledger-observed one: the
    // largest exhaustion→success gap bounds the reset horizon (registry
    // item 13's "shapes refined from ledger observation").
    let shapes = this.#shapes(checkedFamily);
    if (shapes.length === 0) {
      const gaps = this.recoveryGapsMs(checkedFamily).filter((gap) => gap > 0);
      if (gaps.length > 0) {
        shapes = [{ id: "observed-recovery", kind: "rolling", durationMs: Math.max(...gaps) }];
      }
    }

    const windows = shapes.map((shape): WindowConsumptionEstimate => {
      const usageIn = (endMs: number, upTo?: WindowObservation): number =>
        all
          .filter((o) => {
            if (upTo === undefined) return true;
            // "Pre-exhaustion" is timestamp-then-seq order: a row recorded
            // after the exhaustion with an equal timestamp is not part of
            // the capacity sample (round-1 review finding 2).
            return byInstantThenSeq(o, upTo) <= 0;
          })
          .reduce((sum, o) => sum + overlapMs(o, endMs - shape.durationMs, endMs), 0);

      // Conservative reset bound: after the latest exhaustion, the rolling
      // window has fully freed at most one duration later.
      if (latestBlocked !== undefined) {
        const blockedMs = Date.parse(latestBlocked.observedAt);
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
      // the interval-clipped usage that preceded it inside one window.
      // Samples are lower bounds of true capacity (see the module header),
      // so the LARGEST sample is the tightest safe estimate — and it still
      // over-states consumption, never under-states it.
      const samples = blocked
        .map((b) => usageIn(Date.parse(b.observedAt), b))
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

    return {
      family: checkedFamily,
      windows,
      lastQuotaBlockedAt: latestBlocked?.observedAt ?? null,
      lastQuotaSignalAt: latestSignal?.observedAt ?? null,
    };
  }
}
