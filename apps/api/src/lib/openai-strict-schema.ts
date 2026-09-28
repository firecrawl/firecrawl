import { z } from "zod";

// OpenAI structured outputs (strict mode) accept only a subset of JSON Schema.
// normalizeSchemaKeywords fixes the mechanical mistakes we see in user-written
// and LLM-generated schemas; findStrictSchemaViolation names the constructs
// strict mode rejects outright, so they can be refused before any scrape runs.

const JSON_SCHEMA_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

// Rejected by strict mode wherever they appear.
const UNSUPPORTED_KEYWORDS = [
  "allOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
];

// Keys that mark a typeless root as a schema rather than a map of property
// names to schemas (which generateCompletions also accepts at the root).
const SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$comment",
  "$defs",
  "definitions",
  "title",
  "description",
  "properties",
  "required",
  "additionalProperties",
]);

type Schema = Record<string, any>;

function isPlainObject(x: unknown): x is Schema {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function mapValues(obj: Schema, fn: (v: any) => any): Schema {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
}

function lowercaseType(type: unknown): unknown {
  if (typeof type === "string") return type.toLowerCase();
  if (Array.isArray(type)) {
    return type.map(t => (typeof t === "string" ? t.toLowerCase() : t));
  }
  return type;
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
  return normalizeNode(schema, true);
}

function normalizeNode(node: any, isRoot: boolean): any {
  if (!isPlainObject(node)) return node;
  const out: Schema = { ...node };

  if (out.type !== undefined) {
    out.type = lowercaseType(out.type);
  }

  if (Array.isArray(out.oneOf) && out.anyOf === undefined) {
    out.anyOf = out.oneOf;
    delete out.oneOf;
  }

  if (out.type === undefined) {
    const looksLikeSchema =
      !isRoot || Object.keys(out).every(k => SCHEMA_KEYWORDS.has(k));
    if (looksLikeSchema && isPlainObject(out.properties)) {
      out.type = "object";
    } else if (!isRoot && isPlainObject(out.items)) {
      out.type = "array";
    }
  }

  if (isPlainObject(out.properties)) {
    out.properties = mapValues(out.properties, v => normalizeNode(v, false));
  }
  if (isPlainObject(out.items)) {
    out.items = normalizeNode(out.items, false);
  }
  if (Array.isArray(out.anyOf)) {
    out.anyOf = out.anyOf.map(v => normalizeNode(v, false));
  }
  if (isPlainObject(out.additionalProperties)) {
    out.additionalProperties = normalizeNode(out.additionalProperties, false);
  }
  for (const defsKey of ["$defs", "definitions"]) {
    if (isPlainObject(out[defsKey])) {
      out[defsKey] = mapValues(out[defsKey], v => normalizeNode(v, false));
    }
  }

  return out;
}

function describe(value: unknown): string {
  const json = JSON.stringify(value) ?? String(value);
  return json.length > 60 ? json.slice(0, 57) + "..." : json;
}

/**
 * Returns a human-readable description of the first construct in the schema
 * that OpenAI strict structured outputs rejects, or null if none was found.
 * The schema is normalized with normalizeSchemaKeywords first, so anything
 * that function fixes is not reported.
 */
export function findStrictSchemaViolation(schema: any): string | null {
  if (schema === undefined || schema === null) return null;
  const normalized = normalizeSchemaKeywords(schema);
  if (!isPlainObject(normalized)) {
    return `Invalid JSON schema: expected an object, got ${describe(normalized)}.`;
  }

  // A typeless root is a map of property names to schemas.
  if (
    normalized.type === undefined &&
    normalized.anyOf === undefined &&
    normalized.$ref === undefined
  ) {
    for (const [key, value] of Object.entries(normalized)) {
      if (key.startsWith("$")) continue;
      const violation = checkNode(value, key);
      if (violation) return violation;
    }
    return null;
  }

  return checkNode(normalized, "");
}

function checkNode(node: any, path: string): string | null {
  const at = path ? ` at "${path}"` : "";
  const child = (segment: string) => (path ? `${path}.${segment}` : segment);

  if (!isPlainObject(node)) {
    return `Invalid JSON schema${at}: expected a schema object, got ${describe(node)}.`;
  }

  // Recursive schemas are supported; the referenced definition is checked
  // where it is declared.
  if (node.$ref !== undefined) return null;

  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (node[keyword] !== undefined) {
      return `Invalid JSON schema${at}: "${keyword}" is not supported for JSON extraction.`;
    }
  }

  if (
    node.type === undefined &&
    node.anyOf === undefined &&
    node.enum === undefined &&
    node.const === undefined
  ) {
    return `Invalid JSON schema${at}: missing "type".`;
  }

  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    const invalid = types.find(
      t => typeof t !== "string" || !JSON_SCHEMA_TYPES.has(t),
    );
    if (types.length === 0 || invalid !== undefined) {
      return `Invalid JSON schema${at}: "type" must be one of ${[...JSON_SCHEMA_TYPES].join(", ")}, got ${describe(node.type)}.`;
    }
  }

  if (typeIncludes(node.type, "array") && !isPlainObject(node.items)) {
    return node.items === undefined
      ? `Invalid JSON schema${at}: arrays must define "items".`
      : `Invalid JSON schema${at}: "items" must be a single schema object, got ${describe(node.items)}.`;
  }

  if (node.properties !== undefined) {
    if (!isPlainObject(node.properties)) {
      return `Invalid JSON schema${at}: "properties" must be an object, got ${describe(node.properties)}.`;
    }
    for (const [key, value] of Object.entries(node.properties)) {
      const violation = checkNode(value, child(`properties.${key}`));
      if (violation) return violation;
    }
  }

  if (isPlainObject(node.items)) {
    const violation = checkNode(node.items, child("items"));
    if (violation) return violation;
  }

  if (node.anyOf !== undefined) {
    if (!Array.isArray(node.anyOf)) {
      return `Invalid JSON schema${at}: "anyOf" must be an array, got ${describe(node.anyOf)}.`;
    }
    for (let i = 0; i < node.anyOf.length; i++) {
      const violation = checkNode(node.anyOf[i], child(`anyOf.${i}`));
      if (violation) return violation;
    }
  }

  for (const defsKey of ["$defs", "definitions"]) {
    if (isPlainObject(node[defsKey])) {
      for (const [key, value] of Object.entries(node[defsKey])) {
        const violation = checkNode(value, child(`${defsKey}.${key}`));
        if (violation) return violation;
      }
    }
  }

  return null;
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
