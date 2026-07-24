import { vi } from "vitest";
import express from "express";
import request from "supertest";

// Stub billing and the upstream fetch so route tests can assert billing
// metadata without a live proxy or real Autumn/DB calls.
const billTeamMock = vi.fn().mockResolvedValue({ success: true });
vi.mock("../../services/billing/credit_billing", () => ({
  billTeam: (...args: any[]) => billTeamMock(...args),
}));

const fetchMock = vi.fn();
// Stub only `fetch`; keep the real Agent/interceptors that other modules need.
vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  return { ...actual, fetch: (...args: any[]) => fetchMock(...args) };
});

vi.mock("../../services/logging/log_job", () => ({
  logRequest: vi.fn().mockResolvedValue(undefined),
  logResearchEndpoint: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/keyless", () => ({
  chargeKeylessCredits: vi.fn().mockResolvedValue(undefined),
}));

import { config } from "../../config";
import {
  featureIdForBillingEndpoint,
  SEARCH_CREDITS_FEATURE_ID,
} from "../../services/autumn/autumn.service";
import { createResearchRouter } from "./research-proxy";

// Drive every mounted route and assert each bills against search credits.
describe("research proxy billing", () => {
  let originalProxyUrl: string | undefined;

  const buildApp = (flags: unknown = null) => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).auth = { team_id: "team-123" };
      (req as any).acuc = { api_key_id: 42, flags };
      next();
    });
    app.use("/search/research", createResearchRouter());
    return app;
  };

  const upstreamResponse = (body: unknown) => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  });

  beforeAll(() => {
    originalProxyUrl = config.RESEARCH_PROXY_URL;
    config.RESEARCH_PROXY_URL = "http://research.test";
  });

  afterAll(() => {
    config.RESEARCH_PROXY_URL = originalProxyUrl;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    billTeamMock.mockResolvedValue({ success: true });
  });

  const billingOf = () => billTeamMock.mock.calls[0][3];
  const creditsOf = () => billTeamMock.mock.calls[0][1];

  const searchCases = [
    { name: "papers search", path: "/search/research/papers", query: { query: "rag" } },
    {
      name: "similar papers",
      path: "/search/research/papers/1706.03762/similar",
      query: { intent: "attention" },
    },
    { name: "github search", path: "/search/research/github", query: { query: "firecrawl" } },
  ];

  it.each(searchCases)(
    "$name bills search credits, scaled by result count",
    async ({ path, query }) => {
      fetchMock.mockResolvedValue(
        upstreamResponse({ results: new Array(11).fill({}) }),
      );

      const res = await request(buildApp()).get(path).query(query);

      expect(res.statusCode).toBe(200);
      expect(billTeamMock).toHaveBeenCalledTimes(1);
      expect(billingOf().endpoint).toBe("search");
      expect(featureIdForBillingEndpoint(billingOf().endpoint)).toBe(
        SEARCH_CREDITS_FEATURE_ID,
      );
      expect(creditsOf()).toBe(4); // ceil(11 / 10) * 2
    },
  );

  it("paper read bills search credits at a flat 1 credit", async () => {
    fetchMock.mockResolvedValue(upstreamResponse({ paperId: "1706.03762" }));

    const res = await request(buildApp())
      .get("/search/research/papers/1706.03762")
      .query({ query: "attention" });

    expect(res.statusCode).toBe(200);
    expect(billTeamMock).toHaveBeenCalledTimes(1);
    expect(billingOf().endpoint).toBe("search");
    expect(creditsOf()).toBe(1);
  });

  it("applies the ZDR search-credit rate for forced-zdr teams", async () => {
    fetchMock.mockResolvedValue(
      upstreamResponse({ results: new Array(11).fill({}) }),
    );

    const res = await request(buildApp({ searchZDR: "forced-zdr" }))
      .get("/search/research/papers")
      .query({ query: "rag" });

    expect(res.statusCode).toBe(200);
    expect(billingOf().endpoint).toBe("search");
    expect(creditsOf()).toBe(20); // ceil(11 / 10) * 10
  });
});
