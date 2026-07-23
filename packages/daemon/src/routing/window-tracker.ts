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
 *     claims only what the data supports (the per-rule statement and its
 *     receipts live on windowState): a stated-period pin after every
 *     exhaustion; observed-evidence pins for synthesized shapes; usage
 *     fractions ONLY for windows whose reset semantics are known rolling,
 *     measured by interval overlap against the LATEST exhaustion's
 *     capacity sample; honest `null` everywhere else. Durations are
 *     recorded rounded UP, so an interval can only widen — never shrink
 *     into a false post-exhaustion start. Activity outside Camino is
 *     explicitly out of scope, and a capacity reduction after the latest
 *     observed signal is invisible until the next one: the live
 *     quota-blocked classification remains the authoritative backstop
 *     (CAM-EXEC-06 — exhaustion queues work regardless of any estimate).
 *   - A provider with NO recorded window shape (Grok Build) is still
 *     schedulable: once a GENUINE recovery has been observed — a succeeded
 *     dispatch whose whole interval lies after an exhaustion; a success
 *     that was already in flight when the limit tripped proves nothing —
 *     the largest exhaustion→recovery gap is synthesized as an
 *     "observed-recovery" window whose PIN expires only on further
 *     recovery evidence, never on the guessed duration. Before any gap
 *     exists, `windows` stays empty and `lastQuotaBlockedAt` tells the
 *     scheduler "exhausted, reset horizon unknown" — resuming on evidence
 *     (a later successful dispatch) is the WP-114 scheduler's policy,
 *     stated here as its boundary.
 *
 * The 85% dispatch-pause rule that consumes these estimates is the WP-114
 * scheduler's (CAM-ROUTE-06); the shared threshold value lives in
 * @camino/shared (QUOTA_PAUSE_THRESHOLD).
 */
import Database from "better-sqlite3";
import { PROVIDER_FAMILIES } from "@camino/shared";
import type { DispatchOutcome, ProviderFamily, WindowShape } from "@camino/shared";
import { CAPABILITY_SEED } from "./capability-seed.js";

// Pre-release schema iterations BUMP this version rather than migrating:
// no store shipped before this work package merges, so a mid-review store
// at an older version is refused with the precise version message (round-6
// review finding 5). Migration machinery starts with the first released
// version.
// Bumped 2 → 3 (round-18 finding 2 / round-19 finding 4): the `outcome` CHECK now
// admits 'killed-budget'. Per the pre-release policy above, an existing v2 store is
// REFUSED with the precise version message (not silently kept on the old CHECK),
// rather than migrated — no store has shipped.
const SCHEMA_VERSION = 3;

const OUTCOMES: readonly DispatchOutcome[] = [
  "succeeded",
  "requirement-failed",
  "quota-blocked",
  "cancelled",
  "killed",
  // WP-107's per-attempt budget breach (CAM-EXEC-03). A DispatchOutcome the tracker
  // MUST accept, or a real killed-budget record is rejected downstream (round-18
  // finding 2). Kept in lockstep with the SQL CHECK below and DispatchOutcome.
  "killed-budget",
];

// The BEFORE INSERT guards refuse EVERY rewrite route (REPLACE deletes a
// conflicting row WITHOUT firing the DELETE trigger — the PR #45 fold):
//   - explicit seq (ordinary autoincrement inserts reach the trigger with
//     the -1 sentinel, so anything >= 0 is caller-supplied) — closes
//     replacement, fresh-position forgery, and max-rowid poisoning
//     (rounds 1, 3, 4);
//   - an INSERT whose dispatch_id already exists — closes the
//     REPLACE-on-UNIQUE-dispatch_id route (round-6 finding 1); the
//     app-level replay path never reaches this trigger because it returns
//     the existing row before inserting.
// The CHECK (seq > 0) separately refuses negative forgeries that would
// collide with the sentinel (round-2 finding 3). All shapes probed
// directly against better-sqlite3 before coding.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS window_observations (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT CHECK (seq > 0),
  dispatch_id  TEXT    NOT NULL UNIQUE CHECK (length(dispatch_id) > 0),
  family       TEXT    NOT NULL CHECK (family IN ('anthropic', 'openai', 'xai')),
  observed_at  TEXT    NOT NULL,
  duration_ms  INTEGER NOT NULL CHECK (duration_ms >= 0),
  outcome      TEXT    NOT NULL CHECK (outcome IN ('succeeded', 'requirement-failed', 'quota-blocked', 'cancelled', 'killed', 'killed-budget')),
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
WHEN NEW.seq >= 0
BEGIN
  SELECT RAISE(ABORT, 'window observations are append-only: explicit seq rejected');
END;

CREATE TRIGGER IF NOT EXISTS window_obs_append_only_dispatch
BEFORE INSERT ON window_observations
WHEN EXISTS (SELECT 1 FROM window_observations WHERE dispatch_id = NEW.dispatch_id)
BEGIN
  SELECT RAISE(ABORT, 'window observations are append-only: dispatch replacement rejected');
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
  dispatch_id: string;
  family: string;
  observed_at: string;
  duration_ms: number;
  outcome: string;
  quota_signal: number;
}

/** One dispatch observation as recorded (and as read back). */
export interface WindowObservation {
  readonly seq: number;
  /** The recording key: one row per dispatch/attempt, replay-idempotent. */
  readonly dispatchId: string;
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
  /**
   * Durable identity of the dispatch/attempt this observation describes
   * (the WP-114 attempt id). Recording is IDEMPOTENT on it: replaying the
   * same id with identical content returns the existing row (the WP-104
   * §4.4 recovery posture — a crash between dispatch and downstream
   * processing must not double-count usage; round-5 review finding 1);
   * the same id with DIFFERENT content is refused as conflicting evidence.
   * When `at` is omitted, the recorded instant is this store's clock
   * derivation, not caller content — a replay after the clock advanced
   * still matches and returns the original row (round-6 finding 2).
   */
  readonly dispatchId: string;
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
  readonly basis:
    "exhaustion-observed" | "usage-fraction" | "no-capacity-estimate" | "reset-semantics-unknown";
  /** Dispatch time overlapping the current window (interval-clipped). */
  readonly observedUsageMs: number;
  /** The LATEST exhaustion's pre-exhaustion usage — a lower bound of capacity at that time, if any. */
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
   * The daemon's durable cross-process writer lock (WP-104) — a REQUIRED
   * decision, not an optional that can be forgotten (round-8 review
   * finding 1: an optional lock claimed as "the production path" was wired
   * nowhere). Pass the held lock (the WP-114 dispatch composition wires
   * the recovery writer lock when it feeds DispatchRecords through this
   * store), or pass `null` EXPLICITLY for a test/tooling context that
   * accepts the single-writer risk. Every recordDispatch asserts a
   * supplied lock is still held; the in-database dispatch guard
   * additionally converts any residual check/insert race into replay
   * semantics rather than a rewrite.
   */
  readonly writerLock: { assertHeld(context: string): void } | null;
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
  readonly #writerLock: { assertHeld(context: string): void } | undefined;
  readonly #insert: Database.Statement;

  constructor(path: string, options: QuotaWindowTrackerOptions) {
    // The lock DECISION is enforced at runtime, not just in the type
    // (round-9 review finding 1: TypeScript erases, and a JS caller could
    // omit the property): only a lock-shaped value or an EXPLICIT null —
    // the named test-context opt-out — counts as a decision.
    if (options === null || typeof options !== "object" || !("writerLock" in options)) {
      throw new TypeError(
        "QuotaWindowTracker requires a writerLock decision: pass the daemon's held writer lock, or explicitly null for a test context",
      );
    }
    const lock = options.writerLock;
    if (lock !== null && (typeof lock !== "object" || typeof lock.assertHeld !== "function")) {
      throw new TypeError(
        "writerLock must be the daemon's held writer lock ({ assertHeld }) or explicitly null",
      );
    }
    this.#now = options.now ?? (() => new Date());
    this.#writerLock = lock ?? undefined;
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
      // Structural integrity is DELEGATED to SQLite's own checker (the
      // WP-003 delegate-to-fsck lesson): integrity_check catches b-tree
      // corruption and table/index inconsistencies — including a rootpage
      // swap that conceals rows behind an intact-looking schema (round-3
      // finding 3). What no in-process check can catch is a WELL-FORMED
      // forged file (rootpage redirection to a consistent fake b-tree is
      // the same class as byte-editing rows in place); that is the
      // filesystem-writer boundary named above.
      const integrity = this.#db.pragma("integrity_check", { simple: true }) as string;
      if (integrity !== "ok") {
        throw new Error(
          `window-observation store ${path} fails integrity_check (${integrity}) — refusing to open`,
        );
      }
      this.#insert = this.#db.prepare(
        `INSERT INTO window_observations (dispatch_id, family, observed_at, duration_ms, outcome, quota_signal)
         VALUES (@dispatchId, @family, @observedAt, @durationMs, @outcome, @quotaSignal)`,
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
    const dispatchId = input.dispatchId;
    if (typeof dispatchId !== "string" || dispatchId.length === 0 || dispatchId.length > 200) {
      throw new TypeError("dispatchId must be a non-empty string of at most 200 UTF-16 units");
    }
    if (!dispatchId.isWellFormed() || dispatchId.includes("\0")) {
      throw new TypeError("dispatchId must be well-formed text without NUL");
    }
    if (!OUTCOMES.includes(input.outcome)) {
      throw new TypeError(`Unknown dispatch outcome: ${JSON.stringify(input.outcome)}`);
    }
    if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
      throw new TypeError("durationMs must be a finite non-negative number");
    }
    this.#writerLock?.assertHeld("window observation append");
    const quotaSignalSeen = input.quotaSignalSeen === true || input.outcome === "quota-blocked";
    const durationMs = Math.ceil(input.durationMs);
    // An EXPLICIT instant is caller content and validates up front; an
    // omitted one is THIS STORE'S clock derivation, consulted only when a
    // new row is actually inserted — a replay of an already-recorded
    // dispatch must not require a live clock (round-7 review finding 3).
    const explicitAt =
      input.at === undefined ? undefined : validInstant("observation instant", input.at);
    // Idempotent replay, checked BEFORE inserting (rounds 5–6): the same
    // dispatch id with identical content returns the EXISTING row —
    // clock-derived instants are not compared (round-6 finding 2) —
    // and different CONTENT is refused (WP-104 §4.4 posture).
    const readExisting = (): WindowObservation | undefined => {
      const existing = this.#db
        .prepare("SELECT * FROM window_observations WHERE dispatch_id = ?")
        .get(dispatchId) as ObservationRow | undefined;
      if (existing === undefined) return undefined;
      const matches =
        existing.family === checkedFamily &&
        existing.duration_ms === durationMs &&
        existing.outcome === input.outcome &&
        existing.quota_signal === (quotaSignalSeen ? 1 : 0) &&
        (explicitAt === undefined || existing.observed_at === explicitAt);
      if (!matches) {
        throw new Error(
          `dispatch ${dispatchId} is already recorded with different content — refusing conflicting evidence`,
        );
      }
      return {
        seq: existing.seq,
        dispatchId: existing.dispatch_id,
        family: existing.family as ProviderFamily,
        observedAt: existing.observed_at,
        durationMs: existing.duration_ms,
        outcome: existing.outcome as DispatchOutcome,
        quotaSignalSeen: existing.quota_signal === 1,
      };
    };
    const replayed = readExisting();
    if (replayed !== undefined) return replayed;
    const observedAt = explicitAt ?? validInstant("observation instant", this.#now());
    try {
      const result = this.#insert.run({
        dispatchId,
        family: checkedFamily,
        observedAt,
        durationMs,
        outcome: input.outcome,
        quotaSignal: quotaSignalSeen ? 1 : 0,
      });
      return {
        seq: Number(result.lastInsertRowid),
        dispatchId,
        family: checkedFamily,
        observedAt,
        durationMs,
        outcome: input.outcome,
        quotaSignalSeen,
      };
    } catch (error) {
      // A concurrent writer (outside the single-writer posture, or a
      // check/insert race) hit the dispatch guard or the UNIQUE key first.
      // Degrade to replay semantics: re-read and return the winner's row
      // when content matches; refuse conflicts (round-7 review finding 2).
      if (
        !/dispatch replacement rejected|UNIQUE constraint failed: window_observations\.dispatch_id/.test(
          String(error),
        )
      ) {
        throw error;
      }
      const raced = readExisting();
      if (raced === undefined) throw error;
      return raced;
    }
  }

  /** All observations for a family, in insertion order (seq). */
  observations(family: ProviderFamily): WindowObservation[] {
    const rows = this.#db
      .prepare("SELECT * FROM window_observations WHERE family = ? ORDER BY seq")
      .all(validFamily(family)) as ObservationRow[];
    return rows.map((row) => ({
      seq: row.seq,
      dispatchId: row.dispatch_id,
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
  recoveryGapsMs(family: ProviderFamily, options: { asOf?: Date } = {}): number[] {
    const asOfMs = options.asOf?.getTime() ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(asOfMs) && options.asOf !== undefined) {
      throw new TypeError("asOf must be a valid Date");
    }
    const ordered = this.observations(family)
      .filter((o) => Date.parse(o.observedAt) <= asOfMs)
      .sort(byInstantThenSeq);
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
   *
   * Estimation rules, per shape (round-3 findings 1–2, round-4 findings
   * 1–4):
   *   - SEEDED shape after an exhaustion: pinned at 1.0 for one full
   *     period — sound for ANY reset semantics of a stated period, since
   *     no reset can take longer than the period itself. A quota signal
   *     cannot be attributed to a specific window, so EVERY window pins on
   *     it: each pin is an upper bound, and choosing when to probe/resume
   *     among differently-pinned windows is the WP-114 scheduler's policy.
   *   - SYNTHESIZED (observed-recovery) shape: its duration is an
   *     observation, not a stated period, so an exhaustion stays pinned
   *     until a GENUINE recovery is observed after it — after in recorded
   *     order (timestamp-then-seq) AND starting at or past the exhaustion.
   *     The pin never expires on a guess, and a backfilled shorter gap
   *     cannot un-pin a still-exhausted provider.
   *   - kind "unknown-reset" past its pin (including every synthesized
   *     shape): estimatedConsumption is null, basis
   *     "reset-semantics-unknown". A trailing-period usage fraction is
   *     UNSOUND there: a capacity sample straddling an unseen reset can
   *     over-state capacity and so under-state consumption.
   *   - kind "rolling" past its pin: observed usage over the LATEST
   *     exhaustion's capacity sample — only the latest (a zero-usage
   *     latest exhaustion yields null, never a stale sample), and with
   *     quota-blocked attempts' own wall time excluded from the sample.
   *     Fractions compare wall time to wall time (a stated heuristic
   *     currency — wall time over-counts provider-side consumption in the
   *     numerator, the safe direction). NAMED BOUNDARY: a capacity
   *     REDUCTION after the latest observed exhaustion is invisible until
   *     the next signal — estimates lag it, and the live quota-blocked
   *     classification is the backstop that re-pins.
   */
  windowState(family: ProviderFamily, options: { now?: Date } = {}): ProviderWindowState {
    const checkedFamily = validFamily(family);
    const nowMs = (options.now ?? this.#now()).getTime();
    if (!Number.isFinite(nowMs)) {
      throw new TypeError("windowState clock must yield a valid Date");
    }
    // AS-OF semantics (round-5 review finding 2): the state at `now` is
    // computed from observations whose instant is at or before `now` — a
    // future-dated row (skewed clock, backfill tooling) is recorded but
    // invisible until its instant arrives; it must not un-pin the present.
    const all = this.observations(checkedFamily).filter((o) => Date.parse(o.observedAt) <= nowMs);
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
    // largest exhaustion→recovery gap estimates the reset horizon (registry
    // item 13's "shapes refined from ledger observation"). Its kind is
    // unknown-reset: one recovery gap establishes a horizon, NOT rolling
    // semantics, so no usage fraction is ever computed on it (round-4
    // review finding 2).
    let shapes = this.#shapes(checkedFamily);
    let synthesized = false;
    if (shapes.length === 0) {
      const gaps = this.recoveryGapsMs(checkedFamily, { asOf: new Date(nowMs) }).filter(
        (gap) => gap > 0,
      );
      if (gaps.length > 0) {
        shapes = [
          { id: "observed-recovery", kind: "unknown-reset", durationMs: Math.max(...gaps) },
        ];
        synthesized = true;
      }
    }

    // Has a GENUINE recovery been observed after the LATEST exhaustion?
    // Governs the synthesized pin. "After" is BOTH the recorded order
    // (timestamp-then-seq — an equal-timestamp success recorded before the
    // exhaustion is not after it; round-4 review finding 1) AND the
    // interval condition (the success started at or past the exhaustion —
    // an in-flight success proves nothing; round-2 finding 1).
    const recoveryAfterLatestBlock =
      latestBlocked !== undefined &&
      all.some((o) => {
        if (o.outcome !== "succeeded") return false;
        if (byInstantThenSeq(o, latestBlocked) <= 0) return false;
        const endMs = Date.parse(o.observedAt);
        return endMs - o.durationMs >= Date.parse(latestBlocked.observedAt);
      });

    const windows = shapes.map((shape): WindowConsumptionEstimate => {
      // Usage NUMERATOR: every recorded row counts (wall time over-counts
      // provider-side consumption, which can only raise the fraction — the
      // safe direction). Fractions therefore compare wall time to wall
      // time; they are pressure heuristics with the live signal as the
      // backstop, stated in the windowState doc.
      const usageIn = (endMs: number): number =>
        all.reduce((sum, o) => sum + overlapMs(o, endMs - shape.durationMs, endMs), 0);

      // Pin after an exhaustion. A seeded shape un-pins after one full
      // period (sound for any reset semantics of a stated period); a
      // synthesized shape un-pins only on OBSERVED recovery evidence — its
      // duration is a guess, and a guess must not expire a pin (round-3
      // review finding 1).
      if (latestBlocked !== undefined) {
        const blockedMs = Date.parse(latestBlocked.observedAt);
        const pinned = synthesized
          ? !recoveryAfterLatestBlock
          : nowMs < blockedMs + shape.durationMs;
        if (pinned) {
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

      const observedUsageMs = usageIn(nowMs);

      // No usage fraction for a window whose reset semantics are unknown:
      // a capacity sample straddling an unseen reset can over-state
      // capacity and so under-state consumption (round-3 review finding 2).
      if (shape.kind === "unknown-reset") {
        return {
          shape,
          estimatedConsumption: null,
          basis: "reset-semantics-unknown",
          observedUsageMs,
          capacityEstimateMs: null,
        };
      }

      // Capacity refinement from the ledger: the LATEST exhaustion's
      // interval-clipped pre-exhaustion usage — and ONLY the latest. An
      // exhaustion whose own window shows no measured usage yields no
      // estimate rather than resurrecting a stale sample (round-4 review
      // finding 3). Quota-blocked attempts' own wall time is EXCLUDED from
      // the sample: a refused attempt's runtime is local waiting and
      // cleanup, not evidence of provider capacity (round-4 finding 4).
      // The numerator keeps every row (over-counting usage raises the
      // fraction — the safe direction); the denominator must not.
      let capacityEstimateMs: number | null = null;
      if (latestBlocked !== undefined) {
        const blockedMs = Date.parse(latestBlocked.observedAt);
        const sample = all
          .filter((o) => o.outcome !== "quota-blocked" && byInstantThenSeq(o, latestBlocked) <= 0)
          .reduce((sum, o) => sum + overlapMs(o, blockedMs - shape.durationMs, blockedMs), 0);
        if (sample > 0) capacityEstimateMs = sample;
      }
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
