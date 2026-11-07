let warned = false;

/** Emits the deprecation warning for v1-style method calls, once per process. */
export function warnV1Usage(): void {
  if (warned) return;
  warned = true;
  const message =
    "firecrawl: v1-style methods (scrapeUrl, crawlUrl, batchScrapeUrls, ...) are deprecated and mapped to the v2 API. " +
    "Use scrape(), crawl(), batchScrape() and the other v2 methods instead.";
  if (typeof process !== "undefined" && typeof process.emitWarning === "function") {
    process.emitWarning(message, { type: "DeprecationWarning", code: "FIRECRAWL_V1_METHOD" });
  } else {
    console.warn(message);
  }
}

/** v1 crawl options that have a v2 equivalent. */
export type V1CrawlOptions = { maxDepth?: number; allowBackwardLinks?: boolean; ignoreSitemap?: boolean };

/** Renames v1 crawl options to their v2 names; v2 options given alongside win. */
export function toV2CrawlOptions<T extends object>(req: T & V1CrawlOptions): T {
  const { maxDepth, allowBackwardLinks, ignoreSitemap, ...rest } = req;
  return {
    ...(maxDepth != null && { maxDiscoveryDepth: maxDepth }),
    ...(allowBackwardLinks != null && { crawlEntireDomain: allowBackwardLinks }),
    ...(ignoreSitemap != null && { sitemap: ignoreSitemap ? "skip" : "include" }),
    ...rest,
  } as T;
}

/** A v2 result with the `success` flag v1 results carried. */
export type V1Result<T> = T & { success: true };

/** Warns once, then runs the v2 call and adds the v1 `success` flag to its result. */
export async function callV1<T extends object>(call: () => Promise<T>): Promise<V1Result<T>> {
  warnV1Usage();
  return { ...(await call()), success: true };
}
