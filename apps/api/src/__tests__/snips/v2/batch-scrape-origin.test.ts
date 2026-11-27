import type * as CrawlRedis from "../../../lib/crawl-redis";
import type * as QueueJobs from "../../../services/queue-jobs";
import type * as NuqRouter from "../../../services/worker/nuq-router";

const mocks = vi.hoisted(() => ({
  addScrapeJobs: vi.fn<typeof QueueJobs.addScrapeJobs>(),
  getCrawl: vi.fn(),
}));

vi.mock("../../../services/queue-jobs", async importOriginal => ({
  ...(await importOriginal<typeof QueueJobs>()),
  addScrapeJobs: mocks.addScrapeJobs,
}));
vi.mock("../../../lib/crawl-redis", async importOriginal => ({
  ...(await importOriginal<typeof CrawlRedis>()),
  getCrawl: mocks.getCrawl,
  saveCrawl: vi.fn(),
  markCrawlActive: vi.fn(),
  finishCrawlKickoff: vi.fn(),
  lockURLs: vi.fn().mockResolvedValue(true),
  addCrawlJobs: vi.fn(),
}));
vi.mock("../../../services/worker/nuq-router", async importOriginal => ({
  ...(await importOriginal<typeof NuqRouter>()),
  crawlGroup: { addGroup: vi.fn() },
  resolveNewGroupBackend: vi.fn().mockResolvedValue(undefined),
}));

import { batchScrapeController } from "../../../controllers/v2/batch-scrape";
import { createService, replaceService } from "../../../service/service";

type FakeResponse = {
  headersSent: boolean;
  code?: number;
  body?: unknown;
  status: (code: number) => FakeResponse;
  json: (body: unknown) => FakeResponse;
};

async function enqueuedOrigins(body: { origin?: string; appendToId?: string }) {
  const res: FakeResponse = {
    headersSent: false,
    status: code => ((res.code = code), res),
    json: payload => ((res.body = payload), res),
  };
  await batchScrapeController(
    {
      body: {
        urls: ["https://open.example/a", "https://open.example/b"],
        ...body,
      },
      headers: {},
      protocol: "http",
      host: "api.test",
      auth: { team_id: "team-1" },
      requestBlocklistChecked: true,
      acuc: { flags: {}, team_id: "team-1", org_id: "org-1" },
    } as unknown as Parameters<typeof batchScrapeController>[0],
    res as unknown as Parameters<typeof batchScrapeController>[1],
  );
  return mocks.addScrapeJobs.mock.calls.flatMap(([jobs]) =>
    jobs.map(job => job.data.origin),
  );
}

describe("v2 batch scrape child job origin", () => {
  beforeAll(() => {
    replaceService(
      createService(
        { modules: {} },
        { core: { name: "core" }, logger: { error: vi.fn() } },
      ),
    );
  });

  afterAll(() => {
    replaceService(undefined);
  });

  beforeEach(() => {
    mocks.addScrapeJobs.mockReset();
    mocks.getCrawl.mockReset();
  });

  it("keeps the submitter's origin", async () => {
    expect(await enqueuedOrigins({ origin: "python-sdk@4.57.0" })).toEqual([
      "python-sdk@4.57.0",
      "python-sdk@4.57.0",
    ]);
  });

  it("defaults to api when no origin is sent", async () => {
    expect(await enqueuedOrigins({})).toEqual(["api", "api"]);
  });

  it("gives appended children the original batch's origin, not the append request's", async () => {
    const appendToId = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    mocks.getCrawl.mockResolvedValue({
      team_id: "team-1",
      crawlerOptions: null,
      scrapeOptions: {},
      internalOptions: { teamId: "team-1" },
      createdAt: Date.now(),
      origin: "python-sdk@4.57.0",
    });

    expect(
      await enqueuedOrigins({ appendToId, origin: "js-sdk@4.56.0" }),
    ).toEqual(["python-sdk@4.57.0", "python-sdk@4.57.0"]);
    expect(mocks.getCrawl).toHaveBeenCalledWith(appendToId);
  });
});
