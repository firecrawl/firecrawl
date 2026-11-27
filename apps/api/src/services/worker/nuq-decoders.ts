import { z } from "zod";
import type { Document } from "../../controllers/v2/types";
import { logger as _logger } from "../../lib/logger";
import type { ScrapeJobData } from "../../types";

const storedWebhookSchema = z.looseObject({
  url: z.string().nullish(),
});

const scrapeJobCommonShape = {
  team_id: z.string(),
  zeroDataRetention: z
    .boolean()
    .nullish()
    .transform(value => value ?? false),
  webhook: z.union([storedWebhookSchema, z.string()]).nullish(),
  origin: z
    .string()
    .nullish()
    .transform(value => value ?? "api"),
  apiKeyId: z
    .number()
    .nullish()
    .transform(value => value ?? null),
  requestId: z.string().nullish(),
  skipNuq: z.boolean().nullish(),
  traceContext: z.looseObject({}).nullish(),
};

const scrapeJobSingleUrlsShapeSchema = z.looseObject({
  ...scrapeJobCommonShape,
  mode: z.literal("single_urls"),
  url: z.string(),
  v1: z.boolean().nullish(),
  crawl_id: z.string().nullish(),
  crawlerOptions: z.looseObject({}).nullish(),
  scrapeOptions: z
    .looseObject({})
    .nullish()
    .transform(value => value ?? {}),
});

const scrapeJobKickoffShapeSchema = z.looseObject({
  ...scrapeJobCommonShape,
  mode: z.literal("kickoff"),
  url: z.string(),
  crawl_id: z.string(),
  v1: z
    .boolean()
    .nullish()
    .transform(value => value ?? false),
  crawlerOptions: z.looseObject({}).nullish(),
  scrapeOptions: z
    .looseObject({})
    .nullish()
    .transform(value => value ?? {}),
});

const scrapeJobKickoffSitemapShapeSchema = z.looseObject({
  ...scrapeJobCommonShape,
  mode: z.literal("kickoff_sitemap"),
  crawl_id: z.string(),
  sitemapUrl: z.string(),
  v1: z
    .boolean()
    .nullish()
    .transform(value => value ?? false),
});

const scrapeJobDataShapeSchema = z.discriminatedUnion("mode", [
  scrapeJobSingleUrlsShapeSchema,
  scrapeJobKickoffShapeSchema,
  scrapeJobKickoffSitemapShapeSchema,
]);

const scrapeJobDataTargetSchema = z.custom<ScrapeJobData>(
  value => typeof value === "object" && value !== null,
);

const storedDocumentShapeSchema = z.looseObject({
  title: z.string().nullish(),
  description: z.string().nullish(),
  url: z.string().nullish(),
  markdown: z.string().nullish(),
  html: z.string().nullish(),
  rawHtml: z.string().nullish(),
  rawBase64: z.string().nullish(),
  links: z.array(z.string()).nullish(),
  images: z.array(z.string()).nullish(),
  screenshot: z.string().nullish(),
  summary: z.string().nullish(),
  answer: z.string().nullish(),
  warning: z.string().nullish(),
  metadata: z.looseObject({}).nullish(),
});

const storedDocumentSchema: z.ZodType<Document> = z.custom<Document>(
  value => storedDocumentShapeSchema.safeParse(value).success,
);

/** Validates and returns a non-null scrape job payload. */
export function decodeScrapeJobData(raw: unknown): ScrapeJobData {
  const parsed = scrapeJobDataShapeSchema.safeParse(raw);
  if (!parsed.success) {
    _logger.error("Invalid scrape job data payload", {
      issues: parsed.error.issues,
    });
    throw new Error("Invalid scrape job data payload");
  }
  return scrapeJobDataTargetSchema.parse(parsed.data);
}

/** Validates and returns a stored scrape document, unwrapping legacy arrays. */
export function decodeScrapeReturnValue(raw: unknown): Document | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const candidate: unknown = Array.isArray(raw) ? raw[0] : raw;
  if (candidate === null || candidate === undefined) {
    return null;
  }
  const parsed = storedDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    _logger.error("Invalid scrape returnvalue payload", {
      issues: parsed.error.issues,
    });
    throw new Error("Invalid scrape returnvalue payload");
  }
  return parsed.data;
}
