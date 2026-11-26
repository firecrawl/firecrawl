import { detectSerpPage as nativeDetectSerpPage } from "@mendable/firecrawl-rs";
import { config } from "../config";
import { sampled } from "./rollout";

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

/**
 * Returns the search engine and query when the URL is a results page for a
 * query (google.*\/search?q=, bing.com/search?q=, ...), otherwise null. Other
 * pages on those domains (Maps, Shopping product pages, the home page) are not
 * results pages and return null.
 */
export function detectSerpPage(url: string): SerpPage | null {
  return nativeDetectSerpPage(url) as SerpPage | null;
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
