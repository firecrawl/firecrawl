import type { Logger } from "winston";
import type { WebSearchResult } from "../lib/entities";
import {
  fetchGovUpstream,
  usOnlySkippedWarning,
  usOnlyUpstreamRefusal,
  UsOnlyUpstreamRefusalError,
} from "../lib/research-upstream";
import { hasCategory, type CategoryOption } from "../lib/search-query-builder";

export function wantsGovCategory(categories?: CategoryOption[]): boolean {
  return hasCategory(categories, "gov");
}

export async function searchGovCategory(
  options: {
    query: string;
    limit: number;
    teamId: string;
    timeout: number;
    zeroDataRetention: boolean;
    usOnly?: boolean;
    /** Receives the warnings for parts the upstream skipped for a US-only request. */
    warnings?: string[];
  },
  logger: Logger,
): Promise<WebSearchResult[]> {
  try {
    const upstream = await fetchGovUpstream({
      query: options.query,
      k: options.limit,
      headers: {
        "firecrawl-team-id": options.teamId,
        "firecrawl-zero-data-retention": String(options.zeroDataRetention),
        ...(options.usOnly ? { "firecrawl-us-only": "true" } : {}),
      },
      timeoutMs: options.timeout,
    });
    if (upstream === null) {
      return [];
    }
    if (options.usOnly && upstream.status >= 400 && upstream.status < 500) {
      throw await usOnlyUpstreamRefusal(
        upstream,
        "Government search refused the request.",
      );
    }
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      logger.warn("Gov category upstream failed", { status: upstream.status });
      return [];
    }

    const skipped = options.usOnly
      ? usOnlySkippedWarning(upstream.headers)
      : undefined;
    if (skipped) options.warnings?.push(skipped);

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
    if (error instanceof UsOnlyUpstreamRefusalError) throw error;
    logger.warn("Gov category upstream error", { error });
    return [];
  }
}
