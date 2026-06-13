import { finishCrawlSuper } from "./crawl-logic";
import { getCrawl } from "../../lib/crawl-redis";
import { logCrawl } from "../logging/log_job";
import { createWebhookSender } from "../webhook/index";
import type { NuQJob } from "./nuq";

jest.mock("../../lib/crawl-redis", () => ({
  finishCrawl: jest.fn(async () => {}),
  getCrawl: jest.fn(),
  getCrawlJobs: jest.fn(async () => []),
  getDoneJobsOrderedLength: jest.fn(async () => 2),
}));

jest.mock("../../db/rpc", () => ({
  creditsBilledByCrawlId: jest.fn(async () => [{ credits_billed: 0 }]),
}));

jest.mock("../../controllers/v1/crawl-status", () => ({
  getJobs: jest.fn(async () => []),
}));

jest.mock("../logging/log_job", () => ({
  logCrawl: jest.fn(async () => {}),
  logBatchScrape: jest.fn(async () => {}),
}));

jest.mock("../webhook/index", () => ({
  createWebhookSender: jest.fn(),
  WebhookEvent: {
    CRAWL_COMPLETED: "crawl.completed",
    BATCH_SCRAPE_COMPLETED: "batch_scrape.completed",
  },
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

beforeEach(() => jest.clearAllMocks());

// A ZDR crawl on the FDB queue sheds the member's input data, so finishCrawlSuper
// runs with job.data === null. It must not crash and must recover the webhook,
// team, and api version from the stored crawl.
test("recovers crawl context from sc when job.data is shed (ZDR)", async () => {
  const sendMock = jest.fn();
  (createWebhookSender as jest.Mock).mockResolvedValue({ send: sendMock });
  (getCrawl as jest.Mock).mockResolvedValue({
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
  expect((logCrawl as jest.Mock).mock.calls[0][0]).toMatchObject({
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
  (getCrawl as jest.Mock).mockResolvedValue({ ...baseSc, v1: true });

  const job = {
    id: "job-2",
    groupId: "crawl-2",
    ownerId: "team-from-sc",
    data: null,
  } as unknown as NuQJob<any>;

  await expect(finishCrawlSuper(job)).resolves.not.toThrow();
  expect(createWebhookSender).not.toHaveBeenCalled();
});
