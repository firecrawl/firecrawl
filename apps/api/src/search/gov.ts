import type { Logger } from "winston";
import type { WebSearchResult } from "../lib/entities";
import { fetchGovUpstream } from "../lib/research-upstream";
import { hasCategory, type CategoryOption } from "../lib/search-query-builder";

export function wantsGovCategory(categories?: CategoryOption[]): boolean {
  return hasCategory(categories, "gov");
}

export async function searchGovCategory(
  options: { query: string; limit: number; teamId: string; timeout: number },
  logger: Logger,
): Promise<WebSearchResult[]> {
  try {
    const upstream = await fetchGovUpstream({
      query: options.query,
      k: options.limit,
      headers: { "firecrawl-team-id": options.teamId },
      timeoutMs: options.timeout,
    });
    if (upstream === null) {
      return [];
    }
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      logger.warn("Gov category upstream failed", { status: upstream.status });
      return [];
    }

    const body: any = await upstream.json();
    const results: any[] = Array.isArray(body?.data?.web) ? body.data.web : [];
    return results
      .slice(0, options.limit)
      .map((result, index) => ({
        url: typeof result?.url === "string" ? result.url : "",
        title:
          typeof result?.title === "string" && result.title.trim().length > 0
            ? result.title
            : typeof result?.url === "string"
              ? result.url
              : "",
        description:
          typeof result?.description === "string" ? result.description : "",
        position: index + 1,
        category: "gov",
      }))
      .filter(result => result.url.length > 0);
  } catch (error) {
    logger.warn("Gov category upstream error", { error });
    return [];
  }
}
