import { vi } from "vitest";
import type { BaseScrapeOptions } from "../../controllers/v2/types";
import { finishCrawlSuper } from "./crawl-logic";
import { createWebhookSender } from "../webhook/index";
import { queueJobStore } from "../../service/defaults";
import type { CrawlFinished } from "../../service/hooks";
import { createService, replaceService } from "../../service/service";

const mocks = vi.hoisted(() => ({
  finishCrawl: vi.fn(async () => {}),
  getCrawl: vi.fn(),
  getCrawlJobs: vi.fn(async () => []),
  getDoneJobsOrderedLength: vi.fn(async () => 2),
  isCrawlFinishMarked: vi.fn(async () => false),
  createWebhookSender: vi.fn(),
}));

vi.mock("../../lib/crawl-redis", () => ({
  finishCrawl: mocks.finishCrawl,
  getCrawl: mocks.getCrawl,
  getCrawlJobs: mocks.getCrawlJobs,
  getDoneJobsOrderedLength: mocks.getDoneJobsOrderedLength,
  isCrawlFinishMarked: mocks.isCrawlFinishMarked,
}));

vi.mock("../../controllers/v2/crawl-status", () => ({
  getJobs: vi.fn(async () => []),
}));

vi.mock("../webhook/index", () => ({
  createWebhookSender: mocks.createWebhookSender,
  WebhookEvent: {
    CRAWL_COMPLETED: "crawl.completed",
    BATCH_SCRAPE_COMPLETED: "batch_scrape.completed",
  },
}));

vi.mock("../redis", () => ({ redisEvictConnection: {} }));

const defaultScrapeOptions: BaseScrapeOptions = {
  formats: [{ type: "markdown" }],
  onlyMainContent: true,
  onlyCleanContent: false,
  waitFor: 0,
  mobile: false,
  removeBase64Images: true,
  fastMode: false,
  blockAds: true,
  proxy: "auto",
  checkPromptInjection: false,
};

function makeShedJob(id: string) {
  return {
    id: `job-${id}`,
    groupId: `crawl-${id}`,
    data: null,
  };
}

const baseSc = {
  originUrl: "https://example.com",
  crawlerOptions: {},
  scrapeOptions: {},
  internalOptions: { zeroDataRetention: true },
  team_id: "team-from-sc",
  createdAt: Date.now(),
  zeroDataRetention: true,
};

const jobStoreUsage = vi.fn(async () => 7);
const crawlFinishedEvents: Array<CrawlFinished> = [];

beforeAll(() => {
  replaceService(
    createService(
      {
        modules: {
          jobStore: {
            ...queueJobStore(),
            usage: jobStoreUsage,
          },
        },
        extensions: [
          {
            name: "test-crawl-finished",
            hooks: {
              "crawl.finished": event => {
                crawlFinishedEvents.push(event);
              },
            },
          },
        ],
      },
      { core: { name: "core" }, logger: { error: vi.fn() } },
    ),
  );
});

afterAll(() => {
  replaceService(undefined);
});

beforeEach(() => {
  vi.clearAllMocks();
  crawlFinishedEvents.length = 0;
  jobStoreUsage.mockResolvedValue(7);
});

// A ZDR crawl on the FDB queue sheds the member's input data, so finishCrawlSuper
// runs with job.data === null. It must not crash and must recover the webhook,
// team, and api version from the stored crawl.
test("recovers crawl context from sc when job.data is shed (ZDR)", async () => {
  const sendMock = vi.fn();
  mocks.createWebhookSender.mockResolvedValue({ send: sendMock });
  mocks.getCrawl.mockResolvedValue({
    ...baseSc,
    v1: true,
    webhook: { url: "https://hook.example" },
  });

  const job = {
    id: "job-1",
    groupId: "crawl-1",
    data: null,
  };

  await expect(finishCrawlSuper(job)).resolves.not.toThrow();

  expect(crawlFinishedEvents).toHaveLength(1);
  expect(crawlFinishedEvents[0]).toMatchObject({
    id: "crawl-1",
    requestId: "crawl-1",
    kind: "crawl",
    completed: 2,
    cancelled: false,
    charged: 7,
    ctx: expect.objectContaining({
      teamId: "team-from-sc",
      zeroDataRetention: true,
    }),
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
  mocks.getCrawl.mockResolvedValue({ ...baseSc, v1: true });

  const job = {
    id: "job-2",
    groupId: "crawl-2",
    data: null,
  };

  await expect(finishCrawlSuper(job)).resolves.not.toThrow();
  expect(createWebhookSender).not.toHaveBeenCalled();
});

test("emits crawl.finished metadata for crawls and batch scrapes", async () => {
  mocks.getCrawl.mockResolvedValueOnce({
    ...baseSc,
    zeroDataRetention: false,
    internalOptions: {},
    v1: true,
    origin: "website",
  });
  await finishCrawlSuper(makeShedJob("dash"));

  mocks.getCrawl.mockResolvedValueOnce({
    ...baseSc,
    crawlerOptions: null,
    v1: true,
    origin: "website",
    cancelled: true,
  });
  mocks.getDoneJobsOrderedLength.mockResolvedValueOnce(0);
  await finishCrawlSuper(makeShedJob("batch"));

  expect(crawlFinishedEvents).toEqual([
    expect.objectContaining({
      id: "crawl-dash",
      kind: "crawl",
      origin: "website",
      originUrl: "https://example.com",
      completed: 2,
      cancelled: false,
      charged: 7,
      ctx: expect.objectContaining({
        teamId: "team-from-sc",
        zeroDataRetention: false,
      }),
    }),
    expect.objectContaining({
      id: "crawl-batch",
      kind: "batchScrape",
      origin: "website",
      completed: 0,
      cancelled: true,
      charged: 7,
      ctx: expect.objectContaining({
        teamId: "team-from-sc",
        zeroDataRetention: true,
      }),
    }),
  ]);
});

// A missing stored crawl must not skip the finish: it recovers what it needs
// from the member job and still sends the completion webhook.
test("finishes from the member job when the stored crawl is missing", async () => {
  const sendMock = vi.fn();
  mocks.createWebhookSender.mockResolvedValue({ send: sendMock });
  mocks.getCrawl.mockResolvedValue(null);

  const webhook = {
    url: "https://hook.example",
    headers: {},
    metadata: {},
    events: ["completed" as const],
  };

  const job = {
    id: "job-3",
    groupId: "crawl-3",
    data: {
      mode: "single_urls" as const,
      url: "https://example.com",
      origin: "api",
      apiKeyId: null,
      team_id: "team-from-job",
      crawlerOptions: null,
      scrapeOptions: defaultScrapeOptions,
      internalOptions: { teamId: "team-from-job", orgId: null },
      zeroDataRetention: false,
      v1: true,
      webhook,
      requestId: "req-3",
    },
  };

  await finishCrawlSuper(job);

  expect(crawlFinishedEvents).toEqual([
    expect.objectContaining({
      id: "crawl-3",
      kind: "batchScrape",
      requestId: "req-3",
      ctx: expect.objectContaining({ teamId: "team-from-job" }),
    }),
  ]);
  expect(createWebhookSender).toHaveBeenCalledWith({
    teamId: "team-from-job",
    jobId: "crawl-3",
    webhook,
    v0: false,
  });
  expect(sendMock).toHaveBeenCalledWith("batch_scrape.completed", {
    success: true,
    data: [],
  });
});

test("fails visibly when the stored crawl and the member job data are both gone", async () => {
  mocks.getCrawl.mockResolvedValue(null);

  const job = {
    id: "job-4",
    groupId: "crawl-4",
    data: null,
  };

  await expect(finishCrawlSuper(job)).rejects.toThrow(/Stored crawl missing/);
  expect(crawlFinishedEvents).toHaveLength(0);
  expect(createWebhookSender).not.toHaveBeenCalled();
});
