vi.mock("../lib/concurrency-limit", () => ({
  cleanOldConcurrencyLimitEntries: vi.fn(async () => {}),
  getConcurrencyLimitActiveJobs: vi.fn(async () => []),
  getConcurrencyQueueJobsCount: vi.fn(async () => 0),
  getCrawlConcurrencyLimitActiveJobs: vi.fn(async () => []),
  getTeamQueueLimit: vi.fn(() => 10),
  MAX_BACKLOG_TIMEOUT_MS: 24 * 60 * 60 * 1000,
  pushConcurrencyLimitActiveJob: vi.fn(async () => {}),
  pushConcurrencyLimitedJob: vi.fn(async () => {}),
  pushConcurrencyLimitedJobs: vi.fn(async () => {}),
  pushCrawlConcurrencyLimitActiveJob: vi.fn(async () => {}),
  QueueFullError: class QueueFullError extends Error {},
}));

vi.mock("../lib/logger", () => {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return { logger };
});

vi.mock("./notification/email_notification", () => ({
  sendNotificationWithCustomDays: vi.fn(),
}));

vi.mock("./notification/notification-check", () => ({
  shouldSendConcurrencyLimitNotification: vi.fn(async () => false),
}));

vi.mock("../controllers/auth", () => ({
  getACUCTeam: vi.fn(async () => ({ flags: null, concurrency: 2 })),
}));

vi.mock("../lib/gcs-jobs", () => ({
  getJobFromGCS: vi.fn(),
  removeJobFromGCS: vi.fn(),
}));

vi.mock("./ab-test", () => ({
  abTestJob: vi.fn(),
}));

vi.mock("./worker/nuq", () => ({
  scrapeQueue: {
    addJob: vi.fn(async (id, data) => ({
      id,
      data,
      status: "waiting",
      createdAt: new Date(),
      priority: 0,
    })),
    addJobs: vi.fn(async () => []),
  },
}));

vi.mock("./worker/nuq-router", () => ({
  fdbEnqueueScrapeJobs: vi.fn(),
  resolveJobBackend: vi.fn(async () => "pg"),
  scrapeQueue: {
    removeJob: vi.fn(),
    removeJobs: vi.fn(),
    waitForJob: vi.fn(),
  },
}));

vi.mock("./worker/nuq-fdb", () => ({
  nuqFdbHealthCheck: vi.fn(async () => false),
  scrapeQueueFdb: {
    getTeamPendingCount: vi.fn(),
  },
  withFdbTimeout: vi.fn(value => value),
}));

vi.mock("../lib/otel-tracer", () => ({
  serializeTraceContext: vi.fn(() => ({ traceparent: "traceparent" })),
}));

vi.mock("../lib/deployment", () => ({
  isSelfHosted: vi.fn(() => true),
}));

vi.mock("./monitoring/stale", () => ({
  MONITOR_CHECK_STALE_TIMEOUT_MS: 60 * 1000,
}));

vi.mock("../lib/crawl-redis", () => ({
  getCrawl: vi.fn(async () => null),
}));

vi.mock("../lib/scrape-job-permissions", () => ({
  checkScrapeJobPermissions: vi.fn(() => ({})),
}));

import { CrawlDenialError } from "../lib/error";
import { checkScrapeJobPermissions } from "../lib/scrape-job-permissions";
import { getACUCTeam } from "../controllers/auth";
import type { ScrapeJobSingleUrls } from "../types";
import { addScrapeJob } from "./queue-jobs";
import { scrapeQueue } from "./worker/nuq";
import { resolveJobBackend } from "./worker/nuq-router";

const baseJobData: ScrapeJobSingleUrls = {
  mode: "single_urls",
  url: "https://www.linkedin.com/in/example",
  team_id: "team-1",
  scrapeOptions: {} as any,
  internalOptions: {
    teamId: "team-1",
    teamFlags: null,
  },
  origin: "api",
  zeroDataRetention: false,
  apiKeyId: null,
};

describe("addScrapeJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkScrapeJobPermissions).mockReturnValue({});
  });

  it("rejects denied single-url scrape jobs before enqueueing", async () => {
    vi.mocked(checkScrapeJobPermissions).mockReturnValueOnce({
      error: "blocked",
    });

    await expect(addScrapeJob(baseJobData, "job-1")).rejects.toThrow(
      CrawlDenialError,
    );

    expect(checkScrapeJobPermissions).toHaveBeenCalledWith(
      baseJobData,
      null,
    );
    expect(getACUCTeam).not.toHaveBeenCalled();
    expect(resolveJobBackend).not.toHaveBeenCalled();
    expect(scrapeQueue.addJob).not.toHaveBeenCalled();
  });

  it("leaves crawl-tracked jobs to the worker-side cleanup path", async () => {
    vi.mocked(checkScrapeJobPermissions).mockReturnValue({
      error: "blocked",
    });

    await addScrapeJob({ ...baseJobData, crawl_id: "crawl-1" }, "job-2");

    expect(checkScrapeJobPermissions).not.toHaveBeenCalled();
    expect(resolveJobBackend).toHaveBeenCalled();
    expect(scrapeQueue.addJob).toHaveBeenCalledWith(
      "job-2",
      expect.objectContaining({
        crawl_id: "crawl-1",
        traceContext: { traceparent: "traceparent" },
      }),
      expect.objectContaining({
        groupId: "crawl-1",
        ownerId: "team-1",
      }),
    );
  });
});
