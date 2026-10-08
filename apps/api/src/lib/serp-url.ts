import { config } from "../config";
import { sampled } from "./rollout";
import { parseHostname } from "./url-utils";

type SerpEngine =
  | "Google"
  | "Bing"
  | "DuckDuckGo"
  | "Brave"
  | "Yahoo"
  | "Baidu"
  | "Yandex"
  | "Ecosia"
  | "Startpage";

type SerpPage = { engine: SerpEngine; query: string };

const MAX_QUERY_CHARS = 200;

function queryParam(params: URLSearchParams, ...names: string[]): string {
  for (const name of names) {
    const value = (params.get(name) ?? "").trim();
    if (value) return value.slice(0, MAX_QUERY_CHARS);
  }
  return "";
}

function engineAndQuery(url: URL): SerpPage | null {
  const host = url.hostname.toLowerCase();
  const parsedHost = parseHostname(host);
  const domain = parsedHost.domain ?? "";
  const domainWithoutSuffix = parsedHost.domainWithoutSuffix ?? "";
  const subdomain = parsedHost.subdomain ?? "";
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const params = url.searchParams;
  const bareOrWww = subdomain === "" || subdomain === "www";
  const page = (engine: SerpEngine, matches: boolean, ...names: string[]) => {
    const query = matches ? queryParam(params, ...names) : "";
    return query ? { engine, query } : null;
  };

  if (domainWithoutSuffix === "google" && bareOrWww) {
    return page("Google", path === "/search", "q");
  }
  if (domain === "bing.com") {
    return page("Bing", path === "/search", "q");
  }
  if (domain === "duckduckgo.com") {
    return page(
      "DuckDuckGo",
      path === "/" || path === "/html" || path === "/lite",
      "q",
    );
  }
  if (host === "search.brave.com") {
    return page("Brave", path === "/search", "q");
  }
  if (
    domainWithoutSuffix === "yahoo" &&
    (subdomain === "search" || subdomain.endsWith(".search"))
  ) {
    // Yahoo appends tracking after a semicolon: /search;_ylt=...
    return page("Yahoo", /^\/search(?:[/;]|$)/.test(path), "p", "q");
  }
  if (domain === "baidu.com" && bareOrWww) {
    return page("Baidu", path === "/s", "wd", "word");
  }
  if (domainWithoutSuffix === "yandex" && bareOrWww) {
    return page("Yandex", path === "/search", "text");
  }
  if (domain === "ecosia.org") {
    return page("Ecosia", path === "/search", "q");
  }
  if (domain === "startpage.com") {
    return page(
      "Startpage",
      path === "/do/search" || path === "/sp/search",
      "q",
      "query",
    );
  }
  return null;
}

/**
 * Returns the search engine and query when the URL is a results page for a
 * query (google.*\/search?q=, bing.com/search?q=, ...), otherwise null. Other
 * pages on those domains (Maps, Shopping product pages, the home page) are not
 * results pages and return null.
 */
export function detectSerpPage(url: string): SerpPage | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return engineAndQuery(parsed);
}

export function serpScrapeWarning(engine: SerpEngine): string {
  return `This URL is a ${engine} search results page. Firecrawl's /search endpoint returns ranked results for a query without the page's ads and layout, and can scrape each result in the same call: https://docs.firecrawl.dev/features/search`;
}

/**
 * Whether a team sees the SERP scrape warning. SERP_SCRAPE_WARNING turns it on
 * for every team, SERP_SCRAPE_WARNING_TEAM_IDS for listed teams, and
 * SERP_SCRAPE_WARNING_ROLLOUT_PERCENT for a stable share of teams.
 */
export function serpScrapeWarningEnabled(teamId: string): boolean {
  if (config.SERP_SCRAPE_WARNING) return true;
  if (config.SERP_SCRAPE_WARNING_TEAM_IDS?.includes(teamId)) return true;
  return sampled(`team:${teamId}`, config.SERP_SCRAPE_WARNING_ROLLOUT_PERCENT);
}
