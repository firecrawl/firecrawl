type MinimalRobot = {
  isAllowed(url: string, userAgent: string): boolean | null | undefined;
};

export function isUrlAllowedByRobotsForUserAgents(
  url: string,
  robots: MinimalRobot | null,
  userAgents: string[],
): boolean {
  if (!robots) return true;

  const getDecisionForUserAgent = (
    userAgent: string,
  ): boolean | undefined => {
    const isAllowed = robots.isAllowed(url, userAgent);

    if (isAllowed == null) {
      return undefined;
    }

    if (isAllowed && !url.endsWith("/")) {
      const parsed = new URL(url);
      if (!parsed.pathname.endsWith("/")) {
        parsed.pathname += "/";
      }
      const urlWithSlash = parsed.toString();
      const isAllowedWithSlash = robots.isAllowed(urlWithSlash, userAgent);
      if (isAllowedWithSlash === false) {
        return false;
      }
    }

    return isAllowed;
  };

  for (const userAgent of userAgents) {
    const decision = getDecisionForUserAgent(userAgent);
    if (decision !== undefined) {
      return decision;
    }
  }

  return true;
}
