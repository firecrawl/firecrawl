import { z } from "zod";
import type { Document } from "../../controllers/v2/types";
import type { ScrapeJobData } from "../../types";

const storedWebhookSchema = z.looseObject({
  url: z.string(),
});

const scrapeJobCommonShape = {
  team_id: z.string().optional(),
  zeroDataRetention: z.boolean().optional(),
  v1: z.boolean().optional(),
  webhook: z.union([storedWebhookSchema, z.string()]).optional(),
  origin: z.string().optional(),
  requestId: z.string().optional(),
  skipNuq: z.boolean().optional(),
  traceContext: z.looseObject({}).optional(),
};

const scrapeJobSingleUrlsShapeSchema = z.looseObject({
  ...scrapeJobCommonShape,
  mode: z.literal("single_urls"),
  url: z.string(),
  crawl_id: z.string().optional(),
  crawlerOptions: z.looseObject({}).nullable().optional(),
  scrapeOptions: z.looseObject({}).optional(),
});

const scrapeJobKickoffShapeSchema = z.looseObject({
  ...scrapeJobCommonShape,
  mode: z.literal("kickoff"),
  url: z.string(),
  crawl_id: z.string(),
  crawlerOptions: z.looseObject({}).nullable().optional(),
  scrapeOptions: z.looseObject({}).optional(),
});

const scrapeJobKickoffSitemapShapeSchema = z.looseObject({
  ...scrapeJobCommonShape,
  mode: z.literal("kickoff_sitemap"),
  crawl_id: z.string(),
  sitemapUrl: z.string(),
});

const scrapeJobDataShapeSchema = z.discriminatedUnion("mode", [
  scrapeJobSingleUrlsShapeSchema,
  scrapeJobKickoffShapeSchema,
  scrapeJobKickoffSitemapShapeSchema,
]);

const scrapeJobDataSchema: z.ZodType<ScrapeJobData> = z.custom<ScrapeJobData>(
  value => scrapeJobDataShapeSchema.safeParse(value).success,
);

const storedDocumentShapeSchema = z.looseObject({});

const storedDocumentSchema: z.ZodType<Document> = z.custom<Document>(
  value => storedDocumentShapeSchema.safeParse(value).success,
);

/** Validates and returns a non-null scrape job payload. */
export function decodeScrapeJobData(raw: unknown): ScrapeJobData {
  const parsed = scrapeJobDataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Invalid scrape job data payload");
  }
  return parsed.data;
}

/** Validates and returns a stored scrape document, unwrapping legacy arrays. */
export function decodeScrapeReturnValue(raw: unknown): Document | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const candidate: unknown = Array.isArray(raw) ? raw[0] : raw;
  const parsed = storedDocumentSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
