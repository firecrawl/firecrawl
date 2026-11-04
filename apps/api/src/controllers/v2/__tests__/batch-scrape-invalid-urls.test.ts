import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addScrapeJobs: vi.fn(),
}));

vi.mock("../../../lib/threat-protection/request", () => ({
  resolveThreatProtection: vi
    .fn()
    .mockResolvedValue({ orgConfig: null, policy: null }),
  checkUrlsAgainstThreatPolicy: vi.fn(),
}));

vi.mock("../../../lib/key-restriction", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/key-restriction")>()),
  checkKeyFormatRestriction: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("../../../services/logging/log_job", () => ({
  logRequest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/request-credits-store", () => ({
  AGENT_REQUEST_CREDITS_SHARDS: 1,
  initializeRequestCredits: vi.fn().mockResolvedValue(undefined),
  requestCreditsShards: vi.fn().mockReturnValue(1),
}));

vi.mock("../../../lib/crawl-redis", () => ({
  addCrawlJobs: vi.fn().mockResolvedValue(undefined),
  finishCrawlKickoff: vi.fn().mockResolvedValue(undefined),
  getCrawl: vi.fn().mockResolvedValue(null),
  lockURLs: vi.fn().mockResolvedValue(true),
  markCrawlActive: vi.fn().mockResolvedValue(undefined),
  saveCrawl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../services/worker/nuq-router", () => ({
  crawlGroup: { addGroup: vi.fn().mockResolvedValue(undefined) },
  resolveNewGroupBackend: vi.fn().mockResolvedValue("nuq"),
}));

vi.mock("../../../services/queue-jobs", () => ({
  addScrapeJobs: mocks.addScrapeJobs,
}));

vi.mock("../../../scraper/WebScraper/utils/blocklist", () => ({
  isUrlBlocked: vi.fn().mockReturnValue(false),
}));

vi.mock("../../../lib/siem-logging", () => ({
  emitRejectedScrapeActivityEvents: vi.fn(),
}));

vi.mock("../../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { ZodError } from "zod";
import { batchScrapeController } from "../batch-scrape";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";

function makeReq(body: Record<string, unknown>) {
  return {
    body,
    auth: { team_id: TEAM_ID },
    acuc: { api_key_id: 7, org_id: null, flags: {} },
    headers: {},
    protocol: "http",
    host: "localhost",
    get: () => undefined,
  } as any;
}

function makeRes() {
  const res: any = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe("batch scrape invalid URLs", () => {
  beforeEach(() => {
    mocks.addScrapeJobs.mockReset().mockResolvedValue(undefined);
  });

  it("skips an invalid URL by default, as ignoreInvalidURLs defaults to true", async () => {
    const res = makeRes();
    await batchScrapeController(
      makeReq({ urls: ["https://example.com", "not a url"] }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, invalidURLs: ["not a url"] }),
    );
    const jobs = mocks.addScrapeJobs.mock.calls[0][0];
    expect(jobs.map((job: any) => job.data.url)).toEqual([
      "https://example.com",
    ]);
  });

  it("skips an invalid URL when ignoreInvalidURLs is true", async () => {
    const res = makeRes();
    await batchScrapeController(
      makeReq({
        urls: ["https://example.com", "not a url"],
        ignoreInvalidURLs: true,
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, invalidURLs: ["not a url"] }),
    );
    const jobs = mocks.addScrapeJobs.mock.calls[0][0];
    expect(jobs.map((job: any) => job.data.url)).toEqual([
      "https://example.com",
    ]);
  });

  it("answers 400 without queueing when every URL is invalid", async () => {
    const res = makeRes();
    await batchScrapeController(
      makeReq({ urls: ["not a url", "also bad"] }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "No valid URLs provided",
    });
    expect(mocks.addScrapeJobs).not.toHaveBeenCalled();
  });

  it("rejects the whole request when ignoreInvalidURLs is false", async () => {
    await expect(
      batchScrapeController(
        makeReq({
          urls: ["https://example.com", "not a url"],
          ignoreInvalidURLs: false,
        }),
        makeRes(),
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(mocks.addScrapeJobs).not.toHaveBeenCalled();
  });
});
