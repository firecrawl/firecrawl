import type { z } from "zod";
import { jsonRecordSchema, jsonValueSchema } from "./json-types";
import type { JsonObject, JsonValue } from "./json-types";

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

type SchemaNode = {
  type?: JsonValue;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode | JsonValue;
  anyOf?: Array<SchemaNode | JsonValue>;
  oneOf?: Array<SchemaNode | JsonValue>;
  additionalProperties?: boolean | SchemaNode | JsonValue;
  $defs?: Record<string, SchemaNode>;
  definitions?: Record<string, SchemaNode>;
  $ref?: JsonValue;
  $schema?: JsonValue;
  $id?: JsonValue;
  $comment?: JsonValue;
  title?: JsonValue;
  description?: JsonValue;
  required?: JsonValue;
  enum?: JsonValue;
  const?: JsonValue;
  [key: string]: SchemaNode | JsonValue | undefined;
};

type SchemaNodeWithProperties = SchemaNode & {
  properties: Record<string, SchemaNode>;
};

type WrappedRootSchema = {
  type: "object";
  properties: JsonObject;
  required: Array<string>;
  additionalProperties: false;
  $defs?: JsonObject;
};

function mapValues(
  obj: JsonObject,
  fn: (v: JsonValue | undefined) => JsonValue | undefined,
): JsonObject {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
}

function lowercaseType(type: JsonValue | undefined): JsonValue | undefined {
  if (typeof type === "string") {
    return type.toLowerCase();
  }
  if (Array.isArray(type)) {
    return type.map((t: JsonValue | undefined) =>
      typeof t === "string" ? t.toLowerCase() : t,
    );
  }
  return type;
}

export function typeIncludes(type: unknown, name: string): boolean {
  return type === name || (Array.isArray(type) && type.includes(name));
}

function isJsonArray(
  value: JsonValue | undefined,
): value is ReadonlyArray<JsonValue | undefined> {
  return Array.isArray(value);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Whether a typeless root is a schema rather than a bare map of property names
// to schemas (which JSON extraction also accepts at the root): every key is a
// schema keyword holding the kind of value that keyword takes, and
// "properties" maps names to schemas instead of being a schema itself (a
// field that happens to be called "properties").
function isTypelessRootSchema(node: JsonObject): boolean {
  const properties = node.properties;
  if (!isJsonObject(properties)) {
    return false;
  }
  if (typeof properties.type === "string") {
    return false;
  }
  return Object.entries(node).every(([key, value]) => {
    switch (key) {
      case "$schema":
      case "$id":
      case "$comment":
      case "title":
      case "description":
        return typeof value === "string";
      case "required":
        return Array.isArray(value);
      case "additionalProperties":
        return typeof value === "boolean";
      case "properties":
      case "$defs":
      case "definitions":
        return isJsonObject(value);
      default:
        return false;
    }
  });
}

/**
 * Lowercases type names ("String" -> "string"), turns oneOf into anyOf, and
 * fills in a missing type when properties/items make it unambiguous. Returns
 * a new schema; the input is not modified.
 */
export function normalizeSchemaKeywords(
  schema: JsonObject & { properties: JsonObject },
): SchemaNodeWithProperties;
export function normalizeSchemaKeywords(schema: JsonObject): SchemaNode;
export function normalizeSchemaKeywords(
  schema: JsonObject | null | undefined,
): SchemaNode | null | undefined;
export function normalizeSchemaKeywords(
  schema: unknown,
): JsonValue | undefined {
  if (schema === undefined) {
    return undefined;
  }
  const parsedObject = jsonRecordSchema.safeParse(schema);
  if (parsedObject.success) {
    return normalizeNode(parsedObject.data, true);
  }
  const parsedValue = jsonValueSchema.safeParse(schema);
  if (!parsedValue.success) {
    return undefined;
  }
  return normalizeNode(parsedValue.data, true);
}

function normalizeNode(
  node: JsonValue | undefined,
  isRoot: boolean,
): JsonValue | undefined {
  if (!isJsonObject(node)) {
    return node;
  }
  const out: JsonObject = { ...node };

  if (out.type !== undefined) {
    out.type = lowercaseType(out.type);
  }

  if (Array.isArray(out.oneOf) && out.anyOf === undefined) {
    out.anyOf = out.oneOf;
    delete out.oneOf;
  }

  const outProperties = out.properties;
  const hasProperties = isJsonObject(outProperties);
  const outItems = out.items;
  const hasItems = isJsonObject(outItems);

  if (out.type === undefined) {
    if (isRoot ? isTypelessRootSchema(out) : hasProperties) {
      out.type = "object";
    } else if (!isRoot && hasItems) {
      out.type = "array";
    }
  }

  if (hasProperties) {
    out.properties = mapValues(outProperties, v => normalizeNode(v, false));
  }
  if (hasItems) {
    out.items = normalizeNode(outItems, false);
  }
  if (Array.isArray(out.anyOf)) {
    out.anyOf = out.anyOf.map((v: JsonValue | undefined) =>
      normalizeNode(v, false),
    );
  }
  // Strict mode closes every object (additionalProperties: false), so keys
  // beyond "properties" never come back; a schema for them is dropped here
  // rather than validated. Without "properties", it's a typed dictionary,
  // which findStrictSchemaViolation reports.
  const outAdditionalProperties = out.additionalProperties;
  if (isJsonObject(outAdditionalProperties)) {
    out.additionalProperties = hasProperties
      ? false
      : normalizeNode(outAdditionalProperties, false);
  }
  for (const defsKey of ["$defs", "definitions"]) {
    const defs = out[defsKey];
    if (isJsonObject(defs)) {
      out[defsKey] = mapValues(defs, v => normalizeNode(v, false));
    }
  }

  return out;
}

// Annotations that can sit next to the fields of a bare map. Any other key,
// "$"-prefixed or not, is a property name.
const ROOT_ANNOTATIONS = new Set(["$schema", "$id", "$comment"]);

/**
 * normalizeSchemaKeywords, plus turning a bare map of property names to
 * schemas into an object schema. Its "$defs" (a map of definitions, not a
 * schema) moves to the root of that object schema.
 */
export function toRootSchema(
  schema: JsonObject & { properties: JsonObject },
): SchemaNodeWithProperties;
export function toRootSchema(schema: JsonObject): SchemaNode;
export function toRootSchema(
  schema: JsonObject | null | undefined,
): SchemaNode | null | undefined;
export function toRootSchema(schema: unknown): JsonValue | undefined {
  if (schema === undefined) {
    return undefined;
  }
  const parsedObject = jsonRecordSchema.safeParse(schema);
  if (!parsedObject.success) {
    const parsedValue = jsonValueSchema.safeParse(schema);
    if (!parsedValue.success) {
      return undefined;
    }
    return normalizeNode(parsedValue.data, true);
  }
  const obj = parsedObject.data;
  const isBareRoot =
    obj.type === undefined &&
    obj.anyOf === undefined &&
    obj.oneOf === undefined &&
    obj.$ref === undefined &&
    !isTypelessRootSchema(obj);
  if (!isBareRoot) {
    return normalizeNode(obj, true);
  }
  const { $defs, ...rest } = obj;
  const hasDefs = isJsonObject($defs) && typeof $defs.type !== "string";
  const fields = hasDefs ? rest : obj;
  const entries = Object.entries(fields).filter(
    ([key]) => !ROOT_ANNOTATIONS.has(key),
  );
  const wrapped: WrappedRootSchema = {
    type: "object",
    properties: Object.fromEntries(entries),
    required: entries.map(([key]) => key),
    additionalProperties: false,
  };
  if (hasDefs) {
    wrapped.$defs = $defs;
  }
  return normalizeNode(wrapped, true);
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
export function findStrictSchemaViolation(schema: unknown): string | null {
  if (schema === undefined || schema === null) {
    return null;
  }
  const parsedSchema = jsonRecordSchema.safeParse(schema);
  if (!parsedSchema.success) {
    return `Invalid JSON schema: expected an object, got ${describe(schema)}.`;
  }
  const root = toRootSchema(parsedSchema.data);
  if (!isJsonObject(root)) {
    return `Invalid JSON schema: expected an object, got ${describe(root)}.`;
  }

  // Structured outputs need an object at the root; JSON extraction wraps a
  // root array in one, but nothing else.
  if (root.$ref === undefined) {
    if (root.anyOf !== undefined) {
      return 'Invalid JSON schema: the root must be an object or array schema, not "anyOf".';
    }
    if (
      !typeIncludes(root.type, "object") &&
      !typeIncludes(root.type, "array")
    ) {
      return `Invalid JSON schema: the root must be an object or array schema, got type ${describe(root.type)}.`;
    }
  }

  return checkNode(root, "");
}

function checkNode(
  rawNode: JsonValue | undefined,
  path: string,
): string | null {
  const at = path ? ` at "${path}"` : "";
  const child = (segment: string) => (path ? `${path}.${segment}` : segment);

  if (!isJsonObject(rawNode)) {
    return `Invalid JSON schema${at}: expected a schema object, got ${describe(rawNode)}.`;
  }
  const node = rawNode;

  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (node[keyword] !== undefined) {
      return `Invalid JSON schema${at}: "${keyword}" is not supported for JSON extraction.`;
    }
  }

  // A reference takes its type from the definition it points to, which is
  // checked where it is declared.
  const isReference = node.$ref !== undefined;

  if (
    !isReference &&
    node.type === undefined &&
    node.anyOf === undefined &&
    node.enum === undefined &&
    node.const === undefined
  ) {
    return `Invalid JSON schema${at}: missing "type".`;
  }

  if (node.type !== undefined) {
    const types: ReadonlyArray<JsonValue | undefined> = Array.isArray(node.type)
      ? node.type
      : [node.type];
    const invalid = types.find(
      t => typeof t !== "string" || !JSON_SCHEMA_TYPES.has(t),
    );
    if (types.length === 0 || invalid !== undefined) {
      return `Invalid JSON schema${at}: "type" must be one of ${[...JSON_SCHEMA_TYPES].join(", ")}, got ${describe(node.type)}.`;
    }
  }

  const nodeItems = node.items;
  const hasItems = isJsonObject(nodeItems);
  if (!isReference && typeIncludes(node.type, "array") && !hasItems) {
    return nodeItems === undefined
      ? `Invalid JSON schema${at}: arrays must define "items".`
      : `Invalid JSON schema${at}: "items" must be a single schema object, got ${describe(nodeItems)}.`;
  }

  if (
    typeIncludes(node.type, "object") &&
    node.properties === undefined &&
    isJsonObject(node.additionalProperties)
  ) {
    return `Invalid JSON schema${at}: objects must list their "properties"; a dictionary described only by "additionalProperties" is not supported for JSON extraction.`;
  }

  if (node.properties !== undefined) {
    if (!isJsonObject(node.properties)) {
      return `Invalid JSON schema${at}: "properties" must be an object, got ${describe(node.properties)}.`;
    }
    for (const [key, value] of Object.entries(node.properties)) {
      const violation = checkNode(value, child(`properties.${key}`));
      if (violation) {
        return violation;
      }
    }
  }

  if (hasItems) {
    const violation = checkNode(nodeItems, child("items"));
    if (violation) {
      return violation;
    }
  }

  if (node.anyOf !== undefined) {
    if (!isJsonArray(node.anyOf)) {
      return `Invalid JSON schema${at}: "anyOf" must be an array, got ${describe(node.anyOf)}.`;
    }
    for (let i = 0; i < node.anyOf.length; i++) {
      const violation = checkNode(node.anyOf[i], child(`anyOf.${i}`));
      if (violation) {
        return violation;
      }
    }
  }

  for (const defsKey of ["$defs", "definitions"]) {
    const defs = node[defsKey];
    if (isJsonObject(defs)) {
      for (const [key, value] of Object.entries(defs)) {
        const violation = checkNode(value, child(`${defsKey}.${key}`));
        if (violation) {
          return violation;
        }
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
