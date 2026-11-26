import { getCrawlScope as nativeGetCrawlScope } from "@mendable/firecrawl-rs";

interface CrawlScope {
  /** Directory every crawled path must sit under. Always ends with "/". */
  prefix: string;
  /** Single path allowed alongside the prefix, or null. */
  exact: string | null;
}

/** Resolves the path a crawl is scoped to when backward crawling is disabled. */
export function getCrawlScope(initialUrl: string): CrawlScope {
  const scope = nativeGetCrawlScope(initialUrl);
  return {
    prefix: scope.prefix,
    exact: scope.exact ?? null,
  };
}

/** Human-readable scope for denial messages. */
export function describeCrawlScope(scope: CrawlScope): string {
  return scope.exact
    ? `${scope.exact} or ${scope.prefix}*`
    : `${scope.prefix}*`;
}
