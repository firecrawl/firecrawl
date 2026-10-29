import { z } from "zod";
import {
  addStrictSchemaIssue,
  findStrictSchemaViolation,
  normalizeSchemaKeywords,
  toRootSchema,
} from "./openai-strict-schema";

describe("normalizeSchemaKeywords", () => {
  it("lowercases type names, including nested and nullable ones", () => {
    const result = normalizeSchemaKeywords({
      type: "Object",
      properties: {
        name: { type: "String" },
        count: { type: ["Integer", "null"] },
        tags: { type: "Array", items: { type: "String" } },
      },
    });

    expect(result).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: ["integer", "null"] },
        tags: { type: "array", items: { type: "string" } },
      },
    });
  });

  it("turns oneOf into anyOf", () => {
    const result = normalizeSchemaKeywords({
      type: "object",
      properties: {
        slot: { oneOf: [{ type: "string" }, { type: "Number" }] },
      },
    });

    expect(result.properties.slot).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
  });

  it("infers a missing type from properties or items below the root", () => {
    const result = normalizeSchemaKeywords({
      type: "object",
      properties: {
        identity: { properties: { name: { type: "string" } } },
        list: { items: { type: "string" } },
      },
    });

    expect(result.properties.identity.type).toBe("object");
    expect(result.properties.list.type).toBe("array");
  });

  it("leaves a root map of property names alone, even with an 'items' field", () => {
    const schema = {
      items: { type: "array", items: { type: "string" } },
      total: { type: "number" },
    };

    expect(normalizeSchemaKeywords(schema)).toEqual(schema);
  });

  it("infers object for a typeless root that only uses schema keywords", () => {
    const result = normalizeSchemaKeywords({
      $schema: "http://json-schema.org/draft-07/schema#",
      properties: { name: { type: "string" } },
      required: ["name"],
    });

    expect(result.type).toBe("object");
  });

  it("drops additionalProperties schemas next to properties", () => {
    const result = normalizeSchemaKeywords({
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: { type: "array" },
    });

    expect(result.additionalProperties).toBe(false);
  });

  it("does not modify its input", () => {
    const schema = { type: "String" };
    normalizeSchemaKeywords(schema);
    expect(schema.type).toBe("String");
  });
});

describe("toRootSchema", () => {
  it("turns a bare map into an object schema, skipping $schema", () => {
    expect(
      toRootSchema({
        $schema: "http://json-schema.org/draft-07/schema#",
        name: { type: "String" },
      }),
    ).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
  });

  it("keeps $-named fields other than annotations, and moves $defs to the root", () => {
    expect(
      toRootSchema({
        $schema: "http://json-schema.org/draft-07/schema#",
        $metadata: { type: "string" },
        item: { $ref: "#/$defs/item" },
        $defs: { item: { type: "object", properties: {} } },
      }),
    ).toEqual({
      type: "object",
      properties: {
        $metadata: { type: "string" },
        item: { $ref: "#/$defs/item" },
      },
      required: ["$metadata", "item"],
      additionalProperties: false,
      $defs: { item: { type: "object", properties: {} } },
    });
  });

  it("treats a field named 'properties' as a field, not as a schema keyword", () => {
    const result = toRootSchema({
      title: { type: "string" },
      properties: {
        type: "array",
        items: { type: "object", properties: { price: { type: "number" } } },
      },
    });

    expect(result.type).toBe("object");
    expect(Object.keys(result.properties)).toEqual(["title", "properties"]);
    expect(result.properties.properties.type).toBe("array");
  });

  it("keeps a typeless root schema a schema", () => {
    const result = toRootSchema({
      title: "Listing",
      properties: { price: { type: "number" } },
      required: ["price"],
    });

    expect(result).toEqual({
      title: "Listing",
      type: "object",
      properties: { price: { type: "number" } },
      required: ["price"],
    });
  });
});

describe("findStrictSchemaViolation", () => {
  it("accepts a plain object schema", () => {
    expect(
      findStrictSchemaViolation({
        type: "object",
        properties: {
          title: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["open", "closed"] },
          price: { anyOf: [{ type: "number" }, { type: "null" }] },
        },
        required: ["title"],
      }),
    ).toBeNull();
  });

  it("accepts undefined (no schema)", () => {
    expect(findStrictSchemaViolation(undefined)).toBeNull();
  });

  it("accepts what normalizeSchemaKeywords fixes", () => {
    expect(
      findStrictSchemaViolation({
        type: "object",
        properties: {
          name: { type: "String" },
          slot: { oneOf: [{ type: "string" }, { type: "integer" }] },
          identity: { properties: { value: { type: "string" } } },
        },
      }),
    ).toBeNull();
  });

  it("accepts a root map of property names to schemas", () => {
    expect(
      findStrictSchemaViolation({
        $schema: "http://json-schema.org/draft-07/schema#",
        judgments: {
          type: "array",
          items: {
            type: "object",
            properties: { citation: { type: "string" } },
          },
        },
      }),
    ).toBeNull();
  });

  it("accepts a bare map with a field named 'properties'", () => {
    expect(
      findStrictSchemaViolation({
        title: { type: "string" },
        properties: { type: "array", items: { type: "string" } },
      }),
    ).toBeNull();
  });

  it("accepts nullable root arrays", () => {
    expect(
      findStrictSchemaViolation({
        type: ["array", "null"],
        items: { type: "string" },
      }),
    ).toBeNull();
  });

  it("rejects roots that are neither objects nor arrays", () => {
    expect(findStrictSchemaViolation({ type: "string" })).toBe(
      'Invalid JSON schema: the root must be an object or array schema, got type "string".',
    );
    expect(
      findStrictSchemaViolation({
        anyOf: [{ type: "object", properties: {} }, { type: "null" }],
      }),
    ).toBe(
      'Invalid JSON schema: the root must be an object or array schema, not "anyOf".',
    );
  });

  it("checks definitions behind a root $ref", () => {
    expect(
      findStrictSchemaViolation({
        $ref: "#/$defs/listing",
        $defs: {
          listing: {
            type: "object",
            properties: { photos: { type: "array" } },
          },
        },
      }),
    ).toBe(
      'Invalid JSON schema at "$defs.listing.properties.photos": arrays must define "items".',
    );
  });

  it("checks keywords next to a $ref", () => {
    expect(
      findStrictSchemaViolation({
        type: "object",
        properties: { node: { $ref: "#/$defs/node", allOf: [] } },
        $defs: { node: { type: "object", properties: {} } },
      }),
    ).toBe(
      'Invalid JSON schema at "properties.node": "allOf" is not supported for JSON extraction.',
    );
  });

  it("accepts recursive schemas using $ref", () => {
    expect(
      findStrictSchemaViolation({
        type: "object",
        properties: { root: { $ref: "#/$defs/node" } },
        $defs: {
          node: {
            type: "object",
            properties: {
              children: { type: "array", items: { $ref: "#/$defs/node" } },
            },
          },
        },
      }),
    ).toBeNull();
  });

  it("rejects arrays without items, naming the path", () => {
    expect(
      findStrictSchemaViolation({
        type: "object",
        properties: {
          centers: {
            type: "array",
            items: {
              type: "object",
              properties: { professionals: { type: "array" } },
            },
          },
        },
      }),
    ).toBe(
      'Invalid JSON schema at "properties.centers.items.properties.professionals": arrays must define "items".',
    );
  });

  it("rejects tuple-style items", () => {
    expect(
      findStrictSchemaViolation({
        type: "object",
        properties: {
          row: {
            type: "array",
            items: [{ type: "string" }, { type: "number" }],
          },
        },
      }),
    ).toContain('"items" must be a single schema object');
  });

  it.each([
    "allOf",
    "not",
    "if",
    "then",
    "else",
    "dependentRequired",
    "dependentSchemas",
  ])("rejects %s", keyword => {
    expect(
      findStrictSchemaViolation({
        type: "object",
        properties: {
          data: { type: "object", properties: {}, [keyword]: [] },
        },
      }),
    ).toBe(
      `Invalid JSON schema at "properties.data": "${keyword}" is not supported for JSON extraction.`,
    );
  });

  it("rejects oneOf when anyOf is also present", () => {
    expect(
      findStrictSchemaViolation({
        type: "object",
        properties: {
          slot: {
            anyOf: [{ type: "string" }],
            oneOf: [{ type: "number" }],
          },
        },
      }),
    ).toBe(
      'Invalid JSON schema at "properties.slot": "oneOf" is not supported for JSON extraction.',
    );
  });

  it("rejects non-object properties and non-array anyOf", () => {
    expect(
      findStrictSchemaViolation({
        type: "object",
        properties: { data: { type: "object", properties: ["a", "b"] } },
      }),
    ).toBe(
      'Invalid JSON schema at "properties.data": "properties" must be an object, got ["a","b"].',
    );
    expect(
      findStrictSchemaViolation({
        type: "object",
        properties: { slot: { anyOf: { type: "string" } } },
      }),
    ).toBe(
      'Invalid JSON schema at "properties.slot": "anyOf" must be an array, got {"type":"string"}.',
    );
  });

  it("ignores additionalProperties schemas next to properties", () => {
    expect(
      findStrictSchemaViolation({
        type: "object",
        properties: { name: { type: "string" } },
        additionalProperties: { type: "array" },
      }),
    ).toBeNull();
  });

  it("rejects typed dictionaries", () => {
    expect(
      findStrictSchemaViolation({
        type: "object",
        properties: {
          prices: { type: "object", additionalProperties: { type: "number" } },
        },
      }),
    ).toBe(
      'Invalid JSON schema at "properties.prices": objects must list their "properties"; a dictionary described only by "additionalProperties" is not supported for JSON extraction.',
    );
  });

  it("rejects type names that are not JSON Schema types", () => {
    expect(
      findStrictSchemaViolation({
        type: "object",
        properties: { level: { type: "enum", enum: ["a", "b"] } },
      }),
    ).toContain('"type" must be one of');
    expect(
      findStrictSchemaViolation({
        type: "object",
        properties: { title: { type: { type: "string" } } },
      }),
    ).toContain('"type" must be one of');
  });

  it("rejects shorthand property values", () => {
    expect(
      findStrictSchemaViolation({ status: "string", price: "string" }),
    ).toBe(
      'Invalid JSON schema at "properties.status": expected a schema object, got "string".',
    );
  });

  it("rejects nested schemas without a type", () => {
    expect(
      findStrictSchemaViolation({
        type: "object",
        properties: { metadata: {} },
      }),
    ).toBe('Invalid JSON schema at "properties.metadata": missing "type".');
  });
});

describe("addStrictSchemaIssue", () => {
  const schemaField = z.any().optional().superRefine(addStrictSchemaIssue);

  it("adds a zod issue for an unsupported schema", () => {
    const result = schemaField.safeParse({
      type: "object",
      properties: { events: { type: "array" } },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe(
      'Invalid JSON schema at "properties.events": arrays must define "items".',
    );
  });

  it("passes supported and missing schemas", () => {
    expect(schemaField.safeParse(undefined).success).toBe(true);
    expect(
      schemaField.safeParse({
        type: "object",
        properties: { title: { type: "string" } },
      }).success,
    ).toBe(true);
  });
});
