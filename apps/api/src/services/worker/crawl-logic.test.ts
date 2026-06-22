import type { Mock } from "vitest";
import { finishCrawlSuper } from "./crawl-logic";
import { getCrawl } from "../../lib/crawl-redis";
import { logCrawl } from "../logging/log_job";
import { createWebhookSender } from "../webhook/index";
import type { NuQJob } from "./nuq";

vi.mock("../../lib/crawl-redis", () => ({
  finishCrawl: vi.fn(async () => {}),
  getCrawl: vi.fn(),
  getCrawlJobs: vi.fn(async () => []),
  getDoneJobsOrderedLength: vi.fn(async () => 2),
}));

vi.mock("../../db/rpc", () => ({
  creditsBilledByCrawlId: vi.fn(async () => [{ credits_billed: 0 }]),
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
