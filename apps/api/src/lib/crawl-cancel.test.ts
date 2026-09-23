const {
  getCrawl,
  getCrawlJobs,
  saveCrawl,
  removeConcurrencyLimitedJobs,
  cancelGroup,
} = vi.hoisted(() => ({
  getCrawl: vi.fn(),
  getCrawlJobs: vi.fn(),
  saveCrawl: vi.fn(),
  removeConcurrencyLimitedJobs: vi.fn(),
  cancelGroup: vi.fn(),
}));

vi.mock("./crawl-redis", () => ({ getCrawl, getCrawlJobs, saveCrawl }));
vi.mock("./concurrency-limit", () => ({ removeConcurrencyLimitedJobs }));
vi.mock("./logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../services/worker/nuq-router", () => ({
  crawlGroup: { cancelGroup },
}));

import { cancelCrawl } from "./crawl-cancel";

describe("cancelCrawl", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks a PG crawl cancelled and removes all queued jobs", async () => {
    const crawl = { team_id: "team-1", queueBackend: "pg" } as any;
    getCrawl.mockResolvedValue(crawl);
    getCrawlJobs.mockResolvedValue(["job-1", "job-2"]);

    await expect(cancelCrawl("crawl-1")).resolves.toBe(true);

    expect(saveCrawl).toHaveBeenCalledWith(
      "crawl-1",
      expect.objectContaining({ cancelled: true }),
    );
    expect(removeConcurrencyLimitedJobs).toHaveBeenCalledWith("team-1", [
      "job-1",
      "job-2",
    ]);
    expect(cancelGroup).not.toHaveBeenCalled();
  });

  it("marks an FDB crawl cancelled and cancels its group", async () => {
    const crawl = { team_id: "team-1", queueBackend: "fdb" } as any;

    await expect(cancelCrawl("crawl-1", crawl)).resolves.toBe(true);

    expect(getCrawl).not.toHaveBeenCalled();
    expect(saveCrawl).toHaveBeenCalledWith(
      "crawl-1",
      expect.objectContaining({ cancelled: true }),
    );
    expect(cancelGroup).toHaveBeenCalledWith("crawl-1");
    expect(removeConcurrencyLimitedJobs).not.toHaveBeenCalled();
  });

  it("still cancels queued PG jobs when crawl metadata has expired", async () => {
    getCrawl.mockResolvedValue(null);
    cancelGroup.mockResolvedValue(false);
    getCrawlJobs.mockResolvedValue(["job-1"]);

    await expect(cancelCrawl("crawl-1", undefined, "team-1")).resolves.toBe(
      true,
    );

    expect(removeConcurrencyLimitedJobs).toHaveBeenCalledWith("team-1", [
      "job-1",
    ]);
  });
});
