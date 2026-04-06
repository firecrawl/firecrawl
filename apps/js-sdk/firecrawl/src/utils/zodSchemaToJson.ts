import { zodToJsonSchema as zodToJsonSchemaLib } from "zod-to-json-schema";

type SchemaConverter = (schema: unknown) => unknown;

export function isZodSchema(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const schema = value as Record<string, unknown>;

  const hasV3Markers =
    "_def" in schema &&
    (typeof schema.safeParse === "function" ||
      typeof schema.parse === "function");

  const hasV4Markers = "_zod" in schema && typeof schema._zod === "object";

  return hasV3Markers || hasV4Markers;
}

function isZodV4Schema(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  return "_zod" in schema && typeof (schema as Record<string, unknown>)._zod === "object";
}

function tryZodV4Conversion(schema: unknown): Record<string, unknown> | null {
  if (!isZodV4Schema(schema)) return null;

  try {
    // Zod v4 exports toJSONSchema as a module-level function (z.toJSONSchema).
    // Resolve the user's zod module — it's already loaded since the schema was
    // created with it. Works in both CJS and ESM (tsup/esbuild shims require).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const zod = require("zod");
    if (typeof zod?.toJSONSchema === "function") {
      return zod.toJSONSchema(schema) as Record<string, unknown>;
    }
  } catch {
    // V4 conversion not available — zod v4 may not be installed
  }

  return null;
}

export function zodSchemaToJsonSchema(schema: unknown): Record<string, unknown> | unknown {
  if (!isZodSchema(schema)) {
    return schema;
  }

  const v4Result = tryZodV4Conversion(schema);
  if (v4Result) {
    return v4Result;
  }

  try {
    return zodToJsonSchemaLib(schema as Parameters<typeof zodToJsonSchemaLib>[0]) as Record<string, unknown>;
  } catch {
    return schema;
  }
}

export function looksLikeZodShape(obj: unknown): boolean {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const values = Object.values(obj);
  if (values.length === 0) return false;
  return values.some(
    (v) =>
      v &&
      typeof v === "object" &&
      (v as Record<string, unknown>)._def &&
      typeof (v as Record<string, unknown>).safeParse === "function"
  );
}
