import { AbortManagerThrownError } from "../scraper/scrapeURL/lib/abortManager";
import { CrawlDenialError } from "./error";

export function shouldFailClosedOnInitialRobotsFetch(
  robotsMode?: "ignore" | "respect" | "strict",
): boolean {
  return robotsMode === "strict";
}

export function shouldUseJsRobotsFilterPath({
  ignoreRobotsTxt,
  skipRobots,
  userAgent,
}: {
  ignoreRobotsTxt: boolean;
  skipRobots: boolean;
  userAgent?: string;
}): boolean {
  return Boolean(userAgent?.trim()) && !ignoreRobotsTxt && !skipRobots;
}

export function isRobotsVerificationAbortError(error: unknown): boolean {
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

export function shouldReturnFailedScrapeResponseForRobotsError(
  error: unknown,
): boolean {
  return (
    error instanceof CrawlDenialError &&
    (error.message === "URL blocked by robots.txt" ||
      error.message === "Failed to verify robots.txt in strict mode")
  );
}
