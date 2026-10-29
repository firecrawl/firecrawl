import { dereferenceSchema } from "../dereference-schema";

describe("dereferenceSchema", () => {
  it("inlines an internal $ref pointer", async () => {
    const schema = {
      type: "object",
      properties: {
        user: { $ref: "#/definitions/User" },
      },
      definitions: {
        User: { type: "object", properties: { name: { type: "string" } } },
      },
    };

    const result = await dereferenceSchema(schema);

    expect(result.properties.user).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
    });
  });

  it("resolves nested refs (a ref target that itself contains a ref)", async () => {
    const schema = {
      properties: { a: { $ref: "#/definitions/A" } },
      definitions: {
        A: { properties: { b: { $ref: "#/definitions/B" } } },
        B: { type: "number" },
      },
    };

    const result = await dereferenceSchema(schema);

    expect(result.properties.a.properties.b).toEqual({ type: "number" });
  });

  it("does not mutate the input schema", async () => {
    const schema = {
      properties: { user: { $ref: "#/definitions/User" } },
      definitions: { User: { type: "string" } },
    };

    await dereferenceSchema(schema);

    expect(schema.properties.user).toEqual({ $ref: "#/definitions/User" });
  });

  it("breaks self-referential cycles without infinite recursion", async () => {
    const schema = {
      definitions: {
        Node: {
          type: "object",
          properties: { next: { $ref: "#/definitions/Node" } },
        },
      },
      properties: { root: { $ref: "#/definitions/Node" } },
    };

    const result = await dereferenceSchema(schema);

    // One level is inlined; the cycle back to Node is left as a $ref.
    expect(result.properties.root.type).toBe("object");
    expect(result.properties.root.properties.next).toEqual({
      $ref: "#/definitions/Node",
    });
  });

  it("leaves an unresolvable internal pointer as-is", async () => {
    const schema = { properties: { z: { $ref: "#/definitions/Missing" } } };

    const result = await dereferenceSchema(schema);

    expect(result.properties.z).toEqual({ $ref: "#/definitions/Missing" });
  });
});
