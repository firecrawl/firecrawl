import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { RequestWithAuth } from "../../controllers/v2/types";
import type { JsonObject } from "../../lib/json-types";

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
import { replaceService } from "../../service/service";
import type { CoreParts } from "../../service/service";
import { testService, withService } from "../../service/testing";

const parts: CoreParts = { core: { name: "core" }, logger: { error: vi.fn() } };

type MockReq = {
  path: string;
  body: {
    limit?: number;
    url?: string;
    urls?: Array<string>;
    query?: string;
    prompt?: string;
  };
  auth: { team_id: string; org_id: string };
  acuc: JsonObject;
  account?: { remainingCredits: number };
};

function buildReq(overrides: Partial<MockReq> = {}): MockReq {
  return {
    path: "/crawl",
    body: { limit: 100 },
    auth: { team_id: "team_test", org_id: "org_test" },
    acuc: {},
    ...overrides,
  };
}

const limitBodySchema = z.object({ limit: z.number() });

async function runMiddleware(
  reqSpec: MockReq,
  middleware = checkCreditsMiddleware(),
) {
  let nextCalled = false;
  let nextErr: unknown;
  const headers: Record<string, string> = {};
  const statusSpy = vi.fn();
  const jsonSpy = vi.fn();

  const app = express();
  app.use(express.json());
  app.post<Record<string, string>, undefined, undefined>(
    reqSpec.path,
    (req, res, next) => {
      const authReq: RequestWithAuth = Object.assign(req, {
        auth: reqSpec.auth,
      });
      const origSetHeader = res.setHeader.bind(res);
      vi.spyOn(res, "setHeader").mockImplementation((name, value) => {
        headers[name] = String(value);
        return origSetHeader(name, value);
      });
      const origStatus = res.status.bind(res);
      vi.spyOn(res, "status").mockImplementation(code => {
        statusSpy(code);
        return origStatus(code);
      });
      const origJson = res.json.bind(res);
      vi.spyOn(res, "json").mockImplementation(body => {
        jsonSpy(body);
        return origJson(body);
      });
      middleware(authReq, res, err => {
        nextCalled = true;
        nextErr = err;
        reqSpec.account = authReq.account;
        const parsedBody = limitBodySchema.safeParse(authReq.body);
        if (parsedBody.success) {
          reqSpec.body.limit = parsedBody.data.limit;
        }
        if (err) {
          next(err);
          return;
        }
        res.statusCode = 204;
        res.end();
      });
    },
  );

  await request(app).post(reqSpec.path).send(reqSpec.body);

  return {
    res: { headers, status: statusSpy, json: jsonSpy },
    nextErr,
    nextCalled,
  };
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
