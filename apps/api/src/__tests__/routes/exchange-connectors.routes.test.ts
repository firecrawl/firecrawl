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
              team_id: "team-connectors",
              org_id: "org-connectors",
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

describe("Alexandria connector routes on the Exchange proxy", () => {
  const original = {
    USE_DB_AUTHENTICATION: config.USE_DB_AUTHENTICATION,
    FIRE_EXCHANGE_URL: config.FIRE_EXCHANGE_URL,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    config.USE_DB_AUTHENTICATION = true;
    config.FIRE_EXCHANGE_URL = "https://exchange.test";
    mocks.upstreamFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ connectors: [] }), { status: 200 }),
    );
  });

  afterEach(() => {
    Object.assign(config, original);
  });

  it.each([
    ["get", "/exchange/connectors", "/v1/connectors"],
    ["get", "/exchange/connectors/catalog", "/v1/connectors/catalog"],
    ["post", "/exchange/connectors", "/v1/connectors"],
    ["get", "/exchange/connectors/mcp-deepwiki", "/v1/connectors/mcp-deepwiki"],
    [
      "patch",
      "/exchange/connectors/mcp-deepwiki",
      "/v1/connectors/mcp-deepwiki",
    ],
    [
      "delete",
      "/exchange/connectors/mcp-deepwiki",
      "/v1/connectors/mcp-deepwiki",
    ],
    [
      "post",
      "/exchange/connectors/mcp-deepwiki/sync",
      "/v1/connectors/mcp-deepwiki/sync",
    ],
    [
      "patch",
      "/exchange/connectors/mcp-deepwiki/tools/read_wiki_structure",
      "/v1/connectors/mcp-deepwiki/tools/read_wiki_structure",
    ],
    ["get", "/exchange/team-skills", "/v1/team-skills"],
    ["post", "/exchange/team-skills", "/v1/team-skills"],
    ["patch", "/exchange/team-skills/item-1", "/v1/team-skills/item-1"],
    ["delete", "/exchange/team-skills/item-1", "/v1/team-skills/item-1"],
    [
      "get",
      "/exchange/team-skills/references?q=fred",
      "/v1/team-skills/references?q=fred",
    ],
  ] as const)(
    "forwards %s %s for a team with exchangeRetrieve, granting connectors",
    async (method, path, upstreamPath) => {
      keyResolvesAs({ exchangeRetrieve: true });
      const body = { catalogId: "deepwiki" };
      let req = request(app)
        [method](path)
        .set("authorization", `Bearer ${KEY}`);
      if (method !== "get" && method !== "delete") req = req.send(body);
      const response = await req;
      expect(response.status).toBe(200);
      expect(mocks.upstreamFetch).toHaveBeenCalledTimes(1);
      const { url, init } = upstream();
      expect(url).toBe(`https://exchange.test${upstreamPath}`);
      expect(init.method).toBe(method.toUpperCase());
      expect(init.headers).toMatchObject({
        "x-exchange-team-id": "team-connectors",
        "x-exchange-connectors": "true",
      });
      if (method === "post" || method === "patch")
        expect(JSON.parse(String(init.body))).toEqual(body);
    },
  );

  it("refuses a team without exchangeRetrieve before reaching Exchange", async () => {
    keyResolvesAs({});
    const response = await request(app)
      .post("/exchange/connectors")
      .set("authorization", `Bearer ${KEY}`)
      .send({ catalogId: "deepwiki" });
    expect(response.status).toBe(403);
    expect(mocks.upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["get", "/exchange/team-skills", "/v1/team-skills"],
    ["post", "/exchange/team-skills", "/v1/team-skills"],
    ["patch", "/exchange/team-skills/item-1", "/v1/team-skills/item-1"],
    ["delete", "/exchange/team-skills/item-1", "/v1/team-skills/item-1"],
    [
      "get",
      "/exchange/team-skills/references?q=fred",
      "/v1/team-skills/references?q=fred",
    ],
  ] as const)(
    "forwards %s %s for any team, without granting connectors",
    async (method, path, upstreamPath) => {
      keyResolvesAs({});
      let req = request(app)
        [method](path)
        .set("authorization", `Bearer ${KEY}`);
      if (method !== "get" && method !== "delete")
        req = req.send({ name: "Digest" });
      const response = await req;
      expect(response.status).toBe(200);
      expect(mocks.upstreamFetch).toHaveBeenCalledTimes(1);
      const { url, init } = upstream();
      expect(url).toBe(`https://exchange.test${upstreamPath}`);
      expect(init.headers).toMatchObject({
        "x-exchange-team-id": "team-connectors",
      });
      expect(init.headers).not.toHaveProperty("x-exchange-connectors");
    },
  );

  it("forwards the team's billing country only when known, never the caller's own", async () => {
    keyResolvesAs({});
    mocks.billingCountry.mockResolvedValueOnce("DE");
    await request(app)
      .get("/exchange/team-skills")
      .set("authorization", `Bearer ${KEY}`)
      .set("x-exchange-billing-country", "US");
    expect(upstream().init.headers).toMatchObject({
      "x-exchange-billing-country": "DE",
    });

    mocks.upstreamFetch.mockClear();
    await request(app)
      .get("/exchange/team-skills")
      .set("authorization", `Bearer ${KEY}`)
      .set("x-exchange-billing-country", "US");
    expect(upstream().init.headers).not.toHaveProperty(
      "x-exchange-billing-country",
    );
  });

  it("re-encodes path segments before forwarding", async () => {
    keyResolvesAs({});
    await request(app)
      .patch("/exchange/team-skills/item%201")
      .set("authorization", `Bearer ${KEY}`)
      .send({ name: "Digest" });
    expect(mocks.upstreamFetch).toHaveBeenCalledTimes(1);
    expect(upstream().url).toBe(
      "https://exchange.test/v1/team-skills/item%201",
    );
  });

  it.each([
    "/exchange/supply/..%2Fretrieve",
    "/exchange/supply/%2e%2e%2Fretrieve",
    "/exchange/supply/x%5C..%5Cretrieve",
    "/exchange/supply/a//b",
    "/exchange/supply/%E0%A4%A",
  ])("refuses %s before reaching Exchange", async path => {
    keyResolvesAs({ exchangeRetrieve: true });
    const response = await request(app)
      .post(path)
      .set("authorization", `Bearer ${KEY}`)
      .send({});
    expect(response.status).toBe(400);
    expect(mocks.upstreamFetch).not.toHaveBeenCalled();
  });

  it("never forwards a caller's own x-exchange-connectors header", async () => {
    keyResolvesAs({});
    // A route open without the flag: the header must still not reach Exchange.
    await request(app)
      .get("/exchange/enrichment/preferences")
      .set("authorization", `Bearer ${KEY}`)
      .set("x-exchange-connectors", "true");
    expect(mocks.upstreamFetch).toHaveBeenCalledTimes(1);
    expect(upstream().init.headers).not.toHaveProperty("x-exchange-connectors");
  });
});
