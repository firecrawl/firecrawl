import type { Logger } from "winston";
import { z } from "zod";
import type { ExchangeSearchResult } from "../lib/entities";
import {
  EXCHANGE_DISCOVER_TIMEOUT_MS,
  ExchangeProxyError,
  forwardToExchange,
} from "../lib/exchange-proxy";

const capabilitySchema = z
  .object({
    address: z.string(),
    cohorts: z.array(z.string()).optional(),
    concept: z.string().optional(),
    creditsCost: z.number().int().nonnegative(),
    provider: z.string(),
    similarity: z.number().optional(),
  })
  .passthrough();

const discoverSchema = z.object({ capabilities: z.array(z.unknown()) });

const EXCHANGE_DISCOVER_MAX = 24;

export async function searchExchangeCatalog(
  input: {
    query: string;
    limit: number;
    teamId: string;
    requestId?: string;
    timeoutMs?: number;
  },
  logger: Logger,
): Promise<ExchangeSearchResult[] | null> {
  const limit = Math.min(Math.max(input.limit, 1), EXCHANGE_DISCOVER_MAX);
  const timeoutMs = Math.min(
    input.timeoutMs ?? EXCHANGE_DISCOVER_TIMEOUT_MS,
    EXCHANGE_DISCOVER_TIMEOUT_MS,
  );
  try {
    const path = `/v1/discover?q=${encodeURIComponent(input.query)}&limit=${limit}`;
    const upstream = await forwardToExchange({
      teamId: input.teamId,
      method: "GET",
      path,
      timeoutMs,
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
    const results: ExchangeSearchResult[] = [];
    let dropped = 0;
    for (const entry of parsed.data.capabilities) {
      const hit = capabilitySchema.safeParse(entry);
      if (!hit.success) {
        dropped += 1;
        continue;
      }
      results.push({
        provider: hit.data.provider,
        capability: hit.data.address,
        concept: hit.data.concept ?? "",
        cohorts: hit.data.cohorts ?? [],
        creditsCost: hit.data.creditsCost,
        similarity: hit.data.similarity ?? 0,
      });
    }
    if (dropped > 0) {
      logger.warn("Exchange catalogue search dropped malformed entries", {
        dropped,
        kept: results.length,
      });
    }
    return results;
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
