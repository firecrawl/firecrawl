import { CrawlDenialError } from "./error";
import { getHeaderValueCaseInsensitive } from "./header-utils";
import { AbortManagerThrownError } from "../scraper/scrapeURL/lib/abortManager";

type FetchRobotsTxtResult = {
  content: string;
  url: string;
};

type RobotsChecker = {
  robots: unknown;
};

type RobotsLogger = {
  info(message: string, meta?: unknown): void;
  debug(message: string, meta?: unknown): void;
};

type VerifyScrapeRobotsAccessArgs = {
  url: string;
  id: string;
  logger: RobotsLogger;
  robotsMode?: "ignore" | "respect" | "strict";
  cachedRobotsTxt?: string;
  zeroDataRetention: boolean;
  location?: unknown;
  headers?: Record<string, string>;
  abort?: AbortSignal;
};

type VerifyScrapeRobotsAccessDeps = {
  fetchRobotsTxt(args: {
    url: string;
    zeroDataRetention: boolean;
    location?: unknown;
    headers?: Record<string, string>;
  }, scrapeId: string, logger: RobotsLogger, abort?: AbortSignal): Promise<FetchRobotsTxtResult>;
  createRobotsChecker(url: string, robotsTxt: string): RobotsChecker;
  isUrlAllowedByRobots(url: string, robots: unknown, userAgents: string[]): boolean;
  getRobotsUserAgents(userAgent?: string): string[];
};

function isRobotsVerificationAbortError(error: unknown): boolean {
  if (error instanceof AbortManagerThrownError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === "AbortError" || error.message === "Robots.txt fetch aborted"
  );
}

export async function verifyScrapeRobotsAccess(
  {
    url,
    id,
    logger,
    robotsMode = "respect",
    cachedRobotsTxt,
    zeroDataRetention,
    location,
    headers,
    abort,
  }: VerifyScrapeRobotsAccessArgs,
  deps: VerifyScrapeRobotsAccessDeps,
): Promise<void> {
  if (robotsMode === "ignore") {
    return;
  }

  const urlObj = new URL(url);
  if (urlObj.pathname === "/robots.txt") {
    return;
  }

  try {
    let robotsTxt = cachedRobotsTxt;

    if (robotsTxt === undefined) {
      const response = await deps.fetchRobotsTxt(
        {
          url,
          zeroDataRetention,
          location,
          headers,
        },
        id,
        logger,
        abort,
      );
      robotsTxt = response.content;
    }

    const checker = deps.createRobotsChecker(url, robotsTxt);
    const isAllowed = deps.isUrlAllowedByRobots(
      url,
      checker.robots,
      deps.getRobotsUserAgents(
        getHeaderValueCaseInsensitive(headers, "user-agent"),
      ),
    );

    if (!isAllowed) {
      logger.info("URL blocked by robots.txt", { url });
      throw new CrawlDenialError("URL blocked by robots.txt");
    }
  } catch (error) {
    if (error instanceof CrawlDenialError) {
      throw error;
    }
    if (isRobotsVerificationAbortError(error)) {
      throw error;
    }
    if (robotsMode === "strict") {
      throw new CrawlDenialError("Failed to verify robots.txt in strict mode");
    }
    logger.debug("Failed to fetch robots.txt, allowing scrape", {
      error,
      url,
    });
  }
}
