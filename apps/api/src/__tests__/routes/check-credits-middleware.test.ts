import type { MockedFunction } from "vitest";
import type { NextFunction } from "express";

vi.mock("../../services/autumn/autumn.service", () => ({
  autumnService: {
    checkCredits: vi.fn(),
  },
  CREDITS_FEATURE_ID: "CREDITS",
}));

vi.mock("../../services/autumn/usage", () => ({
  getTeamBalance: vi.fn(),
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
import { getTeamBalance } from "../../services/autumn/usage";

const checkCreditsMock = autumnService.checkCredits as MockedFunction<
  typeof autumnService.checkCredits
>;
const getTeamBalanceMock = getTeamBalance as MockedFunction<
  typeof getTeamBalance
>;

function buildReq(overrides: any = {}): any {
  return {
    path: "/v1/crawl",
    body: { limit: 100 },
    auth: { team_id: "team_test", org_id: "org_test" },
    acuc: {},
    ...overrides,
  };
}

function runMiddleware(
  req: any,
): Promise<{ res: any; nextErr?: any; nextCalled: boolean }> {
  return new Promise(resolve => {
    let settled = false;
    let nextCalled = false;
    const settle = (payload: { res: any; nextErr?: any }) => {
      if (settled) return;
      settled = true;
      resolve({ ...payload, nextCalled });
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

    const next: NextFunction = (err?: any) => {
      nextCalled = true;
      settle({ res, nextErr: err });
    };
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
    checkCreditsMock
      .mockResolvedValueOnce({ allowed: false, remaining: 5 })
      .mockResolvedValueOnce({ allowed: true, remaining: 5 });

    const req = buildReq({ body: { limit: 100 } });
    const { res } = await runMiddleware(req);

    expect(res.status).not.toHaveBeenCalled();
    expect(req.body.limit).toBe(5);
    expect(checkCreditsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        value: 5,
        properties: expect.objectContaining({
          source: "checkCreditsMiddleware:clamp",
          apiKeyId: null,
        }),
      }),
    );
  });

  it("blocks with 402 when a per-key spend limit denies but the team balance is healthy", async () => {
    // A per-API-key spend limit does not lower the team balance, so both the
    // initial check and the clamped re-check deny with credits still remaining.
    checkCreditsMock.mockResolvedValue({ allowed: false, remaining: 5000 });

    const req = buildReq({ body: { limit: 100 } });
    const { res, nextCalled } = await runMiddleware(req);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(nextCalled).toBe(false);
    // A request that ends in a 402 keeps the caller's original limit.
    expect(req.body.limit).toBe(100);
  });

  it("clamps the crawl limit down only, never up to the remaining balance", async () => {
    checkCreditsMock
      .mockResolvedValueOnce({ allowed: false, remaining: 5000 })
      .mockResolvedValueOnce({ allowed: true, remaining: 5000 });

    const req = buildReq({ body: { limit: 5 } });
    const { res } = await runMiddleware(req);

    expect(res.status).not.toHaveBeenCalled();
    expect(req.body.limit).toBe(5);
  });

  it("fails open when the clamped re-check finds Autumn unavailable", async () => {
    checkCreditsMock
      .mockResolvedValueOnce({ allowed: false, remaining: 5 })
      .mockResolvedValueOnce(null);

    const req = buildReq({ body: { limit: 100 } });
    const { res, nextCalled } = await runMiddleware(req);

    expect(res.status).not.toHaveBeenCalled();
    expect(nextCalled).toBe(true);
    expect(req.body.limit).toBe(5);
  });

  it("forwards the API key id in the check properties so Autumn can enforce per-key limits", async () => {
    checkCreditsMock.mockResolvedValue({ allowed: true, remaining: 100 });

    const req = buildReq({
      acuc: { api_key_id: 4242 },
    });
    await runMiddleware(req);

    expect(checkCreditsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({ apiKeyId: 4242 }),
      }),
    );
  });

  it("sends a null apiKeyId when the request has no resolved api key id", async () => {
    checkCreditsMock.mockResolvedValue({ allowed: true, remaining: 100 });

    const req = buildReq();
    await runMiddleware(req);

    expect(checkCreditsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({ apiKeyId: null }),
      }),
    );
  });
});

describe("checkCreditsMiddleware – unverified agent-key 50-credit cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function buildUnverifiedReq(overrides: any = {}) {
    return buildReq({
      acuc: {
        _agentSponsor: {
          status: "pending",
          verification_deadline: new Date(
            Date.now() + 86_400_000,
          ).toISOString(),
        },
      },
      ...overrides,
    });
  }

  it("blocks with 402 when Autumn usage has reached the 50-credit cap", async () => {
    getTeamBalanceMock.mockResolvedValue({ usage: 50 } as any);

    const req = buildUnverifiedReq();
    const { res } = await runMiddleware(req);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "unverified_credit_limit_reached",
        credits_used: 50,
      }),
    );
    // The main Autumn credit check must not run once the cap is hit.
    expect(checkCreditsMock).not.toHaveBeenCalled();
  });

  it("allows the request when Autumn usage is under the cap", async () => {
    getTeamBalanceMock.mockResolvedValue({ usage: 10 } as any);
    checkCreditsMock.mockResolvedValue({ allowed: true, remaining: 100 });

    const req = buildUnverifiedReq();
    const { res, nextErr } = await runMiddleware(req);

    expect(res.status).not.toHaveBeenCalled();
    expect(nextErr).toBeUndefined();
    expect(req.agentIndexOnly).toBe(true);
  });

  it("fails open (does not block) when the Autumn balance lookup throws", async () => {
    getTeamBalanceMock.mockRejectedValue(new Error("autumn down"));
    checkCreditsMock.mockResolvedValue({ allowed: true, remaining: 100 });

    const req = buildUnverifiedReq();
    const { res } = await runMiddleware(req);

    expect(res.status).not.toHaveBeenCalled();
  });
});
