// WP-114: trusted toolchain resolution — the non-Docker half. The image
// build + provenance proof lives in container-obligations.test.ts.
import { describe, expect, it } from "vitest";
import { TRUSTED_TOOL_DIRS, ToolchainError, resolveTrustedTool } from "./image-provenance.js";

describe("resolveTrustedTool", () => {
  it("resolves a universal system tool to an absolute path inside the trusted dirs", () => {
    const sh = resolveTrustedTool("sh");
    expect(sh.startsWith("/")).toBe(true);
    expect(TRUSTED_TOOL_DIRS.some((dir) => sh === `${dir}/sh`)).toBe(true);
  });

  it("REFUSES a tool absent from the trusted dirs — no ambient-PATH fallback", () => {
    expect(() => resolveTrustedTool("definitely-not-a-real-tool-4471")).toThrow(ToolchainError);
    expect(() => resolveTrustedTool("definitely-not-a-real-tool-4471")).toThrow(
      /trusted directories/,
    );
  });

  it("refuses names that are not plain executable names (no paths, no traversal)", () => {
    for (const bad of ["../sh", "/bin/sh", "a b", "", ".hidden"]) {
      expect(() => resolveTrustedTool(bad)).toThrow(/plain executable name/);
    }
  });

  it("never consults $PATH: a PATH pointing at a writable dir changes nothing", () => {
    const original = process.env["PATH"];
    process.env["PATH"] = "/tmp";
    try {
      const sh = resolveTrustedTool("sh");
      expect(TRUSTED_TOOL_DIRS.some((dir) => sh === `${dir}/sh`)).toBe(true);
    } finally {
      process.env["PATH"] = original;
    }
  });
});
