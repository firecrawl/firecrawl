import { z } from "zod";

// Keep these verticals and observation codes aligned with the structured
// Search/Scrape feedback contract proposed in firecrawl/firecrawl#4616.
export const feedbackVerticalSchema = z.enum([
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

const detail = z.string().trim().min(10).max(2000);
const website = z.url({ protocol: /^https?$/ }).max(2048);
const comparison = z.strictObject({
  reference: z.string().trim().min(1).max(2048),
  detail,
});
const observation = <T extends z.ZodRawShape>(shape: T) =>
  z
    .strictObject({
      detail,
      basis: z.enum(["output", "source_comparison", "expectation"]),
      comparison: comparison.optional(),
      ...shape,
    })
    .refine(
      value => {
        const item = value as { basis: string; comparison?: unknown };
        return item.basis !== "source_comparison" || !!item.comparison;
      },
      {
        message:
          "Source comparisons require a reference and the correct content.",
      },
    );
const failureObservation = observation({
  kind: z.literal("failure"),
  reason: z.enum(["timeout", "transport_error", "proxy_error", "other"]),
});
const searchResult = {
  source: z.enum(["web", "images", "news"]).optional(),
  position: z.number().int().positive(),
  vertical: feedbackVerticalSchema.optional(),
};
const knownSources = z.array(website).max(20).optional();
const searchObservation = z.union([
  failureObservation,
  observation({ ...searchResult, kind: z.literal("useful") }),
  observation({
    ...searchResult,
    kind: z.literal("irrelevant"),
    knownSources,
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
    vertical: feedbackVerticalSchema,
    topic: z.string().trim().min(1).max(200).optional(),
    knownSources,
  }),
]);
const scrapeFields = {
  format: z.string().trim().min(1).max(100).optional(),
  location: z.string().trim().min(1).max(200).optional(),
};
const scrapeObservation = z.union([
  failureObservation,
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
    reason: z.enum(["wrong", "hallucinated", "missing_fields"]),
  }),
]);

export const alexandriaFeedbackSchema = z
  .strictObject({
    categories: z.tuple([z.literal("alexandria")]),
    rating: z.enum(["good", "partial", "bad"]),
    requestedWebsite: website,
    requestedVertical: feedbackVerticalSchema,
    task: detail.optional(),
    assessment: detail.optional(),
    search: z.array(searchObservation).min(1).max(20).optional(),
    scrape: z.array(scrapeObservation).min(1).max(20).optional(),
    origin: z.string().trim().min(1).max(100).default("api"),
    integration: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .refine(
    value => new TextEncoder().encode(JSON.stringify(value)).length <= 8 * 1024,
    "Alexandria feedback must be 8KB or smaller",
  );

export type AlexandriaFeedbackRequest = z.infer<
  typeof alexandriaFeedbackSchema
>;
export type AlexandriaFeedbackRequestInput = z.input<
  typeof alexandriaFeedbackSchema
>;
