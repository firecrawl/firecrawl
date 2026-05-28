import type { NextFunction } from "express";

jest.mock("../../services/autumn/autumn.service", () => ({
  autumnService: {
    checkCredits: jest.fn(),
  },
}));

jest.mock("../../services/supabase", () => ({
  supabase_service: { rpc: jest.fn() },
}));

jest.mock("../../lib/http-metrics", () => ({
  httpRequestDurationSeconds: { observe: jest.fn() },
  getRoutePattern: jest.fn(() => "/v1/crawl"),
}));

jest.mock("../../controllers/auth", () => ({
  authenticateUser: jest.fn(),
}));

jest.mock("../../services/idempotency/create", () => ({
  createIdempotencyKey: jest.fn(),
}));

jest.mock("../../services/idempotency/validate", () => ({
  validateIdempotencyKey: jest.fn(),
}));

jest.mock("uuid", () => ({ validate: jest.fn(() => true) }));

jest.mock("geoip-country", () => ({ lookup: jest.fn(() => null) }), {
  virtual: true,
});

import { checkCreditsMiddleware } from "../../routes/shared";
import { autumnService } from "../../services/autumn/autumn.service";

const checkCreditsMock = autumnService.checkCredits as jest.MockedFunction<
  typeof autumnService.checkCredits
>;

function buildReq(overrides: any = {}): any {
  return {
    path: "/v1/crawl",
    body: { limit: 100 },
    auth: { team_id: "team_test", org_id: "org_test" },
    acuc: { adjusted_credits_used: 0 },
    ...overrides,
  };
}

function runMiddleware(req: any): Promise<{ res: any; nextErr?: any }> {
  return new Promise(resolve => {
    let settled = false;
    const settle = (payload: { res: any; nextErr?: any }) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    const res: any = {
      status: jest.fn((..._args: any[]) => {
        // 402 / 403 paths terminate via res.status(...).json(...) without next()
        setImmediate(() => settle({ res }));
        return res;
      }),
      json: jest.fn().mockReturnThis(),
      headersSent: false,
    };

    const next: NextFunction = (err?: any) => settle({ res, nextErr: err });
    checkCreditsMiddleware()(req, res, next);
  });
}

describe("checkCreditsMiddleware – Autumn overage handling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not clamp the crawl limit when Autumn allows overage with 0 remaining", async () => {
    checkCreditsMock.mockResolvedValue({ allowed: true, remaining: 0 });

    const req = buildReq();
    const { res } = await runMiddleware(req);

    expect(res.status).not.toHaveBeenCalled();
    expect(req.account.remainingCredits).toBe(Infinity);
    // request body limit must NOT have been clamped down to 0
    expect(req.body.limit).toBe(100);
  });

  it("blocks with 402 when Autumn denies and no remaining credits", async () => {
    checkCreditsMock.mockResolvedValue({ allowed: false, remaining: 0 });

    const req = buildReq();
    const { res } = await runMiddleware(req);

    expect(res.status).toHaveBeenCalledWith(402);
  });

  it("adjusts crawl limit down when Autumn denies but some credits remain", async () => {
    checkCreditsMock.mockResolvedValue({ allowed: false, remaining: 5 });

    const req = buildReq({ body: { limit: 100 } });
    const { res } = await runMiddleware(req);

    expect(res.status).not.toHaveBeenCalled();
    expect(req.body.limit).toBe(5);
  });
});
