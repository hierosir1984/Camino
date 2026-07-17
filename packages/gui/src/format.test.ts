import { describe, expect, it } from "vitest";
import { formatStateLabel } from "./format.js";

describe("formatStateLabel", () => {
  it("renders Appendix A states as readable labels", () => {
    expect(formatStateLabel("awaiting-merge-approval")).toBe("Awaiting merge approval");
    expect(formatStateLabel("queued-quota")).toBe("Queued quota");
    expect(formatStateLabel("complete-with-residue")).toBe("Complete with residue");
    expect(formatStateLabel("merged")).toBe("Merged");
  });

  it("is defensive about empty input", () => {
    expect(formatStateLabel("")).toBe("");
  });
});
