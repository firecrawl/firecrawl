import { fetch as undiciFetch } from "undici";
import type { Response as UndiciResponse } from "undici";
import { config } from "../../config";
import { JSDOM } from "jsdom";
import type { SearchV2Response, WebSearchResult } from "../../lib/entities";
import { logger } from "../../lib/logger";
import { getSecureDispatcher } from "../../scraper/scrapeURL/engines/utils/safeFetch";

class DDGAntiBotError extends Error {
  constructor() {
    super("Blocked by DuckDuckGo Anti-Bot measures");
  }
}

class DDGRateLimitError extends Error {
  readonly status: number;
  readonly statusText: string;

  constructor(status: number, statusText: string) {
    super("DuckDuckGo: Too many requests, try again later.");
    this.status = status;
    this.statusText = statusText;
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

function cleanUrl(href: string): string {
  if (href.includes("uddg=")) {
    const url = new URL(href, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : href;
  }
  return href;
}

function extractResults(
  document: Document,
  seenUrls: Set<string>,
): Array<WebSearchResult> {
  const anomalyModal = document.querySelector(".anomaly-modal__modal");
  if (anomalyModal) {
    throw new DDGAntiBotError();
  }

  const results: Array<WebSearchResult> = [];
  const blocks = Array.from(document.querySelectorAll(".result.web-result"));

  for (const block of blocks) {
    const titleLink = block.querySelector<HTMLAnchorElement>(".result__a");
    const snippet = block.querySelector(".result__snippet");

    if (!titleLink || !snippet) {
      continue;
    }

    const rawUrl = titleLink.href?.trim();
    const title = titleLink.textContent?.trim();
    const description = snippet.textContent?.trim();

    if (rawUrl && title && description) {
      const url = cleanUrl(rawUrl);
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        results.push({ url, title, description });
      }
    }
  }

  return results;
}

function getNextPageData(document: Document): URLSearchParams | null {
  const nextButton = document.querySelector<HTMLInputElement>(
    'input[type="submit"][class="btn btn--alt"][value="Next"]',
  );

  if (!nextButton) {
    return null;
  }

  const nextForm = nextButton.closest<HTMLFormElement>("form");
  if (!nextForm) {
    return null;
  }

  const formData = new URLSearchParams();
  const inputs = Array.from(nextForm.querySelectorAll("input"));

  for (const input of inputs) {
    const name = input.getAttribute("name");
    const value = input.getAttribute("value");
    if (name && value !== null) {
      formData.set(name, value);
    }
  }

  return formData;
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

    const results: Array<WebSearchResult> = [];
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
        let response: UndiciResponse;

        if (isFirstPage) {
          response = await undiciFetch(
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
          response = await undiciFetch(`https://html.duckduckgo.com/html`, {
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

        if (response.status === 429) {
          await response.body?.cancel();
          if (results.length > 0) {
            break;
          }
          throw new DDGRateLimitError(response.status, response.statusText);
        }

        const buf = Buffer.from(await response.arrayBuffer());
        const dom = new JSDOM(buf.toString("utf8"));
        const doc = dom.window.document;

        const newResults = extractResults(doc, seenUrls);

        isFirstPage = false;
        antiBotRetries = 0;

        results.push(...newResults);

        if (newResults.length === 0) {
          break;
        }

        nextPageData = getNextPageData(doc);
      } catch (error: unknown) {
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
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }

      await new Promise<void>(resolve => {
        setTimeout(resolve, 1000);
      });
    }

    if (results.length === 0) {
      logger.warn("DuckDuckGo: No results found", { term });
      return {};
    }

    return { web: results.slice(0, num_results) };
  } catch (error: unknown) {
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
      throw new Error("DuckDuckGo: Blocked by anti-bot measures.", {
        cause: error,
      });
    }

    if (error instanceof DDGRateLimitError) {
      logger.warn("DuckDuckGo: Too many requests, try again later.", {
        status: error.status,
        statusText: error.statusText,
      });
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("DuckDuckGo search error", { error: errorMessage, term });
    throw error;
  }
}
