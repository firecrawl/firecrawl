import type { Logger } from "winston";
import { config } from "../../config";
import type { ErrorCodes } from "../../lib/error";
import { exchangeRequest } from "./client";

export type ExchangeUrlSuggestion = {
  provider: string;
  capability: string;
  reason: string;
  input?: Record<string, string>;
  creditsCost?: number;
  contractPath: string;
};

export type ExchangeUrlSuggestions = {
  suggestions: ExchangeUrlSuggestion[];
  message: string;
};

/**
 * Exchange capabilities that can return a URL's data instead of scraping it
 * (`GET /v1/discover/suggestions`). Fails open: any error, timeout or empty
 * answer returns undefined so a caller never changes its own outcome.
 */
export async function exchangeUrlSuggestions(input: {
  teamId: string;
  url: string;
  timeoutMs?: number;
}): Promise<ExchangeUrlSuggestions | undefined> {
  if (!config.FIRE_EXCHANGE_URL) return undefined;
  try {
    const response = await exchangeRequest({
      teamId: input.teamId,
      path: `/v1/discover/suggestions?${new URLSearchParams({ url: input.url })}`,
      timeoutMs: input.timeoutMs ?? 1500,
    });
    if (response.status !== 200) return undefined;
    const body = response.body as {
      suggestions?: unknown;
      message?: unknown;
    } | null;
    if (
      !body ||
      !Array.isArray(body.suggestions) ||
      body.suggestions.length === 0 ||
      typeof body.message !== "string"
    )
      return undefined;
    return {
      suggestions: (body.suggestions as ExchangeUrlSuggestion[]).map(
        suggestion => ({
          ...suggestion,
          contractPath: suggestion.contractPath?.replace(
            /^\/v1\/discover\//,
            "/exchange/discover/",
          ),
        }),
      ),
      message: body.message,
    };
  } catch {
    return undefined;
  }
}

/**
 * Scrape failures where the page could not be fetched at all: every engine
 * failed, or the browser could not load the site. Other failures (timeouts,
 * DNS, unsupported files, actions) are not about access to the page.
 */
const SUGGESTION_ERROR_CODES: ReadonlySet<ErrorCodes> = new Set([
  "SCRAPE_ALL_ENGINES_FAILED",
  "SCRAPE_SITE_ERROR",
]);

/**
 * Builds the user-facing error of a failed single scrape, appending the
 * Exchange's suggestion when it knows a capability that returns the page's
 * data. Only for access failures, never for zero-data-retention requests (the
 * URL would leave the scrape), and bounded by the suggestions timeout; every
 * other case returns the original message unchanged.
 */
export async function scrapeErrorWithSuggestions(input: {
  teamId: string;
  url: string;
  code: ErrorCodes;
  message: string;
  zeroDataRetention: boolean;
  logger: Pick<Logger, "debug">;
  timeoutMs?: number;
}): Promise<{
  error: string;
  alexandriaSuggestions?: ExchangeUrlSuggestion[];
}> {
  if (
    !config.FIRE_EXCHANGE_URL ||
    input.zeroDataRetention ||
    !SUGGESTION_ERROR_CODES.has(input.code)
  )
    return { error: input.message };
  const result = await exchangeUrlSuggestions({
    teamId: input.teamId,
    url: input.url,
    timeoutMs: input.timeoutMs,
  });
  input.logger.debug("Exchange URL suggestions for failed scrape", {
    code: input.code,
    suggestions: result?.suggestions.length ?? 0,
  });
  if (!result) return { error: input.message };
  return {
    error: `${input.message} ${result.message}`,
    alexandriaSuggestions: result.suggestions,
  };
}
