/**
 * Sites that answer some requests with a 200 page holding only their generic
 * error shell. Such a page is not the requested content: it must not count as
 * a successful scrape or be stored in the index.
 */
const SOFT_ERROR_PAGE_MARKERS: { host: string; marker: string }[] = [
  { host: "target.com", marker: 'data-test="genericError"' },
];

export function isSoftErrorPage(
  url: string,
  html: string | undefined,
): boolean {
  if (!html) return false;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return SOFT_ERROR_PAGE_MARKERS.some(
    ({ host, marker }) =>
      (hostname === host || hostname.endsWith("." + host)) &&
      html.includes(marker),
  );
}
