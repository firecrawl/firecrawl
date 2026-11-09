import { describe, expect, it } from "vitest";
import { mixSchemaObjects } from "../extract/helpers/mix-schema-objs";
import { mixSchemaObjects_F0 } from "../extract/fire-0/helpers/mix-schema-objs-f0";
import { transformArrayToObject } from "../extract/helpers/transform-array-to-obj";
import { transformArrayToObject_F0 } from "../extract/fire-0/helpers/transform-array-to-obj-f0";
import { mergeNullValObjs } from "../extract/helpers/merge-null-val-objs";
import { mergeNullValObjs_F0 } from "../extract/fire-0/helpers/merge-null-val-objs-f0";

for (const mix of [mixSchemaObjects, mixSchemaObjects_F0]) {
  describe(mix.name, () => {
    for (const side of ["single", "multi"] as const) {
      it(`preserves a JSON hasOwnProperty field in the ${side} result`, async () => {
        const data = JSON.parse('{"hasOwnProperty":"owned","title":"retained"}');
        const schema = { properties: { hasOwnProperty: { type: "string" }, title: { type: "string" } } };
        expect(await mix(schema, side === "single" ? data : {}, side === "multi" ? data : {})).toEqual(data);
      });
    }
    it("retains single-answer precedence and flattened multi-entity arrays", async () => {
      const schema = { properties: { title: { type: "string" }, items: { type: "array" } } };
      expect(await mix(schema, { title: "single" }, { title: "multi", items: [[1], [2]] })).toEqual({ title: "single", items: [1, 2] });
    });
  });
}
for (const transform of [transformArrayToObject, transformArrayToObject_F0]) {
  describe(transform.name, () => {
    it("preserves collided field names on parent and item objects", () => {
      const schema = { properties: {
        hasOwnProperty: { type: "string" },
        items: { type: "array", items: { properties: { hasOwnProperty: { type: "string" }, title: { type: "string" } } } },
      } };
      const data = JSON.parse('{"hasOwnProperty":"parent","items":[{"hasOwnProperty":"item","title":"owned"}]}');
      expect(transform(schema, [data])).toEqual(data);
    });
    it("preserves ordinary array item extraction", () => {
      const schema = { properties: { items: { type: "array", items: { properties: { title: { type: "string" } } } } } };
      expect(transform(schema, [{ items: [{ title: "owned" }] }])).toEqual({ items: [{ title: "owned" }] });
    });
  });
}
for (const merge of [mergeNullValObjs, mergeNullValObjs_F0]) {
  describe(merge.name, () => {
    it("fills null values while retaining a JSON hasOwnProperty field", () => {
      const rows = JSON.parse('[{"hasOwnProperty":"owned","id":"same","label":null},{"hasOwnProperty":"owned","id":"same","label":"resolved"}]');
      expect(merge({ rows })).toEqual({ rows: [{ hasOwnProperty: "owned", id: "same", label: "resolved" }] });
    });
    it("preserves ordinary matching row merges", () => {
      expect(merge({ rows: [{ id: "same", label: null }, { id: "same", label: "resolved" }] })).toEqual({ rows: [{ id: "same", label: "resolved" }] });
    });
  });
}
