const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  searchDeveloperCategory: vi.fn(),
  checkUrlsAgainstThreatPolicy: vi.fn(),
}));

vi.mock("./v2", () => ({ search: mocks.search }));
vi.mock("./developer", () => ({
  wantsDeveloperCategory: (categories?: Array<string | { type: string }>) =>
    (categories ?? []).some(category =>
      typeof category === "string"
        ? category === "developer"
        : category.type === "developer",
    ),
  searchDeveloperCategory: mocks.searchDeveloperCategory,
}));
vi.mock("./scrape", () => ({
  getItemsToScrape: vi.fn(() => []),
  scrapeSearchResults: vi.fn(),
  mergeScrapedContent: vi.fn(),
  calculateScrapeCredits: vi.fn(() => 0),
}));
vi.mock("./highlights", () => ({
  highlightsEnvReady: () => false,
  runIndexedSearchHighlights: vi.fn(),
  searchHighlightsMode: vi.fn(),
}));
vi.mock("../lib/tracking", () => ({
  trackSearchRequest: vi.fn(async () => {}),
  trackSearchResults: vi.fn(async () => {}),
}));
vi.mock("../lib/threat-protection/request", () => ({
  checkUrlsAgainstThreatPolicy: mocks.checkUrlsAgainstThreatPolicy,
}));
vi.mock("../lib/scrape-billing", () => ({
  calculateThreatScanCredits: vi.fn(() => 0),
}));

import { executeSearch } from "./execute";
import { searchRequestSchema } from "../controllers/v2/types";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

const context = {
  teamId: "team-1",
  origin: "api",
  apiKeyId: 1,
  flags: {},
  requestId: "request-1",
  jobId: "job-1",
  apiVersion: "v2",
};

// searchDeveloperCategory returns the exact WebSearchResult shape.
const developerResult = {
  url: "https://github.com/firecrawl/firecrawl/issues/1",
  title: "Retry requests",
  description: "Use exponential backoff.",
  position: 1,
  category: "developer",
};

function options(categories: Array<{ type: string }>) {
  return {
    query: "retries",
    limit: 10,
    sources: [{ type: "web" }],
    categories,
    timeout: 1_000,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.searchDeveloperCategory.mockResolvedValue([developerResult]);
});

describe("executeSearch developer category", () => {
  it("returns sole developer-category results in web without running SERP", async () => {
    const result = await executeSearch(
      options([{ type: "developer" }]),
      context,
      logger,
    );

    expect(mocks.search).not.toHaveBeenCalled();
    expect(result.response).toEqual({ web: [developerResult] });
    expect(result.response).not.toHaveProperty("developer");
    expect(result.developerResultsCount).toBe(1);
  });


  it("filters blocked developer results via threat protection and renumbers", async () => {
    mocks.searchDeveloperCategory.mockResolvedValue([
      { url: "https://ok.example/a", title: "A", description: "", position: 1, category: "developer" },
      { url: "https://blocked.example/b", title: "B", description: "", position: 2, category: "developer" },
      { url: "https://ok.example/c", title: "C", description: "", position: 3, category: "developer" },
    ]);
    mocks.checkUrlsAgainstThreatPolicy.mockResolvedValue({
      decisionsByUrl: new Map([
        ["https://blocked.example/b", { allowed: false }],
      ]),
    });

    const result = await executeSearch(
      options([{ type: "developer" }]),
      { ...context, threatProtectionPolicy: { mode: "block" } } as any,
      logger,
    );

    expect(mocks.checkUrlsAgainstThreatPolicy).toHaveBeenCalledTimes(1);
    expect(mocks.search).not.toHaveBeenCalled();
    expect((result.response.web ?? []).map(x => [x.url, x.position])).toEqual([
      ["https://ok.example/a", 1],
      ["https://ok.example/c", 2],
    ]);
  });

  it("rejects developer combined with other categories at the schema", () => {
    const mixed = searchRequestSchema.safeParse({
      query: "retries",
      categories: ["developer", "github"],
    });
    expect(mixed.success).toBe(false);
    if (!mixed.success) {
      expect(JSON.stringify(mixed.error.issues)).toContain(
        "cannot be combined",
      );
    }

    const sole = searchRequestSchema.safeParse({
      query: "retries",
      categories: ["developer"],
    });
    expect(sole.success).toBe(true);
  });
});
