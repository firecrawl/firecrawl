import { config } from "../../../../config";
import type { EngineScrapeResult } from "..";
import type { Meta } from "../..";
import {
  playwrightMaxReasonableTime,
  scrapeURLWithPlaywrightEndpoint,
} from "../playwright";

export function isPlaywrightProxyConfigured(): boolean {
  return Boolean(config.PLAYWRIGHT_PROXY_MICROSERVICE_URL);
}

export async function scrapeURLWithPlaywrightProxy(
  meta: Meta,
): Promise<EngineScrapeResult> {
  return scrapeURLWithPlaywrightEndpoint(
    meta,
    config.PLAYWRIGHT_PROXY_MICROSERVICE_URL!,
    "stealth",
  );
}

export const playwrightProxyMaxReasonableTime = playwrightMaxReasonableTime;
