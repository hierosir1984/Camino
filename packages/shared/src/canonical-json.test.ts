import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalJson, sha256Hex } from "./canonical-json.js";

describe("canonicalJson", () => {
  it("sorts object keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("is insensitive to key insertion order (the property the hash relies on)", () => {
    const first: Record<string, unknown> = {};
    first["z"] = 1;
    first["a"] = 2;
    const second: Record<string, unknown> = {};
    second["a"] = 2;
    second["z"] = 1;
    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  it("preserves array order (arrays are sequences, not sets)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it("serializes -0 and 0 identically (one canonical zero)", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson({ n: -0 })).toBe(canonicalJson({ n: 0 }));
  });

  it("escapes strings exactly as JSON.stringify does", () => {
    const tricky = 'quo"te\\back\nnew line\u0000nul';
    expect(canonicalJson(tricky)).toBe(JSON.stringify(tricky));
    expect(JSON.parse(canonicalJson(tricky))).toBe(tricky);
  });

  it("round-trips through JSON.parse to an equal value", () => {
    const value = { list: [1, "two", null, true], nested: { x: 0.5 } };
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
  });

  const refusals: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
    ["a bigint", 1n],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["a Set", new Set()],
    ["a RegExp", /x/],
    ["a class instance", new (class Thing {})()],
  ];
  for (const [label, value] of refusals) {
    it(`refuses ${label} instead of silently coercing`, () => {
      expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
    });
  }

  it("refuses nested unserializable values and names the path", () => {
    expect(() => canonicalJson({ terms: { criteria: ["ok", undefined] } })).toThrow(
      /\$\.terms\.criteria\[1\]/,
    );
  });

  it("refuses circular references instead of recursing forever", () => {
    const a: Record<string, unknown> = {};
    a["self"] = a;
    expect(() => canonicalJson(a)).toThrow(/circular/);
  });

  it("accepts null-prototype objects (the recorder's payload shape)", () => {
    const obj = Object.create(null) as Record<string, unknown>;
    obj["k"] = 1;
    expect(canonicalJson(obj)).toBe('{"k":1}');
  });

  it("does not treat repeated (non-circular) references as cycles", () => {
    const leaf = { v: 1 };
    expect(canonicalJson({ a: leaf, b: leaf })).toBe('{"a":{"v":1},"b":{"v":1}}');
  });
});

describe("sha256Hex", () => {
  it("matches the published SHA-256 test vector for the empty string", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("matches the published SHA-256 test vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes the UTF-8 encoding (non-ASCII differs from any ASCII input)", () => {
    expect(sha256Hex("é")).not.toBe(sha256Hex("e"));
    expect(sha256Hex("é")).toMatch(/^[0-9a-f]{64}$/);
  });
});
