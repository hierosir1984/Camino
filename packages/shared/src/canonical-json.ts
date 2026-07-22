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
 * The DOMAIN is deliberately narrow: plain data — a strict SUBSET of what
 * JSON.parse can produce (nesting is bounded at 256 levels, so a legal but
 * deeper JSON document refuses; property writability/configurability is
 * deliberately not part of the test — a frozen data property carries the
 * same value). Everything else REFUSES loudly with its path:
 * undefined, functions, symbols and symbol-keyed properties, bigints,
 * non-finite numbers, non-plain objects (Date/Map/Set/RegExp/class
 * instances), Proxy exotic objects, sparse-array holes and array expando
 * properties, non-enumerable own properties, ACCESSOR properties (a getter
 * has no stable value — evaluating it can throw, observe, or return a
 * different value per read, r3 finding 5), and nesting beyond a named
 * bound. JSON.stringify's habit of silently dropping or coercing such
 * values is exactly what a content hash cannot tolerate — two different
 * inputs must never quietly serialize to the same bytes, and serializing
 * the same input twice must never differ.
 */
import { createHash } from "node:crypto";
import { types } from "node:util";

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

/**
 * A property participates only as an own, enumerable DATA property — the
 * only shape JSON.parse produces. Hidden (non-enumerable) own state would
 * silently vanish ({} and a secret-carrying object would hash alike), and
 * an accessor's value is not stable across reads (r3 finding 5).
 */
function assertDataProperty(owner: object, key: string | number, path: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor === undefined) {
    throw new CanonicalJsonError(path, "property vanished mid-serialization");
  }
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    throw new CanonicalJsonError(path, "accessor properties have no stable JSON form");
  }
  if (descriptor.enumerable !== true) {
    throw new CanonicalJsonError(path, "non-enumerable own properties have no JSON form");
  }
}

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
  if (types.isProxy(obj)) {
    // A Proxy can lie to every introspection below, per call — no stable
    // canonical form exists for it (r3 finding 5's exotica class).
    throw new CanonicalJsonError(path, "Proxy exotic objects have no stable JSON form");
  }
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
        assertDataProperty(obj, i, `${path}[${i}]`);
        parts.push(serialize(obj[i], `${path}[${i}]`, seen, depth + 1));
      }
      // Own properties beyond the indices — expandos (arr.note = "x"),
      // enumerable or hidden — would be silently discarded by JSON:
      // refuse them instead ("length" is the array's own bookkeeping).
      for (const key of Object.getOwnPropertyNames(obj)) {
        if (key === "length") continue;
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
    // Walk ALL own string-named properties (not just enumerable ones) so a
    // hidden property is a refusal, never a silent omission (r3 finding 5).
    const keys = Object.getOwnPropertyNames(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      assertDataProperty(obj, key, `${path}.${key}`);
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
 * equal values (after key ordering) always produce identical bytes, and
 * because only data properties are read, serializing the same value twice
 * always produces the same bytes.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, "$", new Set(), 0);
}

/** SHA-256 (lowercase hex) of the UTF-8 encoding of `text`. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
