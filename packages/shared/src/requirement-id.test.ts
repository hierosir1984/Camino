import { describe, expect, it } from "vitest";
import {
  formatRequirementId,
  isRequirementId,
  parseRequirementId,
  REQUIREMENT_ID_PATTERN,
} from "./requirement-id.js";

describe("requirement IDs", () => {
  it("accepts plain and suffixed PRD IDs", () => {
    expect(isRequirementId("CAM-CORE-01")).toBe(true);
    expect(isRequirementId("CAM-STATE-06")).toBe(true);
    expect(isRequirementId("CAM-VAL-06a")).toBe(true);
  });

  it("rejects malformed IDs", () => {
    for (const bad of ["CAM-CORE-1", "cam-core-01", "CAM-CORE-01x2", "CORE-01", "CAM--01", ""]) {
      expect(isRequirementId(bad), bad).toBe(false);
    }
  });

  it("round-trips parse/format", () => {
    for (const id of ["CAM-CORE-08", "CAM-VAL-06a", "CAM-ROUTE-08"]) {
      expect(formatRequirementId(parseRequirementId(id))).toBe(id);
    }
  });

  it("throws with the offending value on malformed input", () => {
    expect(() => parseRequirementId("CAM-nope")).toThrowError(/CAM-nope/);
  });

  it("pattern stays anchored (no partial matches)", () => {
    expect(REQUIREMENT_ID_PATTERN.test("xxCAM-CORE-01yy")).toBe(false);
  });
});
