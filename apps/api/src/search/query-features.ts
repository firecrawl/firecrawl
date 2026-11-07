import type { Logger } from "winston";
import { config } from "../config";

/** The router's confidence, at or above which a query needs provider data. */
export const ANY_PROVIDER_MIN = 0.83;
const MAX_TIMEOUT_MS = 800;

export type RoutedProviders = {
  /** Probability that any provider serves the query. */
  anyProvider: number;
  /** Providers the router names, best first. */
  providers: { id: string; probability: number }[];
};

/**
 * Asks the search-index query-features router which providers serve a query.
 * Resolves undefined when it is not configured, fails, or times out.
 */
export async function queryFeatures(
  query: string,
  timeoutMs: number,
  logger: Logger,
): Promise<RoutedProviders | undefined> {
  if (!config.QUERY_FEATURES_URL || timeoutMs <= 0) return undefined;
  try {
    const response = await fetch(config.QUERY_FEATURES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "firecrawl-zero-data-retention": "false",
      },
      body: JSON.stringify({
        queries: [query],
        top: 5,
        features: ["alexandria"],
      }),
      signal: AbortSignal.timeout(Math.min(MAX_TIMEOUT_MS, timeoutMs)),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      logger.warn("Query-features router unavailable", {
        status: response.status,
      });
      return undefined;
    }
    const body = (await response.json()) as {
      results?: {
        alexandria?: { any_provider?: unknown; providers?: unknown };
      }[];
    };
    const alexandria = body.results?.[0]?.alexandria;
    const anyProvider = alexandria?.any_provider;
    if (typeof anyProvider !== "number" || !Number.isFinite(anyProvider))
      return undefined;
    const providers = Array.isArray(alexandria?.providers)
      ? alexandria.providers.flatMap(item =>
          item &&
          typeof item.id === "string" &&
          item.id.trim() &&
          typeof item.probability === "number"
            ? [{ id: item.id.trim(), probability: item.probability }]
            : [],
        )
      : [];
    return { anyProvider, providers };
  } catch (error) {
    logger.warn("Query-features router unavailable", { error });
    return undefined;
  }
}
