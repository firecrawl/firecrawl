import { z } from "zod";
import type { JsonObject } from "../../lib/json-types";

function softOptional<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}

const promptCrawlerOptionsSchema = z.object({
  includePaths: softOptional(z.array(z.string())),
  excludePaths: softOptional(z.array(z.string())),
  maxDepth: softOptional(z.number()),
  maxDiscoveryDepth: softOptional(z.number()),
  crawlEntireDomain: softOptional(z.boolean()),
  allowExternalLinks: softOptional(z.boolean()),
  allowSubdomains: softOptional(z.boolean()),
  ignoreRobotsTxt: softOptional(z.boolean()),
  robotsUserAgent: softOptional(z.string()),
  sitemap: softOptional(z.enum(["skip", "include", "only"])),
  ignoreQueryParameters: softOptional(z.boolean()),
  deduplicateSimilarURLs: softOptional(z.boolean()),
  regexOnFullURL: softOptional(z.boolean()),
  delay: softOptional(z.number().positive().max(60)),
  limit: softOptional(z.number()),
});

export type PromptCrawlerOptions = z.infer<typeof promptCrawlerOptionsSchema>;

/** Parses prompt-generated crawler options, retaining only valid defined fields. */
export function parsePromptCrawlerOptions(raw: unknown): PromptCrawlerOptions {
  const parsed = promptCrawlerOptionsSchema.safeParse(raw);
  if (!parsed.success) {
    return {};
  }
  const result: PromptCrawlerOptions = {};
  if (parsed.data.includePaths !== undefined) {
    result.includePaths = parsed.data.includePaths;
  }
  if (parsed.data.excludePaths !== undefined) {
    result.excludePaths = parsed.data.excludePaths;
  }
  if (parsed.data.maxDepth !== undefined) {
    result.maxDepth = parsed.data.maxDepth;
  }
  if (parsed.data.maxDiscoveryDepth !== undefined) {
    result.maxDiscoveryDepth = parsed.data.maxDiscoveryDepth;
  }
  if (parsed.data.crawlEntireDomain !== undefined) {
    result.crawlEntireDomain = parsed.data.crawlEntireDomain;
  }
  if (parsed.data.allowExternalLinks !== undefined) {
    result.allowExternalLinks = parsed.data.allowExternalLinks;
  }
  if (parsed.data.allowSubdomains !== undefined) {
    result.allowSubdomains = parsed.data.allowSubdomains;
  }
  if (parsed.data.ignoreRobotsTxt !== undefined) {
    result.ignoreRobotsTxt = parsed.data.ignoreRobotsTxt;
  }
  if (parsed.data.robotsUserAgent !== undefined) {
    result.robotsUserAgent = parsed.data.robotsUserAgent;
  }
  if (parsed.data.sitemap !== undefined) {
    result.sitemap = parsed.data.sitemap;
  }
  if (parsed.data.ignoreQueryParameters !== undefined) {
    result.ignoreQueryParameters = parsed.data.ignoreQueryParameters;
  }
  if (parsed.data.deduplicateSimilarURLs !== undefined) {
    result.deduplicateSimilarURLs = parsed.data.deduplicateSimilarURLs;
  }
  if (parsed.data.regexOnFullURL !== undefined) {
    result.regexOnFullURL = parsed.data.regexOnFullURL;
  }
  if (parsed.data.delay !== undefined) {
    result.delay = parsed.data.delay;
  }
  if (parsed.data.limit !== undefined) {
    result.limit = parsed.data.limit;
  }
  return result;
}

/**
 * Returns whether a prompt-generated option key should overlay parsed defaults
 * (present in generated options and absent or nullish in the raw request body).
 */
export function shouldApplyPromptOption(
  promptGeneratedOptions: JsonObject,
  preNormalizedBody: JsonObject,
  key: string,
): boolean {
  return (
    Object.hasOwn(promptGeneratedOptions, key) &&
    (!Object.hasOwn(preNormalizedBody, key) ||
      preNormalizedBody[key] === undefined ||
      preNormalizedBody[key] === null)
  );
}

/** Overlays valid prompt-generated crawler options onto target when unset by caller. */
export function applyPromptCrawlerOptions(
  target: PromptCrawlerOptions,
  promptGeneratedOptions: JsonObject,
  preNormalizedBody: JsonObject,
): void {
  const parsed = parsePromptCrawlerOptions(promptGeneratedOptions);
  const shouldApply = (key: keyof PromptCrawlerOptions): boolean =>
    shouldApplyPromptOption(promptGeneratedOptions, preNormalizedBody, key);

  if (shouldApply("includePaths") && parsed.includePaths !== undefined) {
    target.includePaths = parsed.includePaths;
  }
  if (shouldApply("excludePaths") && parsed.excludePaths !== undefined) {
    target.excludePaths = parsed.excludePaths;
  }
  if (
    shouldApply("maxDiscoveryDepth") &&
    parsed.maxDiscoveryDepth !== undefined
  ) {
    target.maxDiscoveryDepth = parsed.maxDiscoveryDepth;
  }
  if (shouldApply("maxDepth") && parsed.maxDepth !== undefined) {
    target.maxDepth = parsed.maxDepth;
  }
  if (shouldApply("limit") && parsed.limit !== undefined) {
    target.limit = parsed.limit;
  }
  if (
    shouldApply("crawlEntireDomain") &&
    parsed.crawlEntireDomain !== undefined
  ) {
    target.crawlEntireDomain = parsed.crawlEntireDomain;
  }
  if (
    shouldApply("allowExternalLinks") &&
    parsed.allowExternalLinks !== undefined
  ) {
    target.allowExternalLinks = parsed.allowExternalLinks;
  }
  if (shouldApply("allowSubdomains") && parsed.allowSubdomains !== undefined) {
    target.allowSubdomains = parsed.allowSubdomains;
  }
  if (shouldApply("ignoreRobotsTxt") && parsed.ignoreRobotsTxt !== undefined) {
    target.ignoreRobotsTxt = parsed.ignoreRobotsTxt;
  }
  if (shouldApply("robotsUserAgent") && parsed.robotsUserAgent !== undefined) {
    target.robotsUserAgent = parsed.robotsUserAgent;
  }
  if (shouldApply("sitemap") && parsed.sitemap !== undefined) {
    target.sitemap = parsed.sitemap;
  }
  if (
    shouldApply("deduplicateSimilarURLs") &&
    parsed.deduplicateSimilarURLs !== undefined
  ) {
    target.deduplicateSimilarURLs = parsed.deduplicateSimilarURLs;
  }
  if (
    shouldApply("ignoreQueryParameters") &&
    parsed.ignoreQueryParameters !== undefined
  ) {
    target.ignoreQueryParameters = parsed.ignoreQueryParameters;
  }
  if (shouldApply("regexOnFullURL") && parsed.regexOnFullURL !== undefined) {
    target.regexOnFullURL = parsed.regexOnFullURL;
  }
  if (shouldApply("delay") && parsed.delay !== undefined) {
    target.delay = parsed.delay;
  }
}
