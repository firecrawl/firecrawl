import {
  getExchangeAccessForRequest,
  type ExchangeAccess,
} from "./exchange";

type ExchangeFlags = Parameters<
  typeof getExchangeAccessForRequest
>[0]["flags"];

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
  zeroDataRetention: boolean;
}): Promise<ExchangeAccess> {
  const body = input.body ?? {};
  const scrapeOptions =
    typeof body.scrapeOptions === "object" && body.scrapeOptions !== null
      ? body.scrapeOptions
      : body;

  return getExchangeAccessForRequest({
    url: input.url,
    formats: scrapeOptions.formats,
    actions: scrapeOptions.actions,
    headers: scrapeOptions.headers,
    waitFor: scrapeOptions.waitFor,
    mobile: scrapeOptions.mobile,
    location: scrapeOptions.location,
    proxy: scrapeOptions.proxy,
    blockAds: scrapeOptions.blockAds,
    profile: scrapeOptions.profile,
    atsv: scrapeOptions.atsv ?? body.pageOptions?.atsv,
    minAge: scrapeOptions.minAge,
    includeTags: scrapeOptions.includeTags ?? body.pageOptions?.includeTags,
    excludeTags: scrapeOptions.excludeTags ?? body.pageOptions?.excludeTags,
    zeroDataRetention: input.zeroDataRetention,
    lockdown: scrapeOptions.lockdown ?? body.lockdown,
    flags: input.flags,
  });
}
