import { config } from "../../../config";
import {
  describeIf,
  itIf,
  TEST_API_URL,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
  scrapeTimeout,
} from "../lib";
import { redisRateLimitClient } from "../../../services/rate-limiter";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { and, desc, eq, gt } from "drizzle-orm";
import request from "supertest";

// The keyless tier is disabled unless both limits are configured. The harness
// passes the shell env through to the server, so we read the same env here and
// only run when it's set (and use the configured values for cap assertions).
const KEYLESS_REQUESTS_PER_DAY = Number(process.env.KEYLESS_REQUESTS_PER_DAY);
const KEYLESS_CREDITS_PER_DAY = Number(process.env.KEYLESS_CREDITS_PER_DAY);
const KEYLESS_ENABLED =
  TEST_PRODUCTION &&
  Number.isFinite(KEYLESS_REQUESTS_PER_DAY) &&
  KEYLESS_REQUESTS_PER_DAY > 0 &&
  Number.isFinite(KEYLESS_CREDITS_PER_DAY) &&
  KEYLESS_CREDITS_PER_DAY > 0;

// Keyless free tier: scrape, parse, search, and interact work without an API key.
// Gated per-IP/day by a request cap AND a credit cap.
// These tests are the only ones that exercise keyless mode, so they exclusively
// own the `keyless_*` rate-limit keyspace — we flush it before each test (and run
// sequentially) for isolation. `req.ip` is loopback under supertest, so the
// per-IP counters are shared across requests here; flushing keeps tests hermetic.

async function flushKeylessBuckets() {
  const keys = await redisRateLimitClient.keys("keyless_*");
  if (keys.length > 0) {
    await redisRateLimitClient.del(...keys);
  }
}

// Recover the loopback IP the server keyed on, so we can seed its credit counter.
async function currentKeylessIp(): Promise<string> {
  const keys = await redisRateLimitClient.keys("keyless_requests:*");
  expect(keys.length).toBeGreaterThan(0);
  return keys[0].slice("keyless_requests:".length);
}

describeIf(KEYLESS_ENABLED)("Keyless free tier", () => {
  beforeAll(() => {
    config.USE_DB_AUTHENTICATION = true;
  });

  afterAll(async () => {
    delete config.USE_DB_AUTHENTICATION;
    await flushKeylessBuckets();
  });

  beforeEach(async () => {
    await flushKeylessBuckets();
  });

  it(
    "allows keyless scrape from a raw API caller (no origin gate) (200)",
    async () => {
      // origin "api" (and no origin at all) is now eligible — the API itself is
      // free without a key on the allowlisted endpoints.
      const response = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .send({
          url: TEST_SUITE_WEBSITE,
          origin: "api",
          formats: ["markdown"],
        });

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
    },
    scrapeTimeout,
  );

  it(
    "allows keyless scrape with no origin field at all (200)",
    async () => {
      const response = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .send({ url: TEST_SUITE_WEBSITE, formats: ["markdown"] });

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
    },
    scrapeTimeout,
  );

  it("does not grant keyless access on non-allowlisted endpoints (401)", async () => {
    // batch/scrape shares RateLimiterMode.Scrape but is NOT allowKeyless.
    const response = await request(TEST_API_URL)
      .post("/v2/batch/scrape")
      .set("Content-Type", "application/json")
      .send({ urls: ["https://example.com"], origin: "js-sdk@2.0.0" });

    expect(response.statusCode).toBe(401);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain("not available without an API key");
  });

  it(
    "allows keyless parse upload and charges the keyless credit cap (200)",
    async () => {
      const response = await request(TEST_API_URL)
        .post("/v2/parse")
        .field(
          "options",
          JSON.stringify({ formats: ["markdown"], origin: "mcp" }),
        )
        .attach(
          "file",
          Buffer.from("<h1>Keyless Parse Upload</h1><p>Hello.</p>"),
          { filename: "keyless.html", contentType: "text/html" },
        );

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.markdown).toContain("Keyless Parse Upload");
      expect(response.body.data.metadata.creditsUsed).toBe(1);

      const ip = await currentKeylessIp();
      const creditsUsed = Number(
        await redisRateLimitClient.get(`keyless_credits:${ip}`),
      );
      expect(creditsUsed).toBeGreaterThanOrEqual(1);
    },
    scrapeTimeout,
  );

  it("enforces the daily request cap with the request signup message (429)", async () => {
    // Each request consumes a slot during auth, then fails fast in the controller
    // (no url) — so we exhaust the cap without real scrapes, and 0 credits.
    for (let i = 0; i < KEYLESS_REQUESTS_PER_DAY; i++) {
      const r = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .send({ origin: "mcp" });
      expect(r.statusCode).not.toBe(429);
    }

    const blocked = await request(TEST_API_URL)
      .post("/v2/scrape")
      .set("Content-Type", "application/json")
      .send({ origin: "mcp" });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.body.error).toContain("unauthenticated requests");
    // Out of quota → emit the OAuth-discovery header so agents find the key flow.
    expect(blocked.headers["www-authenticate"]).toContain("resource_metadata");
  });

  it("enforces the daily credit cap with the credit signup message (429)", async () => {
    // Materialize the loopback IP, then seed its credit counter to the cap.
    await request(TEST_API_URL)
      .post("/v2/scrape")
      .set("Content-Type", "application/json")
      .send({ origin: "mcp" });
    const ip = await currentKeylessIp();
    await redisRateLimitClient.set(
      `keyless_credits:${ip}`,
      String(KEYLESS_CREDITS_PER_DAY),
    );

    const blocked = await request(TEST_API_URL)
      .post("/v2/scrape")
      .set("Content-Type", "application/json")
      .send({ origin: "mcp" });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.body.error).toContain("unauthenticated credits");
  });

  it("enforces the daily credit cap on parse (429)", async () => {
    // Materialize the loopback IP, then seed its credit counter to the cap.
    await request(TEST_API_URL)
      .post("/v2/scrape")
      .set("Content-Type", "application/json")
      .send({ origin: "mcp" });
    const ip = await currentKeylessIp();
    await redisRateLimitClient.set(
      `keyless_credits:${ip}`,
      String(KEYLESS_CREDITS_PER_DAY),
    );

    const blocked = await request(TEST_API_URL)
      .post("/v2/parse")
      .field(
        "options",
        JSON.stringify({ formats: ["markdown"], origin: "mcp" }),
      )
      .attach("file", Buffer.from("<h1>Blocked</h1>"), {
        filename: "blocked.html",
        contentType: "text/html",
      });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.body.error).toContain("unauthenticated credits");
  });

  it(
    "rejects projected multi-credit keyless parse before parsing (429)",
    async () => {
      await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .send({ origin: "mcp" });
      const ip = await currentKeylessIp();
      await redisRateLimitClient.set(
        `keyless_credits:${ip}`,
        String(KEYLESS_CREDITS_PER_DAY - 1),
      );

      const blocked = await request(TEST_API_URL)
        .post("/v2/parse")
        .field(
          "options",
          JSON.stringify({
            origin: "mcp",
            proxy: "basic",
            formats: [
              {
                type: "json",
                schema: {
                  type: "object",
                  properties: { title: { type: "string" } },
                },
              },
            ],
          }),
        )
        .attach("file", Buffer.from("<h1>Blocked parse</h1>"), {
          filename: "blocked.html",
          contentType: "text/html",
        });

      expect(blocked.statusCode).toBe(429);
      expect(blocked.body.error).toContain("unauthenticated credits");
      expect(blocked.headers["www-authenticate"]).toContain(
        "resource_metadata",
      );
    },
    scrapeTimeout,
  );

  it(
    "rejects projected multi-credit keyless scrape before scraping (429)",
    async () => {
      await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .send({ origin: "mcp" });
      const ip = await currentKeylessIp();
      await redisRateLimitClient.set(
        `keyless_credits:${ip}`,
        String(KEYLESS_CREDITS_PER_DAY - 1),
      );

      const blocked = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .send({
          url: TEST_SUITE_WEBSITE,
          origin: "mcp",
          proxy: "basic",
          formats: [
            {
              type: "json",
              schema: {
                type: "object",
                properties: { title: { type: "string" } },
              },
            },
          ],
        });

      expect(blocked.statusCode).toBe(429);
      expect(blocked.body.error).toContain("unauthenticated credits");
      expect(blocked.headers["www-authenticate"]).toContain(
        "resource_metadata",
      );
    },
    scrapeTimeout,
  );

  it(
    "rejects projected multi-credit v1 keyless scrape before scraping (429)",
    async () => {
      await request(TEST_API_URL)
        .post("/v1/scrape")
        .set("Content-Type", "application/json")
        .send({ origin: "mcp" });
      const ip = await currentKeylessIp();
      await redisRateLimitClient.set(
        `keyless_credits:${ip}`,
        String(KEYLESS_CREDITS_PER_DAY - 1),
      );

      const blocked = await request(TEST_API_URL)
        .post("/v1/scrape")
        .set("Content-Type", "application/json")
        .send({
          url: TEST_SUITE_WEBSITE,
          origin: "mcp",
          proxy: "basic",
          formats: ["json"],
          jsonOptions: {
            schema: {
              type: "object",
              properties: { title: { type: "string" } },
            },
          },
        });

      expect(blocked.statusCode).toBe(429);
      expect(blocked.body.error).toContain("unauthenticated credits");
      expect(blocked.headers["www-authenticate"]).toContain(
        "resource_metadata",
      );
    },
    scrapeTimeout,
  );

  it(
    "reconciles keyless scrape reservation to actual credits (200)",
    async () => {
      const response = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .send({
          url: TEST_SUITE_WEBSITE,
          origin: "mcp",
          proxy: "basic",
          formats: [
            {
              type: "json",
              schema: {
                type: "object",
                properties: { title: { type: "string" } },
              },
            },
          ],
        });

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.metadata.creditsUsed).toBe(5);

      const ip = await currentKeylessIp();
      const creditsUsed = Number(
        await redisRateLimitClient.get(`keyless_credits:${ip}`),
      );
      expect(creditsUsed).toBe(response.body.data.metadata.creditsUsed);
    },
    scrapeTimeout,
  );

  it(
    "writes a keyless_credit_usage audit row for a successful keyless scrape (200)",
    async () => {
      // The audit insert is best-effort and fire-and-forget in the controller,
      // so capture the latest id first, then poll for a newer row afterwards.
      const beforeMaxId = (
        await db
          .select({ id: schema.keyless_credit_usage.id })
          .from(schema.keyless_credit_usage)
          .orderBy(desc(schema.keyless_credit_usage.id))
          .limit(1)
      )[0]?.id;

      const response = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .send({
          url: TEST_SUITE_WEBSITE,
          origin: "mcp",
          formats: ["markdown"],
        });

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      const creditsUsed = response.body.data.metadata.creditsUsed;
      expect(creditsUsed).toBeGreaterThan(0);

      const ip = await currentKeylessIp();

      let row: typeof schema.keyless_credit_usage.$inferSelect | undefined;
      for (let i = 0; i < 20; i++) {
        const rows = await db
          .select()
          .from(schema.keyless_credit_usage)
          .where(
            and(
              eq(schema.keyless_credit_usage.ip, ip),
              beforeMaxId !== undefined
                ? gt(schema.keyless_credit_usage.id, beforeMaxId)
                : undefined,
            ),
          )
          .orderBy(desc(schema.keyless_credit_usage.id))
          .limit(1);
        if (rows.length > 0) {
          row = rows[0];
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }

      expect(row).toBeDefined();
      expect(row!.credits_used).toBe(creditsUsed);
    },
    scrapeTimeout,
  );

  it(
    "rejects projected keyless search with scrape options before search (429)",
    async () => {
      await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .send({ origin: "mcp" });
      const ip = await currentKeylessIp();
      await redisRateLimitClient.set(
        `keyless_credits:${ip}`,
        String(KEYLESS_CREDITS_PER_DAY - 1),
      );

      const blocked = await request(TEST_API_URL)
        .post("/v2/search")
        .set("Content-Type", "application/json")
        .send({
          query: "firecrawl",
          limit: 1,
          origin: "mcp",
          scrapeOptions: {
            proxy: "basic",
            formats: ["markdown"],
          },
        });

      expect(blocked.statusCode).toBe(429);
      expect(blocked.body.error).toContain("unauthenticated credits");
      expect(blocked.headers["www-authenticate"]).toContain(
        "resource_metadata",
      );
    },
    scrapeTimeout,
  );

  it(
    "rejects projected v1 keyless search with scrape options before search (429)",
    async () => {
      await request(TEST_API_URL)
        .post("/v1/scrape")
        .set("Content-Type", "application/json")
        .send({ origin: "mcp" });
      const ip = await currentKeylessIp();
      await redisRateLimitClient.set(
        `keyless_credits:${ip}`,
        String(KEYLESS_CREDITS_PER_DAY - 1),
      );

      const blocked = await request(TEST_API_URL)
        .post("/v1/search")
        .set("Content-Type", "application/json")
        .send({
          query: "firecrawl",
          limit: 1,
          origin: "mcp",
          scrapeOptions: {
            proxy: "basic",
            formats: ["markdown"],
          },
        });

      expect(blocked.statusCode).toBe(429);
      expect(blocked.body.error).toContain("unauthenticated credits");
      expect(blocked.headers["www-authenticate"]).toContain(
        "resource_metadata",
      );
    },
    scrapeTimeout,
  );

  it(
    "reconciles keyless search reservation to actual credits (200)",
    async () => {
      const response = await request(TEST_API_URL)
        .post("/v2/search")
        .set("Content-Type", "application/json")
        .send({ query: "firecrawl", limit: 1, origin: "mcp" });

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(typeof response.body.creditsUsed).toBe("number");

      const ip = await currentKeylessIp();
      const creditsUsed = Number(
        await redisRateLimitClient.get(`keyless_credits:${ip}`),
      );
      expect(creditsUsed).toBe(response.body.creditsUsed);
    },
    scrapeTimeout,
  );

  itIf(!!process.env.KEYLESS_PROXY_SECRET)(
    "rate-limits per forwarded client IP when the proxy secret is provided",
    async () => {
      const fakeIp = "203.0.113.7";
      // Seed the forwarded IP's credit counter to the cap.
      await redisRateLimitClient.set(
        `keyless_credits:${fakeIp}`,
        String(KEYLESS_CREDITS_PER_DAY),
      );

      // With the secret, the cap is keyed on the forwarded IP -> blocked.
      const blocked = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .set("x-firecrawl-keyless-secret", process.env.KEYLESS_PROXY_SECRET!)
        .set("x-firecrawl-keyless-ip", fakeIp)
        .send({ origin: "mcp" });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.body.error).toContain("unauthenticated credits");

      // Without the secret, the forwarded IP is ignored (keyed on the real IP).
      const allowed = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .set("x-firecrawl-keyless-ip", fakeIp)
        .send({ origin: "mcp" });
      expect(allowed.statusCode).not.toBe(429);
    },
  );

  itIf(!!process.env.KEYLESS_PROXY_SECRET)(
    "denies keyless access to IPv6 clients (401)",
    async () => {
      const response = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .set("x-firecrawl-keyless-secret", process.env.KEYLESS_PROXY_SECRET!)
        .set("x-firecrawl-keyless-ip", "2001:db8::1")
        .send({ url: TEST_SUITE_WEBSITE, origin: "mcp" });

      // IPv6 is not eligible → falls through to the normal unauthorized path.
      expect(response.statusCode).toBe(401);
    },
  );

  itIf(!!process.env.KEYLESS_PROXY_SECRET)(
    "denies keyless for a malformed forwarded IP (401)",
    async () => {
      // A non-IP forwarded value must not be usable as a limiter bucket.
      const response = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .set("x-firecrawl-keyless-secret", process.env.KEYLESS_PROXY_SECRET!)
        .set("x-firecrawl-keyless-ip", "not-an-ip")
        .send({ url: TEST_SUITE_WEBSITE, origin: "mcp" });

      expect(response.statusCode).toBe(401);
    },
  );

  itIf(!!process.env.KEYLESS_PROXY_SECRET)(
    "keyless eligibility endpoint reflects cap state (hosted MCP probe)",
    async () => {
      const ip = "203.0.113.40";

      // Fresh IP under cap → eligible.
      const ok = await request(TEST_API_URL)
        .get("/v2/keyless/eligibility")
        .set("x-firecrawl-keyless-secret", process.env.KEYLESS_PROXY_SECRET!)
        .set("x-firecrawl-keyless-ip", ip);
      expect(ok.statusCode).toBe(200);
      expect(ok.body.eligible).toBe(true);

      // Seed over the credit cap → ineligible (so the MCP would issue an OAuth
      // challenge instead of serving keyless).
      await redisRateLimitClient.set(
        `keyless_credits:${ip}`,
        String(KEYLESS_CREDITS_PER_DAY),
      );
      const capped = await request(TEST_API_URL)
        .get("/v2/keyless/eligibility")
        .set("x-firecrawl-keyless-secret", process.env.KEYLESS_PROXY_SECRET!)
        .set("x-firecrawl-keyless-ip", ip);
      expect(capped.body.eligible).toBe(false);

      // Without the secret → rejected (no leaking eligibility to untrusted callers).
      const noSecret = await request(TEST_API_URL)
        .get("/v2/keyless/eligibility")
        .set("x-firecrawl-keyless-ip", ip);
      expect(noSecret.statusCode).toBe(401);
    },
  );

  it(
    "grants keyless interact access (past auth, not 401)",
    async () => {
      // A random (non-existent) job id: the request should clear keyless auth and
      // fail downstream, proving interact is allowKeyless — not return 401.
      const response = await request(TEST_API_URL)
        .post("/v2/scrape/00000000-0000-4000-8000-000000000000/interact")
        .set("Content-Type", "application/json")
        .send({ code: "return 1;", origin: "mcp" });

      expect(response.statusCode).not.toBe(401);
    },
    scrapeTimeout,
  );

  itIf(!!config.BROWSER_SERVICE_URL)(
    "rejects projected keyless interact session creation before browser work (429)",
    async () => {
      const scrapeResponse = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .send({
          url: TEST_SUITE_WEBSITE,
          origin: "website-keyless-interact-test",
          proxy: "basic",
          formats: ["markdown"],
        });

      expect(scrapeResponse.statusCode).toBe(200);
      expect(scrapeResponse.body.success).toBe(true);
      expect(typeof scrapeResponse.body.scrape_id).toBe("string");

      const ip = await currentKeylessIp();
      await redisRateLimitClient.set(
        `keyless_credits:${ip}`,
        String(KEYLESS_CREDITS_PER_DAY - 1),
      );

      const blocked = await request(TEST_API_URL)
        .post(`/v2/scrape/${scrapeResponse.body.scrape_id}/interact`)
        .set("Content-Type", "application/json")
        .send({ code: "return 1;", origin: "mcp" });

      expect(blocked.statusCode).toBe(429);
      expect(blocked.body.error).toContain("unauthenticated credits");
      expect(blocked.headers["www-authenticate"]).toContain(
        "resource_metadata",
      );
    },
    scrapeTimeout,
  );

  it(
    "allows keyless scrape from an mcp origin (200)",
    async () => {
      const response = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .send({ url: TEST_SUITE_WEBSITE, origin: "mcp" });

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(typeof response.body.data).toBe("object");
    },
    scrapeTimeout,
  );

  it(
    "allows keyless scrape from a cli integration (200)",
    async () => {
      // The CLI identifies itself via the `integration` field, not `origin`.
      const response = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .send({ url: TEST_SUITE_WEBSITE, integration: "cli" });

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
    },
    scrapeTimeout,
  );

  it(
    "allows keyless scrape from an SDK origin (200)",
    async () => {
      // SDKs send origin like "js-sdk@x.y.z" / "python-sdk@x.y.z".
      const response = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .send({ url: TEST_SUITE_WEBSITE, origin: "js-sdk@2.0.0" });

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
    },
    scrapeTimeout,
  );

  it(
    "allows keyless search from an mcp origin (200)",
    async () => {
      const response = await request(TEST_API_URL)
        .post("/v2/search")
        .set("Content-Type", "application/json")
        .send({ query: "firecrawl", limit: 1, origin: "mcp" });

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
    },
    scrapeTimeout,
  );
});

// Spur Context IP-reputation check on the keyless tier. Only runs when both the
// keyless tier and the Spur integration (SPUR_API_KEY) are configured, plus the
// proxy secret so we can forward a specific test IP. We pre-seed the 30-day
// Spur cache so these are hermetic — no real Spur API call is made (the lookup
// reads the cache first).
const SPUR_ENABLED =
  KEYLESS_ENABLED &&
  !!process.env.SPUR_API_KEY &&
  !!process.env.KEYLESS_PROXY_SECRET;

describeIf(SPUR_ENABLED)("Keyless free tier — Spur IP reputation", () => {
  const spurKey = (ip: string) => `spur_context:${ip}`;

  beforeAll(() => {
    config.USE_DB_AUTHENTICATION = true;
  });

  afterAll(async () => {
    delete config.USE_DB_AUTHENTICATION;
    const keys = await redisRateLimitClient.keys("spur_context:*");
    if (keys.length > 0) await redisRateLimitClient.del(...keys);
  });

  it(
    "refuses keyless for an IP Spur flags as a VPN/proxy tunnel (403)",
    async () => {
      const ip = "203.0.113.66";
      // Seed the Spur cache with a suspicious context (active VPN tunnel).
      await redisRateLimitClient.set(
        spurKey(ip),
        JSON.stringify({
          ip,
          tunnels: [{ type: "VPN", operator: "PROTON_VPN" }],
        }),
      );

      const response = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .set("x-firecrawl-keyless-secret", process.env.KEYLESS_PROXY_SECRET!)
        .set("x-firecrawl-keyless-ip", ip)
        .send({
          url: TEST_SUITE_WEBSITE,
          origin: "mcp",
          formats: ["markdown"],
        });

      expect(response.statusCode).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("suspicious");
      // Out of the keyless path → emit the OAuth-discovery header.
      expect(response.headers["www-authenticate"]).toContain(
        "resource_metadata",
      );
    },
    scrapeTimeout,
  );

  it(
    "allows keyless for a clean (non-anonymizing) IP per Spur (200)",
    async () => {
      const ip = "203.0.113.67";
      // Seed a clean context: datacenter alone is not "suspicious".
      await redisRateLimitClient.set(
        spurKey(ip),
        JSON.stringify({ ip, infrastructure: "DATACENTER", risks: [] }),
      );

      const response = await request(TEST_API_URL)
        .post("/v2/scrape")
        .set("Content-Type", "application/json")
        .set("x-firecrawl-keyless-secret", process.env.KEYLESS_PROXY_SECRET!)
        .set("x-firecrawl-keyless-ip", ip)
        .send({
          url: TEST_SUITE_WEBSITE,
          origin: "mcp",
          formats: ["markdown"],
        });

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
    },
    scrapeTimeout,
  );
});
