export function resolveCrawlerLink(
  link: string,
  baseUrl: string,
): URL | null {
  try {
    return new URL(link.trim(), baseUrl);
  } catch {
    return null;
  }
}
