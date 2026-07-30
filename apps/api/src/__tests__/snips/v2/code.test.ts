import { config } from "../../../config";
import { describeIf, TEST_PRODUCTION } from "../lib";
import { creditUsage, idmux, researchPostRaw, researchRaw } from "./lib";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";

const HAS_RESEARCH = !!config.RESEARCH_PROXY_URL;
const KEYLESS_ENABLED =
  process.env.KEYLESS_REQUESTS_PER_DAY !== undefined &&
  process.env.KEYLESS_CREDITS_PER_DAY !== undefined;

const CANONICAL_PATH = "/v2/search/code/search";
const UPSTREAM_MIRROR_PATH = "/v2/code/search";

const COVERAGE_STATUSES = ["ok", "degraded", "unavailable", "skipped"];

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

describeIf(HAS_RESEARCH)("Code Search API", () => {
  it("serves code search from the canonical mount", async () => {
    const identity = await idmux({
      name: "code/canonical search",
      credits: 100,
    });

    const res = await researchRaw(
      CANONICAL_PATH,
      { query: "how do I configure retries", k: 3 },
      identity,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.results)).toBe(true);
    for (const type of ["doc", "issue", "pull_request", "readme"]) {
      expect(COVERAGE_STATUSES).toContain(res.body.coverage[type]);
    }
    expect(typeof res.body.reranked).toBe("boolean");

    for (const result of res.body.results) {
      expect(typeof result.id).toBe("string");
      expect(typeof result.url).toBe("string");
      expect(["doc", "issue", "pull_request", "readme"]).toContain(result.type);
      expect(Array.isArray(result.passages)).toBe(true);
      expect(result.license).toBeUndefined();
    }
  }, 120000);

  it("serves the same search from a POST body", async () => {
    const identity = await idmux({
      name: "code/post body",
      credits: 100,
    });

    const res = await researchPostRaw(
      CANONICAL_PATH,
      { query: "graceful shutdown", k: 2, types: ["issue", "readme"] },
      identity,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.results)).toBe(true);
    for (const result of res.body.results) {
      expect(["issue", "readme"]).toContain(result.type);
    }
    expect(res.body.coverage.doc).toBe("skipped");
    expect(res.body.coverage.pull_request).toBe("skipped");
  }, 120000);

  it("serves code search from the upstream-mirror mount", async () => {
    const identity = await idmux({
      name: "code/mirror mount",
      credits: 100,
    });

    const res = await researchRaw(
      UPSTREAM_MIRROR_PATH,
      { query: "connection pool sizing", k: 1 },
      identity,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.results)).toBe(true);
  }, 120000);

  it("keeps the upstream casing on repo enrollment status", async () => {
    const identity = await idmux({
      name: "code/repo status casing",
      credits: 100,
    });

    const res = await researchRaw(
      CANONICAL_PATH,
      {
        query: "rate limit handling",
        k: 1,
        repos: "firecrawl/firecrawl",
        types: "issue",
      },
      identity,
    );

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.repos)).toBe(true);
    expect(res.body.repos[0]).toMatchObject({
      repo: "firecrawl/firecrawl",
      types: { pullRequest: expect.any(Boolean) },
    });
  }, 120000);

  it("rejects unknown params and an out-of-bound k", async () => {
    const identity = await idmux({
      name: "code/invalid input",
      credits: 100,
    });

    for (const params of [
      { query: "retries", magic: "true" } as any,
      { query: "retries", k: 101 },
    ]) {
      const res = await researchRaw(CANONICAL_PATH, params, identity);
      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
    }
  });

  it("logs the code search request kind with origin and integration", async () => {
    if (!config.USE_DB_AUTHENTICATION) return;

    const identity = await idmux({
      name: "code/logs metadata",
      credits: 100,
    });
    const query = `code metadata ${Date.now()}`;

    const res = await researchRaw(
      CANONICAL_PATH,
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
            eq(schema.requests.kind, "code_search"),
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

  it("writes a usage row with the billed credits", async () => {
    if (!config.USE_DB_AUTHENTICATION) return;

    const identity = await idmux({
      name: "code/logs usage",
      credits: 100,
    });
    const query = `code usage ${Date.now()}`;

    const res = await researchRaw(CANONICAL_PATH, { query, k: 3 }, identity);
    expect(res.statusCode).toBe(200);

    const expected = Math.ceil(res.body.results.length / 10) * 2;
    const usageLog = await waitForSingleRow<{
      credits_cost: number;
      num_results: number;
      is_successful: boolean;
    }>(async () => {
      const data = await db
        .select({
          credits_cost: schema.code_searches.credits_cost,
          num_results: schema.code_searches.num_results,
          is_successful: schema.code_searches.is_successful,
        })
        .from(schema.code_searches)
        .where(eq(schema.code_searches.target, query))
        .orderBy(desc(schema.code_searches.created_at))
        .limit(1);
      return data[0] ?? null;
    });

    expect(usageLog).not.toBeNull();
    expect(usageLog?.is_successful).toBe(true);
    expect(usageLog?.num_results).toBe(res.body.results.length);
    expect(usageLog?.credits_cost).toBe(expected);
  }, 120000);

  describeIf(KEYLESS_ENABLED)("keyless code search", () => {
    it("permits keyless access on the canonical mount", async () => {
      const res = await researchRaw(CANONICAL_PATH, {
        query: "retry backoff",
        k: 1,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.results)).toBe(true);
    }, 120000);

    it("refuses keyless access on the upstream-mirror mount", async () => {
      const res = await researchRaw(UPSTREAM_MIRROR_PATH, {
        query: "retry backoff",
        k: 1,
      });

      expect(res.statusCode).toBe(401);
    }, 120000);
  });

  describeIf(TEST_PRODUCTION)("code search billing", () => {
    it("bills by returned result count", async () => {
      const identity = await idmux({
        name: "code/bills by results",
        credits: 100,
      });
      const before = (await creditUsage(identity)).remainingCredits;

      const res = await researchRaw(
        CANONICAL_PATH,
        { query: "cancel an in-flight request", k: 11 },
        identity,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      const expectedCredits = Math.ceil(res.body.results.length / 10) * 2;

      await sleepForBilling();
      const after = (await creditUsage(identity)).remainingCredits;
      expect(before - after).toBe(expectedCredits);
    }, 180000);
  });
});
