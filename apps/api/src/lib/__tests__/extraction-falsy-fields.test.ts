import { describe, expect, it } from "vitest";
import { transformArrayToObject } from "../extract/helpers/transform-array-to-obj";
import { transformArrayToObject_F0 } from "../extract/fire-0/helpers/transform-array-to-obj-f0";
for (const transform of [transformArrayToObject, transformArrayToObject_F0]) {
  describe(transform.name, () => {
    for (const [value, replacement, type] of [[false, true, "boolean"], [0, 5, "number"], ["", "later", "string"]] as const) {
      it(`retains first ${type} answer ${JSON.stringify(value)} without an array schema`, () => {
        const schema = { properties: { answer: { type } } };
        expect(transform(schema, [{ answer: value }, { answer: replacement }])).toEqual({ answer: value });
      });
    }
    it("continues filling null and undefined first values", () => {
      const schema = { properties: { answer: { type: "string" } } };
      for (const value of [null, undefined]) {
        expect(transform(schema, [{ answer: value }, { answer: "resolved" }])).toEqual({ answer: "resolved" });
        expect(transform(schema, [{ answer: value }, { answer: { nested: "resolved" } }])).toEqual({ answer: { nested: "resolved" } });
      }
    });
    it("retains ordinary first-value precedence and complementary keys", () => {
      expect(transform({ properties: { answer: { type: "string" }, other: { type: "string" } } }, [{ answer: "first" }, { answer: "later", other: "added" }])).toEqual({ answer: "first", other: "added" });
    });
    it("retains first falsy parent value when an array schema is present", () => {
      expect(transform({ properties: { answer: { type: "boolean" }, values: { type: "array", items: { type: "number" } } } }, [{ answer: false, values: [1] }, { answer: true, values: [2] }])).toEqual({ answer: false, values: [1, 2] });
    });
  });
}
