import express from "express";
import request from "supertest";

// The real exchangeRouter, authMiddleware and auth.ts; only I/O is mocked.
const mocks = vi.hoisted(() => ({
  authChunk: vi.fn(),
  upstreamFetch: vi.fn(),
  billingCountry: vi.fn(async (): Promise<string | undefined> => undefined),
}));

vi.mock("../../lib/billing-country", () => ({
  billingCountryForTeam: mocks.billingCountry,
}));

vi.mock("../../db/connection", () => ({ db: {}, dbRr: {}, dbIndex: {} }));
vi.mock("../../db/rpc", () => ({
  authCreditUsageChunk: mocks.authChunk,
  authCreditUsageChunkFromTeam: vi.fn(),
  getAgentFreeRequestsLeft: vi.fn(),
}));
vi.mock("../../services/redis", () => ({
  getValue: vi.fn().mockResolvedValue(null),
  setValue: vi.fn(),
  deleteKey: vi.fn(),
}));
vi.mock("../../services/redlock", () => ({
  redlock: { using: vi.fn(async (_k, _t, _o, fn) => fn({ aborted: false })) },
}));
vi.mock("ioredis", () => ({ default: class {} }));
vi.mock("../../services/rate-limiter", async importOriginal => ({
  ...(await importOriginal<typeof import("../../services/rate-limiter")>()),
  getRateLimiter: vi.fn(() => ({ consume: vi.fn() })),
  getAutumnRateLimiter: vi.fn(() => ({ consume: vi.fn() })),
  redisRateLimitClient: {
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
  },
}));
vi.mock("../../services/autumn/autumn.service", async importOriginal => {
  const actual =
    await importOriginal<
      typeof import("../../services/autumn/autumn.service")
    >();
  return {
    ...actual,
    autumnService: {
      getTeamLimits: vi.fn().mockResolvedValue({
        concurrency_limit: 2,
        rate_limit_multiplier: 1,
      }),
    },
  };
});
vi.mock("../../services/agent-sponsor", () => ({
  getAgentSponsorStatus: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../services/queue-service", () => ({
  getRedisConnection: vi.fn(() => ({ sadd: vi.fn() })),
  getBillingQueue: vi.fn(() => ({ add: vi.fn() })),
}));
vi.mock("../../services/logging/log_job", () => ({
  logRequest: vi.fn(),
  logProviderScrape: vi.fn(),
}));
vi.mock("undici", async importOriginal => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: mocks.upstreamFetch,
}));

import { config } from "../../config";
import { exchangeRouter } from "../../routes/exchange";

const KEY = "33333333-3333-4333-8333-333333333333";

function keyResolvesAs(flags: Record<string, unknown> | null) {
  mocks.authChunk.mockImplementation(
    async (_db: unknown, key: string, purpose = "general") =>
      key === KEY && purpose === "general"
        ? [
            {
              api_key: KEY,
              api_key_id: 9,
              api_key_id_text: "9",
              team_id: "team-onboarding",
              org_id: "org-onboarding",
              is_banned: false,
              flags,
            },
          ]
        : [],
  );
}

const app = express();
app.use(express.json());
app.use("/exchange", exchangeRouter);

function upstream(index = 0): { url: string; init: RequestInit } {
  const [url, init] = mocks.upstreamFetch.mock.calls[index]!;
  return { url: String(url), init: init as RequestInit };
}

describe("Provider onboarding routes on the Exchange proxy", () => {
  const original = {
    USE_DB_AUTHENTICATION: config.USE_DB_AUTHENTICATION,
    FIRE_EXCHANGE_URL: config.FIRE_EXCHANGE_URL,
  };
  const CODE = "ob_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

  beforeEach(() => {
    vi.clearAllMocks();
    config.USE_DB_AUTHENTICATION = true;
    config.FIRE_EXCHANGE_URL = "https://exchange.test";
    mocks.upstreamFetch.mockImplementation(
      async () => new Response(JSON.stringify({ code: CODE }), { status: 200 }),
    );
  });

  afterEach(() => {
    Object.assign(config, original);
  });

  it.each([
    ["post", "/exchange/onboarding", "/v1/onboarding"],
    ["get", `/exchange/onboarding/${CODE}`, `/v1/onboarding/${CODE}`],
    ["put", `/exchange/onboarding/${CODE}`, `/v1/onboarding/${CODE}`],
    [
      "post",
      `/exchange/onboarding/${CODE}/credentials`,
      `/v1/onboarding/${CODE}/credentials`,
    ],
  ] as const)(
    "forwards %s %s without the exchangeRetrieve flag",
    async (method, path, upstreamPath) => {
      keyResolvesAs(null);
      const body = { step: "api", status: "in_progress", draft: {} };
      let req = request(app)
        [method](path)
        .set("authorization", `Bearer ${KEY}`);
      if (method !== "get") req = req.send(body);
      const response = await req;
      expect(response.status).toBe(200);
      const { url, init } = upstream();
      expect(url).toBe(`https://exchange.test${upstreamPath}`);
      expect(init.method).toBe(method.toUpperCase());
      expect(init.headers).toMatchObject({
        "x-exchange-team-id": "team-onboarding",
      });
      if (method !== "get") expect(JSON.parse(String(init.body))).toEqual(body);
    },
  );

  it("refuses a caller without an API key", async () => {
    const response = await request(app).get(`/exchange/onboarding/${CODE}`);
    expect(response.status).toBe(401);
    expect(mocks.upstreamFetch).not.toHaveBeenCalled();
  });

  it("does not forward paths it has no route for", async () => {
    keyResolvesAs(null);
    const response = await request(app)
      .delete(`/exchange/onboarding/${CODE}`)
      .set("authorization", `Bearer ${KEY}`);
    expect(response.status).toBe(404);
    expect(mocks.upstreamFetch).not.toHaveBeenCalled();
  });
});
