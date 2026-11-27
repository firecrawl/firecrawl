import type { Robot } from "robots-parser";
import robotsParser from "robots-parser";
import type { Logger } from "winston";
import type { ScrapeOptions } from "../controllers/v2/types";
import {
  getV2RequestSchemas,
  scrapeOptionsAcceptsMaxAge,
} from "../controllers/v2/types";
import { scrapeURL } from "../scraper/scrapeURL";
import type { Engine } from "../scraper/scrapeURL/engines";
import type { RequestContext } from "../service/request-context";
import { installedService } from "../service/service";
import { CostTracking } from "./cost-tracking";

const ROBOTS_MAX_AGE = 1 * 24 * 60 * 60 * 1000;

interface RobotsTxtChecker {
  robotsTxtUrl: string;
  robotsTxt: string;
  robots: Robot;
}

interface RobotsScrapeOptionsInput {
  formats: Array<string>;
  timeout: number;
  maxAge?: number;
  location?: ScrapeOptions["location"];
  headers?: Record<string, string>;
  skipTlsVerification?: boolean;
}

export async function fetchRobotsTxt(
  {
    url,
    zeroDataRetention,
    usOnly,
    location,
    headers,
    skipCache,
    skipTlsVerification,
  }: {
    url: string;
    zeroDataRetention: boolean;
    usOnly?: boolean;
    skipTlsVerification?: boolean;
    location?: ScrapeOptions["location"];
    headers?: Record<string, string>;
    skipCache?: boolean;
  },
  scrapeId: string,
  logger: Logger,
  abort?: AbortSignal,
): Promise<{ content: string; url: string }> {
  const urlObj = new URL(url);
  const robotsTxtUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;

  const forceEngine: Array<Engine> = ["fetch"];
  const parentCtx: RequestContext = {
    teamId: "robots-txt",
    zeroDataRetention,
  };
  if (usOnly) {
    parentCtx.usOnly = true;
  }
  const systemCtx =
    installedService()?.modules.policy.system("robots-txt", parentCtx) ??
    parentCtx;

  const schema = getV2RequestSchemas().scrapeOptions;
  const rawScrapeOptions: RobotsScrapeOptionsInput = {
    formats: ["rawHtml"],
    timeout: 8000,
  };
  if (scrapeOptionsAcceptsMaxAge(schema)) {
    rawScrapeOptions.maxAge = skipCache ? 0 : ROBOTS_MAX_AGE;
  }
  if (location) {
    rawScrapeOptions.location = location;
  }
  if (headers) {
    rawScrapeOptions.headers = headers;
  }
  if (skipTlsVerification) {
    rawScrapeOptions.skipTlsVerification = skipTlsVerification;
  }

  const response = await scrapeURL(
    "robots-txt;" + scrapeId,
    robotsTxtUrl,
    schema.parse(rawScrapeOptions),
    {
      ctx: systemCtx,
      forceEngine,
      v0DisableJsDom: true,
      orgId: null,
      externalAbort: abort
        ? {
            signal: abort,
            tier: "external",
            throwable() {
              return new Error("Robots.txt fetch aborted");
            },
          }
        : undefined,
      teamId: systemCtx.teamId,
      zeroDataRetention: systemCtx.zeroDataRetention,
    },
    new CostTracking(),
  );

  if (
    response.success &&
    response.document.metadata.statusCode >= 200 &&
    response.document.metadata.statusCode < 300
  ) {
    return {
      content: response.document.rawHtml ?? "",
      url: response.document.metadata.url || robotsTxtUrl,
    };
  }

  if (response.success && response.document.metadata.statusCode === 404) {
    // A missing robots.txt is expected; return empty content without logging.
    return { content: "", url: robotsTxtUrl };
  }

  const fetchError: unknown = response.success
    ? response.document.metadata.statusCode
    : response.error;
  logger.error(`Request failed for robots.txt fetch`, {
    method: "fetchRobotsTxt",
    robotsTxtUrl,
    error: fetchError,
  });
  return { content: "", url: robotsTxtUrl };
}

export function createRobotsChecker(
  url: string,
  robotsTxt: string,
): RobotsTxtChecker {
  const urlObj = new URL(url);
  const robotsTxtUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;
  const robots = robotsParser(robotsTxtUrl, robotsTxt);
  return {
    robotsTxtUrl,
    robotsTxt,
    robots,
  };
}

export function isUrlAllowedByRobots(
  url: string,
  robots: Robot | null,
  userAgents: Array<string> = ["FireCrawlAgent", "FirecrawlAgent"],
): boolean {
  if (!robots) {
    return true;
  }

  for (const userAgent of userAgents) {
    let isAllowed = robots.isAllowed(url, userAgent);

    // Handle null/undefined responses - default to true (allowed)
    if (isAllowed === null || isAllowed === undefined) {
      isAllowed = true;
    }

    // Also check with trailing slash if URL doesn't have one
    // This catches cases like "Disallow: /path/" when user requests "/path"
    if (isAllowed && !url.endsWith("/")) {
      const urlWithSlash = url + "/";
      let isAllowedWithSlash = robots.isAllowed(urlWithSlash, userAgent);

      if (isAllowedWithSlash === null || isAllowedWithSlash === undefined) {
        isAllowedWithSlash = true;
      }

      // If the trailing slash version is explicitly disallowed, block it
      if (isAllowedWithSlash === false) {
        isAllowed = false;
      }
    }

    if (isAllowed) {
      //   console.log("isAllowed: true, " + userAgent);
      return true;
    }
  }

  return false;
}
