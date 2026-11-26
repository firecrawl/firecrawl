import * as undici from "undici";
import { parseDdgHtml } from "@mendable/firecrawl-rs";
import { config } from "../../config";
import { SearchV2Response, WebSearchResult } from "../../lib/entities";
import { logger } from "../../lib/logger";
import { getSecureDispatcher } from "../../scraper/scrapeURL/engines/utils/safeFetch";

class DDGAntiBotError extends Error {
  constructor() {
    super("Blocked by DuckDuckGo Anti-Bot measures");
  }
}

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

interface SearchOptions {
  tbs?: string;
  lang?: string;
  country?: string;
  location?: string;
  proxy?: string;
  timeout?: number;
}

export async function ddgSearch(
  term: string,
  num_results = 5,
  options: SearchOptions = {},
): Promise<SearchV2Response> {
  const {
    lang = "en",
    country = "us",
    location,
    tbs,
    timeout = 5000,
  } = options;

  try {
    const userAgent =
      USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

    const params = new URLSearchParams({ q: term, kp: "1" });

    if (location) {
      params.set("kl", location);
    } else if (country && lang) {
      params.set("kl", `${country.toLowerCase()}-${lang.toLowerCase()}`);
    }

    if (tbs && (["d", "w", "m", "y"].includes(tbs) || tbs.includes(".."))) {
      params.set("df", tbs);
    }

    const results: WebSearchResult[] = [];
    const seenUrls = new Set<string>();
    const dispatcher = getSecureDispatcher(false);
    let isFirstPage = true;
    let nextPageData: URLSearchParams | null = params;

    let antiBotRetries = 0;
    while (results.length < num_results && nextPageData) {
      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => {
        if (abortController) {
          abortController.abort();
        }
      }, timeout);

      try {
        let response: undici.Response;

        if (isFirstPage) {
          response = await undici.fetch(
            `https://html.duckduckgo.com/html?${params.toString()}`,
            {
              dispatcher,
              redirect: "follow",
              headers: {
                "User-Agent": userAgent,
                Accept:
                  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
                "Accept-Encoding": "gzip, deflate, br",
                "Upgrade-Insecure-Requests": "1",
              },
              signal: abortController.signal,
            },
          );
        } else {
          response = await undici.fetch(`https://html.duckduckgo.com/html`, {
            method: "POST",
            body: nextPageData.toString(),
            dispatcher,
            redirect: "follow",
            headers: {
              "User-Agent": userAgent,
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.5",
              "Accept-Encoding": "gzip, deflate, br",
              "Upgrade-Insecure-Requests": "1",
            },
            signal: abortController.signal,
          });
        }

        const buf = Buffer.from(await response.arrayBuffer());
        const parsed = await parseDdgHtml(
          buf.toString("utf8"),
          Array.from(seenUrls),
        );

        if (parsed.anomalyDetected) {
          throw new DDGAntiBotError();
        }

        for (const result of parsed.results) {
          seenUrls.add(result.url);
        }

        isFirstPage = false;
        antiBotRetries = 0;

        results.push(...parsed.results);

        if (parsed.results.length === 0) break;

        nextPageData = parsed.nextPageParams
          ? new URLSearchParams(
              parsed.nextPageParams.map(({ name, value }) => [name, value]),
            )
          : null;
      } catch (error: any) {
        if (error instanceof DDGAntiBotError) {
          if (antiBotRetries++ > 3) {
            throw error;
          }

          logger.warn(
            "DuckDuckGo: Encountered anti-bot measures, retrying...",
            {
              attempt: antiBotRetries,
              term,
            },
          );
        } else {
          throw error;
        }
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      await new Promise(r => setTimeout(r, 1000));
    }

    if (results.length === 0) {
      logger.warn("DuckDuckGo: No results found", { term });
      return {};
    }

    return { web: results.slice(0, num_results) };
  } catch (error: any) {
    if (error instanceof DDGAntiBotError) {
      if (config.TEST_SUITE_SELF_HOSTED) {
        logger.warn(
          "DuckDuckGo: Blocked by anti-bot measures, returning dummy page for test suite...",
          { term },
        );

        return {
          web: [
            {
              url: "https://example.com",
              title: "DDG Anti-Bot Test Page",
              description:
                "DDG Anti-Bot triggered, returning dummy page for test suite",
              position: 1,
              category: "web",
              html: "<html><body><h1>Hello, World!</h1></body></html>",
              rawHtml:
                "<html><head><title>Hello!</title></head><body><h1>Hello, World!</h1></body></html>",
              links: [],
            },
          ],
        };
      }

      logger.error("DuckDuckGo: Blocked by anti-bot measures", { term });
      throw new Error("DuckDuckGo: Blocked by anti-bot measures.");
    }

    if (error.response?.status === 429) {
      logger.warn("DuckDuckGo: Too many requests, try again later.", {
        status: error.response.status,
        statusText: error.response.statusText,
      });
      throw new Error("DuckDuckGo: Too many requests, try again later.");
    }
    logger.error("DuckDuckGo search error", { error: error.message, term });
    throw error;
  }
}
