import { type FormatOption, type JsonFormat, type ScrapeOptions, type ScreenshotFormat } from "../types";
import zodToJsonSchema from "zod-to-json-schema";

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

