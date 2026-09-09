// Keep in sync with crawl_scope() in apps/api/native/src/crawler.rs.

interface CrawlScope {
  /** Directory every crawled path must sit under. Always ends with "/". */
  prefix: string;
  /** Single path allowed alongside the prefix, or null. */
  exact: string | null;
}

const DOCUMENT_SEGMENT = /\.[A-Za-z0-9]{2,}$/;

/** Resolves the path a crawl is scoped to when backward crawling is disabled. */
export function getCrawlScope(initialUrl: string): CrawlScope {
  let pathname: string;
  try {
    pathname = new URL(initialUrl).pathname;
  } catch {
    return { prefix: "/", exact: null };
  }

  if (!pathname.startsWith("/")) {
    pathname = "/" + pathname;
  }

  if (pathname.endsWith("/")) {
    return { prefix: pathname, exact: null };
  }

  const lastSlash = pathname.lastIndexOf("/");
  if (DOCUMENT_SEGMENT.test(pathname.slice(lastSlash + 1))) {
    return { prefix: pathname.slice(0, lastSlash + 1), exact: null };
  }

  return { prefix: pathname + "/", exact: pathname };
}

export function isWithinCrawlScope(path: string, scope: CrawlScope): boolean {
  return path === scope.exact || path.startsWith(scope.prefix);
}

/** Human-readable scope for denial messages. */
export function describeCrawlScope(scope: CrawlScope): string {
  return scope.exact
    ? `${scope.exact} or ${scope.prefix}*`
    : `${scope.prefix}*`;
}
