import express from "express";
import request from "supertest";
const mocks = vi.hoisted(() => ({ processJob: vi.fn() }));
vi.mock("ioredis", () => ({
  default: class {
    on() {}
    defineCommand() {}
  },
}));
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
app.post("/v1/scrape", (req, res) => scrapeController(req as any, res));

it("answers 429 with Retry-After when the data source is rate-limiting", async () => {
  mocks.processJob.mockRejectedValue(new DataSourceRateLimitedError(6));
  const response = await request(app)
    .post("/v1/scrape")
    .send({ url: "https://profiles.example/person/a" });
  expect(response.status).toBe(429);
  expect(response.headers["retry-after"]).toBe("6");
  expect(response.body).toEqual({
    success: false,
    code: "SCRAPE_DATA_SOURCE_RATE_LIMITED",
    error: "The data source is rate-limiting requests. Retry after 6 seconds.",
  });
});
