import { beforeEach, describe, expect, it, vi } from "vitest";

const mockConfig = vi.hoisted(() => ({
  SERP_SCRAPE_WARNING: undefined as boolean | undefined,
  SERP_SCRAPE_WARNING_TEAM_IDS: undefined as string[] | undefined,
  SERP_SCRAPE_WARNING_ROLLOUT_PERCENT: 0,
}));

vi.mock("../config", () => ({ config: mockConfig }));

import {
  detectSerpPage,
  serpScrapeWarning,
  serpScrapeWarningEnabled,
} from "./serp-url";

describe("detectSerpPage", () => {
  it.each([
    ["https://www.google.com/search?q=firecrawl", "Google"],
    ["https://google.com/search?q=firecrawl&hl=en", "Google"],
    ["https://www.google.co.uk/search?q=firecrawl", "Google"],
    ["https://www.google.com/search/?q=firecrawl", "Google"],
    ["https://www.bing.com/search?q=firecrawl", "Bing"],
    ["https://duckduckgo.com/?q=firecrawl", "DuckDuckGo"],
    ["https://html.duckduckgo.com/html/?q=firecrawl", "DuckDuckGo"],
    ["https://search.brave.com/search?q=firecrawl", "Brave"],
    ["https://search.yahoo.com/search?p=firecrawl", "Yahoo"],
    ["https://search.yahoo.co.jp/search?p=firecrawl", "Yahoo"],
    ["https://search.yahoo.com/search;_ylt=abc?p=firecrawl", "Yahoo"],
    ["https://lite.duckduckgo.com/lite/?q=firecrawl", "DuckDuckGo"],
    ["https://www.baidu.com/s?wd=firecrawl", "Baidu"],
    ["https://yandex.ru/search/?text=firecrawl", "Yandex"],
    ["https://www.ecosia.org/search?q=firecrawl", "Ecosia"],
    ["https://www.startpage.com/sp/search?query=firecrawl", "Startpage"],
  ])("detects %s as %s", (url, engine) => {
    expect(detectSerpPage(url)).toEqual({ engine, query: "firecrawl" });
  });

  it("decodes the query and caps its length", () => {
    expect(
      detectSerpPage("https://www.google.com/search?q=web+scraping%20api"),
    ).toEqual({ engine: "Google", query: "web scraping api" });
    const long = "a".repeat(500);
    expect(
      detectSerpPage(`https://www.bing.com/search?q=${long}`)?.query,
    ).toHaveLength(200);
  });

  it.each([
    // Other pages on search engine domains
    "https://www.google.com/",
    "https://www.google.com/maps/place/Paris",
    "https://www.google.com/search",
    "https://www.google.com/search?q=",
    "https://scholar.google.com/scholar?q=firecrawl",
    "https://docs.google.com/document/d/abc/edit",
    "https://www.bing.com/maps?q=paris",
    "https://duckduckgo.com/about",
    "https://www.baidu.com/s",
    "https://duckduckgo.com/about?q=firecrawl",
    "https://search.yahoo.com/searchfoo?p=firecrawl",
    // Look-alike hosts
    "https://google.example.com/search?q=firecrawl",
    "https://notgoogle.com/search?q=firecrawl",
    "https://example.com/search?q=firecrawl",
    // Not a URL
    "not a url",
    "ftp://www.google.com/search?q=firecrawl",
  ])("ignores %s", url => {
    expect(detectSerpPage(url)).toBeNull();
  });
});

describe("serpScrapeWarning", () => {
  it("names the engine and points to /search", () => {
    const warning = serpScrapeWarning("Google");
    expect(warning).toContain("Google search results page");
    expect(warning).toContain("/search endpoint");
    expect(warning).toContain("https://docs.firecrawl.dev/features/search");
  });
});

describe("serpScrapeWarningEnabled", () => {
  beforeEach(() => {
    mockConfig.SERP_SCRAPE_WARNING = undefined;
    mockConfig.SERP_SCRAPE_WARNING_TEAM_IDS = undefined;
    mockConfig.SERP_SCRAPE_WARNING_ROLLOUT_PERCENT = 0;
  });

  it("is off by default", () => {
    expect(serpScrapeWarningEnabled("team-a")).toBe(false);
  });

  it("is on for every team when SERP_SCRAPE_WARNING is set", () => {
    mockConfig.SERP_SCRAPE_WARNING = true;
    expect(serpScrapeWarningEnabled("team-a")).toBe(true);
  });

  it("is on only for listed teams", () => {
    mockConfig.SERP_SCRAPE_WARNING_TEAM_IDS = ["team-a"];
    expect(serpScrapeWarningEnabled("team-a")).toBe(true);
    expect(serpScrapeWarningEnabled("team-b")).toBe(false);
  });

  it("follows the rollout percent", () => {
    mockConfig.SERP_SCRAPE_WARNING_ROLLOUT_PERCENT = 100;
    expect(serpScrapeWarningEnabled("team-a")).toBe(true);
  });
});
