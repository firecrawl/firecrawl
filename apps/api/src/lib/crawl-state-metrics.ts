import { Counter } from "prom-client";
import type { Logger } from "winston";
import type { LogMeta } from "./json-types";

// Fixed labels only: never add team or crawl IDs here.
const crawlStateMissingTotal = new Counter({
  name: "firecrawl_crawl_state_missing_total",
  help: "Times a live crawl or batch scrape job found no stored crawl document, by site: gate (concurrency admission) or finalizer (crawl completion)",
  labelNames: ["site"],
});

/** Counts and logs a crawl job whose stored crawl document is missing. */
export function recordCrawlStateMissing(
  site: "gate" | "finalizer",
  crawlId: string,
  logger: Logger,
  meta: LogMeta = {},
) {
  crawlStateMissingTotal.inc({ site });
  logger.warn("Stored crawl document missing for a live crawl", {
    site,
    crawlId,
    ...meta,
  });
}
