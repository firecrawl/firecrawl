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
