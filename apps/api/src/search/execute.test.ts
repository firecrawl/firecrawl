import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  checkUrlsAgainstThreatPolicy: vi.fn(),
  removeExplicitResults: vi.fn(),
}));

vi.mock("./v2", () => ({ search: mocks.search }));
vi.mock("./scrape", () => ({
  getItemsToScrape: vi.fn(() => []),
  scrapeSearchResults: vi.fn(),
  mergeScrapedContent: vi.fn(),
}));

import { createLogger } from "winston";
import type { CategoryOption } from "../lib/search-query-builder";
import { executeSearch } from "./execute";

const logger = createLogger({ silent: true });

const web = (url: string, title = "Result") => ({
  url,
  title,
  description: "",
});
const news = (url: string, title: string) => ({ url, title, snippet: "" });

const context = {
  teamId: "team-1",
  origin: "api",
  apiKeyId: 1,
  flags: {},
  teamPlanClass: undefined,
  requestId: "request-1",
  jobId: "job-1",
  apiVersion: "v2",
};

function options(
  categories: Array<CategoryOption>,
): Parameters<typeof executeSearch>[0] {
  return {
    query: "retries",
    limit: 10,
    sources: [{ type: "web" }],
    categories,
    timeout: 1000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeSearch query operators", () => {
  it("sends inurl: with site: as plain terms and enforces both on web results", async () => {
    mocks.search.mockResolvedValue({
      web: [
        web(
          "https://www.finance.example/2026/07/29/contoso-ctso-q4-earnings-report-2026.html",
        ),
        web("https://www.finance.example/quotes/CTSO"),
        web("https://www.stocks.example/stocks/xnas/ctso/earnings"),
        web(
          "https://www.finance.example/2026/04/29/contoso-ctso-q3-earnings-report-2026.html",
        ),
      ],
    });

    const result = await executeSearch(
      { ...options([]), query: "inurl:earnings Contoso site:finance.example" },
      context,
      logger,
    );

    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "earnings Contoso site:finance.example",
        includeDomains: ["finance.example"],
      }),
    );
    expect(result.response.web?.map(x => [x.position, x.url])).toEqual([
      [
        1,
        "https://www.finance.example/2026/07/29/contoso-ctso-q4-earnings-report-2026.html",
      ],
      [
        2,
        "https://www.finance.example/2026/04/29/contoso-ctso-q3-earnings-report-2026.html",
      ],
    ]);
  });

  it("bills nothing when the operators leave no results", async () => {
    mocks.search.mockResolvedValue({
      web: [web("https://www.finance.example/quotes/CTSO")],
    });

    const result = await executeSearch(
      { ...options([]), query: "inurl:earnings Contoso site:finance.example" },
      context,
      logger,
    );

    expect(result.response.web).toEqual([]);
    expect(result.totalResultsCount).toBe(0);
    expect(result.billableResultsCount).toBe(0);
  });

  it("applies both intitle: and site: to news results", async () => {
    mocks.search.mockResolvedValue({
      news: [
        news(
          "https://www.news.example/aktuell/wirtschaft/a.html",
          "Acme: Quarterly results - News",
        ),
        news(
          "https://www.forum.example/r/insurance/comments/1/acme/",
          "Acme denied claim",
        ),
        news(
          "https://www.news.example/agenturmeldungen/dpa/b.html",
          "Local team wins again - News",
        ),
      ],
    });

    const result = await executeSearch(
      {
        ...options([]),
        query: '"Acme" intitle:Acme site:news.example',
        sources: [{ type: "news" }],
        tbs: "qdr:w",
      },
      context,
      logger,
    );

    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: '"Acme" Acme site:news.example',
        includeDomains: ["news.example"],
        tbs: "qdr:w",
      }),
    );
    expect(result.response.news?.map(x => x.url)).toEqual([
      "https://www.news.example/aktuell/wirtschaft/a.html",
    ]);
  });

  it("enforces site: alone on news results", async () => {
    mocks.search.mockResolvedValue({
      news: [
        news("https://www.news.example/aktuell/a.html", "A"),
        news("https://www.acmecare.example/en/blog.html", "B"),
      ],
    });

    const result = await executeSearch(
      {
        ...options([]),
        query: "Acme site:news.example",
        sources: [{ type: "news" }],
      },
      context,
      logger,
    );

    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "Acme site:news.example" }),
    );
    expect(result.response.news?.map(x => x.url)).toEqual([
      "https://www.news.example/aktuell/a.html",
    ]);
  });

  it("enforces site: on image results", async () => {
    mocks.search.mockResolvedValue({
      images: [
        {
          url: "https://www.news.example/a.html",
          title: "A",
          imageUrl: "https://cdn.example/a.jpg",
        },
        {
          url: "https://other.example/b.html",
          title: "B",
          imageUrl: "https://cdn.example/b.jpg",
        },
      ],
    });

    const result = await executeSearch(
      {
        ...options([]),
        query: "Acme site:news.example",
        sources: [{ type: "images" }],
      },
      context,
      logger,
    );

    expect(result.response.images?.map(x => [x.position, x.url])).toEqual([
      [1, "https://www.news.example/a.html"],
    ]);
  });

  it("asks the provider for more results when it enforces inurl: or intitle: itself", async () => {
    mocks.search.mockResolvedValue({ web: [] });

    await executeSearch(
      { ...options([]), query: "inurl:earnings Contoso site:finance.example" },
      context,
      logger,
    );

    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ num_results: 50 }),
    );
  });

  it("forwards a custom date range tbs to the web provider unchanged", async () => {
    mocks.search.mockResolvedValue({ web: [] });
    const tbs = "cdr:1,cd_min:1/1/2024,cd_max:1/31/2024";

    await executeSearch(
      { ...options([]), query: "Contoso earnings site:finance.example", tbs },
      context,
      logger,
    );

    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ tbs, type: ["web"] }),
    );
  });
});

describe("executeSearch team plan class", () => {
  const webResult = {
    url: "https://example.com/",
    title: "Example",
    description: "An example page.",
  };

  it("states the caller's plan class on the web search call", async () => {
    mocks.search.mockResolvedValue({ web: [webResult] });

    await executeSearch(
      options([]),
      { ...context, teamPlanClass: "self_serve" },
      logger,
    );

    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ teamPlanClass: "self_serve" }),
    );
  });

  it("states nothing when the caller knows no plan class", async () => {
    mocks.search.mockResolvedValue({ web: [webResult] });

    await executeSearch(options([]), context, logger);

    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(mocks.search.mock.calls[0][0].teamPlanClass).toBeUndefined();
  });
});
