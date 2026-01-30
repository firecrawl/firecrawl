import {
  type ChangeTrackingFormat,
  type FormatOption,
  type JsonFormat,
  type ParseFormatOption,
  type ParseOptions,
  type ScrapeOptions,
  type ScreenshotFormat,
} from "../types";
import { isZodSchema, zodSchemaToJsonSchema, looksLikeZodShape } from "../../utils/zodSchemaToJson";

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
      const maybeSchema = j.schema;
      if (isZodSchema(maybeSchema)) {
        (j as any).schema = zodSchemaToJsonSchema(maybeSchema);
      } else if (looksLikeZodShape(maybeSchema)) {
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
      const maybeSchema = ct.schema;
      if (isZodSchema(maybeSchema)) {
        (ct as any).schema = zodSchemaToJsonSchema(maybeSchema);
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

const parseFormatTypes = new Set([
  "markdown",
  "html",
  "rawHtml",
  "links",
  "images",
  "summary",
  "json",
  "attributes",
]);

const parseOptionKeys = new Set([
  "formats",
  "includeTags",
  "excludeTags",
  "onlyMainContent",
  "timeout",
  "parsers",
  "removeBase64Images",
]);

export function ensureValidParseFormats(formats?: ParseFormatOption[]): void {
  if (!formats) return;
  for (const fmt of formats) {
    const type = typeof fmt === "string" ? fmt : fmt.type;
    if (!parseFormatTypes.has(type)) {
      throw new Error(`Unsupported parse format: ${type}`);
    }
  }
  ensureValidFormats(formats as FormatOption[]);
}

export function ensureValidParseOptions(options?: ParseOptions): void {
  if (!options) return;
  const unknownKeys = Object.keys(options).filter(k => !parseOptionKeys.has(k));
  if (unknownKeys.length) {
    throw new Error(`Unsupported parse options: ${unknownKeys.join(", ")}`);
  }
  if (options.timeout != null && options.timeout <= 0) {
    throw new Error("timeout must be positive");
  }
  ensureValidParseFormats(options.formats);
}
