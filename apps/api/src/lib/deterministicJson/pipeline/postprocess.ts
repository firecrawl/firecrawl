type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Reconcile an extractor's raw output with the target JSON schema: remap key
// casing, fill/omit nulls, strip junk characters, and dedupe over-extracted list
// items. Returns the cleaned value shaped to the schema.
export function parseWithSchema(value: unknown, jsonSchema: unknown): unknown {
  const remapped = remapKeys(value, jsonSchema);
  const coerced = coerceNulls(remapped, jsonSchema);
  const cleaned = sanitizeStrings(coerced);
  return dedupeArrays(cleaned);
}

const normalizeKey = (k: string): string =>
  k.replace(/[^a-z0-9]/gi, "").toLowerCase();

function remapKeys(value: unknown, schema: unknown): unknown {
  if (!isObject(schema)) return value;

  if (Array.isArray(value)) {
    return value.map(v => remapKeys(v, (schema as { items?: unknown }).items));
  }
  if (!isObject(value)) return value;

  const props = (schema as { properties?: JsonObject }).properties;
  if (!props) return value;

  const canonical = new Map(Object.keys(props).map(k => [normalizeKey(k), k]));
  const out: JsonObject = {};
  for (const [key, v] of Object.entries(value)) {
    const target =
      key in props ? key : (canonical.get(normalizeKey(key)) ?? key);
    out[target] = remapKeys(v, props[target]);
  }
  return out;
}

function schemaAllowsNull(schema: JsonObject): boolean {
  const t = schema.type;
  if (
    t === "null" ||
    (Array.isArray(t) && t.includes("null")) ||
    schema.nullable === true
  ) {
    return true;
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (
      Array.isArray(branches) &&
      branches.some(b => isObject(b) && schemaAllowsNull(b))
    ) {
      return true;
    }
  }
  return false;
}

function typeDefault(schema: JsonObject): unknown {
  const t = schema.type;
  const primary = Array.isArray(t) ? t.find(x => x !== "null") : t;
  switch (primary) {
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object": {
      const props = (schema.properties ?? {}) as JsonObject;
      const out: JsonObject = {};
      for (const key of (schema.required as string[] | undefined) ?? []) {
        const sub = props[key];
        out[key] =
          isObject(sub) && !schemaAllowsNull(sub) ? typeDefault(sub) : null;
      }
      return out;
    }
    default:
      return null;
  }
}

// `required` tracks whether the current value sits in a required slot. We only
// fabricate a default for a required, non-nullable null; an optional null is
// dropped so we never emit a fake value for data that simply isn't on the page.
function coerceNulls(
  value: unknown,
  schema: unknown,
  required = true,
): unknown {
  if (!isObject(schema)) return value;

  if (value === null) {
    if (schemaAllowsNull(schema) || !required) return null;
    return typeDefault(schema);
  }

  if (Array.isArray(value)) {
    const items = (schema as { items?: unknown }).items;
    // An item present in the array is a real value: coerce its required subfields.
    return isObject(items)
      ? value.map(v => coerceNulls(v, items, true))
      : value;
  }

  if (isObject(value)) {
    const props = (schema as { properties?: JsonObject }).properties;
    if (!props) return value;
    const requiredKeys = new Set(
      (schema as { required?: string[] }).required ?? [],
    );
    const out: JsonObject = {};
    for (const [key, v] of Object.entries(value)) {
      if (!(key in props)) {
        out[key] = v;
        continue;
      }
      const sub = props[key];
      // Optional field the model returned as null: omit it so a non-nullable
      // optional field still validates, instead of fabricating a default.
      if (
        v === null &&
        !requiredKeys.has(key) &&
        !(isObject(sub) && schemaAllowsNull(sub))
      ) {
        continue;
      }
      out[key] = coerceNulls(v, sub, requiredKeys.has(key));
    }
    // Fill in required keys the model omitted entirely.
    for (const key of requiredKeys) {
      if (!(key in out))
        out[key] = isObject(props[key])
          ? typeDefault(props[key] as JsonObject)
          : null;
    }
    return out;
  }
  return value;
}

// Drop exact-duplicate OBJECTS from arrays (a common over-extraction artifact -
// e.g. a list selector that matches each card twice, or triplicated rows).
// Scalar duplicates are left alone since repeated primitives can be legitimate.
function dedupeArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const item of value.map(dedupeArrays)) {
      if (item && typeof item === "object") {
        const key = JSON.stringify(item);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(item);
    }
    return out;
  }
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = dedupeArrays(v);
    return out;
  }
  return value;
}

// Characters that ride along from the DOM but are never real content: private-
// use icon-font glyphs, zero-width joiners / BOM, and C0/C1 control codes.
// .trim() won't remove them, so we strip them and collapse the doubled spaces
// they leave behind (newlines preserved so multi-line text keeps its shape).
// Built via RegExp(string) so the source stays pure ASCII.
const JUNK_CHARS = new RegExp(
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F" +
    "\\u200B-\\u200D\\u2060\\uFEFF\\uE000-\\uF8FF" +
    "\\u{F0000}-\\u{FFFFD}\\u{100000}-\\u{10FFFD}]",
  "gu",
);

function sanitizeStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(JUNK_CHARS, "")
      .replace(/[^\S\r\n]{2,}/g, " ")
      .trim();
  }
  if (Array.isArray(value)) return value.map(sanitizeStrings);
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const [key, v] of Object.entries(value)) out[key] = sanitizeStrings(v);
    return out;
  }
  return value;
}
