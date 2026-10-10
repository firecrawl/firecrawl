import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { mixSchemaObjects } from "../extract/helpers/mix-schema-objs";
import { mixSchemaObjects_F0 } from "../extract/fire-0/helpers/mix-schema-objs-f0";
import { transformArrayToObject } from "../extract/helpers/transform-array-to-obj";
import { transformArrayToObject_F0 } from "../extract/fire-0/helpers/transform-array-to-obj-f0";
import { deduplicateObjectsArray } from "../extract/helpers/deduplicate-objs-array";
import { deduplicateObjectsArray_F0 } from "../extract/fire-0/helpers/deduplicate-objs-array-f0";
import { mergeNullValObjs } from "../extract/helpers/merge-null-val-objs";
import { mergeNullValObjs_F0 } from "../extract/fire-0/helpers/merge-null-val-objs-f0";
for (const [mix, transform, deduplicate, merge] of [
  [mixSchemaObjects, transformArrayToObject, deduplicateObjectsArray, mergeNullValObjs],
  [mixSchemaObjects_F0, transformArrayToObject_F0, deduplicateObjectsArray_F0, mergeNullValObjs_F0],
] as const) {
  describe(mix.name, () => {
    it("preserves schema-declared arrays of arrays", async () => {
      const schema = { type: "object", properties: { matrix: { type: "array", items: { type: "array", items: { type: "number" } } } } };
      const data = { matrix: [[1, 2], [3, 4]] };
      const validate = new Ajv().compile(schema);
      expect(validate(data)).toBe(true);
      const result = await mix(schema, {}, data);
      expect(validate(result)).toBe(true);
      expect(result).toEqual(data);
    });
    it("preserves nested object matrix fields", async () => {
      const schema = { properties: { nested: { type: "object", properties: { matrix: { type: "array", items: { type: "array", items: { type: "string" } } } } } } };
      const data = { nested: { matrix: [["a"], ["b"]] } };
      expect(await mix(schema, {}, data)).toEqual(data);
    });
    it("retains matrix rank through the extraction completion producer pipeline", async () => {
      const schema = { type: "object", properties: { matrix: { type: "array", items: { type: "array", items: { type: "number" } } } } };
      const completions = [{ matrix: [[1, 2]] }, { matrix: [[3, 4]] }];
      const validate = new Ajv().compile(schema);
      expect(completions.every(completion => validate(completion))).toBe(true);
      const transformed = transform(schema, completions);
      expect(transformed).toEqual({ matrix: [[1, 2], [3, 4]] });
      const result = await mix(schema, {}, merge(deduplicate(transformed)));
      expect(validate(result)).toBe(true);
      expect(result).toEqual({ matrix: [[1, 2], [3, 4]] });
    });
    it("retains scalar rank through the same completion producer pipeline", async () => {
      const schema = { type: "object", properties: { values: { type: "array", items: { type: "number" } } } };
      const transformed = transform(schema, [{ values: [1] }, { values: [2] }]);
      expect(await mix(schema, {}, merge(deduplicate(transformed)))).toEqual({ values: [1, 2] });
    });
    it("continues flattening chunk wrappers for scalar-item arrays", async () => {
      const schema = { properties: { values: { type: "array", items: { type: "number" } } } };
      expect(await mix(schema, {}, { values: [[1], [2]] })).toEqual({ values: [1, 2] });
    });
  });
}
