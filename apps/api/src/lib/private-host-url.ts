/** The request schema's public-host shape check needs an explicit exception for
 * single-label hosts on trusted self-hosted instances. Connection-time SSRF
 * protection still decides whether the resolved address may be fetched. */
export function allowsBarePrivateHost(
  url: string,
  permissions: {
    privateScraping: boolean;
    legacyWebhooks: boolean;
    selfHostedTestSuite: boolean;
  },
): boolean {
  if (permissions.privateScraping) {
    // URL parsing/HTTP-only validation also happens in each request schema.
    try {
      return !new URL(url).hostname.includes(".");
    } catch {
      return false;
    }
  }

  // Preserve the narrower legacy test-suite exception for webhook deployments.
  return (
    permissions.selfHostedTestSuite &&
    permissions.legacyWebhooks &&
    /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(:\d+)?([\/?#]|$)/i.test(
      url,
    )
  );
}
