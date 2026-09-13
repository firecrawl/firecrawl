import { getCrawlScope } from "../../lib/crawl-scope";
import { parseHostname } from "../../lib/url-utils";

export function getKickoffSitemapUrls(
  url: string,
  robotsSitemaps: string[],
): string[] {
  const urlObj = new URL(url);
  if (urlObj.pathname.endsWith(".xml") || urlObj.pathname.endsWith(".xml.gz")) {
    return [url];
  }

  const urlWithSitemap = new URL(urlObj.href);
  urlWithSitemap.pathname = getCrawlScope(urlObj.href).prefix + "sitemap.xml";
  urlWithSitemap.search = "";
  urlWithSitemap.hash = "";

  const attempts = [
    ...robotsSitemaps,
    urlWithSitemap.href,
    new URL("/sitemap.xml", urlObj.href).href,
  ];

  // Root domain sitemap.xml. Skipped when the host has no registrable domain
  // (IP literals, localhost): assigning a null domain would stringify to the
  // literal hostname "null" and produce https://null/sitemap.xml.
  const rootDomain = parseHostname(urlObj.hostname).domain;
  if (rootDomain && rootDomain !== urlObj.hostname) {
    const urlRootSitemap = new URL("/sitemap.xml", urlObj.href);
    urlRootSitemap.hostname = rootDomain;
    attempts.push(urlRootSitemap.href);
  }

  return [...new Set(attempts)];
}
