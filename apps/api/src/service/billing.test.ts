import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeSearch: vi.fn(),
  logRequest: vi.fn().mockResolvedValue(undefined),
  logSearch: vi.fn().mockResolvedValue(undefined),
  logResearchEndpoint: vi.fn().mockResolvedValue(undefined),
  trackSearchRequest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../search/execute", () => ({
  executeSearch: (...args: any[]) => mocks.executeSearch(...args),
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
import { CostTracking } from "../lib/cost-tracking";
import { defaultModules, unmeteredBilling } from "./defaults";
import type { BillingModule } from "./modules";
import { replaceService, type CoreParts } from "./service";
import { testService, withService } from "./testing";

const parts: CoreParts = { core: { name: "core" }, logger: { error: vi.fn() } };
const TEAM_ID = "11111111-1111-1111-1111-111111111111";

function makeRes() {
  const headers: Record<string, string> = {};
  const res: any = {
    headers,
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
      return res;
    }),
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

function makeSearchReq(body: Record<string, unknown> = { query: "firecrawl" }) {
  return {
    body,
    headers: {},
    auth: { team_id: TEAM_ID },
    acuc: { api_key_id: 7, flags: {} },
  } as any;
}

function searchResult(overrides: Record<string, unknown> = {}) {
  return {
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
        options: {} as any,
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
    const res = makeRes();

    await withService(testService(defaultModules(), parts), async () => {
      await searchController(makeSearchReq(), res);
    });

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
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
    const res = makeRes();

    await withService(
      testService(defaultModules(), parts, { billing }),
      async () => {
        await searchController(makeSearchReq({ query: "docs", limit: 5 }), res);
      },
    );

    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: { teamId: TEAM_ID },
        operation: "search",
        stage: "reserve",
        requestedUnits: 5,
      }),
    );
    expect(res.headers["Retry-After"]).toBe("60");
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({
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
    const res = makeRes();
    const searchFinished = vi.fn();

    await withService(
      testService(defaultModules(), parts, { billing }, [
        {
          name: "observer",
          hooks: { "search.finished": searchFinished },
        },
      ]),
      async () => {
        await searchController(makeSearchReq({ query: "docs" }), res);
      },
    );

    expect(charge).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "search",
        results: 3,
      }),
    );
    expect(settle).toHaveBeenCalledWith(handle, { ok: true, charged: 8 });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].creditsUsed).toBe(8);
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
    const res = makeRes();

    await withService(
      testService(defaultModules(), parts, { billing }),
      async () => {
        await searchController(makeSearchReq({ query: "docs" }), res);
      },
    );

    expect(charge).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith(handle, { ok: false });
    expect(res.status).toHaveBeenCalledWith(500);
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
    const res = makeRes();

    await withService(
      testService(defaultModules(), parts, { billing }),
      async () => {
        await searchController(makeSearchReq({ query: "docs" }), res);
      },
    );

    expect(settle).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenLastCalledWith(handle, { ok: true, charged: 2 });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].creditsUsed).toBe(2);
  });

  it("keeps the 200 response when settlement fails on every retry attempt", async () => {
    const handle = { token: "res-fail" };
    const authorize = vi.fn().mockResolvedValue({ ok: true as const, handle });
    const charge = vi.fn().mockResolvedValue(2);
    const settle = vi.fn().mockRejectedValue(new Error("redis down"));
    const billing: BillingModule = { authorize, charge, settle };
    const res = makeRes();

    await withService(
      testService(defaultModules(), parts, { billing }),
      async () => {
        await searchController(makeSearchReq({ query: "docs" }), res);
      },
    );

    expect(settle).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].creditsUsed).toBe(2);
  });
});
