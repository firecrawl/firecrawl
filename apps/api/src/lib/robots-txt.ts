import robotsParser, { Robot } from "robots-parser";
import { Logger } from "winston";
import { ScrapeOptions, scrapeOptions } from "../controllers/v2/types";
import { CostTracking } from "./extract/extraction-service";
import { scrapeURL } from "../scraper/scrapeURL";
import { Engine } from "../scraper/scrapeURL/engines";

const useFireEngine =
  process.env.FIRE_ENGINE_BETA_URL !== "" &&
  process.env.FIRE_ENGINE_BETA_URL !== undefined;

export interface RobotsTxtChecker {
  robotsTxtUrl: string;
  robotsTxt: string;
  robots: Robot;
}

export async function fetchRobotsTxt(
  {
    url,
    zeroDataRetention = false,
    location,
  }: {
    url: string;
    zeroDataRetention?: boolean;
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
    ...(shouldPrioritizeFireEngine
      ? [
          "fire-engine;tlsclient" as const,
          "fire-engine;tlsclient;stealth" as const,
        ]
      : []),
    "fetch",
    ...(!shouldPrioritizeFireEngine && useFireEngine
      ? [
          "fire-engine;tlsclient" as const,
          "fire-engine;tlsclient;stealth" as const,
        ]
      : []),
  ];

  let content: string = "";
  const response = await scrapeURL(
    "robots-txt;" + scrapeId,
    robotsTxtUrl,
    scrapeOptions.parse({
      formats: ["rawHtml"],
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

export async function checkRobotsTxt(
  url: string,
  scrapeId: string,
  logger: Logger,
  abort?: AbortSignal,
): Promise<boolean> {
  // if url is robots.txt, always allow (prevents infinite loop from scrapeURL when checkRobotsOnScrape is enabled)
  const urlObj = new URL(url);
  if (urlObj.pathname === "/robots.txt") {
    return true;
  }

  try {
    const { content: robotsTxt } = await fetchRobotsTxt(
      { url },
      scrapeId,
      logger,
      abort,
    );
    const checker = createRobotsChecker(url, robotsTxt);
    return isUrlAllowedByRobots(url, checker.robots);
  } catch (error) {
    // If we can't fetch robots.txt, assume it's allowed
    logger?.debug("Failed to fetch robots.txt, allowing scrape", {
      error,
      url,
    });
    return true;
  }
}
