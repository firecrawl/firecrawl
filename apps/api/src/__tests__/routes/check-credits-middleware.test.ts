import type { MockedFunction } from "vitest";
import type { NextFunction } from "express";
import { logger } from "../../lib/logger";

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../../services/autumn/autumn.service", () => ({
  autumnService: {
    checkCredits: vi.fn(),
    hostedMcpFeatureId: async () => "MCP_CREDITS",
  },
  CREDITS_FEATURE_ID: "CREDITS",
}));

vi.mock("../../services/autumn/usage", () => ({
  getTeamBalance: vi.fn(),
}));

vi.mock("../../lib/api-key-spend-limit", () => ({
  getApiKeySpendLimit: vi.fn(),
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
import { getApiKeySpendLimit } from "../../lib/api-key-spend-limit";

const checkCreditsMock = autumnService.checkCredits as MockedFunction<
  typeof autumnService.checkCredits
>;
const getTeamBalanceMock = getTeamBalance as MockedFunction<
  typeof getTeamBalance
>;
const getApiKeySpendLimitMock = getApiKeySpendLimit as MockedFunction<
  typeof getApiKeySpendLimit
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
  middleware = checkCreditsMiddleware(),
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
      locals: {},
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
    middleware(req, res, next);
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
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.not.objectContaining({ request: expect.anything() }),
    );
  });

  it("tells a Gateway account to contact its platform on a 402", async () => {
    checkCreditsMock.mockResolvedValue({
      allowed: false,
      remaining: 0,
      gatewayProvisioned: true,
    });

    const { res } = await runMiddleware(buildReq());

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: "platform_managed_credits",
        error: expect.stringContaining("contact that platform"),
      }),
    );
  });

  it("keeps the generic 402 for an account that is not a Gateway account", async () => {
    checkCreditsMock.mockResolvedValue({ allowed: false, remaining: 0 });

    const { res } = await runMiddleware(buildReq());

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "insufficient_credits",
        error: expect.not.stringContaining("contact that platform"),
      }),
    );
  });

  it("adjusts crawl limit down when Autumn denies but some credits remain", async () => {
    checkCreditsMock
      .mockResolvedValueOnce({ allowed: false, remaining: 5 })
      .mockResolvedValueOnce({ allowed: true, remaining: 5 });

    const req = buildReq({ body: { limit: 100 } });
    const { res } = await runMiddleware(req);

    expect(res.status).not.toHaveBeenCalled();
    expect(req.body.limit).toBe(5);
    expect(logger.warn).toHaveBeenCalledWith(
      "Adjusting limit to remaining credits",
      expect.not.objectContaining({ request: expect.anything() }),
    );
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

  it("hands the ACUC's org to both checks, so neither reads teams.org_id", async () => {
    checkCreditsMock
      .mockResolvedValueOnce({ allowed: false, remaining: 5 })
      .mockResolvedValueOnce({ allowed: true, remaining: 5 });

    const req = buildReq({ body: { limit: 100 } });
    await runMiddleware(req);

    expect(checkCreditsMock).toHaveBeenCalledTimes(2);
    for (const [params] of checkCreditsMock.mock.calls) {
      expect(params).toEqual(
        expect.objectContaining({ orgId: "org_test", teamId: "team_test" }),
      );
    }
  });

  // Keyless and preview identities carry no org, and neither does the DB-auth
  // bypass. checkCredits answered null for all of them, so the middleware takes
  // that fail-open answer itself rather than asking with an org it hasn't got.
  it.each([null, undefined])(
    "fails open without asking Autumn when org_id is %s",
    async orgId => {
      const req = buildReq({
        auth: { team_id: "preview_1.2.3.4", org_id: orgId },
      });
      const { res, nextCalled } = await runMiddleware(req);

      expect(checkCreditsMock).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(nextCalled).toBe(true);
      expect(req.account.remainingCredits).toBe(Infinity);
      expect(req.body.limit).toBe(100);
    },
  );

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

describe("checkCreditsMiddleware – /agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("leaves the credit decision to the agent controller", async () => {
    const req = buildReq({ path: "/agent", body: { prompt: "x" } });
    const { res, nextCalled } = await runMiddleware(req);

    expect(nextCalled).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
    expect(checkCreditsMock).not.toHaveBeenCalled();
  });
});

describe("checkCreditsMiddleware – agent-key denials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function buildSponsoredReq(status: "blocked" | "pending") {
    return buildReq({
      acuc: {
        team_id: "team_test",
        api_key_id: 42,
        _agentSponsor: {
          status,
          verification_deadline: new Date(Date.now() - 1000).toISOString(),
          email: "owner@example.com",
        },
      },
    });
  }

  it.each([
    ["blocked", "agent_key_blocked"],
    ["pending", "agent_key_verification_expired"],
  ] as const)(
    "logs a %s agent key as auth/denied before the 403",
    async (status, reason) => {
      const { res } = await runMiddleware(buildSponsoredReq(status));

      expect(res.status).toHaveBeenCalledWith(403);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith("Request denied", {
        canonicalLog: "auth/denied",
        reason,
        status: 403,
        method: undefined,
        route: "/v1/crawl",
        teamId: "team_test",
        apiKeyId: 42,
      });
      expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
        "owner@example.com",
      );
      expect(checkCreditsMock).not.toHaveBeenCalled();
    },
  );
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

describe("checkCreditsMiddleware – MCP credits", () => {
  const hostedMcpAuth = {
    team_id: "team_test",
    org_id: "org_test",
    hostedMcp: true,
  };

  const spendsMcpCredits = checkCreditsMiddleware(undefined, undefined, {
    mcpCredits: true,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gates a hosted MCP call on MCP credits, the balance it is billed to", async () => {
    checkCreditsMock.mockResolvedValue({ allowed: true, remaining: 100 });

    const req = buildReq({
      path: "/v2/scrape",
      body: {},
      auth: hostedMcpAuth,
      acuc: { api_key_id: 7 },
    });
    const { res, nextCalled } = await runMiddleware(req, spendsMcpCredits);

    expect(res.status).not.toHaveBeenCalled();
    expect(nextCalled).toBe(true);
    expect(checkCreditsMock).toHaveBeenCalledExactlyOnceWith({
      teamId: "team_test",
      orgId: "org_test",
      value: 1,
      properties: {
        source: "checkCreditsMiddleware",
        path: "/v2/scrape",
        apiKeyId: 7,
      },
      featureId: "MCP_CREDITS",
    });
  });

  it("refuses a hosted MCP call MCP credits and what they fall back to can't cover", async () => {
    checkCreditsMock.mockResolvedValue({ allowed: false, remaining: 0 });

    const req = buildReq({ auth: hostedMcpAuth });
    const { res, nextCalled } = await runMiddleware(req, spendsMcpCredits);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(nextCalled).toBe(false);
  });

  it("clamps the crawl limit against MCP credits when the team's credits can't cover it either", async () => {
    checkCreditsMock
      .mockResolvedValueOnce({ allowed: false, remaining: 5 })
      .mockResolvedValueOnce({ allowed: false, remaining: 0 })
      .mockResolvedValueOnce({ allowed: true, remaining: 5 });

    const req = buildReq({ auth: hostedMcpAuth, body: { limit: 100 } });
    const { res } = await runMiddleware(req, spendsMcpCredits);

    expect(res.status).not.toHaveBeenCalled();
    expect(req.body.limit).toBe(5);
    expect(req.auth.hostedMcp).toBe(true);
    expect(
      checkCreditsMock.mock.calls.map(([check]) => check.featureId),
    ).toEqual(["MCP_CREDITS", "CREDITS", "MCP_CREDITS"]);
  });

  it("clamps the crawl limit against the team's credits when they cover more", async () => {
    checkCreditsMock
      .mockResolvedValueOnce({ allowed: false, remaining: 5 })
      .mockResolvedValueOnce({ allowed: false, remaining: 40 })
      .mockResolvedValueOnce({ allowed: true, remaining: 40 });

    const req = buildReq({
      auth: { ...hostedMcpAuth },
      body: { limit: 100 },
    });
    const { res } = await runMiddleware(req, spendsMcpCredits);

    expect(res.status).not.toHaveBeenCalled();
    expect(req.body.limit).toBe(40);
    expect(req.auth.hostedMcp).toBe(false);
    expect(
      checkCreditsMock.mock.calls.map(([check]) => check.featureId),
    ).toEqual(["MCP_CREDITS", "CREDITS", "CREDITS"]);
  });

  it("falls back to the MCP clamp when the team clamp is refused", async () => {
    checkCreditsMock
      .mockResolvedValueOnce({ allowed: false, remaining: 5 })
      .mockResolvedValueOnce({ allowed: false, remaining: 40 })
      .mockResolvedValueOnce({ allowed: false, remaining: 40 })
      .mockResolvedValueOnce({ allowed: true, remaining: 5 });

    const req = buildReq({
      auth: { ...hostedMcpAuth },
      body: { limit: 100 },
    });
    const { res } = await runMiddleware(req, spendsMcpCredits);

    expect(res.status).not.toHaveBeenCalled();
    expect(req.body.limit).toBe(5);
    expect(req.auth.hostedMcp).toBe(true);
    expect(
      checkCreditsMock.mock.calls.map(([check]) => check.featureId),
    ).toEqual(["MCP_CREDITS", "CREDITS", "CREDITS", "MCP_CREDITS"]);
    expect(checkCreditsMock.mock.calls[2][0].value).toBe(40);
    expect(checkCreditsMock.mock.calls[3][0].value).toBe(5);
  });

  it("keeps the MCP refusal when the team-credit check can't be answered", async () => {
    checkCreditsMock
      .mockResolvedValueOnce({ allowed: false, remaining: 0 })
      .mockResolvedValueOnce(null);

    const req = buildReq({ auth: { ...hostedMcpAuth } });
    const { res, nextCalled } = await runMiddleware(req, spendsMcpCredits);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(nextCalled).toBe(false);
    expect(
      checkCreditsMock.mock.calls.map(([check]) => check.featureId),
    ).toEqual(["MCP_CREDITS", "CREDITS"]);
  });

  it("bills a hosted MCP call on the team's own credits when MCP credits can't cover it", async () => {
    checkCreditsMock
      .mockResolvedValueOnce({ allowed: false, remaining: 0 })
      .mockResolvedValueOnce({ allowed: true, remaining: 200000 });

    const req = buildReq({
      path: "/v2/scrape",
      body: {},
      auth: { ...hostedMcpAuth },
      acuc: { api_key_id: 7 },
    });
    const { res, nextCalled } = await runMiddleware(req, spendsMcpCredits);

    expect(res.status).not.toHaveBeenCalled();
    expect(nextCalled).toBe(true);
    expect(req.auth.hostedMcp).toBe(false);
    expect(checkCreditsMock.mock.calls[1][0]).toMatchObject({
      teamId: "team_test",
      value: 1,
      featureId: "CREDITS",
    });
  });

  it("gates a call the hosted MCP did not make on the route's own feature", async () => {
    checkCreditsMock.mockResolvedValue({ allowed: true, remaining: 100 });

    const req = buildReq({ body: { limit: 100, origin: "mcp-fastmcp" } });
    const { res, nextCalled } = await runMiddleware(req, spendsMcpCredits);

    expect(res.status).not.toHaveBeenCalled();
    expect(nextCalled).toBe(true);

    expect(checkCreditsMock).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: "CREDITS" }),
    );
  });

  it("gates a hosted MCP call on the route's own feature where billing doesn't use MCP credits", async () => {
    checkCreditsMock.mockResolvedValue({ allowed: true, remaining: 100 });

    const req = buildReq({ path: "/v2/extract", auth: hostedMcpAuth });
    const { res, nextCalled } = await runMiddleware(req);

    expect(res.status).not.toHaveBeenCalled();
    expect(nextCalled).toBe(true);

    expect(checkCreditsMock).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: "CREDITS" }),
    );
  });
});

describe("checkCreditsMiddleware – 402 names the limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function body(res: any) {
    return res.json.mock.calls[0][0];
  }

  it("names a per-key spend limit when the team balance covers the request", async () => {
    checkCreditsMock.mockResolvedValue({ allowed: false, remaining: 2500 });
    getApiKeySpendLimitMock.mockResolvedValue({
      credits: 2000,
      interval: "month",
    });

    const req = buildReq({
      path: "/v2/scrape",
      body: {},
      acuc: { api_key_id: 42 },
    });
    const { res } = await runMiddleware(req);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(getApiKeySpendLimitMock).toHaveBeenCalledWith(42);
    expect(body(res)).toMatchObject({
      success: false,
      code: "api_key_spend_limit",
      requested_credits: 1,
      remaining_credits: 2500,
      limit: { type: "api_key", credits: 2000, interval: "month" },
    });
    expect(body(res).error).toContain("spend limit of 2000 credits per month");
  });

  it("says when a request asks for more than the key's whole limit", async () => {
    checkCreditsMock.mockResolvedValue({ allowed: false, remaining: 600 });
    getApiKeySpendLimitMock.mockResolvedValue({ credits: 9, interval: "day" });

    const req = buildReq({
      path: "/v2/search",
      body: { limit: 10 },
      acuc: { api_key_id: 42 },
    });
    const { res } = await runMiddleware(req, checkCreditsMiddleware(10));

    expect(body(res).code).toBe("api_key_spend_limit");
    expect(body(res).error).toContain("more than the key's whole limit");
  });

  it("reports the plan balance and its reset when the team is short", async () => {
    checkCreditsMock.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetsAt: Date.UTC(2026, 11, 1),
    });

    const req = buildReq({
      path: "/v2/scrape",
      body: {},
      acuc: { api_key_id: 42 },
    });
    const { res } = await runMiddleware(req);

    expect(getApiKeySpendLimitMock).not.toHaveBeenCalled();
    expect(body(res)).toMatchObject({
      code: "insufficient_credits",
      requested_credits: 1,
      remaining_credits: 0,
      resets_at: "2026-12-01T00:00:00.000Z",
    });
  });

  it("falls back to the plan message when a covered refusal has no key limit", async () => {
    checkCreditsMock.mockResolvedValue({ allowed: false, remaining: 500 });
    getApiKeySpendLimitMock.mockResolvedValue(null);

    const req = buildReq({
      path: "/v2/scrape",
      body: {},
      acuc: { api_key_id: 42 },
    });
    const { res } = await runMiddleware(req);

    expect(body(res).code).toBe("insufficient_credits");
  });

  it("names the hosted MCP allowance on a connected-app refusal", async () => {
    checkCreditsMock.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetsAt: Date.UTC(2026, 10, 2, 12),
    });

    const req = buildReq({
      path: "/v2/scrape",
      body: {},
      auth: { team_id: "team_test", org_id: "org_test", hostedMcp: true },
      acuc: { api_key_id: 7 },
    });
    const { res } = await runMiddleware(
      req,
      checkCreditsMiddleware(undefined, undefined, { mcpCredits: true }),
    );

    expect(getApiKeySpendLimitMock).not.toHaveBeenCalled();
    expect(body(res)).toMatchObject({
      code: "mcp_credits_exhausted",
      resets_at: "2026-11-02T12:00:00.000Z",
    });
  });
});
