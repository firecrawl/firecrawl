import robotsParser, { Robot } from "robots-parser";
import * as undici from "undici";
import { Logger } from "winston";
import { getSecureDispatcher } from "../scraper/scrapeURL/engines/utils/safeFetch";

export interface RobotsTxtChecker {
  robotsTxtUrl: string;
  robotsTxt: string;
  robots: Robot;
}

export async function fetchRobotsTxt(
  url: string,
  skipTlsVerification: boolean = false,
  abort?: AbortSignal,
): Promise<string> {
  const urlObj = new URL(url);
  const robotsTxtUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;

  const response = await undici.fetch(robotsTxtUrl, {
    signal: abort,
    dispatcher: getSecureDispatcher(skipTlsVerification),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch robots.txt: ${response.status} ${response.statusText}`,
    );
  }

  const content = await response.text();
  const contentType = response.headers.get("content-type") || "";

  if (
    (contentType.includes("text/html") && content.trim().startsWith("<")) ||
    contentType.includes("application/json") ||
    contentType.includes("application/xml")
  ) {
    return "";
  }

  return content;
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
  skipTlsVerification: boolean = false,
  logger?: Logger,
  abort?: AbortSignal,
): Promise<boolean> {
  try {
    const robotsTxt = await fetchRobotsTxt(url, skipTlsVerification, abort);
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
