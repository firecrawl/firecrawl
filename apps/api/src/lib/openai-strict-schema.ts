import {
  normalizeSchemaKeywordsJson,
  toRootSchemaJson,
  findStrictSchemaViolationJson,
} from "@mendable/firecrawl-rs";
import { z } from "zod";

// OpenAI structured outputs (strict mode) accept only a subset of JSON Schema.
// normalizeSchemaKeywords fixes mechanical mistakes in user-written and
// LLM-generated schemas; findStrictSchemaViolation names the constructs strict
// mode rejects outright, so they can be refused before any scrape runs.

type Schema = Record<string, any>;

function isPlainObject(x: unknown): x is Schema {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function typeIncludes(type: unknown, name: string): boolean {
  return type === name || (Array.isArray(type) && type.includes(name));
}

/**
 * Lowercases type names ("String" -> "string"), turns oneOf into anyOf, and
 * fills in a missing type when properties/items make it unambiguous. Returns
 * a new schema; the input is not modified.
 */
export function normalizeSchemaKeywords(schema: any): any {
  if (!isPlainObject(schema)) return schema;
  const json = JSON.stringify(schema);
  if (json === undefined) return schema;
  return JSON.parse(normalizeSchemaKeywordsJson(json));
}

/**
 * normalizeSchemaKeywords, plus turning a bare map of property names to
 * schemas into an object schema. Its "$defs" (a map of definitions, not a
 * schema) moves to the root of that object schema.
 */
export function toRootSchema(schema: any): any {
  if (!isPlainObject(schema)) return schema;
  const json = JSON.stringify(schema);
  if (json === undefined) return schema;
  return JSON.parse(toRootSchemaJson(json));
}

/**
 * Returns a human-readable description of the first construct in the schema
 * that OpenAI strict structured outputs rejects, or null if none was found.
 * The schema is normalized with normalizeSchemaKeywords first, so anything
 * that function fixes is not reported.
 */
export function findStrictSchemaViolation(schema: any): string | null {
  if (schema === undefined || schema === null) return null;
  const json = JSON.stringify(schema);
  if (json === undefined) {
    const raw = String(schema);
    const described = raw.length > 60 ? raw.slice(0, 57) + "..." : raw;
    return `Invalid JSON schema: expected an object, got ${described}.`;
  }
  return findStrictSchemaViolationJson(json) ?? null;
}

// Zod refinement for request schemas that JSON extraction sends to OpenAI in
// strict mode: an unsupported schema would otherwise fail mid-scrape and come
// back as a warning on an otherwise successful response.
export function addStrictSchemaIssue(
  schema: unknown,
  ctx: z.RefinementCtx,
): void {
  const violation = findStrictSchemaViolation(schema);
  if (violation) {
    ctx.addIssue({ code: "custom", message: violation });
  }
}
