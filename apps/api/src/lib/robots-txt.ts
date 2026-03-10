import robotsParser, { Robot } from "robots-parser";
import { config } from "../config";
import { Logger } from "winston";
import { ScrapeOptions, scrapeOptions } from "../controllers/v2/types";
import { scrapeURL } from "../scraper/scrapeURL";
import { Engine } from "../scraper/scrapeURL/engines";
import { CostTracking } from "./cost-tracking";
import { useIndex } from "../services";

const ROBOTS_MAX_AGE = 1 * 24 * 60 * 60 * 1000;

const useFireEngine =
  config.FIRE_ENGINE_BETA_URL !== "" &&
  config.FIRE_ENGINE_BETA_URL !== undefined;

interface RobotsTxtChecker {
  robotsTxtUrl: string;
  robotsTxt: string;
  robots: Robot;
}

export async function fetchRobotsTxt(
  {
    url,
    zeroDataRetention,
    location,
  }: {
    url: string;
    zeroDataRetention: boolean;
    location?: ScrapeOptions["location"];
  },
  scrapeId: string,
  logger: Logger,
  abort?: AbortSignal,
): Promise<{ content: string; url: string }> {
  const urlObj = new URL(url);
  const robotsTxtUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;

  const shouldPrioritizeFireEngine = location && useFireEngine;

  const forceEngine: Engine[] = [
    ...(useIndex ? ["index" as const] : []),
    ...(shouldPrioritizeFireEngine
      ? [
          "fire-engine;tlsclient" as const,
          "fire-engine;tlsclient;stealth" as const,
          // final fallback to chrome-cdp to fill the index
          "fire-engine;chrome-cdp" as const,
          "fire-engine;chrome-cdp;stealth" as const,
        ]
      : []),
    "fetch",
    ...(!shouldPrioritizeFireEngine && useFireEngine
      ? [
          "fire-engine;tlsclient" as const,
          "fire-engine;tlsclient;stealth" as const,
          // final fallback to chrome-cdp to fill the index
          "fire-engine;chrome-cdp" as const,
          "fire-engine;chrome-cdp;stealth" as const,
        ]
      : []),
  ];

  let content: string = "";
  const response = await scrapeURL(
    "robots-txt;" + scrapeId,
    robotsTxtUrl,
    scrapeOptions.parse({
      formats: ["rawHtml"],
      timeout: 8000,
      maxAge: ROBOTS_MAX_AGE,
      ...(location ? { location } : {}),
    }),
    {
      forceEngine,
      v0DisableJsDom: true,
      externalAbort: abort
        ? {
            signal: abort,
            tier: "external",
            throwable() {
              return new Error("Robots.txt fetch aborted");
            },
          }
        : undefined,
      teamId: "robots-txt",
      zeroDataRetention,
    },
    new CostTracking(),
  );

  if (
    response.success &&
    response.document.metadata.statusCode >= 200 &&
    response.document.metadata.statusCode < 300
  ) {
    content = response.document.rawHtml!;
  } else {
    if (response.success && response.document.metadata.statusCode === 404) {
      logger.warn("Robots.txt not found", { robotsTxtUrl }); // should probably index 404 robots.txt
      return { content: "", url: robotsTxtUrl };
    }

    logger.error(`Request failed for robots.txt fetch`, {
      method: "fetchRobotsTxt",
      robotsTxtUrl,
      error: response.success
        ? response.document.metadata.statusCode
        : response.error,
    });
    return { content: "", url: robotsTxtUrl };
  }

  // return URL in case we've been redirected
  return {
    content: content,
    url: response.document.metadata.url || robotsTxtUrl,
  };
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
  userAgents: string[] = ["FireCrawlAgent", "FirecrawlAgent"],
): boolean {
  if (!robots) return true;

  for (const userAgent of userAgents) {
    let isAllowed = robots.isAllowed(url, userAgent);

    // Handle null/undefined responses - default to true (allowed)
    if (isAllowed === null || isAllowed === undefined) {
      isAllowed = true;
    }

    if (isAllowed == null) {
      isAllowed = true;
    }

    // Also check with trailing slash if URL doesn't have one
    // This catches cases like "Disallow: /path/" when user requests "/path"
    if (isAllowed && !url.endsWith("/")) {
      const urlWithSlash = url + "/";
      let isAllowedWithSlash = robots.isAllowed(urlWithSlash, userAgent);

      if (isAllowedWithSlash == null) {
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
