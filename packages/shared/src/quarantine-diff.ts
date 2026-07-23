/**
 * The quarantined final diff (WP-108, CAM-EXEC-04): the durable cross-package
 * artifact the quarantine intake emits for an ACCEPTED candidate.
 *
 * A named artifact in the §5 dependency table alongside the contract schema
 * (WP-110) and the packet schema (WP-116). The quarantine module (in `daemon`)
 * PRODUCES it; the schema + total validator live here in `shared` so every
 * consumer holds one definition:
 *   - WP-111 classification re-triggers read `changedPaths` to re-classify the
 *     candidate deterministically (migrations, auth/authz, dependency
 *     manifests, flags, boot/validation config, protected paths, user-visible
 *     surface paths) on the FINAL diff rather than the pre-diff proposal;
 *   - WP-116 evidence binds gating evidence to the candidate identity
 *     (`candidateSha`, `baseSha`) — the Camino-authored commit, never the
 *     worker head.
 *
 * IDENTITY, stated: the artifact records THREE shas — the Camino-authored
 * `candidateSha` (what gating evidence and the eventual push bind to), its
 * `baseSha` (the assigned base, the candidate's sole parent), and the
 * `workerHeadSha` it was rebuilt from (attribution only, never a gating
 * subject; worker-head checks are advisory per CAM-VAL-08). `contractRef`
 * binds the candidate to the WP-110 frozen contract it was produced under
 * (CAM-PLAN-04). The diff carries no worker history: a squash-and-rebuild
 * candidate descends solely from `baseSha` (design §5.1).
 */
import { contractRefProblems } from "./contract.js";
import type { ContractRef } from "./contract.js";

/**
 * A git object name: 40-hex (sha-1) or 64-hex (sha-256), lower-case. Both are
 * accepted so the schema does not pin the repo's object format. MODULE-PRIVATE
 * RegExp behind a predicate (the barrel-immutability boundary: a frozen RegExp
 * is still rewritable via `compile()`); the SOURCE string is exported for
 * messages and tests.
 */
const GIT_OBJECT_NAME_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The git-object-name grammar text, for error messages and tests. */
export const GIT_OBJECT_NAME_PATTERN_SOURCE: string = GIT_OBJECT_NAME_RE.source;

/** Lower-case-hex git object name (sha-1 or sha-256 length). */
export function isGitObjectName(value: string): boolean {
  return GIT_OBJECT_NAME_RE.test(value);
}

/**
 * How a path changed between base and candidate. `--no-renames` is used to
 * compute the diff (a rename is a delete + add), so these three kinds are
 * total. WP-111's re-classification triggers key on the path set; the change
 * kind lets a consumer distinguish an added dependency manifest from a deleted
 * one without re-reading git.
 */
export const CHANGED_PATH_KINDS = Object.freeze(["added", "deleted", "modified"] as const);
export type ChangedPathKind = (typeof CHANGED_PATH_KINDS)[number];

/** One path the candidate changed relative to its assigned base. */
export interface ChangedPath {
  /** Repo-root-relative POSIX path, exactly as stored in the tree. */
  readonly path: string;
  readonly change: ChangedPathKind;
}

/**
 * The quarantined final diff for one accepted candidate. Immutable data: the
 * quarantine intake emits it once, and consumers only read it.
 */
export interface QuarantinedDiff {
  /** The fresh Camino-authored commit (squash-and-rebuild result). */
  readonly candidateSha: string;
  /** The assigned base — the candidate's sole parent (base_sha). */
  readonly baseSha: string;
  /** The candidate's tree (identical to the vetted worker tree, bit-for-bit). */
  readonly treeSha: string;
  /** The worker's final head the candidate was rebuilt from (attribution only). */
  readonly workerHeadSha: string;
  /** The `Camino-Worker-Attribution:` trailer recorded in the candidate message. */
  readonly attributionTrailer: string;
  /** WP-110 contract binding (CAM-PLAN-04), or null when the caller supplied none. */
  readonly contractRef: ContractRef | null;
  /** Base↔candidate changed paths (sorted by path; `--no-renames` semantics). */
  readonly changedPaths: readonly ChangedPath[];
}

/** The attribution-trailer key; the value is always the worker head sha. */
export const WORKER_ATTRIBUTION_TRAILER_KEY = "Camino-Worker-Attribution";

/** The canonical attribution trailer line for a given worker head. */
export function workerAttributionTrailer(workerHeadSha: string): string {
  return `${WORKER_ATTRIBUTION_TRAILER_KEY}: ${workerHeadSha}`;
}

/**
 * Bound on the changed-path list. The quarantine POLICY check enforces this as a
 * rejection BEFORE emit (so an over-cardinality candidate fails cleanly, never
 * throwing here — review r3 finding 3); this validator is the durable backstop.
 */
export const MAX_CHANGED_PATHS = 100_000;
/** Bound on a single stored path length (git's own limit is far higher; this is a sanity cap). */
const MAX_PATH_LENGTH = 8192;

/**
 * A PLAIN object: a direct object literal / `Object.create(null)`, not a class
 * instance and not a record with a forged prototype. A class instance or a
 * `{"__proto__": {…}}`-shaped record can carry fields on its prototype that read
 * as present but serialize to `{}`; requiring a plain object (own fields only)
 * closes that class uniformly (review r2/r3 finding 9).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Total validator for a quarantined-diff record: an empty result means the
 * record is well-formed and internally consistent (the trailer names the
 * worker head; the candidate is neither the worker head nor the base nor its
 * own tree; changed paths are sorted, unique, canonical, non-empty and
 * NUL-free). Used at emit (before handing the artifact on) and at adoption (a
 * consumer refuses a record that fails this, never repairs it — the WP-110
 * contract-validator precedent).
 *
 * SCOPE, stated (review r4 finding 4): this is total over PLAIN-DATA records —
 * the JSON-serializable form an artifact actually takes on a store round-trip,
 * which is the adoption threat. It is NOT hardened against a live in-memory
 * object that lies BETWEEN reads (a stateful `Proxy`, a side-effecting getter)
 * or carries non-JSON fields (`Symbol` keys) — such an object never survives
 * serialization to the store, so it is outside the adoption model. Callers that
 * hand a live object rather than a parsed record own that trust.
 */
export function quarantinedDiffProblems(value: unknown): string[] {
  // Validate a JSON ROUND-TRIP snapshot, so acceptance is INVARIANT under the
  // store round-trip an adopted artifact takes (review r5 findings 5, 7): a
  // non-enumerable own property, a side-effecting getter, a Symbol-keyed field,
  // and a cross-realm prototype all vanish or normalize through JSON — closing
  // the classes a direct property read would accept but that would not survive
  // serialization. A value that is not JSON-serializable is refused outright.
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(JSON.stringify(value));
  } catch (err) {
    return [`quarantinedDiff is not JSON-serializable: ${(err as Error).message}`];
  }
  if (!isPlainObject(snapshot)) {
    return ["quarantinedDiff must be a JSON object (no class instance, array, or scalar)"];
  }
  const record = snapshot as Record<string, unknown>;
  const problems: string[] = [];

  // OWN properties only: a record whose fields live on the PROTOTYPE would read
  // as present here but serialize to `{}` (review r1 finding 9). Reading through
  // `get` makes an inherited field undefined, so it fails its type check.
  const get = (field: string): unknown =>
    Object.hasOwn(record, field) ? record[field] : undefined;

  const shaLengths = new Set<number>();
  const sha = (field: string): string | null => {
    const v = get(field);
    if (typeof v !== "string" || !isGitObjectName(v)) {
      problems.push(
        `${field} must be an own git object name (/${GIT_OBJECT_NAME_PATTERN_SOURCE}/)`,
      );
      return null;
    }
    shaLengths.add(v.length);
    return v;
  };
  const candidateSha = sha("candidateSha");
  const baseSha = sha("baseSha");
  const treeSha = sha("treeSha");
  const workerHeadSha = sha("workerHeadSha");
  // A commit object id and a tree object id are different objects — they can
  // never share an id. candidateSha, baseSha, and workerHeadSha all name COMMITS;
  // none can equal treeSha. Any such equality is an impossible, forged record
  // (review r2 finding 9, r3 finding 5).
  if (treeSha !== null) {
    for (const [name, v] of [
      ["candidateSha", candidateSha],
      ["baseSha", baseSha],
      ["workerHeadSha", workerHeadSha],
    ] as const) {
      if (v !== null && v === treeSha) {
        problems.push(`${name} equals treeSha — a commit id cannot equal its tree id`);
      }
    }
  }
  // One repository has ONE object format; mixing 40-hex (sha-1) and 64-hex
  // (sha-256) identities in one record is impossible and forged (review r1 #9).
  if (shaLengths.size > 1) {
    problems.push(
      "object ids mix sha-1 and sha-256 lengths — one record cannot span object formats",
    );
  }

  // A squash-and-rebuild candidate is a NEW Camino-authored commit; if it
  // equals the worker head the rebuild did not happen (design §5.1).
  if (candidateSha !== null && workerHeadSha !== null && candidateSha === workerHeadSha) {
    problems.push("candidateSha equals workerHeadSha — a rebuilt candidate is a fresh commit");
  }
  // The candidate descends solely from the assigned base; base ≡ candidate
  // would mean an empty rebuild onto itself.
  if (candidateSha !== null && baseSha !== null && candidateSha === baseSha) {
    problems.push("candidateSha equals baseSha — the candidate must be a distinct commit");
  }

  const trailer = get("attributionTrailer");
  if (typeof trailer !== "string") {
    problems.push("attributionTrailer must be an own string");
  } else if (workerHeadSha !== null && trailer !== workerAttributionTrailer(workerHeadSha)) {
    problems.push(
      `attributionTrailer must be "${WORKER_ATTRIBUTION_TRAILER_KEY}: <workerHeadSha>" naming workerHeadSha`,
    );
  }

  const contractRef = get("contractRef");
  if (!Object.hasOwn(record, "contractRef")) {
    problems.push("contractRef is required (null when the caller supplied none)");
  } else if (contractRef !== null) {
    // Validate the ContractRef over its OWN properties only: contractRefProblems
    // reads fields directly, so a ref whose fields live on the prototype would
    // pass while serializing to `{}` (review r2 finding 9). Require a PLAIN object,
    // then snapshot own props into a NULL-prototype object — the null proto has no
    // `__proto__` setter, so a JSON `{"__proto__": {…}}` field lands as an own key
    // (flagged as unknown by contractRefProblems) instead of silently retargeting
    // the snapshot's prototype (review r3 finding 5).
    if (!isPlainObject(contractRef)) {
      problems.push("contractRef must be a plain object or null (no forged prototype)");
    } else {
      const ownRef: Record<string, unknown> = Object.create(null);
      for (const k of Object.keys(contractRef)) ownRef[k] = contractRef[k];
      for (const p of contractRefProblems(ownRef)) problems.push(`contractRef ${p}`);
    }
  }

  const changedPaths = get("changedPaths");
  if (!Array.isArray(changedPaths)) {
    problems.push("changedPaths must be an own array");
  } else {
    if (changedPaths.length > MAX_CHANGED_PATHS) {
      problems.push(`changedPaths exceeds ${MAX_CHANGED_PATHS} entries`);
    }
    // Sparse-array holes have no JSON form and are skipped by iteration, so
    // hunt them by index (the WP-110 contract-validator precedent).
    for (let i = 0; i < changedPaths.length; i += 1) {
      if (!Object.hasOwn(changedPaths, i)) {
        problems.push(`changedPaths[${i}] is a sparse-array hole`);
      }
    }
    let previous: string | undefined;
    changedPaths.forEach((entry, i) => {
      // Plain object only: a `Date` (or any class instance) with own `path` /
      // `change` fields would validate here but serialize to a string, so the
      // adopted diff would not round-trip (review r4 finding 4).
      if (!isPlainObject(entry)) {
        problems.push(`changedPaths[${i}] must be a plain object`);
        return;
      }
      const cp = entry as Record<string, unknown>;
      const path = Object.hasOwn(cp, "path") ? cp["path"] : undefined;
      if (typeof path !== "string" || path.length === 0) {
        problems.push(`changedPaths[${i}].path must be a non-empty own string`);
      } else {
        if (path.length > MAX_PATH_LENGTH) {
          problems.push(`changedPaths[${i}].path exceeds ${MAX_PATH_LENGTH} code units`);
        }
        if (path.includes("\u0000")) problems.push(`changedPaths[${i}].path contains U+0000`);
        // Repo-root-relative POSIX, canonical form only (review r1 finding 9,
        // r2 finding 9): reject a Windows separator (`\\`), and any empty,
        // `.`, or `..` segment — which also rejects a leading `/`, a trailing
        // `/`, a `//` run, and a `./`/`a/./b` component.
        const segs = path.split("/");
        if (path.includes("\\") || segs.some((s) => s === "" || s === "." || s === "..")) {
          problems.push(
            `changedPaths[${i}].path must be a canonical repo-root-relative POSIX path`,
          );
        }
        if (previous !== undefined && !(previous < path)) {
          problems.push(
            `changedPaths must be strictly sorted and duplicate-free (changedPaths[${i}])`,
          );
        }
        previous = path;
      }
      const change = Object.hasOwn(cp, "change") ? cp["change"] : undefined;
      if (
        typeof change !== "string" ||
        !(CHANGED_PATH_KINDS as readonly string[]).includes(change)
      ) {
        problems.push(`changedPaths[${i}].change must be one of ${CHANGED_PATH_KINDS.join(", ")}`);
      }
      const extra = Object.keys(cp).filter((k) => !["path", "change"].includes(k));
      for (const key of extra) {
        problems.push(`changedPaths[${i}] has unknown field ${JSON.stringify(key)}`);
      }
    });
  }

  const allowed = [
    "candidateSha",
    "baseSha",
    "treeSha",
    "workerHeadSha",
    "attributionTrailer",
    "contractRef",
    "changedPaths",
  ];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) problems.push(`unknown field ${JSON.stringify(key)}`);
  }
  return problems;
}
