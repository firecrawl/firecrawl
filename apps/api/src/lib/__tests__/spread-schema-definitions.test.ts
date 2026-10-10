import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { dereferenceSchema } from "../extract/helpers/dereference-schema";
import { spreadSchemas } from "../extract/helpers/spread-schemas";
import { spreadSchemas_F0 } from "../extract/fire-0/helpers/spread-schemas-f0";
for (const split of [spreadSchemas, spreadSchemas_F0]) {
  describe(split.name, () => {
    for (const defs of ["$defs", "definitions"]) {
      it(`retains recursive ${defs} references through dereferencing and splitting`, async () => {
        const schema = { type: "object", properties: { label: { type: "string" }, rows: { type: "array", items: { $ref: `#/${defs}/Node` } } }, [defs]: { Node: { type: "object", properties: { value: { type: "string" }, child: { $ref: `#/${defs}/Node` } }, required: ["value"] } } };
        const valid = { rows: [{ value: "root", child: { value: "leaf" } }] };
        expect(new Ajv().compile(schema)(valid)).toBe(true);
        const dereferenced = await dereferenceSchema(schema);
        const { singleAnswerSchema, multiEntitySchema } = await split(dereferenced, ["rows"]);
        const validate = new Ajv().compile(multiEntitySchema);
        expect(validate(valid)).toBe(true);
        expect(validate({ rows: [{ value: "root", child: { value: 42 } }] })).toBe(false);
        expect(new Ajv().compile(singleAnswerSchema)({ label: "ok" })).toBe(true);
      });
    }
    it("keeps ordinary schemas valid without adding definitions", async () => {
      const { multiEntitySchema } = await split({ type: "object", properties: { rows: { type: "array", items: { type: "string" } } } }, ["rows"]);
      expect(new Ajv().compile(multiEntitySchema)({ rows: ["ok"] })).toBe(true);
      expect(multiEntitySchema).not.toHaveProperty("$defs");
      expect(multiEntitySchema).not.toHaveProperty("definitions");
    });
    it("retains independently registered absolute external references", async () => {
      const schema = { type: "object", properties: { rows: { type: "array", items: { $ref: "https://schema.example.test/item" } } } };
      const { multiEntitySchema } = await split(await dereferenceSchema(schema), ["rows"]);
      const ajv = new Ajv().addSchema({ $id: "https://schema.example.test/item", type: "string" });
      expect(ajv.compile(multiEntitySchema)({ rows: ["ok"] })).toBe(true);
    });
  });
}
