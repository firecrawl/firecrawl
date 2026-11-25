const mocks = vi.hoisted(() => ({
  addScrapeJobs: vi.fn(),
  getCrawl: vi.fn(),
}));

vi.mock("../../../services/queue-jobs", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../services/queue-jobs")>()),
  addScrapeJobs: mocks.addScrapeJobs,
}));
vi.mock("../../../lib/crawl-redis", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/crawl-redis")>()),
  getCrawl: mocks.getCrawl,
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

import { batchScrapeController } from "../../../controllers/v2/batch-scrape";
import { createService, replaceService } from "../../../service/service";

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

  async function enqueuedOrigins(body: Record<string, unknown>) {
    const res: any = {
      headersSent: false,
      status: (code: number) => ((res.code = code), res),
      json: (body: unknown) => ((res.body = body), res),
    };
    await (batchScrapeController as any)(
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
