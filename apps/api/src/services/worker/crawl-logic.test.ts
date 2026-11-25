import type { Mock } from "vitest";
import { finishCrawlSuper } from "./crawl-logic";
import { getCrawl, getDoneJobsOrderedLength } from "../../lib/crawl-redis";
import { createWebhookSender } from "../webhook/index";
import { queueJobStore } from "../../service/defaults";
import type { CrawlFinished } from "../../service/hooks";
import { createService, replaceService } from "../../service/service";
import type { NuQJob } from "./nuq";

vi.mock("../../lib/crawl-redis", () => ({
  finishCrawl: vi.fn(async () => {}),
  getCrawl: vi.fn(),
  getCrawlJobs: vi.fn(async () => []),
  getDoneJobsOrderedLength: vi.fn(async () => 2),
}));

vi.mock("../../controllers/v2/crawl-status", () => ({
  getJobs: vi.fn(async () => []),
}));

vi.mock("../webhook/index", () => ({
  createWebhookSender: vi.fn(),
  WebhookEvent: {
    CRAWL_COMPLETED: "crawl.completed",
    BATCH_SCRAPE_COMPLETED: "batch_scrape.completed",
  },
}));

vi.mock("../redis", () => ({ redisEvictConnection: {} }));

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
const crawlFinishedEvents: CrawlFinished[] = [];

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

test("emits crawl.finished metadata for crawls and batch scrapes", async () => {
  const job = (id: string) =>
    ({
      id: `job-${id}`,
      groupId: `crawl-${id}`,
      ownerId: "team-from-sc",
      data: null,
    }) as unknown as NuQJob<any>;

  (getCrawl as Mock).mockResolvedValueOnce({
    ...baseSc,
    zeroDataRetention: false,
    internalOptions: {},
    v1: true,
    origin: "website",
  });
  await finishCrawlSuper(job("dash"));

  (getCrawl as Mock).mockResolvedValueOnce({
    ...baseSc,
    crawlerOptions: null,
    v1: true,
    origin: "website",
    cancelled: true,
  });
  (getDoneJobsOrderedLength as Mock).mockResolvedValueOnce(0);
  await finishCrawlSuper(job("batch"));

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
