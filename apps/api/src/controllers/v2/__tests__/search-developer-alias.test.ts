import { vi } from "vitest";

const mockFetchResearchUpstream = vi.fn();

vi.mock("../../../lib/research-upstream", () => ({
  fetchResearchUpstream: (...args: any[]) => mockFetchResearchUpstream(...args),
}));

const mockLogRequest = vi.fn();
const mockLogSearch = vi.fn();
const mockLogResearchEndpoint = vi.fn();

vi.mock("../../../services/logging/log_job", () => ({
  logRequest: (...args: any[]) => mockLogRequest(...args),
  logSearch: (...args: any[]) => mockLogSearch(...args),
  logResearchEndpoint: (...args: any[]) => mockLogResearchEndpoint(...args),
}));

const mockExecuteSearch = vi.fn();

vi.mock("../../../search/execute", () => ({
  executeSearch: (...args: any[]) => mockExecuteSearch(...args),
}));

vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/keyless", () => ({
  KEYLESS_FREE_TIER_LIMIT_MESSAGE: "keyless limit reached",
  adjustKeylessCredits: vi.fn().mockResolvedValue(undefined),
  chargeKeylessCredits: vi.fn().mockResolvedValue(undefined),
  logKeylessCreditUsage: vi.fn().mockResolvedValue(undefined),
  reserveKeylessCredits: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../../../lib/keyless-credit-projection", () => ({
  projectSearchTotalCredits: () => 0,
}));

vi.mock("../../../lib/threat-protection/request", () => ({
  resolveThreatProtection: vi.fn().mockResolvedValue({ policy: null }),
  checkUrlsAgainstThreatPolicy: vi.fn(),
}));

vi.mock("../../../lib/key-restriction", () => ({
  actionTypesOf: () => [],
  formatTypesOf: () => [],
  checkKeyFormatRestriction: vi.fn().mockResolvedValue({ allowed: true }),
  checkKeyEndpointRestriction: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("../../../services/sentry", () => ({
  applyZdrScope: vi.fn(),
  captureExceptionWithZdrCheck: vi.fn(),
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

vi.mock("../../../routes/shared", () => ({
  wrap:
    (controller: any) =>
    (req: ExpressRequest, res: ExpressResponse, next: NextFunction) =>
      Promise.resolve(controller(req, res)).catch(next),
}));

import express, {
  NextFunction,
  Request as ExpressRequest,
  Response as ExpressResponse,
} from "express";
import request from "supertest";
import { createDeveloperRouter } from "../research-proxy";
import { searchController } from "../search";
import { wrap } from "../../../routes/shared";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";

const upstreamBody = {
  results: [
    {
      id: "abc",
      type: "issue",
      url: "https://github.com/example/repo/issues/1",
      title: "Retries drop the backoff",
      passages: [{ text: "first passage" }],
    },
  ],
};

function upstreamOk(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name === "content-type" ? "application/json" : null,
    },
    text: async () => JSON.stringify(body),
  };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).auth = { team_id: TEAM_ID };
    (req as any).acuc = { api_key_id: 7, flags: null };
    next();
  });
  app.post("/v2/search", wrap(searchController as any));
  app.use("/v2/search/developer", createDeveloperRouter({ root: true }));
  app.use("/v2/developer", createDeveloperRouter());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLogRequest.mockResolvedValue(undefined);
  mockLogSearch.mockResolvedValue(undefined);
  mockLogResearchEndpoint.mockResolvedValue(undefined);
  mockFetchResearchUpstream.mockResolvedValue(upstreamOk(upstreamBody));
  mockExecuteSearch.mockResolvedValue({
    response: { web: [] },
    totalResultsCount: 0,
    searchCredits: 0,
    scrapeCredits: 0,
    totalCredits: 0,
    shouldScrape: false,
  });
});

describe("/v2/search/developer route alias", () => {
  it("returns the identical GET response as /v2/developer/search", async () => {
    const app = makeApp();
    const canonical = await request(app)
      .get("/v2/developer/search")
      .query({ query: "http client retries", k: 5 });
    const alias = await request(app)
      .get("/v2/search/developer")
      .query({ query: "http client retries", k: 5 });

    expect(canonical.status).toBe(200);
    expect(alias.status).toBe(canonical.status);
    expect(alias.text).toBe(canonical.text);
    expect(alias.headers["content-type"]).toBe(
      canonical.headers["content-type"],
    );
    expect(mockFetchResearchUpstream).toHaveBeenCalledTimes(2);
    expect(mockFetchResearchUpstream.mock.calls[1][0]).toEqual(
      mockFetchResearchUpstream.mock.calls[0][0],
    );
    expect(mockExecuteSearch).not.toHaveBeenCalled();
  });

  it("returns the identical POST response as /v2/developer/search", async () => {
    const app = makeApp();
    const canonical = await request(app)
      .post("/v2/developer/search")
      .send({ query: "http client retries", k: 5 });
    const alias = await request(app)
      .post("/v2/search/developer")
      .send({ query: "http client retries", k: 5 });

    expect(canonical.status).toBe(200);
    expect(alias.status).toBe(canonical.status);
    expect(alias.text).toBe(canonical.text);
    expect(mockFetchResearchUpstream).toHaveBeenCalledTimes(2);
    expect(mockFetchResearchUpstream.mock.calls[1][0]).toEqual(
      mockFetchResearchUpstream.mock.calls[0][0],
    );
    expect(mockExecuteSearch).not.toHaveBeenCalled();
  });

  it("returns identical validation errors on both paths", async () => {
    const app = makeApp();
    const canonical = await request(app).get("/v2/developer/search");
    const alias = await request(app).get("/v2/search/developer");

    expect(canonical.status).toBe(400);
    expect(alias.status).toBe(canonical.status);
    expect(alias.text).toBe(canonical.text);
    expect(mockFetchResearchUpstream).not.toHaveBeenCalled();
  });

  it("does not capture /v2/search itself", async () => {
    const app = makeApp();
    const response = await request(app)
      .post("/v2/search")
      .send({ query: "http client", categories: ["developer"] });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(mockExecuteSearch).toHaveBeenCalledTimes(1);
    expect(mockExecuteSearch.mock.calls[0][0].categories).toEqual([
      { type: "developer" },
    ]);
    expect(mockFetchResearchUpstream).not.toHaveBeenCalled();
  });

  it("keeps the pre-existing developer paths serving", async () => {
    const app = makeApp();
    const nested = await request(app)
      .get("/v2/search/developer/search")
      .query({ query: "http client retries", k: 5 });
    const canonical = await request(app)
      .get("/v2/developer/search")
      .query({ query: "http client retries", k: 5 });

    expect(nested.status).toBe(200);
    expect(nested.text).toBe(canonical.text);
  });

  it("does not serve a root path on the /v2/developer mount", async () => {
    const app = makeApp();
    const response = await request(app)
      .get("/v2/developer")
      .query({ query: "http client retries" });

    expect(response.status).toBe(404);
    expect(mockFetchResearchUpstream).not.toHaveBeenCalled();
  });
});
