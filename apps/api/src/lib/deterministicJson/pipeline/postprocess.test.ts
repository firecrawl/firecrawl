import { describe, expect, it } from "vitest";
import { parseWithSchema } from "./postprocess";

const stringSchema = { type: "string" };

describe("deterministic JSON string fidelity", () => {
  it.each([
    ["Persian non-joiner", "می\u200cروم"],
    ["Indic joiner", "क्\u200dष"],
    ["emoji profession", "👩\u200d⚕️"],
    ["emoji family", "👨\u200d👩\u200d👧\u200d👦"],
    ["word-break opportunity", "ภาษา\u200bไทย"],
    ["word-joiner constraint", "word\u2060joiner"],
  ])("preserves %s", (_name, value) => {
    expect(parseWithSchema(value, stringSchema)).toBe(value);
  });

  it("preserves meaningful format controls in nested fields and arrays", () => {
    const value = {
      display_name: "می\u200cروم 👩\u200d⚕️",
      labels: ["ภาษา\u200bไทย", "word\u2060joiner"],
      child: { text: "क्\u200dष" },
    };
    const schema = {
      type: "object",
      properties: {
        displayName: stringSchema,
        labels: { type: "array", items: stringSchema },
        child: { type: "object", properties: { text: stringSchema } },
      },
    };
    expect(parseWithSchema(value, schema)).toEqual({
      displayName: value.display_name,
      labels: value.labels,
      child: value.child,
    });
  });

  it("does not turn distinct records into duplicates by removing joiners", () => {
    const joined = { name: "👩\u200d⚕️" };
    const separate = { name: "👩⚕️" };
    const schema = {
      type: "array",
      items: { type: "object", properties: { name: stringSchema } },
    };
    expect(parseWithSchema([joined, separate, { ...joined }], schema)).toEqual([
      joined,
      separate,
    ]);
  });

  it("still strips control noise, icon glyphs and BOM while retaining newlines", () => {
    const value =
      " \ufeffA\u0000\u0007\u007f\u0085\ue001  B\nC\r\nD\u{f0001}\u{100001} ";
    expect(parseWithSchema(value, stringSchema)).toBe("A B\nC\r\nD");
  });

  it("keeps ordinary Unicode, combining marks and variation selectors", () => {
    const value = "中文 café e\u0301 ✈️";
    expect(parseWithSchema(value, stringSchema)).toBe(value);
  });

  it("retains schema remapping, defaults and optional-null removal", () => {
    const schema = {
      type: "object",
      properties: {
        displayName: stringSchema,
        total: { type: "integer" },
        optional: stringSchema,
        nullable: { type: ["string", "null"] },
      },
      required: ["total"],
    };
    expect(
      parseWithSchema(
        { display_name: "  A  B  ", optional: null, nullable: null },
        schema,
      ),
    ).toEqual({
      displayName: "A B",
      nullable: null,
      total: 0,
    });
  });

  it("keeps repeated scalar values and exact-object deduplication", () => {
    expect(
      parseWithSchema(["text", "text", { name: "A" }, { name: "A" }], {}),
    ).toEqual(["text", "text", { name: "A" }]);
  });
});
