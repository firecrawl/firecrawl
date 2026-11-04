import Ajv from "ajv";
import { describe, expect, it, vi } from "vitest";
vi.mock("../logger", () => ({ logger: {} }));
import { spreadSchemas } from "../extract/helpers/spread-schemas";
import { spreadSchemas_F0 } from "../extract/fire-0/helpers/spread-schemas-f0";

for (const split of [spreadSchemas, spreadSchemas_F0]) {
  describe(`${split.name} required partition`, () => {
    it("both generated schemas accept their independently valid extraction results", async () => {
      const schema = {
        type: "object", additionalProperties: false,
        properties: {
          title: { type: "string" },
          owners: { type: "array", items: { type: "string" } },
          locations: { type: "array", items: { type: "string" } },
        },
        required: ["title", "owners", "locations"],
      };
      const before = JSON.stringify(schema);
      const { singleAnswerSchema, multiEntitySchema } = await split(schema, ["owners", "locations"]);
      const ajv = new Ajv({ strictRequired: true });
      const single = ajv.compile(singleAnswerSchema);
      const multi = ajv.compile(multiEntitySchema);
      expect(single({ title: "owned" })).toBe(true);
      expect(single({})).toBe(false);
      expect(multi({ owners: ["owned"], locations: ["owned"] })).toBe(true);
      expect(multi({ owners: ["owned"] })).toBe(false);
      expect(multi({ locations: ["owned"] })).toBe(false);
      expect(singleAnswerSchema.required).toEqual(["title"]);
      expect(multiEntitySchema.required).toEqual(["owners", "locations"]);
      expect(JSON.stringify(schema)).toBe(before);
    });

    it("single moved root and repeated nested root paths retain required fields", async () => {
      const schema = {
        type: "object",
        properties: { title: { type: "string" }, owners: { type: "array", items: { type: "string" } } },
        required: ["title", "owners"],
      };
      const { singleAnswerSchema, multiEntitySchema } = await split(schema, ["owners.name", "owners.address", "missing"]);
      expect(singleAnswerSchema.required).toEqual(["title"]);
      expect(multiEntitySchema.required).toEqual(["owners"]);
      const ajv = new Ajv({ strictRequired: true });
      expect(ajv.compile(singleAnswerSchema)({ title: "owned" })).toBe(true);
      expect(ajv.compile(multiEntitySchema)({ owners: [] })).toBe(true);
    });
  });
}
