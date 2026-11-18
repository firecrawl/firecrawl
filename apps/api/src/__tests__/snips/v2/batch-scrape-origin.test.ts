const mocks = vi.hoisted(() => ({
  addScrapeJobs: vi.fn(),
}));

vi.mock(
  "../../../scraper/WebScraper/utils/blocklist",
  async importOriginal => ({
    ...(await importOriginal<
      typeof import("../../../scraper/WebScraper/utils/blocklist")
    >()),
    isUrlBlocked: () => false,
  }),
);
vi.mock("../../../services/queue-jobs", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../services/queue-jobs")>()),
  addScrapeJobs: mocks.addScrapeJobs,
}));
vi.mock("../../../lib/crawl-redis", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/crawl-redis")>()),
  saveCrawl: vi.fn(),
  markCrawlActive: vi.fn(),
  finishCrawlKickoff: vi.fn(),
  lockURLs: vi.fn().mockResolvedValue(true),
  addCrawlJobs: vi.fn(),
}));
vi.mock("../../../services/worker/nuq-router", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../../../services/worker/nuq-router")
  >()),
  crawlGroup: { addGroup: vi.fn() },
  resolveNewGroupBackend: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../services/logging/log_job", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../../../services/logging/log_job")
  >()),
  logRequest: vi.fn(),
}));

import { batchScrapeController as v1BatchScrape } from "../../../controllers/v1/batch-scrape";
import { batchScrapeController as v2BatchScrape } from "../../../controllers/v2/batch-scrape";

describe.each([
  ["v1", v1BatchScrape],
  ["v2", v2BatchScrape],
])("%s batch scrape child job origin", (_version, controller: any) => {
  beforeEach(() => {
    mocks.addScrapeJobs.mockReset();
  });

  async function enqueuedOrigins(body: Record<string, unknown>) {
    const res: any = {
      headersSent: false,
      status: () => res,
      json: () => res,
    };
    await controller(
      {
        body: {
          urls: ["https://open.example/a", "https://open.example/b"],
          ...body,
        },
        headers: {},
        protocol: "http",
        host: "api.test",
        auth: { team_id: "team-1" },
        acuc: { flags: {}, team_id: "team-1", org_id: "org-1" },
      },
      res,
    );
    return mocks.addScrapeJobs.mock.calls
      .flat(2)
      .map((job: any) => job.data.origin);
  }

  it("keeps the submitter's origin", async () => {
    expect(await enqueuedOrigins({ origin: "python-sdk@4.57.0" })).toEqual([
      "python-sdk@4.57.0",
      "python-sdk@4.57.0",
    ]);
  });

  it("defaults to api when no origin is sent", async () => {
    expect(await enqueuedOrigins({})).toEqual(["api", "api"]);
  });
});
