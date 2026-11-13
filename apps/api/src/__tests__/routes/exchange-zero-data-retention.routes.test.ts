import express from "express";
import request from "supertest";

// The real exchangeRouter, authMiddleware and auth.ts; only I/O is mocked.
const mocks = vi.hoisted(() => ({
  authChunk: vi.fn(),
  upstreamFetch: vi.fn(),
  clickhouse: null as { query: ReturnType<typeof vi.fn> } | null,
  query: vi.fn(),
}));

vi.mock("../../lib/clickhouse-client", () => ({
  get clickhouseClient() {
    return mocks.clickhouse;
  },
  chInsert: vi.fn(),
}));
vi.mock("../../lib/billing-country", () => ({
  billingCountryForTeam: vi.fn(async () => undefined),
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

const KEY = "44444444-4444-4444-8444-444444444444";
const TEAM_ID = "11111111-1111-4111-8111-111111111111";

const app = express();
app.use(express.json());
app.use("/exchange", exchangeRouter);

let flags: Record<string, unknown> = {};

function forwardedHeaders() {
  const [, init] = mocks.upstreamFetch.mock.calls[0]!;
  return (init as RequestInit).headers as Record<string, string>;
}

describe("Exchange proxy under zero data retention", () => {
  const original = {
    USE_DB_AUTHENTICATION: config.USE_DB_AUTHENTICATION,
    FIRE_EXCHANGE_URL: config.FIRE_EXCHANGE_URL,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    flags = {};
    config.USE_DB_AUTHENTICATION = true;
    config.FIRE_EXCHANGE_URL = "https://exchange.test/";
    mocks.clickhouse = { query: mocks.query };
    mocks.query.mockResolvedValue({ json: vi.fn().mockResolvedValue([]) });
    mocks.authChunk.mockImplementation(
      async (_db: unknown, key: string, purpose = "general") =>
        key === KEY && purpose === "general"
          ? [
              {
                api_key: KEY,
                api_key_id: 9,
                api_key_id_text: "9",
                team_id: TEAM_ID,
                org_id: "org-zdr",
                is_banned: false,
                flags,
              },
            ]
          : [],
    );
    mocks.upstreamFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  });

  afterEach(() => {
    Object.assign(config, original);
  });

  const routes = [
    ["discovery", () => request(app).get("/exchange/discover?q=people")],
    [
      "skills",
      () =>
        request(app)
          .post("/exchange/skills/resolve")
          .send({ urls: ["https://example.com/"] }),
    ],
    ["recommendations", () => request(app).get("/exchange/recommendations")],
  ] as const;

  it.each(routes)(
    "tells Exchange when the team is held to it (%s)",
    async (_name, send) => {
      flags = { scrapeZDR: "forced" };
      const response = await send().set("authorization", `Bearer ${KEY}`);
      expect(response.status).toBe(200);
      expect(forwardedHeaders()["x-exchange-zero-data-retention"]).toBe("true");
    },
  );

  it.each([{ forceZDR: true }, { scrapeZDR: "forced" }])(
    "reads the legacy and current flag alike (%o)",
    async teamFlags => {
      flags = teamFlags;
      await request(app)
        .get("/exchange/discover?q=people")
        .set("authorization", `Bearer ${KEY}`);
      expect(forwardedHeaders()["x-exchange-zero-data-retention"]).toBe("true");
    },
  );

  it.each([{}, { scrapeZDR: "allowed" }])(
    "leaves it off otherwise (%o)",
    async teamFlags => {
      flags = teamFlags;
      await request(app)
        .get("/exchange/discover?q=people")
        .set("authorization", `Bearer ${KEY}`);
      expect(forwardedHeaders()).not.toHaveProperty(
        "x-exchange-zero-data-retention",
      );
    },
  );

  it("does not take the header from the caller", async () => {
    await request(app)
      .get("/exchange/discover?q=people")
      .set("authorization", `Bearer ${KEY}`)
      .set("x-exchange-zero-data-retention", "false");
    expect(forwardedHeaders()).not.toHaveProperty(
      "x-exchange-zero-data-retention",
    );
  });
});
