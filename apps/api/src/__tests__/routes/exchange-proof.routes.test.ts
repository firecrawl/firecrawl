import express from "express";
import request from "supertest";

// The real exchangeRouter with only I/O mocked; the proof routes never reach auth.
const mocks = vi.hoisted(() => ({
  upstreamFetch: vi.fn(),
}));

vi.mock("../../lib/clickhouse-client", () => ({
  clickhouseClient: null,
  chInsert: vi.fn(),
}));
vi.mock("../../lib/billing-country", () => ({
  billingCountryForTeam: vi.fn(async () => undefined),
}));
vi.mock("../../db/connection", () => ({ db: {}, dbRr: {}, dbIndex: {} }));
vi.mock("../../db/rpc", () => ({
  authCreditUsageChunk: vi.fn(),
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

const TOKEN = "aaa111.bbb_222.ccc-333.ddd444";
const PAGE = "<!doctype html><html><body><h1>Add photos</h1></body></html>";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]);

const app = express();
app.use(express.json());
app.use("/exchange", exchangeRouter);

function upstream(): { url: string; init: RequestInit } {
  const [url, init] = mocks.upstreamFetch.mock.calls[0]!;
  return { url: String(url), init: init as RequestInit };
}

describe("proof link routes", () => {
  const original = {
    FIRE_EXCHANGE_URL: config.FIRE_EXCHANGE_URL,
    EXCHANGE_INTERNAL_SECRET: config.EXCHANGE_INTERNAL_SECRET,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    config.FIRE_EXCHANGE_URL = "https://exchange.test/";
    config.EXCHANGE_INTERNAL_SECRET = "internal-secret";
    mocks.upstreamFetch.mockImplementation(
      async () =>
        new Response(PAGE, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": "default-src 'self'",
            "referrer-policy": "no-referrer",
            "permissions-policy": "camera=(self)",
            "x-robots-tag": "noindex",
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
            "set-cookie": "session=abc",
            "x-internal": "hidden",
          },
        }),
    );
  });

  afterEach(() => {
    Object.assign(config, original);
  });

  describe("GET /exchange/proof/:token", () => {
    it.each([
      "a.b.c",
      "a.b.c.d.e",
      "a..b.c",
      "a.b.c.d%20x",
      `${"a".repeat(126)}.b.c.d`,
    ])(
      "answers 404 for the malformed token %s without calling upstream",
      async token => {
        const response = await request(app).get(`/exchange/proof/${token}`);

        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({ success: false });
        expect(mocks.upstreamFetch).not.toHaveBeenCalled();
      },
    );

    it("forwards a good token and returns the upstream page untouched", async () => {
      const response = await request(app)
        .get(`/exchange/proof/${TOKEN}?ignored=1`)
        .set("accept", "text/html")
        .set("x-request-id", "req-1")
        .set("authorization", "Bearer should-not-forward")
        .set("cookie", "a=b");

      expect(response.status).toBe(200);
      expect(response.text).toBe(PAGE);
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-security-policy"]).toBe(
        "default-src 'self'",
      );
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["permissions-policy"]).toBe("camera=(self)");
      expect(response.headers["x-robots-tag"]).toBe("noindex");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["x-internal"]).toBeUndefined();

      const { url, init } = upstream();
      expect(url).toBe(`https://exchange.test/v1/proof/${TOKEN}`);
      expect(init.method).toBe("GET");
      expect(init.headers).toEqual({
        accept: "text/html",
        "x-request-id": "req-1",
        "x-exchange-secret": "internal-secret",
        "x-exchange-client-ip": expect.any(String),
      });
    });

    it("returns an upstream error status as it is", async () => {
      mocks.upstreamFetch.mockResolvedValue(
        new Response("<p>Gone</p>", {
          status: 410,
          headers: { "content-type": "text/html" },
        }),
      );

      const response = await request(app).get(`/exchange/proof/${TOKEN}`);

      expect(response.status).toBe(410);
      expect(response.text).toBe("<p>Gone</p>");
    });

    it("answers 502 instead of passing an upstream redirect on", async () => {
      mocks.upstreamFetch.mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: "https://internal.test/elsewhere" },
        }),
      );

      const response = await request(app).get(`/exchange/proof/${TOKEN}`);

      expect(response.status).toBe(502);
      expect(response.headers.location).toBeUndefined();
    });

    it("omits the secret header when none is configured", async () => {
      config.EXCHANGE_INTERNAL_SECRET = undefined as never;

      await request(app).get(`/exchange/proof/${TOKEN}`);

      expect(
        (upstream().init.headers as Record<string, string>)[
          "x-exchange-secret"
        ],
      ).toBeUndefined();
    });

    it("answers 503 when no Exchange URL is configured", async () => {
      config.FIRE_EXCHANGE_URL = undefined as never;

      const response = await request(app).get(`/exchange/proof/${TOKEN}`);

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        success: false,
        error: "This endpoint is not available.",
      });
      expect(mocks.upstreamFetch).not.toHaveBeenCalled();
    });

    it("answers 502 when upstream fails", async () => {
      mocks.upstreamFetch.mockRejectedValue(new Error("connection refused"));

      const response = await request(app).get(`/exchange/proof/${TOKEN}`);

      expect(response.status).toBe(502);
      expect(response.body).toMatchObject({ success: false });
    });
  });

  describe("POST /exchange/proof/:token/photos", () => {
    beforeEach(() => {
      mocks.upstreamFetch.mockImplementation(
        async () =>
          new Response(JSON.stringify({ success: true, id: "photo-1" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      );
    });

    it("forwards the bytes, type and allowed query parameters only", async () => {
      const response = await request(app)
        .post(
          `/exchange/proof/${TOKEN}/photos?item=3&takenAt=2026-01-01T00:00:00Z&lat=1.5&lng=2.5&accuracy=9&extra=x&item2=y&token=z`,
        )
        .set("content-type", "image/png")
        .set("x-request-id", "req-2")
        .set("authorization", "Bearer should-not-forward")
        .send(PNG);

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ success: true, id: "photo-1" });

      const { url, init } = upstream();
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe(
        `https://exchange.test/v1/proof/${TOKEN}/photos`,
      );
      expect([...parsed.searchParams.keys()].sort()).toEqual([
        "accuracy",
        "item",
        "lat",
        "lng",
        "takenAt",
      ]);
      expect(parsed.searchParams.get("takenAt")).toBe("2026-01-01T00:00:00Z");
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({
        "content-type": "image/png",
        "x-request-id": "req-2",
        "x-exchange-secret": "internal-secret",
        "x-exchange-client-ip": expect.any(String),
      });
      expect(Buffer.from(init.body as Buffer).equals(PNG)).toBe(true);
    });

    it("drops a query parameter longer than 64 characters", async () => {
      await request(app)
        .post(
          `/exchange/proof/${TOKEN}/photos?item=${"x".repeat(65)}&lat=${"1".repeat(64)}`,
        )
        .set("content-type", "image/webp")
        .send(PNG);

      const parsed = new URL(upstream().url);
      expect(parsed.searchParams.has("item")).toBe(false);
      expect(parsed.searchParams.get("lat")).toBe("1".repeat(64));
    });

    it("answers 415 for another content type", async () => {
      const response = await request(app)
        .post(`/exchange/proof/${TOKEN}/photos`)
        .set("content-type", "text/plain")
        .send("not an image");

      expect(response.status).toBe(415);
      expect(response.body).toMatchObject({ success: false });
      expect(mocks.upstreamFetch).not.toHaveBeenCalled();
    });

    it("answers 415 for a JSON body", async () => {
      const response = await request(app)
        .post(`/exchange/proof/${TOKEN}/photos`)
        .send({ a: 1 });

      expect(response.status).toBe(415);
      expect(mocks.upstreamFetch).not.toHaveBeenCalled();
    });

    it("answers 413 over 10 MB", async () => {
      const response = await request(app)
        .post(`/exchange/proof/${TOKEN}/photos`)
        .set("content-type", "image/jpeg")
        .send(Buffer.alloc(10 * 1024 * 1024 + 1));

      expect(response.status).toBe(413);
      expect(response.body).toMatchObject({ success: false });
      expect(mocks.upstreamFetch).not.toHaveBeenCalled();
    });

    it("answers 404 for a malformed token without reading the body", async () => {
      const response = await request(app)
        .post("/exchange/proof/not-a-token/photos")
        .set("content-type", "image/png")
        .send(PNG);

      expect(response.status).toBe(404);
      expect(mocks.upstreamFetch).not.toHaveBeenCalled();
    });

    it("answers 502 instead of passing an upstream redirect on", async () => {
      mocks.upstreamFetch.mockResolvedValue(
        new Response(null, {
          status: 307,
          headers: { location: "https://internal.test/elsewhere" },
        }),
      );

      const response = await request(app)
        .post(`/exchange/proof/${TOKEN}/photos`)
        .set("content-type", "image/png")
        .send(PNG);

      expect(response.status).toBe(502);
      expect(response.headers.location).toBeUndefined();
    });

    it("answers 503 when no Exchange URL is configured", async () => {
      config.FIRE_EXCHANGE_URL = undefined as never;

      const response = await request(app)
        .post(`/exchange/proof/${TOKEN}/photos`)
        .set("content-type", "image/png")
        .send(PNG);

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        success: false,
        error: "This endpoint is not available.",
      });
      expect(mocks.upstreamFetch).not.toHaveBeenCalled();
    });
  });

  describe("rate limit", () => {
    it("answers 429 per IP after 60 page loads", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 70; i++) {
        statuses.push(
          (await request(app).get(`/exchange/proof/${TOKEN}`)).status,
        );
      }

      expect(statuses.at(-1)).toBe(429);
      expect(statuses.filter(status => status === 429).length).toBeGreaterThan(
        0,
      );
      expect(mocks.upstreamFetch.mock.calls.length).toBeLessThanOrEqual(60);
    });
  });
});
