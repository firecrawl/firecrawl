/**
 * Rewrite an absolute or protocol-relative URL onto apiUrl's scheme, host and
 * port (keeping path and query, dropping any fragment) so credentials never
 * leave the configured API origin. Relative URLs are returned unchanged.
 * Throws if apiUrl is not an absolute URL.
 */
export function pinToApiOrigin(apiUrl: string, url: string): string {
  const normalized = url.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+/, "");
  if (!/^([a-z][a-z\d+\-.]*:|[\\/]{2})/i.test(normalized)) return url;
  const base = URL.canParse(apiUrl) ? new URL(apiUrl) : null;
  if (!base?.host) {
    throw new Error(`apiUrl must be an absolute URL, got ${JSON.stringify(apiUrl)}`);
  }
  const target = new URL(normalized, base);
  const pinned = new URL(base.origin);
  pinned.pathname = target.pathname;
  pinned.search = target.search;
  return pinned.href;
}
