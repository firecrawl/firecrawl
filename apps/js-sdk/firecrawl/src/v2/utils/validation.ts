import {
  type ChangeTrackingFormat,
  type FormatOption,
  type JsonFormat,
  type ParseFormatOption,
  type ParseOptions,
  type QuestionFormat,
  type HighlightsFormat,
  type QueryFormat,
  type ScrapeOptions,
  type ScreenshotFormat,
} from "../types";
import {
  isZodSchema,
  zodSchemaToJsonSchema,
  looksLikeZodShape,
} from "../../utils/zodSchemaToJson";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
    if ((fmt as QuestionFormat).type === "question") {
      const q = fmt as QuestionFormat;
      if (typeof q.question !== "string" || q.question.trim().length === 0) {
        throw new Error("question format requires a non-empty 'question' string");
      }
      continue;
    }
    if ((fmt as HighlightsFormat).type === "highlights") {
      const h = fmt as HighlightsFormat;
      if (typeof h.query !== "string" || h.query.trim().length === 0) {
        throw new Error("highlights format requires a non-empty 'query' string");
      }
      continue;
    }
    if ((fmt as QueryFormat).type === "query") {
      const q = fmt as QueryFormat;
      if (typeof q.prompt !== "string" || q.prompt.trim().length === 0) {
        throw new Error("query format requires a non-empty 'prompt' string");
      }
      if (q.mode != null && q.mode !== "freeform" && q.mode !== "directQuote") {
        throw new Error("query format mode must be 'freeform' or 'directQuote'");
      }
      continue;
    }
    if ((fmt as ScreenshotFormat).type === "screenshot") {
      // no-op; already camelCase; validate numeric fields if present
      const s = fmt as ScreenshotFormat;
      if (s.quality != null && (!isFiniteNumber(s.quality) || s.quality < 0)) {
        throw new Error("screenshot.quality must be a non-negative number");
      }
    }
  }
}

export function ensureValidScrapeOptions(options?: ScrapeOptions): void {
  if (!options) return;
  if (
    options.timeout != null &&
    (!isFiniteNumber(options.timeout) || options.timeout <= 0)
  ) {
    throw new Error("timeout must be positive");
  }
  if (
    options.waitFor != null &&
    (!isFiniteNumber(options.waitFor) || options.waitFor < 0)
  ) {
    throw new Error("waitFor must be non-negative");
  }
  ensureValidFormats(options.formats);
}

export function ensureValidParseFormats(formats?: ParseFormatOption[]): void {
  if (!formats) return;

  for (const fmt of formats) {
    if (typeof fmt === "string") {
      if (fmt === "json") {
        throw new Error("json format must be an object with { type: 'json', prompt, schema }");
      }
      if (fmt === "screenshot") {
        throw new Error("parse does not support screenshot format");
      }
      if (fmt === "changeTracking") {
        throw new Error("parse does not support changeTracking format");
      }
      if (fmt === "branding") {
        throw new Error("parse does not support branding format");
      }
      if (fmt === "audio" || fmt === "video") {
        throw new Error(`parse does not support ${fmt} format`);
      }
      continue;
    }

    const type = (fmt as any).type;
    if (type === "changeTracking") {
      throw new Error("parse does not support changeTracking format");
    }
    if (type === "screenshot") {
      throw new Error("parse does not support screenshot format");
    }
    if (type === "branding") {
      throw new Error("parse does not support branding format");
    }
    if (type === "audio" || type === "video") {
      throw new Error(`parse does not support ${type} format`);
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

    if ((fmt as QuestionFormat).type === "question") {
      const q = fmt as QuestionFormat;
      if (typeof q.question !== "string" || q.question.trim().length === 0) {
        throw new Error("question format requires a non-empty 'question' string");
      }
      continue;
    }
    if ((fmt as HighlightsFormat).type === "highlights") {
      const h = fmt as HighlightsFormat;
      if (typeof h.query !== "string" || h.query.trim().length === 0) {
        throw new Error("highlights format requires a non-empty 'query' string");
      }
      continue;
    }
    if ((fmt as QueryFormat).type === "query") {
      const q = fmt as QueryFormat;
      if (typeof q.prompt !== "string" || q.prompt.trim().length === 0) {
        throw new Error("query format requires a non-empty 'prompt' string");
      }
      if (q.mode != null && q.mode !== "freeform" && q.mode !== "directQuote") {
        throw new Error("query format mode must be 'freeform' or 'directQuote'");
      }
    }
  }
}

export function ensureValidParseOptions(options?: ParseOptions): void {
  if (!options) return;
  if (
    options.timeout != null &&
    (!isFiniteNumber(options.timeout) || options.timeout <= 0)
  ) {
    throw new Error("timeout must be positive");
  }

  const raw = options as Record<string, unknown>;
  if (raw.waitFor !== undefined) {
    throw new Error("parse does not support waitFor");
  }
  if (raw.actions !== undefined) {
    throw new Error("parse does not support actions");
  }
  if (raw.location !== undefined) {
    throw new Error("parse does not support location overrides");
  }
  if (raw.mobile !== undefined) {
    throw new Error("parse does not support mobile rendering");
  }
  if (
    raw.maxAge !== undefined ||
    raw.minAge !== undefined ||
    raw.storeInCache !== undefined ||
    raw.lockdown !== undefined
  ) {
    throw new Error("parse does not support cache/index options");
  }
  if (raw.proxy !== undefined && raw.proxy !== "basic" && raw.proxy !== "auto") {
    throw new Error("parse only supports proxy values of 'basic' or 'auto'");
  }

  ensureValidParseFormats(options.formats);
}

