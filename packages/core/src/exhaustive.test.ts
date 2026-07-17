import { describe, expect, it } from "vitest";
import { exhaustive } from "./exhaustive.js";

type Demo = "a" | "b";

function handle(value: Demo): string {
  switch (value) {
    case "a":
      return "A";
    case "b":
      return "B";
    default:
      return exhaustive(value, "Demo");
  }
}

describe("exhaustive", () => {
  it("never fires when every variant is handled", () => {
    expect(handle("a")).toBe("A");
    expect(handle("b")).toBe("B");
  });

  it("throws with context on an illegal runtime value", () => {
    expect(() => handle("c" as Demo)).toThrowError(/Unhandled Demo: "c"/);
  });
});
