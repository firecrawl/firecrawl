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

const CANONICAL_PATH = "/v2/search/developer";
/** Compatibility mount kept for published CLI/MCP builds; removed once they ship on CANONICAL_PATH. */
const LEGACY_PATH = "/v2/developer/search";
const SERVING_PATHS = [CANONICAL_PATH, LEGACY_PATH];

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

describeIf(HAS_RESEARCH)("Developer Search API", () => {
  describe.each(SERVING_PATHS)("developer search on %s", path => {
    it("serves developer search", async () => {
      const identity = await idmux({
        name: `developer/get ${path}`,
        credits: 100,
      });

      const res = await researchRaw(
        path,
        { query: "how do I configure retries", k: 3 },
        identity,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.results)).toBe(true);

      for (const result of res.body.results) {
        expect(typeof result.id).toBe("string");
        expect(typeof result.url).toBe("string");
        expect(Array.isArray(result.passages)).toBe(true);
        expect(result.license).toBeUndefined();
      }
    }, 120000);

    it("serves the same search from a POST body", async () => {
      const identity = await idmux({
        name: `developer/post ${path}`,
        credits: 100,
      });

      const res = await researchPostRaw(
        path,
        { query: "graceful shutdown", k: 2, types: ["issue", "readme"] },
        identity,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.results)).toBe(true);
    }, 120000);
  });

  it("keeps the upstream casing on repo enrollment status", async () => {
    const identity = await idmux({
      name: "developer/repo status casing",
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
      name: "developer/invalid input",
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

  it("logs the developer search request kind with origin and integration", async () => {
    if (!config.USE_DB_AUTHENTICATION) return;

    const identity = await idmux({
      name: "developer/logs metadata",
      credits: 100,
    });
    const query = `developer metadata ${Date.now()}`;

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

  it("redacts stored payloads for a forced-ZDR team", async () => {
    if (!config.USE_DB_AUTHENTICATION) return;

    const identity = await idmux({
      name: "developer/forced ZDR retention",
      credits: 100,
      flags: { searchZDR: "forced-zdr" },
    });

    const res = await researchRaw(
      CANONICAL_PATH,
      {
        query: `private developer query ${Date.now()}`,
        k: 1,
      },
      identity,
    );
    expect(res.statusCode).toBe(200);

    const requestLog = await waitForSingleRow<{
      id: string;
      target_hint: string;
      dr_clean_by: string | null;
    }>(async () => {
      const data = await db
        .select({
          id: schema.requests.id,
          target_hint: schema.requests.target_hint,
          dr_clean_by: schema.requests.dr_clean_by,
        })
        .from(schema.requests)
        .where(
          and(
            eq(schema.requests.team_id, identity.teamId),
            eq(schema.requests.kind, "code_search"),
          ),
        )
        .orderBy(desc(schema.requests.created_at))
        .limit(1);
      return data[0] ?? null;
    });

    expect(requestLog).not.toBeNull();
    expect(requestLog?.target_hint).toBe(
      "<redacted due to zero data retention>",
    );
    expect(requestLog?.dr_clean_by).not.toBeNull();

    const usageLog = await waitForSingleRow<{
      target: string;
      options: unknown;
      response: unknown;
      error: string | null;
    }>(async () => {
      if (!requestLog) return null;
      const data = await db
        .select({
          target: schema.code_searches.target,
          options: schema.code_searches.options,
          response: schema.code_searches.response,
          error: schema.code_searches.error,
        })
        .from(schema.code_searches)
        .where(eq(schema.code_searches.request_id, requestLog.id))
        .limit(1);
      return data[0] ?? null;
    });

    expect(usageLog).toEqual({
      target: "<redacted due to zero data retention>",
      options: null,
      response: null,
      error: null,
    });
  }, 120000);

  it("writes a usage row with the billed credits", async () => {
    if (!config.USE_DB_AUTHENTICATION) return;

    const identity = await idmux({
      name: "developer/logs usage",
      credits: 100,
    });
    const query = `developer usage ${Date.now()}`;

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

  describeIf(KEYLESS_ENABLED)("keyless developer search", () => {
    it("permits keyless access on the canonical mount", async () => {
      const res = await researchRaw(CANONICAL_PATH, {
        query: "retry backoff",
        k: 1,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.results)).toBe(true);
    }, 120000);

    it("refuses keyless access on the legacy mount", async () => {
      const res = await researchRaw(LEGACY_PATH, {
        query: "retry backoff",
        k: 1,
      });

      expect(res.statusCode).toBe(401);
    }, 120000);
  });

  describeIf(TEST_PRODUCTION)("developer search billing", () => {
    it("bills by returned result count", async () => {
      const identity = await idmux({
        name: "developer/bills by results",
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
