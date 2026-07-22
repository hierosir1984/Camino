/**
 * Canonical JSON + content hashing (WP-110, CAM-PLAN-04).
 *
 * A contract hash must be a function of the contract's terms and nothing
 * else, so every package that computes it — the daemon freezing contracts,
 * WP-108's scope checks, WP-112's change control, WP-116's evidence packets —
 * must produce byte-identical serializations of equal values. This module is
 * that single definition.
 *
 * Canonical form: object keys sorted by UTF-16 code unit; array order
 * preserved; strings/booleans/null via JSON.stringify; numbers must be
 * finite (JSON.stringify renders -0 as "0", so 0 and -0 share one canonical
 * form — the same normalization the intent journal's canonical-read applies).
 *
 * Everything else REFUSES loudly: undefined, functions, symbols, bigints,
 * non-finite numbers, and non-plain objects (Date, Map, Set, RegExp, class
 * instances). JSON.stringify's habit of silently dropping or coercing such
 * values is exactly what a content hash cannot tolerate — two different
 * inputs must never quietly serialize to the same bytes.
 */
import { createHash } from "node:crypto";

/** Thrown when a value has no canonical JSON form. Never swallowed into a hash. */
export class CanonicalJsonError extends Error {
  /** JSON-pointer-ish path to the offending value (e.g. "$.terms.criteria[2]"). */
  readonly path: string;
  constructor(path: string, problem: string) {
    super(`no canonical JSON form at ${path}: ${problem}`);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Nesting bound (r2 finding 9): legitimate contract/plan values are a few
 * levels deep; unbounded recursion turns pathological input into a raw
 * RangeError instead of a named refusal.
 */
const MAX_DEPTH = 256;

function serialize(value: unknown, path: string, seen: Set<object>, depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new CanonicalJsonError(path, `nesting exceeds ${MAX_DEPTH} levels`);
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(path, `non-finite number ${String(value)}`);
      }
      // JSON.stringify(-0) === "0": one canonical form for the two zeros.
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new CanonicalJsonError(path, `${typeof value} values have no JSON form`);
  }
  if (value === null) return "null";
  const obj = value as object;
  if (seen.has(obj)) {
    throw new CanonicalJsonError(path, "circular reference");
  }
  seen.add(obj);
  try {
    // Symbol-keyed properties have no JSON form and would otherwise vanish
    // silently, hashing two different values alike (r2 finding 9).
    if (Object.getOwnPropertySymbols(obj).length > 0) {
      throw new CanonicalJsonError(path, "symbol-keyed properties have no JSON form");
    }
    if (Array.isArray(obj)) {
      // Explicit index walk with Object.hasOwn: iteration methods SKIP
      // holes, and the `in` operator sees INHERITED numeric properties —
      // a polluted Array.prototype[0] would silently fill a hole and
      // collide two different arrays (r1 finding 7; r2 finding 9). A hole
      // has no JSON form — refuse it with its path.
      const parts: string[] = [];
      for (let i = 0; i < obj.length; i += 1) {
        if (!Object.hasOwn(obj, i)) {
          throw new CanonicalJsonError(`${path}[${i}]`, "sparse-array hole");
        }
        parts.push(serialize(obj[i], `${path}[${i}]`, seen, depth + 1));
      }
      // Non-index own properties on an array (arr.note = "x") would be
      // silently discarded by JSON — refuse them instead.
      for (const key of Object.keys(obj)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= obj.length) {
          throw new CanonicalJsonError(
            `${path}.${key}`,
            "arrays with non-index own properties have no JSON form",
          );
        }
      }
      return `[${parts.join(",")}]`;
    }
    if (!isPlainObject(obj)) {
      throw new CanonicalJsonError(
        path,
        "only plain objects and arrays are canonicalizable (Date/Map/Set/RegExp/class instances are not)",
      );
    }
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const element: unknown = (obj as Record<string, unknown>)[key];
      parts.push(`${JSON.stringify(key)}:${serialize(element, `${path}.${key}`, seen, depth + 1)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

/**
 * The canonical serialization of `value`, or a CanonicalJsonError naming the
 * exact path that has no canonical form. Total over its declared domain:
 * equal values (after key ordering) always produce identical bytes.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, "$", new Set(), 0);
}

/** SHA-256 (lowercase hex) of the UTF-8 encoding of `text`. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
