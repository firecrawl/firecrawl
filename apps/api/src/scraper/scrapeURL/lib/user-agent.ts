/**
 * The User-Agent Firecrawl presents to the sites it scrapes.
 *
 * It lives in its own module so the scraper engines and the unit tests can
 * depend on it without pulling in the whole `robustFetch` stack (undici
 * agents, DNS cache, config).
 */
export const FIRE_CRAWL_AGENT_USER_AGENT = "FireCrawlAgent/1.0.0";

/**
 * Build a headers object with a guaranteed User-Agent, avoiding duplicates.
 *
 * If the caller already provided a User-Agent header (matched
 * case-insensitively), it is preserved and moved to the canonical
 * position; otherwise {@link FIRE_CRAWL_AGENT_USER_AGENT} is used as
 * the default. The caller-supplied user-agent key is stripped from the
 * spread to prevent sending two UA headers.
 */
export function buildHeadersWithUserAgent(
  headers?: Record<string, string>,
  defaultUserAgent: string = FIRE_CRAWL_AGENT_USER_AGENT,
): Record<string, string> {
  const existingUserAgent = headers
    ? headers[
        Object.keys(headers).find(k => k.toLowerCase() === "user-agent") ?? ""
      ]
    : undefined;

  return {
    "User-Agent": existingUserAgent ?? defaultUserAgent,
    ...(headers !== undefined
      ? Object.fromEntries(
          Object.entries(headers).filter(
            ([k]) => k.toLowerCase() !== "user-agent",
          ),
        )
      : {}),
  };
}
