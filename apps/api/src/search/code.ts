import type { Logger } from "winston";
import type { WebSearchResult } from "../lib/entities";
import { fetchResearchUpstream } from "../lib/research-upstream";
import type { CategoryOption } from "../lib/search-query-builder";

const CODE_QUERY_KEYS = ["query", "k"];

export function wantsCodeCategory(categories?: CategoryOption[]): boolean {
  return (categories ?? []).some(category =>
    typeof category === "string"
      ? category === "code"
      : category.type === "code",
  );
}

export async function searchCodeCategory(
  options: { query: string; limit: number; teamId: string; timeout: number },
  logger: Logger,
): Promise<WebSearchResult[]> {
  try {
    const upstream = await fetchResearchUpstream({
      path: "/v2/code/search",
      params: { query: options.query, k: options.limit },
      queryKeys: CODE_QUERY_KEYS,
      headers: { "firecrawl-team-id": options.teamId },
      timeoutMs: options.timeout,
    });
    if (upstream === null) {
      return [];
    }
    if (!upstream.ok) {
      logger.warn("Code category upstream failed", {
        status: upstream.status,
      });
      return [];
    }

    const body: any = await upstream.json();
    const results: any[] = Array.isArray(body?.results) ? body.results : [];
    return results
      .slice(0, options.limit)
      .map((result, index) => ({
        url: typeof result?.url === "string" ? result.url : "",
        title: typeof result?.url === "string" ? result.url : "",
        description:
          typeof result?.passages?.[0]?.text === "string"
            ? result.passages[0].text
            : "",
        position: index + 1,
        category: "code",
      }))
      .filter(result => result.url.length > 0);
  } catch (error) {
    logger.warn("Code category upstream error", { error });
    return [];
  }
}
