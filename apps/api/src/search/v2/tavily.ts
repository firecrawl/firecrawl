import { tavily } from "@tavily/core";
import { config } from "../../config";
import { SearchV2Response, WebSearchResult } from "../../lib/entities";
import { logger } from "../../lib/logger";

export async function tavilySearch(
  query: string,
  options: {
    num_results?: number;
    lang?: string;
    country?: string;
  },
): Promise<SearchV2Response> {
  try {
    const client = tavily({ apiKey: config.TAVILY_API_KEY! });

    const response = await client.search(query, {
      maxResults: Math.min(options.num_results ?? 5, 20),
      searchDepth: "basic",
      topic: "general",
    });

    if (!response.results || response.results.length === 0) {
      return {};
    }

    const web: WebSearchResult[] = response.results.map(
      (result: any, index: number) => ({
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
