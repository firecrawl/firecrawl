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
import { logger } from "../../lib/logger";
import { exchangeRouter } from "../../routes/exchange";

const KEY = "44444444-4444-4444-8444-444444444444";
const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TEAM_ID = "22222222-2222-4222-8222-222222222222";

const RECOMMENDATIONS = {
  success: true,
  data: {
    windowDays: 30,
    items: [
      {
        provider: "youtube",
        name: "YouTube",
        description: "Videos",
        categories: ["media"],
        toolCount: 3,
        kind: "website",
        basis: "Matches sites you scrape (youtube.com)",
      },
    ],
  },
};

const app = express();
app.use(express.json());
app.use("/exchange", exchangeRouter);

function rowsAre(rows: { kind: string; target: string; n: number }[]) {
  mocks.query.mockResolvedValue({ json: vi.fn().mockResolvedValue(rows) });
}

function clickhouseQuery() {
  return mocks.query.mock.calls[0][0] as {
    query: string;
    query_params: Record<string, unknown>;
    clickhouse_settings: Record<string, unknown>;
  };
}

function upstream(): { url: string; init: RequestInit } {
  const [url, init] = mocks.upstreamFetch.mock.calls[0]!;
  return { url: String(url), init: init as RequestInit };
}

function forwardedBody() {
  return JSON.parse(String(upstream().init.body));
}

describe("GET /exchange/recommendations", () => {
  const original = {
    USE_DB_AUTHENTICATION: config.USE_DB_AUTHENTICATION,
    FIRE_EXCHANGE_URL: config.FIRE_EXCHANGE_URL,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    config.USE_DB_AUTHENTICATION = true;
    config.FIRE_EXCHANGE_URL = "https://exchange.test/";
    mocks.clickhouse = { query: mocks.query };
    mocks.authChunk.mockImplementation(
      async (_db: unknown, key: string, purpose = "general") =>
        key === KEY && purpose === "general"
          ? [
              {
                api_key: KEY,
                api_key_id: 9,
                api_key_id_text: "9",
                team_id: TEAM_ID,
                org_id: "org-recommendations",
                is_banned: false,
                flags: {},
              },
            ]
          : [],
    );
    mocks.upstreamFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify(RECOMMENDATIONS), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    rowsAre([]);
  });

  afterEach(() => {
    Object.assign(config, original);
  });

  it("forwards the authenticated team's hosts and kinds and returns the Exchange's answer", async () => {
    rowsAre([
      { kind: "scrape", target: "youtube.com", n: 12 },
      { kind: "crawl", target: "YouTube.com.", n: 3 },
      { kind: "map", target: "docs.example.org", n: 5 },
      { kind: "scrape", target: "not a host", n: 4 },
      { kind: "scrape", target: "", n: 2 },
      { kind: "search", target: "", n: 7 },
      { kind: "research_paper_search", target: "", n: 4 },
    ]);

    const response = await request(app)
      .get("/exchange/recommendations")
      .set("authorization", `Bearer ${KEY}`)
      .set("x-request-id", "req-1");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(RECOMMENDATIONS);

    const query = clickhouseQuery();
    expect(query.query).toContain("FROM requests");
    expect(query.query).toContain("team_id = {teamId: UUID}");
    expect(query.query).toContain("kind != 'alexandria'");
    expect(query.query).toContain("LIMIT {rowsPerKind: UInt32} BY kind");
    expect(query.query_params).toMatchObject({
      teamId: TEAM_ID,
      urlKinds: ["scrape", "batch_scrape", "crawl", "map", "extract"],
      redacted: "<redacted due to zero data retention>",
      rowsPerKind: 200,
    });
    expect(query.clickhouse_settings).toEqual({
      max_execution_time: 2,
      timeout_overflow_mode: "break",
    });

    const { url, init } = upstream();
    expect(url).toBe("https://exchange.test/v1/recommendations");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      "x-exchange-team-id": TEAM_ID,
      "x-request-id": "req-1",
    });
    expect(forwardedBody()).toEqual({
      hosts: [
        { host: "youtube.com", requests: 15 },
        { host: "docs.example.org", requests: 5 },
      ],
      kinds: {
        scrape: 18,
        crawl: 3,
        map: 5,
        search: 7,
        research_paper_search: 4,
      },
    });
  });

  it("ignores a team named by the caller in headers, query or body", async () => {
    await request(app)
      .get(
        `/exchange/recommendations?team_id=${OTHER_TEAM_ID}&teamId=${OTHER_TEAM_ID}`,
      )
      .set("authorization", `Bearer ${KEY}`)
      .set("x-exchange-team-id", OTHER_TEAM_ID)
      .send({ teamId: OTHER_TEAM_ID, team_id: OTHER_TEAM_ID });

    expect(clickhouseQuery().query_params.teamId).toBe(TEAM_ID);
    expect(upstream().init.headers).toMatchObject({
      "x-exchange-team-id": TEAM_ID,
    });
    expect(JSON.stringify(forwardedBody())).not.toContain(OTHER_TEAM_ID);
  });

  it("refuses an unauthenticated caller before reading anything", async () => {
    const response = await request(app).get("/exchange/recommendations");
    expect(response.status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.upstreamFetch).not.toHaveBeenCalled();
  });

  it.each(["", "?searches=false", "?searches=1"])(
    "reads no search text without searches=true (%s)",
    async suffix => {
      rowsAre([
        { kind: "search", target: "", n: 3 },
        { kind: "scrape", target: "example.com", n: 1 },
      ]);

      await request(app)
        .get(`/exchange/recommendations${suffix}`)
        .set("authorization", `Bearer ${KEY}`);

      expect(clickhouseQuery().query).not.toContain("kind = 'search'");
      expect(clickhouseQuery().query).not.toContain("trimBoth");
      const body = forwardedBody();
      expect(body).not.toHaveProperty("searches");
      expect(body.kinds).toEqual({ search: 3, scrape: 1 });
    },
  );

  it("includes the team's search queries only with searches=true", async () => {
    rowsAre([
      { kind: "search", target: "fed interest rates", n: 4 },
      { kind: "search", target: "site:youtube.com cooking", n: 2 },
      ...Array.from({ length: 60 }, (_, i) => ({
        kind: "search",
        target: `query ${i}`,
        n: 1,
      })),
    ]);

    await request(app)
      .get("/exchange/recommendations?searches=true")
      .set("authorization", `Bearer ${KEY}`);

    expect(clickhouseQuery().query).toContain(
      "kind = 'search', trimBoth(target_hint)",
    );
    const body = forwardedBody();
    expect(body.searches).toHaveLength(50);
    expect(body.searches.slice(0, 2)).toEqual([
      { query: "fed interest rates", requests: 4 },
      { query: "site:youtube.com cooking", requests: 2 },
    ]);
    expect(body.kinds).toEqual({ search: 66 });
  });

  it("forwards at most 100 hosts, busiest first", async () => {
    rowsAre(
      Array.from({ length: 150 }, (_, i) => ({
        kind: "scrape",
        target: `site${i}.example.com`,
        n: i + 1,
      })),
    );

    await request(app)
      .get("/exchange/recommendations")
      .set("authorization", `Bearer ${KEY}`);

    const { hosts } = forwardedBody();
    expect(hosts).toHaveLength(100);
    expect(hosts[0]).toEqual({ host: "site149.example.com", requests: 150 });
    expect(hosts[99]).toEqual({ host: "site50.example.com", requests: 51 });
  });

  it("forwards empty signals when ClickHouse is not configured", async () => {
    mocks.clickhouse = null;

    const response = await request(app)
      .get("/exchange/recommendations?searches=true")
      .set("authorization", `Bearer ${KEY}`);

    expect(response.status).toBe(200);
    expect(forwardedBody()).toEqual({ hosts: [], searches: [], kinds: {} });
  });

  it("forwards empty signals and warns without query text when ClickHouse fails", async () => {
    const warn = vi.spyOn(logger, "warn");
    mocks.query.mockRejectedValue(new Error("Timeout exceeded"));

    const response = await request(app)
      .get("/exchange/recommendations")
      .set("authorization", `Bearer ${KEY}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(RECOMMENDATIONS);
    expect(forwardedBody()).toEqual({ hosts: [], kinds: {} });
    expect(warn).toHaveBeenCalledWith("Recommendation signals unavailable", {
      module: "alexandria/recommendation-signals",
      teamId: TEAM_ID,
      error: "Timeout exceeded",
    });
    warn.mockRestore();
  });

  it("passes an Exchange 404 through verbatim", async () => {
    mocks.upstreamFetch.mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: "Not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await request(app)
      .get("/exchange/recommendations")
      .set("authorization", `Bearer ${KEY}`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ success: false, error: "Not found" });
  });

  it("answers 503 without reading or forwarding when the Exchange is not configured", async () => {
    config.FIRE_EXCHANGE_URL = undefined;

    const response = await request(app)
      .get("/exchange/recommendations")
      .set("authorization", `Bearer ${KEY}`);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      success: false,
      error: "This endpoint is not available.",
    });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.upstreamFetch).not.toHaveBeenCalled();
  });

  it("answers 504 when the Exchange times out and 502 when it cannot be reached", async () => {
    mocks.upstreamFetch.mockRejectedValueOnce(
      new DOMException("timed out", "TimeoutError"),
    );
    const timedOut = await request(app)
      .get("/exchange/recommendations")
      .set("authorization", `Bearer ${KEY}`);
    expect(timedOut.status).toBe(504);

    mocks.upstreamFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const unreachable = await request(app)
      .get("/exchange/recommendations")
      .set("authorization", `Bearer ${KEY}`);
    expect(unreachable.status).toBe(502);
  });
});
