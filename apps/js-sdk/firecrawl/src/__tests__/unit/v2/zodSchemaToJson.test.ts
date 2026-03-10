import { describe, test, expect } from "@jest/globals";
import { z } from "zod";
import {
  isZodSchema,
  zodSchemaToJsonSchema,
  looksLikeZodShape,
} from "../../../utils/zodSchemaToJson";

describe("zodSchemaToJson utility", () => {
  test("isZodSchema detects Zod schemas and rejects non-Zod values", () => {
    expect(isZodSchema(z.object({ name: z.string() }))).toBe(true);
    expect(isZodSchema(z.string())).toBe(true);
    expect(isZodSchema(z.number())).toBe(true);
    expect(isZodSchema(z.array(z.string()))).toBe(true);
    expect(isZodSchema(z.enum(["A", "B"]))).toBe(true);
    expect(isZodSchema(z.union([z.string(), z.number()]))).toBe(true);
    expect(isZodSchema(z.string().optional())).toBe(true);
    expect(isZodSchema(z.string().nullable())).toBe(true);

    expect(isZodSchema(null)).toBe(false);
    expect(isZodSchema(undefined)).toBe(false);
    expect(isZodSchema({ name: "test" })).toBe(false);
    expect(isZodSchema({ type: "object", properties: {} })).toBe(false);
    expect(isZodSchema("string")).toBe(false);
    expect(isZodSchema(42)).toBe(false);
    expect(isZodSchema([1, 2, 3])).toBe(false);
  });

  test("zodSchemaToJsonSchema converts Zod schemas to JSON Schema", () => {
    const simpleSchema = z.object({ name: z.string() });
    const simpleResult = zodSchemaToJsonSchema(simpleSchema) as Record<string, unknown>;
    expect(simpleResult.type).toBe("object");
    expect(simpleResult.properties).toBeDefined();
    expect((simpleResult.properties as Record<string, unknown>).name).toBeDefined();

    const complexSchema = z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(100),
      age: z.number().min(0).max(150).optional(),
      tags: z.array(z.string()),
      status: z.enum(["active", "inactive"]),
      metadata: z.object({
        createdAt: z.string(),
        nested: z.object({ value: z.number() }),
      }),
    });
    const complexResult = zodSchemaToJsonSchema(complexSchema) as Record<string, unknown>;
    expect(complexResult.type).toBe("object");
    expect(complexResult.properties).toBeDefined();
    expect(complexResult.required).toContain("id");
    expect(complexResult.required).not.toContain("age");

    const enumResult = zodSchemaToJsonSchema(z.enum(["a", "b", "c"])) as Record<string, unknown>;
    expect(enumResult.enum).toEqual(["a", "b", "c"]);

    const arrayResult = zodSchemaToJsonSchema(z.array(z.number())) as Record<string, unknown>;
    expect(arrayResult.type).toBe("array");
    expect(arrayResult.items).toBeDefined();
  });

  test("zodSchemaToJsonSchema passes through non-Zod values unchanged", () => {
    const jsonSchema = { type: "object", properties: { name: { type: "string" } } };
    expect(zodSchemaToJsonSchema(jsonSchema)).toEqual(jsonSchema);
    expect(zodSchemaToJsonSchema(null)).toBe(null);
    expect(zodSchemaToJsonSchema(undefined)).toBe(undefined);
    expect(zodSchemaToJsonSchema("string")).toBe("string");
    expect(zodSchemaToJsonSchema(42)).toBe(42);
    expect(zodSchemaToJsonSchema({ foo: "bar" })).toEqual({ foo: "bar" });
  });

  test("looksLikeZodShape detects .shape property misuse", () => {
    const schema = z.object({ title: z.string(), count: z.number() });
    expect(looksLikeZodShape(schema.shape)).toBe(true);
    expect(looksLikeZodShape(schema)).toBe(false);
    expect(looksLikeZodShape(null)).toBe(false);
    expect(looksLikeZodShape(undefined)).toBe(false);
    expect(looksLikeZodShape({ name: "test" })).toBe(false);
    expect(looksLikeZodShape({})).toBe(false);
    expect(looksLikeZodShape([1, 2, 3])).toBe(false);
    expect(looksLikeZodShape({ type: "object", properties: {} })).toBe(false);
  });

  test("SDK-like usage: convert Zod schema or pass through JSON schema", () => {
    const zodSchema = z.object({
      name: z.string(),
      email: z.string().email(),
      age: z.number().min(0),
    });

    if (isZodSchema(zodSchema)) {
      const result = zodSchemaToJsonSchema(zodSchema) as Record<string, unknown>;
      expect(result.type).toBe("object");
      expect(result.properties).toBeDefined();
    } else {
      throw new Error("Should detect Zod schema");
    }

    const existingJsonSchema = {
      type: "object" as const,
      properties: { title: { type: "string" as const } },
      required: ["title"] as string[],
    };

    expect(isZodSchema(existingJsonSchema)).toBe(false);
    expect(zodSchemaToJsonSchema(existingJsonSchema)).toEqual(existingJsonSchema);
  });
});
