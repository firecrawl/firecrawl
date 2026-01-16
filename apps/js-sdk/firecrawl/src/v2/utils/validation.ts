import { type FormatOption, type JsonFormat, type ScrapeOptions, type ScreenshotFormat, type ChangeTrackingFormat } from "../types";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Detects if an object looks like a Zod schema's `.shape` property.
 * When users mistakenly pass `schema.shape` instead of `schema`, the object
 * will have Zod types as values but won't be a Zod schema itself.
 */
function looksLikeZodShape(obj: unknown): boolean {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const values = Object.values(obj);
  if (values.length === 0) return false;
  // Check if at least one value looks like a Zod type
  return values.some((v: any) => v && typeof v === "object" && v._def && typeof v.safeParse === "function");
}

export function ensureValidFormats(formats?: FormatOption[]): void {
  if (!formats) return;
  for (const fmt of formats) {
    if (typeof fmt === "string") {
      if (fmt === "json") {
        throw new Error("json format must be an object with { type: 'json', prompt, schema }");
      }
      continue;
    }
    if ((fmt as JsonFormat).type === "json") {
      const j = fmt as JsonFormat;
      if (!j.prompt && !j.schema) {
        throw new Error("json format requires either 'prompt' or 'schema' (or both)");
      }
      // Flexibility: allow passing a Zod schema. Convert to JSON schema internally.
      const maybeSchema: any = j.schema as any;
      const isZod = !!maybeSchema && (typeof maybeSchema.safeParse === "function" || typeof maybeSchema.parse === "function") && !!maybeSchema._def;
      if (isZod) {
        try {
          (j as any).schema = zodToJsonSchema(maybeSchema);
        } catch {
          // If conversion fails, leave as-is; server-side may still handle, or request will fail explicitly
        }
      } else if (looksLikeZodShape(maybeSchema)) {
        // User likely passed schema.shape instead of the schema itself
        throw new Error(
          "json format schema appears to be a Zod schema's .shape property. " +
          "Pass the Zod schema directly (e.g., `schema: MySchema`) instead of `schema: MySchema.shape`. " +
          "The SDK will automatically convert Zod schemas to JSON Schema format."
        );
      }
      continue;
    }
    if ((fmt as ChangeTrackingFormat).type === "changeTracking") {
      const ct = fmt as ChangeTrackingFormat;
      const maybeSchema: any = ct.schema as any;
      const isZod = !!maybeSchema && (typeof maybeSchema.safeParse === "function" || typeof maybeSchema.parse === "function") && !!maybeSchema._def;
      if (isZod) {
        try {
          (ct as any).schema = zodToJsonSchema(maybeSchema);
        } catch {
          // Best-effort conversion; if it fails, leave original value
        }
      } else if (looksLikeZodShape(maybeSchema)) {
        throw new Error(
          "changeTracking format schema appears to be a Zod schema's .shape property. " +
          "Pass the Zod schema directly (e.g., `schema: MySchema`) instead of `schema: MySchema.shape`. " +
          "The SDK will automatically convert Zod schemas to JSON Schema format."
        );
      }
      continue;
    }
    if ((fmt as ScreenshotFormat).type === "screenshot") {
      // no-op; already camelCase; validate numeric fields if present
      const s = fmt as ScreenshotFormat;
      if (s.quality != null && (typeof s.quality !== "number" || s.quality < 0)) {
        throw new Error("screenshot.quality must be a non-negative number");
      }
    }
  }
}

export function ensureValidScrapeOptions(options?: ScrapeOptions): void {
  if (!options) return;
  if (options.timeout != null && options.timeout <= 0) {
    throw new Error("timeout must be positive");
  }
  if (options.waitFor != null && options.waitFor < 0) {
    throw new Error("waitFor must be non-negative");
  }
  ensureValidFormats(options.formats);
}

