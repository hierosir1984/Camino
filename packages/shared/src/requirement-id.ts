/**
 * Stable requirement IDs, `CAM-AREA-NN` (PRD change-control convention).
 * A trailing letter suffix is allowed for split requirements (e.g. CAM-VAL-06a).
 *
 * MODULE-PRIVATE by design: an exported RegExp is enforcement policy any
 * package-root importer could rewrite, and Object.freeze does NOT close that.
 * `RegExp.prototype.compile()` (legacy, still normative in Annex B) replaces
 * [[OriginalSource]]/[[OriginalFlags]] and only THEN writes `lastIndex` — the
 * write freeze turns into a TypeError. The pattern is already swapped by the
 * time it throws, so a caller that wraps the call in try/catch keeps the whole
 * bypass. Not exporting the object is the boundary that does not depend on
 * that ordering; the immutable SOURCE string below covers messages and tests.
 * (Same shape as WP-105's CREDENTIAL_SHAPED_PATTERN.)
 */
const REQUIREMENT_ID_RE = /^CAM-([A-Z]+)-(\d{2})([a-z])?$/;

/** The grammar's pattern text, for error messages and tests. Strings are immutable. */
export const REQUIREMENT_ID_PATTERN_SOURCE: string = REQUIREMENT_ID_RE.source;

export interface RequirementId {
  readonly area: string;
  readonly number: number;
  readonly suffix: string | undefined;
}

export function isRequirementId(value: string): boolean {
  return REQUIREMENT_ID_RE.test(value);
}

/** Parse a requirement ID, throwing on malformed input. */
export function parseRequirementId(value: string): RequirementId {
  const match = REQUIREMENT_ID_RE.exec(value);
  if (!match) {
    throw new Error(`Malformed requirement ID: ${JSON.stringify(value)} (expected CAM-AREA-NN)`);
  }
  const [, area, digits, suffix] = match;
  return { area: area as string, number: Number(digits), suffix };
}

export function formatRequirementId(id: RequirementId): string {
  const digits = String(id.number).padStart(2, "0");
  return `CAM-${id.area}-${digits}${id.suffix ?? ""}`;
}
