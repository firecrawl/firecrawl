import { z } from "zod";
import type { Document } from "../../controllers/v2/types";
import type { ScrapeJobData } from "../../types";

const storedWebhookSchema = z.looseObject({
  url: z.string().nullish(),
});

const scrapeJobCommonShape = {
  team_id: z.string().nullish(),
  zeroDataRetention: z.boolean().nullish(),
  v1: z.boolean().nullish(),
  webhook: z.union([storedWebhookSchema, z.string()]).nullish(),
  origin: z.string().nullish(),
  requestId: z.string().nullish(),
  skipNuq: z.boolean().nullish(),
  traceContext: z.looseObject({}).nullish(),
};

const scrapeJobSingleUrlsShapeSchema = z.looseObject({
  ...scrapeJobCommonShape,
  mode: z.literal("single_urls"),
  url: z.string(),
  crawl_id: z.string().nullish(),
  crawlerOptions: z.looseObject({}).nullish(),
  scrapeOptions: z.looseObject({}).nullish(),
});

const scrapeJobKickoffShapeSchema = z.looseObject({
  ...scrapeJobCommonShape,
  mode: z.literal("kickoff"),
  url: z.string(),
  crawl_id: z.string(),
  crawlerOptions: z.looseObject({}).nullish(),
  scrapeOptions: z.looseObject({}).nullish(),
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
