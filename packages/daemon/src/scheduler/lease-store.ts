/**
 * SQLite attempt-lease store (WP-114, CAM-STATE-04; PRD §5 registry item 5
 * verbatim): lease generations monotonic per environment, persisted in
 * SQLite; heartbeat 30 s, TTL 5 min; every environment operation presents
 * its generation; stale-generation writes rejected; re-grant only after
 * kill-confirm; exactly one fenced owner per validation environment at any
 * time. The cross-package interface it implements lives in
 * @camino/shared/lease (the seam WP-115 and any future janitor consume).
 *
 * Invariants enforced IN THE DATABASE, not only in this class (the WP-103
 * REPLACE-guard lesson: every rewrite route is refused by triggers, so a
 * buggy or bypassing writer cannot silently corrupt the fencing facts):
 *
 *   - generations only ever INCREASE (monotonic-per-environment trigger);
 *   - a lease row's identity (environment, generation, holder, grantedAt)
 *     is immutable; only heartbeat and the one settlement transition may
 *     ever update a row, and settled rows are absorbing;
 *   - at most one `held` lease per environment (fenced-owner trigger), and
 *     a new lease may only be inserted at the environment's CURRENT
 *     generation;
 *   - no DELETE on either table; REPLACE routes are closed by explicit
 *     BEFORE INSERT guards on existing keys.
 *
 * NAMED BOUNDARY (every daemon store states it): the triggers make the
 * store tamper-EVIDENT against in-process writers, not tamper-proof
 * against a filesystem writer — that perimeter is the 0700 state directory
 * (CAM-CORE-01 posture).
 */
import Database from "better-sqlite3";
import type {
  DispatchOutcome,
  EnvironmentLeaseStore,
  EnvironmentLeaseView,
  FenceResult,
  GrantResult,
  KillConfirmSource,
  LapsedLease,
  LeaseRecoveryReport,
  LeaseReleaseContext,
  LeaseState,
  SettleResult,
} from "@camino/shared";
import {
  KILL_CONFIRM_SOURCES,
  LEASE_TTL_MS,
  environmentIdProblems,
  leaseLapsed,
} from "@camino/shared";

// Pre-release schema iterations BUMP this version rather than migrating
// (the WP-106 window-tracker convention): no store ships before this work
// package merges, so an older store is refused with the precise message.
// Bumped 1 → 2 (falsification round 1, finding 4): the settlement triggers
// now demand the settlement EVIDENCE in SQL (released ⇒ outcome recorded;
// kill-confirmed ⇒ instant + source recorded), generation updates advance
// by EXACTLY one, and heartbeats never regress — an in-band writer that
// bypasses this class dies on the same guards the API enforces. NAMED
// BOUNDARY, restated: this is tamper-EVIDENT depth, not proof — a
// filesystem writer can still rebuild the whole file; that perimeter is
// the 0700 state directory + the WP-104 writer lock, as for every store.
const SCHEMA_VERSION = 2;

const DISPATCH_OUTCOMES: readonly DispatchOutcome[] = [
  "succeeded",
  "requirement-failed",
  "quota-blocked",
  "cancelled",
  "killed",
  "killed-budget",
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lease_environments (
  environment_id     TEXT PRIMARY KEY CHECK (length(environment_id) > 0),
  current_generation INTEGER NOT NULL CHECK (current_generation >= 1)
);

CREATE TABLE IF NOT EXISTS leases (
  environment_id      TEXT    NOT NULL CHECK (length(environment_id) > 0),
  generation          INTEGER NOT NULL CHECK (generation >= 1),
  holder_attempt_id   TEXT    NOT NULL CHECK (length(holder_attempt_id) > 0),
  granted_at          TEXT    NOT NULL,
  heartbeat_at        TEXT    NOT NULL,
  state               TEXT    NOT NULL CHECK (state IN ('held', 'released', 'kill-confirmed')),
  released_outcome    TEXT    CHECK (released_outcome IS NULL OR released_outcome IN ('succeeded', 'requirement-failed', 'quota-blocked', 'cancelled', 'killed', 'killed-budget')),
  kill_confirmed_at   TEXT,
  kill_confirm_source TEXT    CHECK (kill_confirm_source IS NULL OR kill_confirm_source IN ('process-group', 'container', 'never-spawned')),
  PRIMARY KEY (environment_id, generation)
);

CREATE TRIGGER IF NOT EXISTS lease_env_monotonic
BEFORE UPDATE ON lease_environments
WHEN NEW.current_generation != OLD.current_generation + 1 OR NEW.environment_id != OLD.environment_id
BEGIN
  SELECT RAISE(ABORT, 'lease generations advance by exactly one: any other update rejected');
END;

CREATE TRIGGER IF NOT EXISTS lease_env_no_delete
BEFORE DELETE ON lease_environments
BEGIN
  SELECT RAISE(ABORT, 'lease environments are permanent: DELETE rejected');
END;

CREATE TRIGGER IF NOT EXISTS lease_env_no_replace
BEFORE INSERT ON lease_environments
WHEN EXISTS (SELECT 1 FROM lease_environments WHERE environment_id = NEW.environment_id)
BEGIN
  SELECT RAISE(ABORT, 'lease environments are permanent: replacement rejected');
END;

CREATE TRIGGER IF NOT EXISTS leases_no_delete
BEFORE DELETE ON leases
BEGIN
  SELECT RAISE(ABORT, 'leases are permanent evidence: DELETE rejected');
END;

CREATE TRIGGER IF NOT EXISTS leases_no_replace
BEFORE INSERT ON leases
WHEN EXISTS (SELECT 1 FROM leases WHERE environment_id = NEW.environment_id AND generation = NEW.generation)
BEGIN
  SELECT RAISE(ABORT, 'leases are permanent evidence: replacement rejected');
END;

CREATE TRIGGER IF NOT EXISTS leases_one_fenced_owner
BEFORE INSERT ON leases
WHEN NEW.state != 'held'
  OR EXISTS (SELECT 1 FROM leases WHERE environment_id = NEW.environment_id AND state = 'held')
BEGIN
  SELECT RAISE(ABORT, 'exactly one fenced owner per environment: insert must be held and alone');
END;

CREATE TRIGGER IF NOT EXISTS leases_current_generation_only
BEFORE INSERT ON leases
WHEN NEW.generation != (SELECT current_generation FROM lease_environments WHERE environment_id = NEW.environment_id)
BEGIN
  SELECT RAISE(ABORT, 'a lease may only be granted at the environment''s current generation');
END;

CREATE TRIGGER IF NOT EXISTS leases_identity_immutable
BEFORE UPDATE ON leases
WHEN NEW.environment_id != OLD.environment_id
  OR NEW.generation != OLD.generation
  OR NEW.holder_attempt_id != OLD.holder_attempt_id
  OR NEW.granted_at != OLD.granted_at
BEGIN
  SELECT RAISE(ABORT, 'lease identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS leases_settled_absorbing
BEFORE UPDATE ON leases
WHEN OLD.state != 'held'
BEGIN
  SELECT RAISE(ABORT, 'a settled lease is absorbing: further updates rejected');
END;

CREATE TRIGGER IF NOT EXISTS leases_release_carries_outcome
BEFORE UPDATE ON leases
WHEN NEW.state = 'released' AND NEW.released_outcome IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a release must record its dispatch outcome: evidence-free release rejected');
END;

CREATE TRIGGER IF NOT EXISTS leases_kill_confirm_carries_evidence
BEFORE UPDATE ON leases
WHEN NEW.state = 'kill-confirmed' AND (NEW.kill_confirmed_at IS NULL OR NEW.kill_confirm_source IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'a kill-confirm must record its instant and source: evidence-free confirm rejected');
END;

CREATE TRIGGER IF NOT EXISTS leases_heartbeat_never_regresses
BEFORE UPDATE ON leases
WHEN NEW.state = 'held' AND NEW.heartbeat_at < OLD.heartbeat_at
BEGIN
  SELECT RAISE(ABORT, 'heartbeats never regress: backdated heartbeat rejected');
END;
`;

/** Expected schema objects from a pristine in-memory creation (canon-store pattern). */
let expectedLeaseSchema: Map<string, string> | null = null;
function expectedSchemaObjects(): Map<string, string> {
  if (expectedLeaseSchema !== null) return expectedLeaseSchema;
  const mem = new Database(":memory:");
  try {
    mem.exec(SCHEMA);
    const rows = mem
      .prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; sql: string | null }>;
    expectedLeaseSchema = new Map(rows.map((r) => [r.name, r.sql ?? ""]));
    return expectedLeaseSchema;
  } finally {
    mem.close();
  }
}

interface LeaseRow {
  environment_id: string;
  generation: number;
  holder_attempt_id: string;
  granted_at: string;
  heartbeat_at: string;
  state: string;
  released_outcome: string | null;
  kill_confirmed_at: string | null;
  kill_confirm_source: string | null;
}

export interface SqliteLeaseStoreOptions {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  /**
   * The daemon's durable cross-process writer lock (WP-104) — a REQUIRED
   * decision (the WP-106 round-8 lesson: an optional lock gets wired
   * nowhere). Pass the held lock, or `null` EXPLICITLY for a test context.
   */
  readonly writerLock: { assertHeld(context: string): void } | null;
}

function assertKey(label: string, value: string): void {
  const problems = environmentIdProblems(value);
  if (problems.length > 0) {
    throw new TypeError(`${label}: ${problems.join("; ")}`);
  }
}

export class SqliteLeaseStore implements EnvironmentLeaseStore {
  readonly #db: Database.Database;
  readonly #now: () => Date;
  readonly #writerLock: { assertHeld(context: string): void } | undefined;

  constructor(path: string, options: SqliteLeaseStoreOptions) {
    if (options === null || typeof options !== "object" || !("writerLock" in options)) {
      throw new TypeError(
        "SqliteLeaseStore requires a writerLock decision: pass the daemon's held writer lock, or explicitly null for a test context",
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
    this.#db = new Database(path);
    // Every refusal path closes the native handle (WP-104 store pattern).
    try {
      this.#db.pragma("journal_mode = WAL");
      const encoding = this.#db.pragma("encoding", { simple: true }) as string;
      if (encoding !== "UTF-8") {
        throw new Error(
          `lease store ${path} uses encoding ${encoding}; expected UTF-8 — refusing to open`,
        );
      }
      const version = this.#db.pragma("user_version", { simple: true }) as number;
      if (version === 0) {
        this.#db.exec(SCHEMA);
        this.#db.pragma(`user_version = ${SCHEMA_VERSION}`);
      } else if (version !== SCHEMA_VERSION) {
        throw new Error(
          `lease store ${path} has schema version ${version}; this daemon expects ${SCHEMA_VERSION}`,
        );
      }
      // Tamper-EVIDENT adoption (the WP-109 canon-store pattern): the
      // fencing promises rest on the triggers, so a store whose schema
      // OBJECTS differ from this daemon's is refused, not trusted on its
      // user_version alone. Boundary: evidence, not proof (module header).
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
          `lease store ${path} has ${actual.size} schema objects, expected ${expected.size} — ` +
            "refusing to open a tampered or foreign store",
        );
      }
      for (const [name, sql] of expected) {
        if (actual.get(name) !== sql) {
          throw new Error(
            `lease store ${path} schema object ${name} does not match this daemon's definition — ` +
              "refusing to open a tampered or foreign store",
          );
        }
      }
      // Structural integrity delegated to SQLite's own checker (the WP-003
      // delegate-to-fsck lesson).
      const integrity = this.#db.pragma("integrity_check", { simple: true }) as string;
      if (integrity !== "ok") {
        throw new Error(
          `lease store ${path} fails integrity_check (${integrity}) — refusing to open`,
        );
      }
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  grant(environmentId: string, holderAttemptId: string): GrantResult {
    assertKey("environmentId", environmentId);
    assertKey("holderAttemptId", holderAttemptId);
    this.#writerLock?.assertHeld("lease grant");
    const nowIso = this.#instant();
    // One synchronous transaction: the availability check and the grant
    // cannot interleave with another in-process writer (the WP-103
    // approvePlan frame discipline), and the triggers refuse any racing
    // cross-process writer that slipped past the writer lock.
    const tx = this.#db.transaction((): GrantResult => {
      const current = this.#currentRow(environmentId);
      if (current !== undefined && current.state === "held") {
        const view = this.#toView(current);
        const lapsed = leaseLapsed(view, Date.parse(nowIso), LEASE_TTL_MS);
        return lapsed
          ? { ok: false, code: "kill-confirm-required", holder: view }
          : { ok: false, code: "held-live", holder: view };
      }
      let generation: number;
      if (current === undefined) {
        this.#db
          .prepare(
            "INSERT INTO lease_environments (environment_id, current_generation) VALUES (?, 1)",
          )
          .run(environmentId);
        generation = 1;
      } else {
        generation = current.generation + 1;
        this.#db
          .prepare("UPDATE lease_environments SET current_generation = ? WHERE environment_id = ?")
          .run(generation, environmentId);
      }
      this.#db
        .prepare(
          `INSERT INTO leases (environment_id, generation, holder_attempt_id, granted_at, heartbeat_at, state)
           VALUES (?, ?, ?, ?, ?, 'held')`,
        )
        .run(environmentId, generation, holderAttemptId, nowIso, nowIso);
      return {
        ok: true,
        lease: { environmentId, generation, holderAttemptId, grantedAt: nowIso },
      };
    });
    return tx();
  }

  heartbeat(environmentId: string, generation: number): FenceResult {
    assertKey("environmentId", environmentId);
    this.#assertGeneration(generation);
    this.#writerLock?.assertHeld("lease heartbeat");
    const nowIso = this.#instant();
    const tx = this.#db.transaction((): FenceResult => {
      const fence = this.#fence(environmentId, generation);
      if (!fence.ok) return fence;
      // Heartbeats never regress (a stepping-back clock must not make a
      // live lease look lapsed): keep the max of the stored and new instant.
      const row = this.#currentRow(environmentId) as LeaseRow;
      const at = Date.parse(nowIso) > Date.parse(row.heartbeat_at) ? nowIso : row.heartbeat_at;
      this.#db
        .prepare("UPDATE leases SET heartbeat_at = ? WHERE environment_id = ? AND generation = ?")
        .run(at, environmentId, generation);
      return { ok: true };
    });
    return tx();
  }

  admitOperation(environmentId: string, generation: number): FenceResult {
    assertKey("environmentId", environmentId);
    this.#assertGeneration(generation);
    return this.#fence(environmentId, generation);
  }

  release(environmentId: string, generation: number, ctx: LeaseReleaseContext): SettleResult {
    assertKey("environmentId", environmentId);
    this.#assertGeneration(generation);
    // Fail-closed runtime checks beneath the types (a JS caller could pass
    // anything): release without confirmed group-gone would permit two
    // owners — the exact invariant CAM-STATE-04 exists to prevent.
    if (ctx === null || typeof ctx !== "object" || ctx.groupGone !== true) {
      throw new TypeError(
        "lease release requires groupGone: true — release is sequenced strictly after the worker " +
          "process group is confirmed gone (WP-105 LeaseHandle ordering; CAM-STATE-04)",
      );
    }
    if (!DISPATCH_OUTCOMES.includes(ctx.outcome)) {
      throw new TypeError(
        `lease release outcome must be a DispatchOutcome (got ${String(ctx.outcome)})`,
      );
    }
    this.#writerLock?.assertHeld("lease release");
    const tx = this.#db.transaction((): SettleResult => {
      const settle = this.#settleTarget(environmentId, generation);
      if (!settle.ok) return settle;
      this.#db
        .prepare(
          "UPDATE leases SET state = 'released', released_outcome = ? WHERE environment_id = ? AND generation = ?",
        )
        .run(ctx.outcome, environmentId, generation);
      return { ok: true, lease: this.#toView(this.#row(environmentId, generation)) };
    });
    return tx();
  }

  recordKillConfirm(
    environmentId: string,
    generation: number,
    source: KillConfirmSource,
  ): SettleResult {
    assertKey("environmentId", environmentId);
    this.#assertGeneration(generation);
    if (!(KILL_CONFIRM_SOURCES as readonly string[]).includes(source)) {
      throw new TypeError(`kill-confirm source must be one of ${KILL_CONFIRM_SOURCES.join(", ")}`);
    }
    this.#writerLock?.assertHeld("lease kill-confirm");
    const nowIso = this.#instant();
    const tx = this.#db.transaction((): SettleResult => {
      const settle = this.#settleTarget(environmentId, generation);
      if (!settle.ok) return settle;
      this.#db
        .prepare(
          "UPDATE leases SET state = 'kill-confirmed', kill_confirmed_at = ?, kill_confirm_source = ? WHERE environment_id = ? AND generation = ?",
        )
        .run(nowIso, source, environmentId, generation);
      return { ok: true, lease: this.#toView(this.#row(environmentId, generation)) };
    });
    return tx();
  }

  current(environmentId: string): EnvironmentLeaseView | undefined {
    assertKey("environmentId", environmentId);
    const row = this.#currentRow(environmentId);
    return row === undefined ? undefined : this.#toView(row);
  }

  at(environmentId: string, generation: number): EnvironmentLeaseView | undefined {
    assertKey("environmentId", environmentId);
    this.#assertGeneration(generation);
    const row = this.#db
      .prepare("SELECT * FROM leases WHERE environment_id = ? AND generation = ?")
      .get(environmentId, generation) as LeaseRow | undefined;
    return row === undefined ? undefined : this.#toView(row);
  }

  listCurrent(): EnvironmentLeaseView[] {
    const rows = this.#db
      .prepare(
        `SELECT l.* FROM leases l
         JOIN lease_environments e
           ON e.environment_id = l.environment_id AND e.current_generation = l.generation
         ORDER BY l.environment_id`,
      )
      .all() as LeaseRow[];
    return rows.map((row) => this.#toView(row));
  }

  inspectRecovered(now?: Date): LeaseRecoveryReport {
    const nowMs = (now ?? this.#now()).getTime();
    if (!Number.isFinite(nowMs))
      throw new TypeError("inspectRecovered clock must yield a valid Date");
    const heldLive: EnvironmentLeaseView[] = [];
    const lapsed: LapsedLease[] = [];
    for (const view of this.listCurrent()) {
      if (view.state !== "held") continue;
      if (leaseLapsed(view, nowMs, LEASE_TTL_MS)) {
        const beat = Date.parse(view.heartbeatAt);
        lapsed.push({
          lease: view,
          lapsedMs: Number.isNaN(beat) ? Number.MAX_SAFE_INTEGER : nowMs - beat,
        });
      } else {
        heldLive.push(view);
      }
    }
    return { heldLive, lapsed };
  }

  /** All lease rows for one environment, oldest first (audit surface). */
  history(environmentId: string): EnvironmentLeaseView[] {
    assertKey("environmentId", environmentId);
    const rows = this.#db
      .prepare("SELECT * FROM leases WHERE environment_id = ? ORDER BY generation")
      .all(environmentId) as LeaseRow[];
    return rows.map((row) => this.#toView(row));
  }

  #instant(): string {
    const now = this.#now();
    const ms = now instanceof Date ? now.getTime() : Number.NaN;
    if (!Number.isFinite(ms)) throw new TypeError("lease store clock must yield a valid Date");
    return now.toISOString();
  }

  #assertGeneration(generation: number): void {
    if (!Number.isInteger(generation) || generation < 1) {
      throw new TypeError("generation must be an integer >= 1");
    }
  }

  #currentRow(environmentId: string): LeaseRow | undefined {
    const env = this.#db
      .prepare("SELECT current_generation FROM lease_environments WHERE environment_id = ?")
      .get(environmentId) as { current_generation: number } | undefined;
    if (env === undefined) return undefined;
    const row = this.#row(environmentId, env.current_generation);
    return row;
  }

  #row(environmentId: string, generation: number): LeaseRow {
    const row = this.#db
      .prepare("SELECT * FROM leases WHERE environment_id = ? AND generation = ?")
      .get(environmentId, generation) as LeaseRow | undefined;
    if (row === undefined) {
      throw new Error(
        `lease store inconsistency: environment ${environmentId} points at generation ${generation} ` +
          "but no lease row exists — refusing to reason over a broken store",
      );
    }
    return row;
  }

  /** The shared fencing check: current generation AND held. */
  #fence(environmentId: string, generation: number): FenceResult {
    const env = this.#db
      .prepare("SELECT current_generation FROM lease_environments WHERE environment_id = ?")
      .get(environmentId) as { current_generation: number } | undefined;
    if (env === undefined || env.current_generation !== generation) {
      return {
        ok: false,
        code: "stale-generation",
        currentGeneration: env?.current_generation ?? null,
      };
    }
    const row = this.#row(environmentId, generation);
    if (row.state !== "held") {
      return { ok: false, code: "not-held", state: row.state as LeaseState };
    }
    return { ok: true };
  }

  #settleTarget(environmentId: string, generation: number): { ok: true } | SettleResult {
    const env = this.#db
      .prepare("SELECT current_generation FROM lease_environments WHERE environment_id = ?")
      .get(environmentId) as { current_generation: number } | undefined;
    if (env === undefined || env.current_generation !== generation) {
      return {
        ok: false,
        code: "stale-generation",
        currentGeneration: env?.current_generation ?? null,
      };
    }
    const row = this.#row(environmentId, generation);
    if (row.state !== "held") {
      return { ok: false, code: "already-settled", state: row.state as LeaseState };
    }
    return { ok: true };
  }

  #toView(row: LeaseRow): EnvironmentLeaseView {
    return {
      environmentId: row.environment_id,
      generation: row.generation,
      holderAttemptId: row.holder_attempt_id,
      grantedAt: row.granted_at,
      heartbeatAt: row.heartbeat_at,
      state: row.state as LeaseState,
      ...(row.released_outcome === null
        ? {}
        : { releasedOutcome: row.released_outcome as DispatchOutcome }),
      ...(row.kill_confirmed_at === null ? {} : { killConfirmedAt: row.kill_confirmed_at }),
      ...(row.kill_confirm_source === null
        ? {}
        : { killConfirmSource: row.kill_confirm_source as KillConfirmSource }),
    };
  }
}
