export type EnrichmentTarget = {
  url: string;
  entity: "person" | "company";
};
export function enrichmentTarget(input: unknown): EnrichmentTarget | null {
  if (typeof input !== "string" || input.length > 2048 || /[\\\s]/.test(input))
    return null;
  // Inspect raw authority before URL normalization removes explicit default ports.
  const authority = input.match(/^https?:\/\/([^/?#]+)/i)?.[1];
  if (!authority || authority.includes(":") || authority.includes("@"))
    return null;
  try {
    const url = new URL(input);
    if (
      url.hostname !== "linkedin.com" &&
      !url.hostname.endsWith(".linkedin.com")
    )
      return null;
    const path = /^\/(in|company)\/([^/]+)\/?$/.exec(url.pathname);
    if (!path) return null;
    const slug = decodeURIComponent(path[2]);
    if (
      !slug ||
      /[\s\x00-\x1f\x7f/\\?#%]/.test(slug) ||
      [".", ".."].includes(slug)
    )
      return null;
    return {
      url: `https://www.linkedin.com/${path[1]}/${encodeURIComponent(slug)}`,
      entity: path[1] === "in" ? "person" : "company",
    };
  } catch {
    return null;
  }
}

export function enrichmentSetupError(input: unknown, teamId: string) {
  if (!enrichmentTarget(input)) return null;
  const redirect = `/app/t/${encodeURIComponent(teamId)}/alexandria?enrichment=true`;
  const url = `https://www.firecrawl.dev/signin?redirect=${encodeURIComponent(redirect)}`;
  return {
    error: `This LinkedIn profile cannot be scraped directly. Set up licensed profile enrichment and review provider terms: ${url}`,
    details: { action: { label: "Set up profile enrichment", url } },
  };
}
