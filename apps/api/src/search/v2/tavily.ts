import {
  tavily,
  type TavilyClient,
  type TavilySearchResponse,
} from "@tavily/core";
import { config } from "../../config";
import { SearchV2Response, WebSearchResult } from "../../lib/entities";
import { logger } from "../../lib/logger";

// Lazily instantiated singleton client to avoid per-call allocation overhead
let _client: TavilyClient | null = null;

function getClient(): TavilyClient {
  if (!_client) {
    _client = tavily({ apiKey: config.TAVILY_API_KEY! });
  }
  return _client;
}

export async function tavilySearch(
  query: string,
  options: {
    num_results?: number;
    country?: string;
  },
): Promise<SearchV2Response> {
  try {
    const client = getClient();

    const response = await client.search(query, {
      maxResults: Math.min(options.num_results ?? 5, 20),
      searchDepth: "basic",
      topic: "general",
      // Tavily supports a `country` parameter for locale-sensitive results.
      // There is no separate `lang` parameter in the Tavily API; language
      // preference is inferred from the query and country.
      ...(options.country ? { country: options.country } : {}),
    });

    if (!response.results || response.results.length === 0) {
      return {};
    }

    const web: WebSearchResult[] = response.results.map(
      (result: TavilySearchResponse["results"][number], index: number) => ({
        url: result.url,
        title: result.title,
        description: result.content ?? "",
        position: index + 1,
      }),
    );

    return { web };
  } catch (error) {
    logger.error("Tavily search error", { error });
    return {};
  }
}
