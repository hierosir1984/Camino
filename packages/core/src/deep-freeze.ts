/**
 * Deep structural freeze for the values the core barrel exports (the
 * Appendix A machine tables, projection rule rows, enrichment records,
 * state sets).
 *
 * `Object.freeze` is SHALLOW: freezing a MachineDef would leave every
 * transition row, guard object, and `from` array mutable — and a mutated
 * row changes which state changes are legal. `as const` and `Readonly<...>`
 * erase at runtime and close nothing. So every value export on the barrel
 * goes through this helper, which freezes the whole reachable graph at
 * module load and REFUSES the shapes freeze cannot make immutable:
 *
 *   - values carrying internal mutable state freeze does not reach: a
 *     frozen Set still accepts .add(), a frozen Date .setTime(), and a
 *     frozen RegExp still rewrites its grammar through the legacy
 *     compile() (see the @camino/shared barrel-immutability suite).
 *     Detected structurally rather than by a type list: only null-/
 *     Object.prototype-/Array-/Function-prototyped values are admitted,
 *     which excludes every exotic built-in and every class instance.
 *     Such values stay module-private behind a function instead
 *     (canon-status's SHA_PATTERN is the in-package precedent).
 *   - accessor properties — a getter is behavior where the table promises
 *     data, re-run on every read.
 *
 * Functions reachable INSIDE a table (guard `check`, target `derive`) are
 * frozen too: the containing slot and the function's own properties are
 * what a barrel importer could otherwise retarget. Closure variables are
 * beyond any freeze — that boundary is stated in the barrel sweep, which
 * re-verifies the frozen graph with an independent walker
 * (barrel-immutability.test.ts), so a defect here cannot certify itself.
 *
 * Runs once, at module load, over literals this package authors: a
 * violation throws deterministically on first import — an authoring error
 * every test run catches, not a runtime hazard.
 */

const ADMITTED_PROTOTYPES: ReadonlySet<unknown> = new Set([
  Object.prototype,
  Array.prototype,
  Function.prototype,
  null,
]);

export function deepFreeze<T>(value: T): T {
  freezeGraph(value, "value", new Set());
  return value;
}

function freezeGraph(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  const node: object = value;
  if (seen.has(node)) return;
  seen.add(node);
  if (!ADMITTED_PROTOTYPES.has(Object.getPrototypeOf(node))) {
    throw new Error(
      `deepFreeze(${path}): freeze cannot make this value immutable (exotic built-in or ` +
        `class instance); keep it module-private behind a function instead`,
    );
  }
  Object.freeze(node);
  for (const key of Reflect.ownKeys(node)) {
    const descriptor = Object.getOwnPropertyDescriptor(node, key);
    if (descriptor === undefined) continue;
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new Error(
        `deepFreeze(${path}.${String(key)}): accessor property where the table promises data`,
      );
    }
    freezeGraph(descriptor.value, `${path}.${String(key)}`, seen);
  }
}
