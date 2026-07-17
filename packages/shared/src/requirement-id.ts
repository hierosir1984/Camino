/**
 * Stable requirement IDs, `CAM-AREA-NN` (PRD change-control convention).
 * A trailing letter suffix is allowed for split requirements (e.g. CAM-VAL-06a).
 */
export const REQUIREMENT_ID_PATTERN = /^CAM-([A-Z]+)-(\d{2})([a-z])?$/;

export interface RequirementId {
  readonly area: string;
  readonly number: number;
  readonly suffix: string | undefined;
}

export function isRequirementId(value: string): boolean {
  return REQUIREMENT_ID_PATTERN.test(value);
}

/** Parse a requirement ID, throwing on malformed input. */
export function parseRequirementId(value: string): RequirementId {
  const match = REQUIREMENT_ID_PATTERN.exec(value);
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
