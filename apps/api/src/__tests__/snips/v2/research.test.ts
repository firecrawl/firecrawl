import { config } from "../../../config";
import { describeIf, itIf, TEST_PRODUCTION } from "../lib";
import { creditUsage, idmux, researchRaw } from "./lib";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { redisRateLimitClient } from "../../../services/rate-limiter";

const HAS_RESEARCH = !!config.RESEARCH_PROXY_URL;
const KEYLESS_ENABLED =
  process.env.KEYLESS_REQUESTS_PER_DAY !== undefined &&
  process.env.KEYLESS_CREDITS_PER_DAY !== undefined;
const KEYLESS_PROXY_SECRET = process.env.KEYLESS_PROXY_SECRET;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const sleepForBilling = () => sleep(40000);

async function waitForSingleRow<T>(
  fetcher: () => Promise<T | null>,
  timeoutMs: number = 10000,
  intervalMs: number = 250,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await fetcher();
    if (row) return row;
    await sleep(intervalMs);
  }
  return null;
}

// Keyless requests are keyed on the client IP. When the trusted-proxy secret is
// configured we forward a unique documentation-range (RFC 5737) IP so each test
// owns an isolated per-IP bucket; otherwise we fall back to the loopback IP the
// server actually keyed on, recovered from the limiter keyspace the same way
// keyless.test.ts does.
function keylessHeaders(forwardedIp: string): Record<string, string> {
  return KEYLESS_PROXY_SECRET
    ? {
        "x-firecrawl-keyless-secret": KEYLESS_PROXY_SECRET,
        "x-firecrawl-keyless-ip": forwardedIp,
      }
    : {};
}

async function resolveKeylessIp(forwardedIp: string): Promise<string> {
  if (KEYLESS_PROXY_SECRET) return forwardedIp;
  const keys = await redisRateLimitClient.keys("keyless_requests:*");
  expect(keys.length).toBeGreaterThan(0);
  return keys[0].slice("keyless_requests:".length);
}

// Zero-credit keyless usage is recorded as a canonical log line for now (the
// durable keyless_credit_usage row waits on the firecrawl-db migration), so
// these tests assert no row is written and no credit budget moves. The
// library-level log-line contract is pinned in lib/__tests__/keyless-usage-log.
async function keylessUsageRowCount(ip: string): Promise<number> {
  const rows = await db
    .select({ id: schema.keyless_credit_usage.id })
    .from(schema.keyless_credit_usage)
    .where(eq(schema.keyless_credit_usage.ip, ip));
  return rows.length;
}

describeIf(HAS_RESEARCH)("Research API", () => {
  it("serves paper search from the canonical mount", async () => {
    const identity = await idmux({
      name: "research/canonical paper search",
      credits: 100,
    });

    const res = await researchRaw(
      "/v2/search/research/papers",
      { query: "retrieval augmented generation", k: 2 },
      identity,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.length).toBeGreaterThan(0);
    expect(res.body.results[0].paperId).toBeDefined();
    expect(res.body.results[0].paper_id).toBeUndefined();
  }, 120000);

  it("keeps the legacy research mount working", async () => {
    const identity = await idmux({
      name: "research/legacy paper search",
      credits: 100,
    });

    const res = await researchRaw(
      "/v2/research/papers",
      { query: "diffusion models", k: 1 },
      identity,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results[0].paperId).toBeDefined();
    expect(res.body.results[0].paper_id).toBe(res.body.results[0].paperId);
  }, 120000);

  it("rejects invalid endpoint-specific query params", async () => {
    const identity = await idmux({
      name: "research/invalid params",
      credits: 100,
    });

    const res = await researchRaw(
      "/v2/search/research/papers",
      { query: "rag", magic: "true" } as any,
      identity,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("rejects paper inspect k without read query", async () => {
    const identity = await idmux({
      name: "research/inspect rejects k",
      credits: 100,
    });

    const res = await researchRaw(
      "/v2/search/research/papers/1706.03762",
      { k: 1 },
      identity,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("logs research origin from X-Origin and integration from query", async () => {
    if (!config.USE_DB_AUTHENTICATION) return;

    const identity = await idmux({
      name: "research/logs metadata",
      credits: 100,
    });
    const query = `research metadata ${Date.now()}`;

    const res = await researchRaw(
      "/v2/search/research/papers",
      { query, k: 1, integration: "_research_test" },
      identity,
      { "X-Origin": "mcp" },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    const requestLog = await waitForSingleRow<{
      origin: string | null;
      integration: string | null;
    }>(async () => {
      const data = await db
        .select({
          origin: schema.requests.origin,
          integration: schema.requests.integration,
        })
        .from(schema.requests)
        .where(
          and(
            eq(schema.requests.team_id, identity.teamId),
            eq(schema.requests.kind, "research_paper_search"),
            eq(schema.requests.target_hint, query),
          ),
        )
        .orderBy(desc(schema.requests.created_at))
        .limit(1);
      return data[0] ?? null;
    });

    expect(requestLog).not.toBeNull();
    expect(requestLog?.origin).toBe("mcp");
    expect(requestLog?.integration).toBe("_research_test");
  }, 120000);

  it("rejects invalid research integration values", async () => {
    const identity = await idmux({
      name: "research/invalid integration",
      credits: 100,
    });

    const res = await researchRaw(
      "/v2/search/research/papers",
      { query: "rag", integration: "invalid-integration" },
      identity,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  describeIf(KEYLESS_ENABLED)("keyless research", () => {
    it("permits keyless access on the canonical research index", async () => {
      const res = await researchRaw("/v2/search/research/papers", {
        query: "transformers",
        k: 1,
      });

      expect(res.statusCode).not.toBe(401);
    }, 120000);

    // The Research Index paper endpoints cost 0 credits. The zero-credit
    // charge path must run for them (it emits the canonical keyless/usage log
    // line carrying the client IP — during a distributed corpus-harvest
    // incident only 3.0% of the traffic had a resolvable IP) without touching
    // either durable store: no keyless_credit_usage row (that lands with the
    // firecrawl-db migration) and no credit-budget draw-down.
    itIf(config.USE_DB_AUTHENTICATION === true)(
      "a zero-credit paper search writes no usage row and charges nothing",
      async () => {
        const forwardedIp = "198.51.100.11";

        const res = await researchRaw(
          "/v2/search/research/papers",
          { query: "sparse attention", k: 1 },
          undefined,
          keylessHeaders(forwardedIp),
        );

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);

        const ip = await resolveKeylessIp(forwardedIp);
        // Give the fire-and-forget charge path time to run before asserting
        // it stayed out of the DB.
        await sleep(2000);
        expect(await keylessUsageRowCount(ip)).toBe(0);

        // The keyless *credit* budget must not be drawn down by a free
        // operation. Only meaningful on the isolated forwarded IP — the
        // loopback bucket is shared with the other keyless snips.
        if (KEYLESS_PROXY_SECRET) {
          const creditsUsed = Number(
            (await redisRateLimitClient.get(`keyless_credits:${ip}`)) ?? "0",
          );
          expect(creditsUsed).toBe(0);
        }
      },
      120000,
    );

    // Failure path: ID enumeration — the exact shape of the incident — mostly
    // produces upstream misses. The charge path must run there too (credits
    // are 0 on every non-2xx path) and stay equally free of DB writes.
    itIf(config.USE_DB_AUTHENTICATION === true)(
      "a keyless paper lookup miss also writes no usage row",
      async () => {
        const forwardedIp = "198.51.100.12";

        const res = await researchRaw(
          "/v2/search/research/papers/0000.00000",
          undefined,
          undefined,
          keylessHeaders(forwardedIp),
        );

        expect(res.statusCode).not.toBe(401);
        expect(res.statusCode).toBeGreaterThanOrEqual(400);

        const ip = await resolveKeylessIp(forwardedIp);
        await sleep(2000);
        expect(await keylessUsageRowCount(ip)).toBe(0);
      },
      120000,
    );
  });

  describeIf(TEST_PRODUCTION)("research billing", () => {
    it("research read-paper remains zero-credit", async () => {
      const identity = await idmux({
        name: "research/bills read paper",
        credits: 100,
      });
      const before = (await creditUsage(identity)).remainingCredits;

      const res = await researchRaw(
        "/v2/search/research/papers/1706.03762",
        { query: "attention", k: 1 },
        identity,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);

      await sleepForBilling();
      const after = (await creditUsage(identity)).remainingCredits;
      expect(before - after).toBe(0);
    }, 180000);

    it("research search-like endpoints remain zero-credit", async () => {
      const identity = await idmux({
        name: "research/bills search papers",
        credits: 100,
      });
      const before = (await creditUsage(identity)).remainingCredits;

      const res = await researchRaw(
        "/v2/search/research/papers",
        { query: "graph neural networks", k: 11 },
        identity,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.results.length).toBeGreaterThan(0);
      const expectedCredits = Math.ceil(res.body.results.length / 10) * 2;

      await sleepForBilling();
      const after = (await creditUsage(identity)).remainingCredits;
      expect(before - after).toBe(0);
    }, 180000);
  });
});
