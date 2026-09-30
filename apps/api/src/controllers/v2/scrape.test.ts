import express from "express";
import request from "supertest";
const mocks = vi.hoisted(() => ({ processJob: vi.fn() }));
vi.mock("ioredis", () => ({
  default: class {
    on() {}
    defineCommand() {}
  },
}));
vi.mock("./scrape-alexandria", () => ({ providerScrapeController: vi.fn() }));
vi.mock("../../search/alexandria", () => ({ discoverTools: vi.fn() }));
vi.mock("../../services/worker/scrape-worker", () => ({
  processJobInternal: mocks.processJob,
}));
vi.mock("../../services/worker/team-semaphore", () => ({
  teamConcurrencySemaphore: {
    withSemaphore: (...args: any[]) => args[5](false),
  },
}));
vi.mock("../../lib/job-priority", () => ({ getJobPriority: async () => 10 }));
vi.mock("../../lib/concurrency-limit", () => ({
  getEffectiveConcurrencyLimit: async () => 2,
}));
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
vi.mock("../../lib/keyless-credit-projection", () => ({
  projectScrapeCredits: () => 0,
}));
vi.mock("../../lib/siem-logging", () => ({
  emitRejectedScrapeActivityEvent: vi.fn(),
}));
import { DataSourceRateLimitedError } from "../../scraper/scrapeURL/error";
import { scrapeController } from "./scrape";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  Object.assign(req, {
    auth: { team_id: "team" },
    acuc: { api_key_id: 12, org_id: "org", flags: {} },
  });
  next();
});
app.post("/v2/scrape", (req, res) => scrapeController(req as any, res));

beforeEach(() => {
  vi.clearAllMocks();
});

it("answers 429 with Retry-After when the data source is rate-limiting", async () => {
  mocks.processJob.mockRejectedValue(new DataSourceRateLimitedError(15));
  const response = await request(app)
    .post("/v2/scrape")
    .send({ url: "https://profiles.example/person/a" });
  expect(response.status).toBe(429);
  expect(response.headers["retry-after"]).toBe("15");
  expect(response.body).toEqual({
    success: false,
    code: "SCRAPE_DATA_SOURCE_RATE_LIMITED",
    error: "The data source is rate-limiting requests. Retry after 15 seconds.",
  });
});

it("answers 429 without Retry-After when no interval is known", async () => {
  mocks.processJob.mockRejectedValue(new DataSourceRateLimitedError());
  const response = await request(app)
    .post("/v2/scrape")
    .send({ url: "https://profiles.example/person/a" });
  expect(response.status).toBe(429);
  expect(response.headers["retry-after"]).toBeUndefined();
  expect(response.body.error).toBe(
    "The data source is rate-limiting requests. Retry later.",
  );
});
