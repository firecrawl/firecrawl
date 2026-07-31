import type { WebSearchResult } from "../lib/entities";
import {
  getDefaultResearchSites,
  type CategoryOption,
} from "../lib/search-query-builder";
import type { SearchProfileName } from "./profiles";

export interface InternalSearchDiagnostics {
  engine?: string;
  engines?: string[];
  score?: number;
  publishedDate?: string;
  profile?: SearchProfileName;
}

export type InternalWebSearchResult = WebSearchResult & {
  __search?: InternalSearchDiagnostics;
};

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
]);

const REDIRECT_PARAMS = [
  "url",
  "u",
  "target",
  "redirect",
  "redirect_url",
  "destination",
];

const RESEARCH_DOMAINS = new Set([
  ...getDefaultResearchSites(),
  "doi.org",
  "semanticscholar.org",
  "openalex.org",
  "openreview.net",
  "crossref.org",
  "pmc.ncbi.nlm.nih.gov",
  "ncbi.nlm.nih.gov",
  "acm.org",
  "dl.acm.org",
  "ieee.org",
  "ieeexplore.ieee.org",
  "jstor.org",
  "frontiersin.org",
  "mdpi.com",
  "tandfonline.com",
  "sagepub.com",
]);

function hostMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const target = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .replace(/\.$/, "");
  return target !== "" && (host === target || host.endsWith(`.${target}`));
}

export function isArxivPdfUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      hostMatches(parsed.hostname, "arxiv.org") &&
      /^\/pdf\/[^/]+(?:\.pdf)?$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

export function isPdfLikeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return (
      path.endsWith(".pdf") ||
      path.includes(".pdf/") ||
      isArxivPdfUrl(url) ||
      parsed.searchParams.get("format")?.toLowerCase() === "pdf"
    );
  } catch {
    return false;
  }
}

function unwrapRedirect(parsed: URL): URL {
  for (const name of REDIRECT_PARAMS) {
    const value = parsed.searchParams.get(name);
    if (!value) continue;
    try {
      const candidate = new URL(decodeURIComponent(value));
      if (candidate.protocol === "http:" || candidate.protocol === "https:") {
        return candidate;
      }
    } catch {
      // A non-URL parameter named "url" is ordinary query data.
    }
  }
  return parsed;
}

export function canonicalizeSearchUrl(
  rawUrl: string,
  profile?: SearchProfileName,
): string | null {
  try {
    let parsed = unwrapRedirect(new URL(rawUrl));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;

    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(key)) {
        parsed.searchParams.delete(key);
      }
    }

    if (
      profile === "pdf" &&
      hostMatches(parsed.hostname, "arxiv.org") &&
      parsed.pathname.startsWith("/abs/")
    ) {
      parsed = new URL(
        `https://arxiv.org/pdf/${parsed.pathname.slice("/abs/".length)}`,
      );
    }

    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function categoryTypes(categories?: CategoryOption[]): Set<string> {
  return new Set(
    (categories ?? []).map(category =>
      typeof category === "string" ? category : category.type,
    ),
  );
}

function requestedResearchSites(categories?: CategoryOption[]): string[] {
  const sites: string[] = [];
  for (const category of categories ?? []) {
    if (
      typeof category === "object" &&
      category.type === "research" &&
      category.sites
    ) {
      sites.push(...category.sites);
    }
  }
  return sites;
}

function isGithubHost(hostname: string): boolean {
  return [
    "github.com",
    "githubusercontent.com",
    "raw.githubusercontent.com",
  ].some(domain => hostMatches(hostname, domain));
}

function domainAllowed(
  url: string,
  includeDomains?: string[],
  excludeDomains?: string[],
): boolean {
  const hostname = new URL(url).hostname;
  if (excludeDomains?.some(domain => hostMatches(hostname, domain)) === true) {
    return false;
  }
  return (
    !includeDomains ||
    includeDomains.length === 0 ||
    includeDomains.some(domain => hostMatches(hostname, domain))
  );
}

function categoryAllowed(url: string, categories?: CategoryOption[]): boolean {
  const requested = categoryTypes(categories);
  if (requested.size === 0) return true;
  const parsed = new URL(url);
  const customResearchSites = requestedResearchSites(categories);

  return [...requested].some(category => {
    if (category === "github") return isGithubHost(parsed.hostname);
    if (category === "pdf") return isPdfLikeUrl(url);
    if (category === "research") {
      const domains =
        customResearchSites.length > 0
          ? customResearchSites
          : [...RESEARCH_DOMAINS];
      return domains.some(domain => hostMatches(parsed.hostname, domain));
    }
    return true;
  });
}

function queryTokens(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .replace(/[^\p{L}\p{N}._-]+/gu, " ")
        .split(/\s+/)
        .filter(token => token.length >= 3)
        .filter(
          token =>
            !["site", "filetype", "with", "from", "that", "this"].includes(
              token,
            ),
        ),
    ),
  ].slice(0, 20);
}

function trustScore(url: string): number {
  const hostname = new URL(url).hostname;
  if (isGithubHost(hostname)) return 5;
  if ([...RESEARCH_DOMAINS].some(domain => hostMatches(hostname, domain))) {
    return 4;
  }
  if (
    hostname.startsWith("docs.") ||
    hostname.startsWith("developer.") ||
    hostname.startsWith("developers.")
  ) {
    return 3;
  }
  if (/resulthunter|resultsearch|redirect/i.test(hostname)) return -5;
  return 0;
}

function resultScore(result: InternalWebSearchResult, query: string): number {
  const haystack =
    `${result.title} ${result.description} ${result.url}`.toLowerCase();
  const tokens = queryTokens(query);
  const overlap =
    tokens.length === 0
      ? 0
      : tokens.filter(token => haystack.includes(token)).length / tokens.length;
  const engineScore = Math.log1p(Math.max(0, result.__search?.score ?? 0));
  const freshness = result.__search?.publishedDate ? 0.5 : 0;
  return overlap * 10 + trustScore(result.url) + engineScore + freshness;
}

export function filterAndRankWebResults(
  results: InternalWebSearchResult[],
  options: {
    query: string;
    profiles: SearchProfileName[];
    categories?: CategoryOption[];
    includeDomains?: string[];
    excludeDomains?: string[];
  },
): InternalWebSearchResult[] {
  const seen = new Set<string>();
  const normalized: InternalWebSearchResult[] = [];
  const canonicalProfile =
    options.profiles.length === 1 ? options.profiles[0] : undefined;

  for (const result of results) {
    const url = canonicalizeSearchUrl(result.url, canonicalProfile);
    if (!url || seen.has(url)) continue;
    if (
      !domainAllowed(url, options.includeDomains, options.excludeDomains) ||
      !categoryAllowed(url, options.categories)
    ) {
      continue;
    }
    seen.add(url);
    normalized.push({ ...result, url });
  }

  return normalized
    .map((result, index) => ({
      result,
      index,
      score: resultScore(result, options.query),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ result }, index) => ({ ...result, position: index + 1 }));
}

export function stripSearchDiagnostics(
  results: InternalWebSearchResult[],
): WebSearchResult[] {
  return results.map(result => {
    const { __search: _diagnostics, ...publicResult } = result;
    return publicResult;
  });
}
