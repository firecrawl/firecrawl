export function normalizeMapDomainUrl(url: string): string {
  // Keep behavior intentionally simple to match existing project conventions:
  // normalize host variants by stripping a leading www. sequence in the URL string.
  return url.replace("www.", "");
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
