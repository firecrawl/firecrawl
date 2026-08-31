import type { Logger } from "winston";
import type { WebSearchResult } from "../lib/entities";
import { keylessTeamPseudonym } from "../lib/keyless";
import { fetchResearchUpstream } from "../lib/research-upstream";
import type { CategoryOption } from "../lib/search-query-builder";

const DEVELOPER_QUERY_KEYS = ["query", "k"];

export function wantsDeveloperCategory(categories?: CategoryOption[]): boolean {
  return (categories ?? []).some(category =>
    typeof category === "string"
      ? category === "developer"
      : category.type === "developer",
  );
}

export async function searchDeveloperCategory(
  options: { query: string; limit: number; teamId: string; timeout: number },
  logger: Logger,
): Promise<WebSearchResult[]> {
  try {
    const upstream = await fetchResearchUpstream({
      path: "/v2/code/search",
      params: { query: options.query, k: options.limit },
      queryKeys: DEVELOPER_QUERY_KEYS,
      headers: {
        "firecrawl-team-id": keylessTeamPseudonym(options.teamId),
      },
      timeoutMs: options.timeout,
    });
    if (upstream === null) {
      return [];
    }
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      logger.warn("Developer category upstream failed", {
        status: upstream.status,
      });
      return [];
    }

    const body: any = await upstream.json();
    const results: any[] = Array.isArray(body?.results) ? body.results : [];
    // Exact WebSearchResult shape: developer results are indistinguishable
    // from ordinary web results on the wire. Passage text serves as the
    // description; nothing from the upstream payload leaks through.
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
          typeof result?.passages?.[0]?.text === "string"
            ? result.passages[0].text
            : "",
        position: index + 1,
        category: "developer",
      }))
      .filter(result => result.url.length > 0);
  } catch (error) {
    logger.warn("Developer category upstream error", { error });
    return [];
  }
}
