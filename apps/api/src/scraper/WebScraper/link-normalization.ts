export function resolveCrawlerLink(
  link: string,
  baseUrl: string,
): URL | null {
  const trimmedLink = link.trim();
  if (trimmedLink === "" || trimmedLink.startsWith("#")) {
    return null;
  }

  try {
    const resolvedUrl = new URL(trimmedLink, baseUrl);
    if (
      resolvedUrl.protocol !== "http:" &&
      resolvedUrl.protocol !== "https:"
    ) {
      return null;
    }

    return resolvedUrl;
  } catch {
    return null;
  }
}
