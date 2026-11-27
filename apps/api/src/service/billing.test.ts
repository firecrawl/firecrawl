import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { executeSearch } from "../search/execute";

type ExecuteSearchResult = Awaited<ReturnType<typeof executeSearch>>;

const mocks = vi.hoisted(() => ({
  executeSearch: vi.fn<typeof executeSearch>(),
  logRequest: vi.fn().mockResolvedValue(undefined),
  logSearch: vi.fn().mockResolvedValue(undefined),
  logResearchEndpoint: vi.fn().mockResolvedValue(undefined),
  trackSearchRequest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../search/execute", () => ({
  executeSearch: (...args: Parameters<typeof executeSearch>) =>
    mocks.executeSearch(...args),
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { searchController } from "../controllers/v2/search";
import { scrapeOptions } from "../controllers/v2/types";
import { CostTracking } from "../lib/cost-tracking";
import { defaultModules, unmeteredBilling } from "./defaults";
import type { BillingModule } from "./modules";
import { replaceService } from "./service";
import type { CoreParts } from "./service";
import { testService, withService } from "./testing";

const parts: CoreParts = { core: { name: "core" }, logger: { error: vi.fn() } };
const TEAM_ID = "11111111-1111-1111-1111-111111111111";

async function postSearch(
  body: { query: string; limit?: number } = { query: "firecrawl" },
) {
  const app = express();
  app.use(express.json());
  app.post("/search", async (req, res) => {
    const authedReq = Object.assign(req, {
      auth: { team_id: TEAM_ID },
      acuc: {
        api_key: "test-key",
        api_key_id: 7,
        team_id: TEAM_ID,
        org_id: "test-org",
        flags: {},
        concurrency_limit: 10,
        rate_limit_multiplier: 1,
        is_paid_plan: false,
      },
    });
    await searchController(authedReq, res);
  });
  return request(app).post("/search").send(body);
}

function searchResult(
  overrides: Partial<ExecuteSearchResult> = {},
): ExecuteSearchResult {
  return {
    toolFusion: false,
    response: {
      web: [
        {
          url: "https://example.com",
          title: "Example",
          description: "Example page",
        },
      ],
    },
    totalResultsCount: 1,
    billableResultsCount: 1,
    resultCountsBySource: { web: 1, images: 0, news: 0 },
    resultCategories: {},
    indexResultsCount: 0,
    threatDecisions: [],
    scrapedDocuments: [],
    searchTypes: ["web"],
    scrapeFormats: [],
    shouldScrape: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeSearch.mockResolvedValue(searchResult());
});

afterEach(() => {
  replaceService(undefined);
});

describe("unmeteredBilling", () => {
  it("authorizes every operation without caps or handles and returns undefined for all charge events", async () => {
    const billing = unmeteredBilling();
    const ctx = { teamId: TEAM_ID, zeroDataRetention: false };

    for (const operation of [
      "scrape",
      "parse",
      "search",
      "map",
      "crawl",
      "batchScrape",
      "other",
    ] as const) {
      await expect(
        billing.authorize({
          caller: { teamId: TEAM_ID },
          operation,
          requestedUnits: 50,
        }),
      ).resolves.toEqual({ ok: true });
    }

    await expect(
      billing.charge({
        kind: "scrape",
        ctx,
        jobId: "job-1",
        options: scrapeOptions.parse({}),
        document: null,
        costTracking: new CostTracking(),
        state: {},
      }),
    ).resolves.toBeUndefined();

    await expect(
      billing.charge({
        kind: "search",
        ctx,
        requestId: "req-1",
        results: 10,
        documents: [],
      }),
    ).resolves.toBeUndefined();

    await expect(
      billing.charge({
        kind: "map",
        ctx,
        requestId: "map-1",
        urls: 25,
      }),
    ).resolves.toBeUndefined();

    await expect(
      billing.charge({
        kind: "crawl",
        ctx,
        requestId: "crawl-1",
        urls: 3,
      }),
    ).resolves.toBeUndefined();

    expect(billing.settle).toBeUndefined();
  });

  it("leaves creditsUsed unset on v2 search responses", async () => {
    const res = await withService(testService(defaultModules(), parts), () =>
      postSearch(),
    );

    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.success).toBe(true);
    expect("creditsUsed" in body).toBe(false);
    expect(body.creditsUsed).toBeUndefined();
  });
});

describe("custom BillingModule in v2 searchController", () => {
  it("returns the custom refusal status, headers, and body when reservation fails", async () => {
    const authorize = vi.fn().mockResolvedValue({
      ok: false as const,
      refusal: {
        status: 429,
        headers: { "Retry-After": "60" },
        body: {
          success: false as const,
          code: "RATE_LIMIT",
          error: "Daily allowance exhausted.",
        },
      },
    });
    const charge = vi.fn();
    const settle = vi.fn();
    const billing: BillingModule = { authorize, charge, settle };

    const res = await withService(
      testService(defaultModules(), parts, { billing }),
      () => postSearch({ query: "docs", limit: 5 }),
    );

    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: { teamId: TEAM_ID },
        operation: "search",
        stage: "reserve",
        requestedUnits: 5,
      }),
    );
    expect(res.headers["retry-after"]).toBe("60");
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      success: false,
      code: "RATE_LIMIT",
      error: "Daily allowance exhausted.",
      jobId: expect.any(String),
    });
    expect(mocks.executeSearch).not.toHaveBeenCalled();
    expect(charge).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("charges search results, sums scraped document credits, and settles the reservation handle on success", async () => {
    const handle = { token: "res-1" };
    const authorize = vi.fn().mockResolvedValue({ ok: true as const, handle });
    const charge = vi.fn().mockResolvedValue(2);
    const settle = vi.fn().mockResolvedValue(undefined);
    const billing: BillingModule = { authorize, charge, settle };
    mocks.executeSearch.mockResolvedValue(
      searchResult({
        billableResultsCount: 3,
        scrapedDocuments: [
          { metadata: { statusCode: 200, proxyUsed: "basic", creditsUsed: 1 } },
          { metadata: { statusCode: 200, proxyUsed: "basic", creditsUsed: 5 } },
        ],
      }),
    );
    const searchFinished = vi.fn();

    const res = await withService(
      testService(defaultModules(), parts, { billing }, [
        {
          name: "observer",
          hooks: { "search.finished": searchFinished },
        },
      ]),
      () => postSearch({ query: "docs" }),
    );

    expect(charge).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "search",
        results: 3,
      }),
    );
    expect(settle).toHaveBeenCalledWith(handle, { ok: true, charged: 8 });
    expect(res.status).toBe(200);
    expect(res.body.creditsUsed).toBe(8);
    expect(searchFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        charged: 2,
        scrapeCredits: 6,
        totalCredits: 8,
      }),
    );
  });

  it("settles the reservation handle with ok: false when search execution fails", async () => {
    const handle = { token: "res-err" };
    const authorize = vi.fn().mockResolvedValue({ ok: true as const, handle });
    const charge = vi.fn();
    const settle = vi.fn().mockResolvedValue(undefined);
    const billing: BillingModule = { authorize, charge, settle };
    mocks.executeSearch.mockRejectedValue(new Error("upstream failure"));

    const res = await withService(
      testService(defaultModules(), parts, { billing }),
      () => postSearch({ query: "docs" }),
    );

    expect(charge).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith(handle, { ok: false });
    expect(res.status).toBe(500);
  });

  it("retries transient settlement failures and keeps the 200 response when settlement succeeds on retry", async () => {
    const handle = { token: "res-flaky" };
    const authorize = vi.fn().mockResolvedValue({ ok: true as const, handle });
    const charge = vi.fn().mockResolvedValue(2);
    const settle = vi
      .fn()
      .mockRejectedValueOnce(new Error("redis timeout"))
      .mockResolvedValueOnce(undefined);
    const billing: BillingModule = { authorize, charge, settle };

    const res = await withService(
      testService(defaultModules(), parts, { billing }),
      () => postSearch({ query: "docs" }),
    );

    expect(settle).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenLastCalledWith(handle, { ok: true, charged: 2 });
    expect(res.status).toBe(200);
    expect(res.body.creditsUsed).toBe(2);
  });

  it("keeps the 200 response when settlement fails on every retry attempt", async () => {
    const handle = { token: "res-fail" };
    const authorize = vi.fn().mockResolvedValue({ ok: true as const, handle });
    const charge = vi.fn().mockResolvedValue(2);
    const settle = vi.fn().mockRejectedValue(new Error("redis down"));
    const billing: BillingModule = { authorize, charge, settle };

    const res = await withService(
      testService(defaultModules(), parts, { billing }),
      () => postSearch({ query: "docs" }),
    );

    expect(settle).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(res.body.creditsUsed).toBe(2);
  });
});
