import express from "express";
import request from "supertest";
const mocks = vi.hoisted(() => ({
  processJob: vi.fn(),
  exchange: vi.fn(),
}));
vi.mock("../../services/worker/scrape-worker", () => ({
  processJobInternal: mocks.processJob,
}));
vi.mock("../../services/worker/team-semaphore", () => ({
  teamConcurrencySemaphore: {
    withSemaphore: (
      _team: string,
      _job: string,
      _limit: number,
      _signal: AbortSignal,
      _timeout: number,
      fn: (limited: boolean) => Promise<unknown>,
    ) => fn(false),
  },
}));
vi.mock("../../lib/job-priority", () => ({ getJobPriority: async () => 10 }));
vi.mock("../../services/logging/log_job", () => ({
  logRequest: async () => undefined,
}));
vi.mock("../../lib/key-restriction", () => ({
  checkKeyFormatRestriction: async () => ({ allowed: true }),
  formatTypesOf: () => [],
  actionTypesOf: () => [],
}));
vi.mock("../../lib/threat-protection/request", () => ({
  resolveThreatProtection: async () => ({ policy: null, orgConfig: null }),
}));
vi.mock("../../services/alexandria/client", () => ({
  exchangeRequest: mocks.exchange,
}));
import { scrapeController } from "./scrape";
import { NoEnginesLeftError } from "../../scraper/scrapeURL/error";
import { config } from "../../config";

let flags: Record<string, unknown> = {};
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  Object.assign(req, {
    auth: { team_id: "team" },
    acuc: { api_key_id: 1, flags, concurrency_limit: 2 },
  });
  next();
});
app.post("/v2/scrape", (req, res) => scrapeController(req as any, res));

const url = "https://data.similarweb.com/api/v1/data?domain=example.com";
const suggestions = {
  status: 200,
  body: {
    url,
    suggestions: [
      {
        provider: "similarweb",
        capability: "web/traffic",
        reason: "Similarweb traffic data.",
        input: { domain: "example.com" },
        creditsCost: 110,
        contractPath: "/v1/discover/web-analytics/similarweb",
      },
    ],
    message: "Alexandria suggestion: use Similarweb's web/traffic.",
  },
};
const blocked = new NoEnginesLeftError(["fire-engine;chrome-cdp"]);

describe("v2 scrape failures with Exchange URL suggestions", () => {
  const exchangeUrl = config.FIRE_EXCHANGE_URL;
  beforeEach(() => {
    mocks.processJob.mockReset();
    mocks.exchange.mockReset();
    flags = {};
    (config as any).FIRE_EXCHANGE_URL = "https://exchange.test";
  });
  afterAll(() => {
    (config as any).FIRE_EXCHANGE_URL = exchangeUrl;
  });

  it("appends the suggestion to an all-engines-failed error", async () => {
    mocks.processJob.mockRejectedValue(blocked);
    mocks.exchange.mockResolvedValue(suggestions);
    const response = await request(app).post("/v2/scrape").send({ url });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      success: false,
      code: "SCRAPE_ALL_ENGINES_FAILED",
      error: `${blocked.message} Alexandria suggestion: use Similarweb's web/traffic.`,
      alexandriaSuggestions: [
        {
          ...suggestions.body.suggestions[0],
          contractPath: "/exchange/discover/web-analytics/similarweb",
        },
      ],
    });
    expect(mocks.exchange).toHaveBeenCalledWith({
      teamId: "team",
      path: `/v1/discover/suggestions?url=${encodeURIComponent(url)}`,
      timeoutMs: 1500,
    });
  });

  it("keeps the original error when the Exchange has nothing or fails", async () => {
    mocks.processJob.mockRejectedValue(blocked);
    mocks.exchange
      .mockResolvedValueOnce({ status: 200, body: { url, suggestions: [] } })
      .mockRejectedValueOnce(new Error("timeout"));
    for (let i = 0; i < 2; i++) {
      const response = await request(app).post("/v2/scrape").send({ url });
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        success: false,
        code: "SCRAPE_ALL_ENGINES_FAILED",
        error: blocked.message,
      });
    }
  });

  it("does not consult the Exchange for zero-data-retention scrapes or when unconfigured", async () => {
    mocks.processJob.mockRejectedValue(blocked);
    flags = { scrapeZDR: "forced" };
    let response = await request(app).post("/v2/scrape").send({ url });
    expect(response.body.error).toBe(blocked.message);
    flags = {};
    (config as any).FIRE_EXCHANGE_URL = undefined;
    response = await request(app).post("/v2/scrape").send({ url });
    expect(response.body.error).toBe(blocked.message);
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("never consults the Exchange on success", async () => {
    mocks.processJob.mockResolvedValue({
      markdown: "# ok",
      metadata: { sourceURL: url, statusCode: 200 },
    });
    const response = await request(app).post("/v2/scrape").send({ url });
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body).not.toHaveProperty("alexandriaSuggestions");
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
});
