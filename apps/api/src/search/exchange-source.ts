import type { Logger } from "winston";
import { z } from "zod";
import type { ExchangeSearchResult } from "../lib/entities";
import {
  EXCHANGE_DISCOVER_TIMEOUT_MS,
  ExchangeProxyError,
  forwardToExchange,
} from "../lib/exchange-proxy";

const discoverSchema = z.object({
  capabilities: z.array(
    z
      .object({
        address: z.string(),
        cohorts: z.array(z.string()).optional(),
        concept: z.string().optional(),
        creditsCost: z.number().int().nonnegative(),
        provider: z.string(),
        similarity: z.number().optional(),
      })
      .passthrough(),
  ),
});

const EXCHANGE_DISCOVER_MAX = 24;

export async function searchExchangeCatalog(
  input: { query: string; limit: number; teamId: string; requestId?: string },
  logger: Logger,
): Promise<ExchangeSearchResult[] | null> {
  const limit = Math.min(Math.max(input.limit, 1), EXCHANGE_DISCOVER_MAX);
  const path = `/v1/discover?q=${encodeURIComponent(input.query)}&limit=${limit}`;
  try {
    const upstream = await forwardToExchange({
      teamId: input.teamId,
      method: "GET",
      path,
      timeoutMs: EXCHANGE_DISCOVER_TIMEOUT_MS,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    if (upstream.status < 200 || upstream.status >= 300) {
      logger.warn("Exchange catalogue search answered with an error", {
        status: upstream.status,
      });
      return null;
    }
    const parsed = discoverSchema.safeParse(upstream.body);
    if (!parsed.success) {
      logger.warn("Exchange catalogue search answered in an unknown shape");
      return null;
    }
    return parsed.data.capabilities.map(hit => ({
      provider: hit.provider,
      capability: hit.address,
      concept: hit.concept ?? "",
      cohorts: hit.cohorts ?? [],
      creditsCost: hit.creditsCost,
      similarity: hit.similarity ?? 0,
    }));
  } catch (error) {
    if (error instanceof ExchangeProxyError) {
      logger.warn("Exchange catalogue search unavailable", {
        kind: error.kind,
      });
    } else {
      logger.warn("Exchange catalogue search errored", { error });
    }
    return null;
  }
}
