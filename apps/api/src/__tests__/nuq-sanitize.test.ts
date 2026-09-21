import { stripNulBytes } from "../services/worker/nuq";

// Regression coverage for firecrawl #4113: Postgres JSON rejects embedded NUL
// (\u0000) with error 22P05, which previously threw out of jobFinish and
// crash-looped the nuq-worker. stripNulBytes is applied to returnvalue
// (jobFinish) and failedReason (jobFail) before the UPDATE.
describe("stripNulBytes", () => {
  it("removes NUL bytes from nested objects and arrays (returnvalue shape)", () => {
    const input = {
      a: "x\u0000y",
      nested: { b: ["1\u00002", { c: "\u0000z" }] },
      "k\u0000ey": 1,
    };
    const expected = {
      a: "xy",
      nested: { b: ["12", { c: "z" }] },
      key: 1,
    };
    expect(stripNulBytes(input)).toEqual(expected);
  });

  it("is loss-free for NUL-free input (no whitespace collapse, control chars preserved)", () => {
    const input = {
      a: "normal",
      b: 1,
      c: null,
      d: ["keep", { e: "tabs\tand\nnewlines" }],
    };
    expect(stripNulBytes(input)).toEqual(input);
  });

  it("is idempotent (apply twice === apply once)", () => {
    const x = { a: "x\u0000y", nested: { b: ["1\u00002", { c: "\u0000z" }] } };
    expect(stripNulBytes(stripNulBytes(x))).toEqual(stripNulBytes(x));
  });

  it("strips NUL from a plain string (failedReason shape)", () => {
    expect(stripNulBytes("a\u0000b")).toBe("ab");
  });

  it("passes primitives and null through untouched", () => {
    expect(stripNulBytes(null as null)).toBeNull();
    expect(stripNulBytes(42)).toBe(42);
    expect(stripNulBytes(true)).toBe(true);
    expect(stripNulBytes(undefined as undefined)).toBeUndefined();
  });

  it("strips NUL at any depth and does not overflow the stack on pathologically deep nesting (iterative walk — a naive recursion would either cap out and leave NUL unsanitized, or throw RangeError, both reintroducing the #4113 crash)", () => {
    // 50,000 levels deep — far beyond a recursive call-stack budget (~3.4k) and
    // beyond any prior depth cap. The leaf carries a NUL that must still be
    // stripped, because the value serializes fine for pg and would otherwise
    // trigger 22P05 at the UPDATE.
    let deep: Record<string, unknown> = { leaf: "has\u0000nul" };
    for (let i = 0; i < 50_000; i++) {
      deep = { a: deep };
    }
    // Must not throw...
    let result: Record<string, unknown> = {} as Record<string, unknown>;
    expect(() => {
      result = stripNulBytes(deep) as Record<string, unknown>;
    }).not.toThrow();
    // ...and the deep NUL must actually be removed.
    let leaf: unknown = result;
    for (let i = 0; i < 50_000; i++) {
      leaf = (leaf as Record<string, unknown>).a;
    }
    expect((leaf as Record<string, unknown>).leaf).toBe("hasnul");
  });

  it("preserves an input __proto__ key as a normal own property (no NUL involved; a plain output object would silently drop it)", () => {
    // JSON.parse yields __proto__ as an own enumerable property; the sanitizer
    // must not lose it (it has no NUL and would otherwise round-trip fine).
    const input = JSON.parse('{"__proto__":"kept","normal":"yes"}');
    const result = stripNulBytes(input) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(["__proto__", "normal"]);
    expect(result.__proto__).toBe("kept");
    expect(result.normal).toBe("yes");
    // And it must not pollute Object.prototype globally.
    expect(({} as Record<string, unknown>).kept).toBeUndefined();
  });
});
