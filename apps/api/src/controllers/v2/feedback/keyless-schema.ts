import { z } from "zod";

const detail = z.string().trim().min(10).max(2000);
const comparison = z.strictObject({
  reference: z.string().trim().min(1).max(2048),
  detail,
});
const evidence = {
  detail,
  basis: z.enum(["output", "source_comparison", "expectation"]),
  comparison: comparison.optional(),
};
const observation = <T extends z.ZodRawShape>(shape: T) =>
  z.strictObject({ ...evidence, ...shape }).refine(
    value => {
      const item = value as { basis: string; comparison?: unknown };
      return item.basis !== "source_comparison" || !!item.comparison;
    },
    {
      message:
        "Source comparisons require a reference and observed difference.",
    },
  );
const common = {
  jobId: z.uuid(),
  rating: z.enum(["good", "partial", "bad"]),
  task: detail,
  assessment: detail,
  origin: z.string().trim().max(100).optional().default("api"),
  integration: z.string().trim().max(100).nullable().optional(),
};
const vertical = z.enum([
  "web_general",
  "social",
  "business",
  "research",
  "developer",
  "news",
  "government",
  "finance",
  "other",
]);
const searchResult = {
  source: z.enum(["web", "images", "news"]).optional(),
  position: z.number().int().positive(),
  vertical: vertical.optional(),
};
const searchObservation = z.union([
  observation({ ...searchResult, kind: z.literal("useful") }),
  observation({
    ...searchResult,
    kind: z.literal("irrelevant"),
    reason: z.enum([
      "aggregator_over_official",
      "off_topic",
      "stale",
      "wrong_content_type",
      "snippet_misleading",
      "blocked_or_paywalled",
    ]),
  }),
  observation({
    kind: z.literal("missing"),
    vertical,
    topic: z.string().trim().min(1).max(200).optional(),
    knownSources: z
      .array(z.url({ protocol: /^https?$/ }))
      .max(20)
      .optional(),
  }),
]);
const format = z.string().trim().min(1).optional();
const incorrectReason = z.enum(["wrong", "hallucinated", "missing_fields"]);
const scrapeFields = {
  format,
  location: z.string().trim().min(1).max(200).optional(),
};
const scrapeObservation = z.union([
  observation({ ...scrapeFields, kind: z.literal("correct") }),
  observation({
    ...scrapeFields,
    kind: z.literal("wrong_success"),
    reason: z.enum([
      "blocked_shell",
      "login_required",
      "paywall",
      "empty",
      "wrong_page",
      "stale",
      "wrong_locale",
    ]),
  }),
  observation({
    ...scrapeFields,
    kind: z.literal("incomplete"),
    reason: z.enum([
      "partial_content",
      "dynamic_content",
      "pagination",
      "main_content_stripped",
      "format_lost",
    ]),
  }),
  observation({
    ...scrapeFields,
    kind: z.literal("incorrect"),
    reason: incorrectReason,
  }),
]);
const parseFields = { format, page: z.number().int().positive().optional() };
const parseObservation = z.union([
  observation({
    ...parseFields,
    kind: z.enum([
      "correct",
      "formula",
      "chart_figure",
      "reading_order",
      "headers_footers",
      "headings_formatting",
      "images_dropped",
    ]),
  }),
  observation({
    ...parseFields,
    kind: z.literal("text_ocr"),
    reason: z.enum(["misread_chars", "garbled", "missing_text"]),
  }),
  observation({
    ...parseFields,
    kind: z.literal("table"),
    reason: z.enum(["structure", "cells_glued", "digits"]),
  }),
  observation({
    ...parseFields,
    kind: z.literal("completeness"),
    reason: z.enum([
      "pages_missing",
      "truncated_at_max_pages",
      "sections_dropped",
    ]),
  }),
  observation({
    ...parseFields,
    kind: z.literal("incorrect"),
    reason: incorrectReason,
  }),
]);

export const keylessFeedbackSchema = z.discriminatedUnion("endpoint", [
  z.strictObject({
    ...common,
    endpoint: z.literal("search"),
    observations: z.array(searchObservation).min(1).max(20),
  }),
  z.strictObject({
    ...common,
    endpoint: z.literal("scrape"),
    observations: z.array(scrapeObservation).min(1).max(20),
  }),
  z.strictObject({
    ...common,
    endpoint: z.literal("parse"),
    docClass: z.enum(["born_digital", "scanned", "mixed", "unknown"]),
    observations: z.array(parseObservation).min(1).max(20),
  }),
]);

export type KeylessFeedbackRequest = z.infer<typeof keylessFeedbackSchema>;
export type KeylessFeedbackEndpoint = KeylessFeedbackRequest["endpoint"];
