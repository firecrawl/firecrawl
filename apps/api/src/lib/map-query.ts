export function normalizeMapDomainUrl(url: string): string {
  // Strip www. only from the host portion of the URL to avoid mangling
  // path or query strings that may contain "www." substrings.
  return url.replace(/^(https?:\/\/)www\./i, "$1");
}

export function buildMapUrlQuery(
  url: string,
  search?: string,
  allowExternalLinks: boolean = false,
): string {
  const normalizedUrl = normalizeMapDomainUrl(url);

  return search && allowExternalLinks
    ? `${search} ${normalizedUrl}`
    : search
      ? `${search} site:${normalizedUrl}`
      : `site:${normalizedUrl}`;
}
