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

// Keyless free tier: scrape, search, and interact work without an API key from
// the official MCP server (origin "mcp*"), CLI (integration "cli"), or SDKs
// (origin "<lang>-sdk@..."). Gated per-IP/day by a request cap AND a credit cap.
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
        .send({ url: TEST_SUITE_WEBSITE, origin: "api", formats: ["markdown"] });

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
