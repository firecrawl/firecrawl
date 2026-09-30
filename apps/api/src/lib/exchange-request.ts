import { getExchangeAccessForRequest, type ExchangeAccess } from "./exchange";

type ExchangeFlags = Parameters<typeof getExchangeAccessForRequest>[0]["flags"];

/**
 * Run the Exchange access gate against an API request body, sourcing the
 * effective per-page options from a nested scrapeOptions object (crawl
 * bodies) or the body itself (scrape and batch scrape bodies), with v1
 * pageOptions fallbacks.
 */
export function getExchangeAccessForRequestBody(input: {
  body: Record<string, any>;
  flags: ExchangeFlags;
  url: string;
  blocked: boolean;
  zeroDataRetention: boolean;
  teamId: string | null;
  orgId: string | null;
}): Promise<ExchangeAccess> {
  const body = input.body ?? {};
  const scrapeOptions =
    typeof body.scrapeOptions === "object" && body.scrapeOptions !== null
      ? body.scrapeOptions
      : body;

  return getExchangeAccessForRequest({
    url: input.url,
    teamId: input.teamId,
    orgId: input.orgId,
    blocked: input.blocked,
    formats: scrapeOptions.formats,
    actions: scrapeOptions.actions,
    profile: scrapeOptions.profile,
    minAge: scrapeOptions.minAge,
    zeroDataRetention: input.zeroDataRetention,
    lockdown: scrapeOptions.lockdown ?? body.lockdown,
    flags: input.flags,
  });
}
