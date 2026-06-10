import { DEFAULT_LEGACY_SCRAPE_TIMEOUT_MS } from "./scrape-timeout";

export const defaultOrigin = "api";

export const defaultTimeout = DEFAULT_LEGACY_SCRAPE_TIMEOUT_MS;

export const defaultPageOptions = {
  onlyMainContent: false,
  includeHtml: false,
  waitFor: 0,
  screenshot: false,
  fullPageScreenshot: false,
  parsePDF: true,
};

export const defaultCrawlerOptions = {
  allowBackwardCrawling: false,
  limit: 10000,
};

export const defaultCrawlPageOptions = {
  onlyMainContent: false,
  includeHtml: false,
  removeTags: [],
  parsePDF: true,
};

export const defaultExtractorOptions = {
  mode: "markdown",
};
