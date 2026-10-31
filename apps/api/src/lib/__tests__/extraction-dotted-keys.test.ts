import { describe, expect, it, vi } from "vitest";
import Ajv from "ajv";
vi.mock("../logger", () => ({ logger: { error: vi.fn() } }));
import { SourceTracker } from "../extract/helpers/source-tracker";
import { SourceTracker_F0 } from "../extract/fire-0/helpers/source-tracker-f0";
import { spreadSchemas } from "../extract/helpers/spread-schemas";
import { spreadSchemas_F0 } from "../extract/fire-0/helpers/spread-schemas-f0";
import { transformArrayToObject } from "../extract/helpers/transform-array-to-obj";
import { transformArrayToObject_F0 } from "../extract/fire-0/helpers/transform-array-to-obj-f0";
for (const transform of [transformArrayToObject, transformArrayToObject_F0]) {
  describe(transform.name, () => {
    it("preserves a literal dotted root array property", () => {
      const schema = { type: "object", properties: { "list.values": { type: "array", items: { type: "number" } } } };
      const data = { "list.values": [1, 2] };
      expect(new Ajv().compile(schema)(data)).toBe(true);
      expect(transform(schema, [data])).toEqual(data);
    });
    it("preserves dotted object and array property segments", () => {
      const schema = { type: "object", properties: { "parent.name": { type: "object", properties: { "list.values": { type: "array", items: { type: "number" } } } } } };
      const data = { "parent.name": { "list.values": [1, 2] } };
      expect(new Ajv().compile(schema)(data)).toBe(true);
      expect(transform(schema, [data])).toEqual(data);
    });
    it("preserves nested dotted keys through the actual split and SourceTracker producer path", async () => {
      const schema = { type: "object", properties: { parent: { type: "object", properties: { "list.values": { type: "array", items: { type: "number" } } } } } };
      const data = { parent: { "list.values": [1, 2] } };
      const f0 = transform === transformArrayToObject_F0;
      const split = f0 ? spreadSchemas_F0 : spreadSchemas;
      const { multiEntitySchema } = await split(schema, ["parent.list.values"]);
      expect(new Ajv().compile(multiEntitySchema)(data)).toBe(true);
      const tracker = f0 ? new SourceTracker_F0() : new SourceTracker();
      const result = f0
        ? (tracker as SourceTracker_F0).transformResults_F0([{ extract: data, url: "https://owned.test" }], multiEntitySchema, false)
        : (tracker as SourceTracker).transformResults([{ extract: data, url: "https://owned.test" }], multiEntitySchema, false);
      expect(result).toEqual([{ transformed: data, url: "https://owned.test" }]);
    });
    it("retains ordinary nested paths", () => {
      const schema = { properties: { parent: { type: "object", properties: { values: { type: "array", items: { type: "number" } } } } } };
      expect(transform(schema, [{ parent: { values: [1] } }, { parent: { values: [2] } }])).toEqual({ parent: { values: [1, 2] } });
    });
  });
}
