import type { MockedFunction } from "vitest";
import type { NextFunction } from "express";

vi.mock("../../services/autumn/autumn.service", () => ({
  autumnService: {
    checkCredits: vi.fn(),
  },
  CREDITS_FEATURE_ID: "CREDITS",
}));

vi.mock("../../lib/http-metrics", () => ({
  httpRequestDurationSeconds: { observe: vi.fn() },
  getRoutePattern: vi.fn(() => "/v1/crawl"),
}));

vi.mock("../../controllers/auth", () => ({
  authenticateUser: vi.fn(),
}));

vi.mock("../../services/idempotency/create", () => ({
  createIdempotencyKey: vi.fn(),
}));

vi.mock("../../services/idempotency/validate", () => ({
  validateIdempotencyKey: vi.fn(),
}));

vi.mock("geoip-country", () => ({ lookup: vi.fn(() => null) }));

import { checkCreditsMiddleware } from "../../routes/shared";
import { autumnService } from "../../services/autumn/autumn.service";

const checkCreditsMock = autumnService.checkCredits as MockedFunction<
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
      status: vi.fn((..._args: any[]) => {
        // 402 / 403 paths terminate via res.status(...).json(...) without next()
        setImmediate(() => settle({ res }));
        return res;
      }),
      json: vi.fn().mockReturnThis(),
      headersSent: false,
    };

    const next: NextFunction = (err?: any) => settle({ res, nextErr: err });
    checkCreditsMiddleware()(req, res, next);
  });
}

describe("checkCreditsMiddleware – Autumn overage handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
