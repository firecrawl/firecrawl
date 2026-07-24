import { vi } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks — hoisted above imports by Vitest. The research controller is billed
// fire-and-forget through billTeam and reaches an upstream service over undici;
// stub both so the route-level tests can assert the billing metadata without a
// live proxy or real Autumn/DB calls.
// ---------------------------------------------------------------------------

const billTeamMock = vi.fn().mockResolvedValue({ success: true });
vi.mock("../../services/billing/credit_billing", () => ({
  billTeam: (...args: any[]) => billTeamMock(...args),
}));

const fetchMock = vi.fn();
// Only stub `fetch`; keep the real Agent/interceptors so other modules in the
// import graph (e.g. safeFetch) that rely on `Agent.compose` still work.
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
  CREDITS_FEATURE_ID,
} from "../../services/autumn/autumn.service";
import {
  RESEARCH_BILLING_ENDPOINT,
  computeResearchCredits,
  createResearchRouter,
} from "./research-proxy";
import type { RequestWithAuth } from "../v1/types";

// The research proxy only reads `costModel` off the endpoint config when
// computing credits, so a partial cast keeps these fixtures focused.
const flatEndpoint = { costModel: "flat" } as any;
const perResultEndpoint = { costModel: "perResult" } as any;

function reqWithFlags(flags?: Record<string, unknown>) {
  return { acuc: flags ? { flags } : undefined } as unknown as RequestWithAuth<
    any,
    any,
    any
  >;
}

describe("research proxy billing", () => {
  it("bills the shared research billing endpoint against the search-credits pool", () => {
    // The billing endpoint must resolve to SEARCH_CREDITS so search credits
    // pay for the special search endpoints.
    expect(featureIdForBillingEndpoint(RESEARCH_BILLING_ENDPOINT)).toBe(
      SEARCH_CREDITS_FEATURE_ID,
    );
    expect(featureIdForBillingEndpoint(RESEARCH_BILLING_ENDPOINT)).not.toBe(
      CREDITS_FEATURE_ID,
    );
  });

  it("charges a flat scrape-like credit for read/inspect endpoints", () => {
    // The flat cost model is independent of any returned results.
    expect(computeResearchCredits(flatEndpoint, {}, reqWithFlags())).toBe(1);
    expect(
      computeResearchCredits(
        flatEndpoint,
        { results: [1, 2, 3, 4, 5] },
        reqWithFlags(),
      ),
    ).toBe(1);
  });

  it("scales per-result endpoints by returned result count", () => {
    const body = { results: new Array(11).fill({}) };
    // ceil(11 / 10) * 2 = 4
    expect(computeResearchCredits(perResultEndpoint, body, reqWithFlags())).toBe(
      4,
    );
    // No results → no charge.
    expect(
      computeResearchCredits(perResultEndpoint, { results: [] }, reqWithFlags()),
    ).toBe(0);
  });

  it("applies the ZDR search-credit rate for forced-zdr teams", () => {
    const body = { results: new Array(11).fill({}) };
    // ceil(11 / 10) * 10 = 20
    expect(
      computeResearchCredits(
        perResultEndpoint,
        body,
        reqWithFlags({ searchZDR: "forced-zdr" }),
      ),
    ).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Route-level coverage: exercise every mounted endpoint through the real
// router and assert each one submits the search-credits billing endpoint.
// ---------------------------------------------------------------------------

describe("research proxy routes bill against search credits", () => {
  let originalProxyUrl: string | undefined;

  const buildApp = () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).auth = { team_id: "team-123" };
      (req as any).acuc = { api_key_id: 42, flags: null };
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

  // Each case returns at least one result so the per-result endpoints incur a
  // charge; the flat read endpoint charges regardless of the body shape.
  const cases: Array<{ name: string; path: string; query: Record<string, string> }> = [
    { name: "papers search", path: "/search/research/papers", query: { query: "rag" } },
    {
      name: "similar papers",
      path: "/search/research/papers/1706.03762/similar",
      query: { intent: "attention" },
    },
    {
      name: "paper read",
      path: "/search/research/papers/1706.03762",
      query: { query: "attention" },
    },
    { name: "github search", path: "/search/research/github", query: { query: "firecrawl" } },
  ];

  it.each(cases)(
    "$name bills the search-credits endpoint",
    async ({ path, query }) => {
      fetchMock.mockResolvedValue(upstreamResponse({ results: [{ id: 1 }] }));

      const res = await request(buildApp()).get(path).query(query);

      expect(res.statusCode).toBe(200);
      expect(billTeamMock).toHaveBeenCalledTimes(1);
      const billing = billTeamMock.mock.calls[0][3];
      expect(billing.endpoint).toBe(RESEARCH_BILLING_ENDPOINT);
      expect(featureIdForBillingEndpoint(billing.endpoint)).toBe(
        SEARCH_CREDITS_FEATURE_ID,
      );
    },
  );
});
