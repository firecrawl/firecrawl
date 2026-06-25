vi.mock("uuid", () => ({
  v7: vi.fn(() => "job-1"),
}));

import { getItemsToScrape, scrapeSearchResults } from "./scrape";
import { getJobPriority } from "../lib/job-priority";
import { processJobInternal } from "../services/worker/scrape-worker";
import { CrawlDenialError } from "../lib/error";

vi.mock("../lib/job-priority", () => ({
  getJobPriority: vi.fn().mockResolvedValue(10),
}));

vi.mock("../services/worker/scrape-worker", () => ({
  processJobInternal: vi.fn().mockResolvedValue({
    markdown: "body",
    metadata: { creditsUsed: 1, statusCode: 200, proxyUsed: "basic" },
  }),
}));

describe("scrapeSearchResults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(processJobInternal).mockResolvedValue({
      markdown: "body",
      metadata: { creditsUsed: 1, statusCode: 200, proxyUsed: "basic" },
    } as any);
  });

  it("preserves billing metadata on spawned scrape jobs", async () => {
    await scrapeSearchResults(
      [
        {
          url: "https://example.com",
          title: "Example",
          description: "Desc",
        },
      ],
      {
        teamId: "team-1",
        origin: "api",
        timeout: 60_000,
        scrapeOptions: {} as any,
        apiKeyId: 123,
        requestId: "req-1",
        billing: { endpoint: "agent" },
      },
      { debug: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
      null as any,
    );

    expect(getJobPriority).toHaveBeenCalledWith({
      team_id: "team-1",
      basePriority: 10,
    });
    expect(processJobInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          billing: { endpoint: "agent" },
        }),
      }),
    );
  });

  it("maps worker scrape denials to per-result 403 metadata", async () => {
    vi.mocked(processJobInternal).mockRejectedValueOnce(
      new CrawlDenialError("blocked"),
    );

    const results = await scrapeSearchResults(
      [
        {
          url: "https://www.linkedin.com/in/example",
          title: "Blocked",
          description: "Desc",
        },
      ],
      {
        teamId: "team-1",
        origin: "api",
        timeout: 60_000,
        scrapeOptions: {} as any,
        apiKeyId: 123,
      },
      { debug: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
      null as any,
    );

    expect(results[0].document.metadata).toMatchObject({
      statusCode: 403,
      error: "blocked",
      proxyUsed: "basic",
    });
  });
});

describe("getItemsToScrape", () => {
  it("passes URL-bearing search results through to the scrape layer", () => {
    const items = getItemsToScrape(
      {
        web: [
          {
            url: "https://www.linkedin.com/in/example",
            title: "Blocked",
            description: "Desc",
          },
        ],
      } as any,
      null as any,
      { team_id: "team-1", origin: "api" },
    );

    expect(items).toHaveLength(1);
    expect(items[0].scrapeInput.url).toBe(
      "https://www.linkedin.com/in/example",
    );
  });
});
