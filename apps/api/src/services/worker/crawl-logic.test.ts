import type { Mock } from "vitest";
import { finishCrawlSuper } from "./crawl-logic";
import { getCrawl, getDoneJobsOrderedLength } from "../../lib/crawl-redis";
import { logCrawl } from "../logging/log_job";
import { createWebhookSender } from "../webhook/index";
import { createInAppNotification } from "../notification/in_app";
import type { NuQJob } from "./nuq";

vi.mock("../../lib/crawl-redis", () => ({
  finishCrawl: vi.fn(async () => {}),
  getCrawl: vi.fn(),
  getCrawlJobs: vi.fn(async () => []),
  getDoneJobsOrderedLength: vi.fn(async () => 2),
}));

vi.mock("../../lib/request-credits-store", () => ({
  readRequestCredits: vi.fn(async () => 7),
}));

vi.mock("../../lib/request-credits-analytics", () => ({
  readRequestCreditsFromAnalytics: vi.fn(async () => 7),
}));

vi.mock("../../controllers/v1/crawl-status", () => ({
  getJobs: vi.fn(async () => []),
}));

vi.mock("../logging/log_job", () => ({
  logCrawl: vi.fn(async () => {}),
  logBatchScrape: vi.fn(async () => {}),
}));

vi.mock("../webhook/index", () => ({
  createWebhookSender: vi.fn(),
  WebhookEvent: {
    CRAWL_COMPLETED: "crawl.completed",
    BATCH_SCRAPE_COMPLETED: "batch_scrape.completed",
  },
}));

vi.mock("../redis", () => ({ redisEvictConnection: {} }));

vi.mock("../notification/in_app", async importOriginal => ({
  ...(await importOriginal<typeof import("../notification/in_app")>()),
  createInAppNotification: vi.fn(async () => true),
}));

const baseSc = {
  originUrl: "https://example.com",
  crawlerOptions: {},
  scrapeOptions: {},
  internalOptions: { zeroDataRetention: true },
  team_id: "team-from-sc",
  createdAt: Date.now(),
  zeroDataRetention: true,
};

beforeEach(() => vi.clearAllMocks());

// A ZDR crawl on the FDB queue sheds the member's input data, so finishCrawlSuper
// runs with job.data === null. It must not crash and must recover the webhook,
// team, and api version from the stored crawl.
test("recovers crawl context from sc when job.data is shed (ZDR)", async () => {
  const sendMock = vi.fn();
  (createWebhookSender as Mock).mockResolvedValue({ send: sendMock });
  (getCrawl as Mock).mockResolvedValue({
    ...baseSc,
    v1: true,
    webhook: { url: "https://hook.example" },
  });

  const job = {
    id: "job-1",
    groupId: "crawl-1",
    ownerId: "team-from-sc",
    data: null,
  } as unknown as NuQJob<any>;

  await expect(finishCrawlSuper(job)).resolves.not.toThrow();

  expect(logCrawl).toHaveBeenCalledTimes(1);
  expect((logCrawl as Mock).mock.calls[0][0]).toMatchObject({
    id: "crawl-1",
    team_id: "team-from-sc",
    request_id: "crawl-1",
  });

  expect(createWebhookSender).toHaveBeenCalledWith({
    teamId: "team-from-sc",
    jobId: "crawl-1",
    webhook: { url: "https://hook.example" },
    v0: false,
  });
  expect(sendMock).toHaveBeenCalledTimes(1);
});

// With no webhook on the crawl and shed data, it still completes without firing.
test("does not crash or fire a webhook when none is configured", async () => {
  (getCrawl as Mock).mockResolvedValue({ ...baseSc, v1: true });

  const job = {
    id: "job-2",
    groupId: "crawl-2",
    ownerId: "team-from-sc",
    data: null,
  } as unknown as NuQJob<any>;

  await expect(finishCrawlSuper(job)).resolves.not.toThrow();
  expect(createWebhookSender).not.toHaveBeenCalled();
});

describe("dashboard notification on finish", () => {
  const job = (id: string) =>
    ({
      id: `job-${id}`,
      groupId: `crawl-${id}`,
      ownerId: "team-from-sc",
      data: null,
    }) as unknown as NuQJob<any>;

  test("notifies the team when a crawl started from the dashboard finishes", async () => {
    (getCrawl as Mock).mockResolvedValue({
      ...baseSc,
      zeroDataRetention: false,
      internalOptions: {},
      v1: true,
      origin: "website",
    });

    await finishCrawlSuper(job("dash"));

    expect(createInAppNotification).toHaveBeenCalledWith(
      "team-from-sc",
      "crawlCompleted",
      expect.objectContaining({
        jobId: "crawl-dash",
        url: "https://example.com",
        completed: 2,
        creditsUsed: 7,
        link: "/app/logs?q=crawl-dash",
      }),
      { dedupeKey: "crawl-dash" },
    );
  });

  test("leaves the URL out for zero data retention crawls", async () => {
    (getCrawl as Mock).mockResolvedValue({
      ...baseSc,
      v1: true,
      origin: "website",
    });

    await finishCrawlSuper(job("zdr"));

    expect(createInAppNotification).toHaveBeenCalledWith(
      "team-from-sc",
      "crawlCompleted",
      expect.objectContaining({ url: null }),
      expect.anything(),
    );
  });

  test("names a batch scrape as such", async () => {
    (getCrawl as Mock).mockResolvedValue({
      ...baseSc,
      crawlerOptions: null,
      v1: true,
      origin: "website",
    });

    await finishCrawlSuper(job("batch"));

    expect(createInAppNotification).toHaveBeenCalledWith(
      "team-from-sc",
      "batchScrapeCompleted",
      expect.objectContaining({ url: null }),
      expect.anything(),
    );
  });

  test("stays quiet for API-started, cancelled, and fully failed jobs", async () => {
    (getCrawl as Mock).mockResolvedValueOnce({
      ...baseSc,
      v1: true,
      origin: "api",
    });
    await finishCrawlSuper(job("api"));

    (getCrawl as Mock).mockResolvedValueOnce({
      ...baseSc,
      v1: true,
      origin: "not-the-website",
    });
    await finishCrawlSuper(job("lookalike"));

    (getCrawl as Mock).mockResolvedValueOnce({
      ...baseSc,
      v1: true,
      origin: "website",
    });
    (getDoneJobsOrderedLength as Mock).mockResolvedValueOnce(0);
    await finishCrawlSuper(job("all-failed"));

    (getCrawl as Mock).mockResolvedValueOnce({
      ...baseSc,
      v1: true,
      origin: "website",
      cancelled: true,
    });
    await finishCrawlSuper(job("cancelled"));

    expect(createInAppNotification).not.toHaveBeenCalled();
  });
});
