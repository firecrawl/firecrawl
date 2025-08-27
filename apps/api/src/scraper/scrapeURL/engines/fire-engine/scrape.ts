import { Logger } from "winston";
import * as Sentry from "@sentry/node";
import { z } from "zod";

import { Action } from "../../../../controllers/v1/types";
import { robustFetch } from "../../lib/fetch";
import { MockState } from "../../lib/mock";

export type FireEngineScrapeRequestCommon = {
  url: string;

  headers?: { [K: string]: string };

  blockMedia?: boolean; // default: true
  // pageOptions?: any; // unused, .scrollXPaths is considered on FE side

  // useProxy?: boolean; // unused, default: true
  // customProxy?: string; // unused

  // disableSmartWaitCache?: boolean; // unused, default: false
  // skipDnsCheck?: boolean; // unused, default: false

  priority?: number; // default: 1
  // team_id?: string; // unused
  logRequest?: boolean; // default: true
  instantReturn?: boolean; // default: false
  geolocation?: { country?: string; languages?: string[] };

  mobileProxy?: boolean; // leave it undefined if user doesn't specify

  timeout?: number;
  saveScrapeResultToGCS?: boolean;
  zeroDataRetention?: boolean;
};

export type FireEngineScrapeRequestChromeCDP = {
  engine: "chrome-cdp";
  skipTlsVerification?: boolean;
  actions?: Action[];
  blockMedia?: true; // cannot be false
  mobile?: boolean;
  disableSmartWaitCache?: boolean;
};

export type FireEngineScrapeRequestPlaywright = {
  engine: "playwright";
  blockAds?: boolean; // default: true

  // mutually exclusive, default: false
  screenshot?: boolean;
  fullPageScreenshot?: boolean;

  wait?: number; // default: 0
};

export type FireEngineScrapeRequestTLSClient = {
  engine: "tlsclient";
  atsv?: boolean; // v0 only, default: false
  disableJsDom?: boolean; // v0 only, default: false
};

const schema = z.object({
  jobId: z.string(),
  processing: z.boolean(),
});

export const fireEngineURL = process.env.FIRE_ENGINE_BETA_URL ?? "<mock-fire-engine-url>";
export const fireEngineStagingURL = process.env.FIRE_ENGINE_STAGING_URL ?? "<mock-fire-engine-url>";

export async function fireEngineScrape<
  Engine extends
    | FireEngineScrapeRequestChromeCDP
    | FireEngineScrapeRequestPlaywright
    | FireEngineScrapeRequestTLSClient,
>(
  logger: Logger,
  request: FireEngineScrapeRequestCommon & Engine,
  mock: MockState | null,
  abort?: AbortSignal,
  production = true,
): Promise<z.infer<typeof schema>> {
  const scrapeRequest = await robustFetch({
    url: `${production ? fireEngineURL : fireEngineStagingURL}/scrape`,
    method: "POST",
    headers: {},
    body: request,
    logger: logger.child({ method: "fireEngineScrape/robustFetch" }),
    schema,
    tryCount: 3,
    mock,
    abort,
  });

  return scrapeRequest;
}
