import type { NextFunction } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../../lib/http-metrics", () => ({
  httpRequestDurationSeconds: { observe: vi.fn() },
  getRoutePattern: vi.fn(() => "/v2/crawl"),
}));

vi.mock("geoip-country", () => ({ lookup: vi.fn(() => null) }));

import { checkCreditsMiddleware } from "../../routes/shared";
import { defaultModules } from "../../service/defaults";
import type { BillingModule } from "../../service/modules";
import { replaceService, type CoreParts } from "../../service/service";
import { testService, withService } from "../../service/testing";

const parts: CoreParts = { core: { name: "core" }, logger: { error: vi.fn() } };

function buildReq(overrides: Record<string, unknown> = {}): any {
  return {
    path: "/crawl",
    body: { limit: 100 },
    auth: { team_id: "team_test", org_id: "org_test" },
    acuc: {},
    ...overrides,
  };
}

function runMiddleware(
  req: any,
  middleware = checkCreditsMiddleware(),
): Promise<{ res: any; nextErr?: unknown; nextCalled: boolean }> {
  return new Promise(resolve => {
    let settled = false;
    let nextCalled = false;
    const settle = (payload: { res: any; nextErr?: unknown }) => {
      if (settled) return;
      settled = true;
      resolve({ ...payload, nextCalled });
    };

    const headers: Record<string, string> = {};
    const res: any = {
      locals: {},
      headers,
      setHeader: vi.fn((name: string, value: string) => {
        headers[name] = value;
        return res;
      }),
      status: vi.fn((..._args: unknown[]) => {
        setImmediate(() => settle({ res }));
        return res;
      }),
      json: vi.fn().mockReturnThis(),
      headersSent: false,
    };

    const next: NextFunction = (err?: unknown) => {
      nextCalled = true;
      settle({ res, nextErr: err });
    };
    middleware(req, res, next);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  replaceService(undefined);
});

describe("checkCreditsMiddleware", () => {
  it("allows requests with unlimited remainingCredits under unmeteredBilling", async () => {
    const req = buildReq({ path: "/crawl", body: { limit: 100 } });

    const { res, nextCalled } = await withService(
      testService(defaultModules(), parts),
      () => runMiddleware(req),
    );

    expect(nextCalled).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.account).toEqual({ remainingCredits: Infinity });
    expect(req.body.limit).toBe(100);
  });

  it("derives operation and requestedUnits from path, explicit minimum, and body", async () => {
    const authorize = vi.fn().mockResolvedValue({ ok: true as const });
    const billing: BillingModule = {
      authorize,
      charge: vi.fn().mockResolvedValue(undefined),
    };

    await withService(
      testService(defaultModules(), parts, { billing }),
      async () => {
        await runMiddleware(
          buildReq({ path: "/scrape", body: { url: "https://example.com" } }),
          checkCreditsMiddleware(1, undefined, { mcpCredits: true }),
        );
        await runMiddleware(
          buildReq({ path: "/batch/scrape", body: { urls: ["a", "b", "c"] } }),
          checkCreditsMiddleware(),
        );
        await runMiddleware(
          buildReq({ path: "/search", body: { query: "test", limit: 15 } }),
          checkCreditsMiddleware(undefined, "search_credits", {
            mcpCredits: true,
          }),
        );
      },
    );

    expect(authorize).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        caller: { teamId: "team_test" },
        operation: "scrape",
        stage: "preflight",
        requestedUnits: 1,
      }),
    );
    expect(authorize).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        operation: "batchScrape",
        stage: "preflight",
        requestedUnits: 3,
      }),
    );
    expect(authorize).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        operation: "search",
        stage: "preflight",
        requestedUnits: 15,
      }),
    );
  });

  it("applies maxUnits to req.account and writes back clampedLimit to req.body.limit", async () => {
    const billing: BillingModule = {
      authorize: vi.fn().mockResolvedValue({
        ok: true as const,
        maxUnits: 25,
        clampedLimit: 25,
      }),
      charge: vi.fn().mockResolvedValue(undefined),
    };
    const req = buildReq({ path: "/crawl", body: { limit: 100 } });

    const { nextCalled } = await withService(
      testService(defaultModules(), parts, { billing }),
      () => runMiddleware(req),
    );

    expect(nextCalled).toBe(true);
    expect(req.account).toEqual({ remainingCredits: 25 });
    expect(req.body.limit).toBe(25);
  });

  it("runs billing.authorize preflight on /agent routes", async () => {
    const authorize = vi.fn().mockResolvedValue({ ok: true as const });
    const billing: BillingModule = {
      authorize,
      charge: vi.fn().mockResolvedValue(undefined),
    };
    const req = buildReq({ path: "/agent", body: { prompt: "find pricing" } });

    const { nextCalled } = await withService(
      testService(defaultModules(), parts, { billing }),
      () => runMiddleware(req),
    );

    expect(nextCalled).toBe(true);
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "other",
        stage: "preflight",
      }),
    );
  });

  it("returns the billing module refusal status, headers, and body without calling next", async () => {
    const billing: BillingModule = {
      authorize: vi.fn().mockResolvedValue({
        ok: false as const,
        refusal: {
          status: 402,
          headers: { "X-Billing-Reason": "quota" },
          body: {
            success: false as const,
            code: "insufficient_credits",
            error: "Insufficient credits.",
            remaining_credits: 0,
          },
        },
      }),
      charge: vi.fn().mockResolvedValue(undefined),
    };
    const req = buildReq({ path: "/crawl", body: { limit: 100 } });

    const { res, nextCalled } = await withService(
      testService(defaultModules(), parts, { billing }),
      () => runMiddleware(req),
    );

    expect(nextCalled).toBe(false);
    expect(res.headers["X-Billing-Reason"]).toBe("quota");
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      code: "insufficient_credits",
      error: "Insufficient credits.",
      remaining_credits: 0,
    });
  });
});
