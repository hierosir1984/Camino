/**
 * The public barrel carries no runtime-mutable enforcement policy.
 *
 * THREAT MODEL (the WP-105 rounds-8/9 folds, generalized): a first-party
 * package-root importer — `import { X } from "@camino/shared"` — must not be
 * able to mutate an exported value and thereby change an enforcement or
 * classification decision. This is NOT the WP-107 boundary (deep import into
 * a module's internals, or mutation of a gated object handed out at runtime);
 * it is the ordinary public barrel, which every first-party package already
 * imports freely. `as const` and `Readonly<...>` are compile-time assertions
 * that erase entirely at runtime, so they close nothing here.
 *
 * Two mechanisms, because RegExps need the stronger one:
 *
 *   - arrays / records  → Object.freeze. Non-extensible and non-writable, so
 *     push/splice/assign throw under ESM's implicit strict mode.
 *   - RegExps           → NOT EXPORTED AT ALL, reachable only behind a
 *     predicate. Freezing a RegExp is INSUFFICIENT: the legacy (still
 *     normative, Annex B) `RegExp.prototype.compile()` replaces the pattern's
 *     internal source/flags and only THEN writes `lastIndex` — the write
 *     freeze turns into a TypeError. By the time it throws, the grammar has
 *     already been swapped, so `try { re.compile(".*") } catch {}` is a
 *     complete bypass of a frozen regex. Withholding the object is the
 *     boundary that does not depend on that ordering.
 *
 * The first two tests sweep the WHOLE barrel rather than a hand-kept list, so
 * a later WP that adds a mutable policy export trips them without anyone
 * remembering to update this file.
 *
 * BOUNDARY (stated, not hidden): this closes VALUE mutation through the
 * barrel. It does not address prototype pollution (`Array.prototype.includes`
 * and friends are global surface, not this package's export list) — an
 * unbounded class that no per-package freeze can close, and that a
 * first-party importer with code execution has many other routes to.
 */
import { describe, expect, it } from "vitest";
import * as barrel from "./index.js";
import {
  CANON_FACT_KINDS,
  INTENT_EVENTS,
  OPERATION_CLASSES,
  REQUIREMENT_ID_PATTERN_SOURCE,
  isRequirementId,
  isValidIntentId,
} from "./index.js";

type Entry = readonly [string, unknown];
const entries: readonly Entry[] = Object.entries(barrel);

describe("@camino/shared public barrel immutability", () => {
  it("exports at least the policy sets it is meant to guard (sweep is not vacuous)", () => {
    // Guards against the sweeps below silently passing on an empty list.
    expect(entries.length).toBeGreaterThan(10);
    const objectExports = entries.filter(([, v]) => typeof v === "object" && v !== null);
    expect(objectExports.length).toBeGreaterThan(5);
  });

  it("exports no live RegExp (compile() would rewrite the grammar in place)", () => {
    const exported = entries.filter(([, v]) => v instanceof RegExp).map(([k]) => k);
    expect(exported).toEqual([]);
  });

  it("freezes every exported object and array", () => {
    const unfrozen = entries
      .filter(([, v]) => typeof v === "object" && v !== null && !Object.isFrozen(v))
      .map(([k]) => k);
    expect(unfrozen).toEqual([]);
  });

  it("refuses writes to a frozen classification set (ESM strict mode)", () => {
    // Widening the closed §4.4 class set is what core's validateOperationSpec
    // consults; each of these is the reproduced bypass, now closed.
    expect(() => (OPERATION_CLASSES as unknown as string[]).push("exfiltrate")).toThrow(TypeError);
    expect(() => ((OPERATION_CLASSES as unknown as string[])[0] = "x")).toThrow(TypeError);
    expect(() => (INTENT_EVENTS as unknown as string[]).splice(0, 1)).toThrow(TypeError);
    expect(() => (CANON_FACT_KINDS as unknown as string[]).push("forged")).toThrow(TypeError);
    expect(OPERATION_CLASSES).toContain("catch-all");
    expect(OPERATION_CLASSES).not.toContain("exfiltrate");
  });

  it("keeps the requirement-id grammar unreachable, so compile() has no target", () => {
    expect("REQUIREMENT_ID_PATTERN" in barrel).toBe(false);
    expect(REQUIREMENT_ID_PATTERN_SOURCE).toBe("^CAM-([A-Z]+)-(\\d{2})([a-z])?$");
    // A string is immutable, and reconstructing a regex from it produces a
    // PRIVATE copy: rewriting the copy cannot affect the enforcing predicate.
    const copy = new RegExp(REQUIREMENT_ID_PATTERN_SOURCE);
    (copy as unknown as { compile: (s: string) => void }).compile(".*");
    expect(copy.test("total-junk")).toBe(true);
    expect(isRequirementId("total-junk")).toBe(false);
    expect(isRequirementId("CAM-CORE-01")).toBe(true);
  });

  it("keeps the intent-id grammar unreachable, so the containment proof holds", () => {
    expect("INTENT_ID_PATTERN" in barrel).toBe(false);
    // The delimiter characters the marker-token containment proof excludes.
    expect(isValidIntentId("intent-A]foreign")).toBe(false);
    expect(isValidIntentId("intent-A[foreign")).toBe(false);
    expect(isValidIntentId("intent:A")).toBe(false);
    expect(isValidIntentId("intent-A.2_ok")).toBe(true);
  });
});
