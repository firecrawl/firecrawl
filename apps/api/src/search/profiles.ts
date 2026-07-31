import type { CategoryOption } from "../lib/search-query-builder";

export type SearchProfileName = "general" | "developer" | "research" | "pdf";

export interface SearchProfile {
  name: SearchProfileName;
  explicit: boolean;
  sites?: string[];
}

export interface SearchProfileRequest {
  profile: SearchProfileName;
  query: string;
  engines: string[];
}

const REPOSITORY_INTENT =
  /\b(repo(?:sitory|sitories)?|source\s*code|github|gitlab|pull request|issue|readme)\b/i;
const DOCKER_INTENT = /\b(docker|container|image|dockerfile|compose)\b/i;
const NPM_INTENT =
  /\b(npm|node(?:\.js)?|javascript|typescript|package\.json)\b/i;
const PYPI_INTENT = /\b(pypi|python|pip|pyproject|poetry)\b/i;
const CRATES_INTENT = /\b(crate|crates\.io|cargo|rust)\b/i;
const HUGGINGFACE_INTENT =
  /\b(hugging\s*face|huggingface|transformers|model weights|dataset)\b/i;
const BIOMEDICAL_INTENT =
  /\b(clinical|biomedical|medicine|medical|patient|disease|gene|protein|pubmed|pmc|trial)\b/i;
const RESEARCH_INTENT =
  /\b(paper|preprint|journal|citation|doi|arxiv|study|systematic review|literature review|research|scholar(?:ly)?|conference proceedings|weighted sampling|methodology)\b/i;
const PDF_INTENT = /\b(pdf|filetype:pdf|downloadable paper|full[- ]text)\b/i;
const DEVELOPER_INTENT =
  /\b(api|sdk|cli|library|framework|plugin|package|dependency|code|coding|programming|implementation|bug|stack trace|typescript|javascript|python|rust|golang|docker|kubernetes)\b/i;

function categoryType(category: CategoryOption): SearchProfileName {
  const type = typeof category === "string" ? category : category.type;
  if (type === "github") return "developer";
  if (type === "research" || type === "pdf") return type;
  return "general";
}

/**
 * Resolve the caller's intent without an LLM. Explicit categories are always
 * authoritative; otherwise the classifier deliberately picks one profile so a
 * search cannot fan out across every configured engine.
 */
export function resolveSearchProfiles(
  query: string,
  categories?: CategoryOption[],
): SearchProfile[] {
  if (categories && categories.length > 0) {
    const profiles = new Map<SearchProfileName, SearchProfile>();
    for (const category of categories) {
      const name = categoryType(category);
      const sites =
        typeof category === "object" && category.type === "research"
          ? category.sites
          : undefined;
      const existing = profiles.get(name);
      profiles.set(name, {
        name,
        explicit: true,
        sites: sites ?? existing?.sites,
      });
    }
    return [...profiles.values()];
  }

  if (PDF_INTENT.test(query)) {
    return [{ name: "pdf", explicit: false }];
  }
  if (RESEARCH_INTENT.test(query)) {
    return [{ name: "research", explicit: false }];
  }
  if (
    DEVELOPER_INTENT.test(query) ||
    REPOSITORY_INTENT.test(query) ||
    DOCKER_INTENT.test(query) ||
    NPM_INTENT.test(query) ||
    PYPI_INTENT.test(query) ||
    CRATES_INTENT.test(query) ||
    HUGGINGFACE_INTENT.test(query)
  ) {
    return [{ name: "developer", explicit: false }];
  }
  return [{ name: "general", explicit: false }];
}

function siteExpression(sites: string[]): string {
  return sites.map(site => `site:${site}`).join(" OR ");
}

const RESEARCH_WEB_SITES = [
  "arxiv.org",
  "doi.org",
  "semanticscholar.org",
  "openalex.org",
  "pubmed.ncbi.nlm.nih.gov",
  "pmc.ncbi.nlm.nih.gov",
  "acm.org",
  "ieee.org",
  "springer.com",
  "nature.com",
  "science.org",
];

/**
 * Split profiles into small engine groups. Search operators are only sent to
 * general web engines; specialist APIs receive the user's unmodified query.
 */
export function buildSearchProfileRequests(
  query: string,
  profile: SearchProfile,
): SearchProfileRequest[] {
  switch (profile.name) {
    case "developer": {
      const specialistEngines = ["github"];
      if (REPOSITORY_INTENT.test(query)) specialistEngines.push("gitlab");
      if (DOCKER_INTENT.test(query)) specialistEngines.push("docker hub");
      if (NPM_INTENT.test(query)) specialistEngines.push("npm");
      if (PYPI_INTENT.test(query)) specialistEngines.push("pypi");
      if (CRATES_INTENT.test(query)) specialistEngines.push("crates.io");
      if (HUGGINGFACE_INTENT.test(query)) specialistEngines.push("huggingface");

      return [
        { profile: "developer", query, engines: specialistEngines },
        {
          profile: "developer",
          query: `${query} (site:github.com OR site:gitlab.com OR site:stackoverflow.com)`,
          engines: ["braveapi"],
        },
      ];
    }
    case "research": {
      // The unauthenticated Semantic Scholar adapter returns non-JSON from
      // this deployment, and the arXiv adapter repeatedly consumes the full
      // SearXNG timeout. Brave's authenticated site search below still covers
      // both domains without holding up the structured sources.
      const engines = ["crossref", "openalex"];
      if (BIOMEDICAL_INTENT.test(query)) engines.push("pubmed");
      const sites =
        profile.sites && profile.sites.length > 0
          ? profile.sites
          : RESEARCH_WEB_SITES;
      return [
        { profile: "research", query, engines },
        {
          profile: "research",
          query: `${query} (${siteExpression(sites)})`,
          engines: ["braveapi"],
        },
      ];
    }
    case "pdf":
      return [
        { profile: "pdf", query, engines: ["crossref", "openalex"] },
        {
          profile: "pdf",
          query: `${query} filetype:pdf`,
          engines: ["braveapi"],
        },
        {
          profile: "pdf",
          query: `${query} filetype:pdf`,
          engines: ["bing"],
        },
      ];
    case "general":
    default:
      return [
        {
          profile: "general",
          query,
          engines: ["braveapi"],
        },
        {
          profile: "general",
          query,
          engines: ["bing", "dogpile", "seznam", "yandex", "fynd"],
        },
      ];
  }
}

export function profileNames(profiles: SearchProfile[]): SearchProfileName[] {
  return profiles.map(profile => profile.name);
}
