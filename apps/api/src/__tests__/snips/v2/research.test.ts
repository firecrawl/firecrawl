import os from "os";
import { config } from "../../../config";
import { describeIf, itIf, TEST_PRODUCTION } from "../lib";
import { creditUsage, idmux, researchRaw } from "./lib";
import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { redisRateLimitClient } from "../../../services/rate-limiter";

const HAS_RESEARCH = !!config.RESEARCH_PROXY_URL;
const KEYLESS_ENABLED =
  process.env.KEYLESS_REQUESTS_PER_DAY !== undefined &&
  process.env.KEYLESS_CREDITS_PER_DAY !== undefined;
const KEYLESS_PROXY_SECRET = process.env.KEYLESS_PROXY_SECRET;

const KEYLESS_DISABLED_OPERATIONS = config.RESEARCH_KEYLESS_DISABLED;
const KEYLESS_SEARCH_ENABLED =
  KEYLESS_ENABLED && !KEYLESS_DISABLED_OPERATIONS.includes("search");
const KEYLESS_INSPECT_DISABLED =
  KEYLESS_ENABLED && KEYLESS_DISABLED_OPERATIONS.includes("inspect");

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Unique-per-run forwarded IPs inside TEST-NET-3 (RFC 5737): the keyless
// request/credit counters live for a day per IP, so a fixed constant would
// inherit counts from earlier runs — enough leftover requests would trip the
// daily limit and 429 a test that hard-requires 200. One octet of entropy
// per run plus a distinct final octet per test keeps buckets disjoint
// across runs and across the two zero-credit tests.
const TEST_NET_RUN_OCTET = 1 + Math.floor(Math.random() * 250);
const testNetIp = (finalOctet: number) =>
  `203.0.113.${((TEST_NET_RUN_OCTET + finalOctet) % 254) + 1}`;
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
// owns an isolated per-IP bucket; otherwise we fall back to the IP the server
// actually keyed on, identified deterministically by diffing the limiter
// keyspace counters around the request rather than picking an arbitrary key.
function keylessHeaders(forwardedIp: string): Record<string, string> {
  return KEYLESS_PROXY_SECRET
    ? {
        "x-firecrawl-keyless-secret": KEYLESS_PROXY_SECRET,
        "x-firecrawl-keyless-ip": forwardedIp,
      }
    : {};
}

// Without the trusted-proxy secret the server keys keyless requests on the
// real client IP, which for these tests is the loopback or a local interface
// address. Snapshotting only those candidate keys (plain MGET) avoids the
// blocking KEYS scan on the shared rate-limit Redis, and stays deterministic
// under concurrency: every parallel no-secret snip bumps the same client-IP
// key, so the diff below still identifies exactly one bumped candidate.
// The server normalizes ::ffff:-mapped IPs to plain IPv4 before keying
// (lib/keyless.ts normalizeKeylessIpv4, applied in auth), but keys written by
// older builds may still carry the raw spelling, so cover both per candidate.
function candidateKeylessIps(): string[] {
  const bare = new Set<string>(["127.0.0.1"]);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4") bare.add(addr.address);
    }
  }
  const ips = new Set<string>();
  for (const ip of bare) {
    ips.add(ip);
    ips.add(`::ffff:${ip}`);
  }
  return [...ips];
}

async function snapshotKeylessCounts(): Promise<Map<string, number>> {
  const candidates = candidateKeylessIps();
  const values = await redisRateLimitClient.mget(
    candidates.map(ip => `keyless_requests:${ip}`),
  );
  const counts = new Map<string, number>();
  candidates.forEach((ip, i) => counts.set(ip, Number(values[i] ?? "0")));
  return counts;
}

// Issues the request via `issue` and resolves the keyless IP the server keyed
// it on. With the proxy secret the forwarded IP is authoritative. Without it,
// the counter diff can be transiently ambiguous: keyless.test.ts flushes the
// whole keyless_* keyspace around its own tests, and a flush landing inside
// our snapshot window resets the counters. Ambiguity retries the whole probe
// (the requests under test are idempotent zero-credit GETs) instead of
// asserting on a poisoned window.
async function issueAndResolveKeylessIp<
  T extends { statusCode: number },
>(forwardedIp: string, issue: () => Promise<T>): Promise<{ res: T; ip: string }> {
  if (KEYLESS_PROXY_SECRET) {
    return { res: await issue(), ip: forwardedIp };
  }
  const attempts: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await snapshotKeylessCounts();
    const res = await issue();
    const after = await snapshotKeylessCounts();
    const bumped = [...after.entries()]
      .filter(([ip, count]) => count > (before.get(ip) ?? 0))
      .map(([ip]) => ip);
    if (bumped.length === 1) return { res, ip: bumped[0] };
    attempts.push(bumped.length === 0 ? "none" : `multiple[${bumped.join(", ")}]`);
  }
  // Distinguish the two failure modes: "none" means the request was never
  // counted against any candidate key (not treated as keyless, or the server
  // keyed on an IP outside the candidate set - check candidateKeylessIps
  // covers how this environment connects); "multiple" means concurrent
  // keyless traffic or a keyless_* flush landed inside the window every time.
  throw new Error(
    `keyless IP resolution failed across 3 probes (${attempts.join("; ")}); ` +
      `candidates checked: ${candidateKeylessIps().join(", ")}`,
  );
}

// Zero-credit keyless usage is recorded as a canonical log line for now (the
// durable keyless_credit_usage row waits on the firecrawl-db migration), so
// these tests assert no row is written and no credit budget moves. The
// library-level log-line contract is pinned in lib/__tests__/keyless-usage-log.
// Row assertions are isolated against rows accumulated by earlier runs (the
// pre-log-only version of these tests wrote durable rows for these very IPs):
// snapshot the max id up front and only count rows past it.
async function maxKeylessUsageRowId(): Promise<number> {
  const rows = await db
    .select({ id: schema.keyless_credit_usage.id })
    .from(schema.keyless_credit_usage)
    .orderBy(desc(schema.keyless_credit_usage.id))
    .limit(1);
  return rows[0]?.id ?? 0;
}

async function keylessUsageRowsAfter(
  ip: string,
  afterId: number,
): Promise<number> {
  // With the proxy secret the IP is an isolated RFC 5737 bucket, so ANY new
  // row is a regression. Without it the IP is the shared loopback: a
  // concurrently running keyless snip can legitimately land a *billable* row
  // for the same IP inside our window, so only zero-credit rows — the actual
  // regression signature of the log-only contract — count against us there.
  const conditions = [
    eq(schema.keyless_credit_usage.ip, ip),
    gt(schema.keyless_credit_usage.id, afterId),
  ];
  if (!KEYLESS_PROXY_SECRET) {
    conditions.push(eq(schema.keyless_credit_usage.credits_used, 0));
  }
  const rows = await db
    .select({ id: schema.keyless_credit_usage.id })
    .from(schema.keyless_credit_usage)
    .where(and(...conditions));
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

  it("serves every paper operation to an API key holder", async () => {
    const identity = await idmux({
      name: "research/keyed paper operations",
      credits: 100,
    });

    const search = await researchRaw(
      "/v2/search/research/papers",
      { query: "attention is all you need", k: 1 },
      identity,
    );
    expect(search.statusCode).toBe(200);
    expect(search.body.success).toBe(true);

    const inspect = await researchRaw(
      "/v2/search/research/papers/1706.03762",
      undefined,
      identity,
    );
    expect(inspect.statusCode).toBe(200);

    const read = await researchRaw(
      "/v2/search/research/papers/1706.03762",
      { query: "attention", k: 1 },
      identity,
    );
    expect(read.statusCode).toBe(200);
    expect(read.body.success).toBe(true);

    const similar = await researchRaw(
      "/v2/search/research/papers/1706.03762/similar",
      { intent: "transformer architectures", k: 2 },
      identity,
    );
    expect(similar.statusCode).toBe(200);
  }, 120000);

  describeIf(KEYLESS_SEARCH_ENABLED)("keyless research", () => {
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
      async ctx => {
        const forwardedIp = testNetIp(0);
        const afterId = await maxKeylessUsageRowId();
        // Delta-isolated like the row check: even though the forwarded IP
        // is unique per run, the credits key lives for a day and octet reuse
        // across runs is possible (1/250), so never compare against absolute
        // zero.
        const creditsBefore = KEYLESS_PROXY_SECRET
          ? Number(
              (await redisRateLimitClient.get(
                `keyless_credits:${forwardedIp}`,
              )) ?? "0",
            )
          : 0;

        const { res, ip } = await issueAndResolveKeylessIp(forwardedIp, () =>
          researchRaw(
            "/v2/search/research/papers",
            { query: "sparse attention", k: 1 },
            undefined,
            keylessHeaders(forwardedIp),
          ),
        );

        // Without the proxy secret this request drew from the shared
        // loopback quota, which keyless.test.ts legitimately exhausts to the
        // daily cap. A 429 there is environmental, not a regression - skip
        // rather than assert on a bucket this test cannot isolate.
        if (!KEYLESS_PROXY_SECRET && res.statusCode === 429) {
          ctx.skip();
          return;
        }
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        // The charge path is fire-and-forget, so poll for the *wrong* outcome
        // (a row appearing) across a generous window and require it never
        // materializes — a fixed sleep can pass while a late write still
        // lands, masking exactly the regression this test exists to catch.
        const strayRow = await waitForSingleRow(
          async () => (await keylessUsageRowsAfter(ip, afterId)) > 0 || null,
          6000,
          500,
        );
        expect(strayRow).toBeNull();

        // The keyless *credit* budget must not be drawn down by a free
        // operation. Only meaningful on the isolated forwarded IP — the
        // loopback bucket is shared with the other keyless snips. Polled like
        // the row check: the charge path is fire-and-forget, so a single
        // immediate read could pass on a stale 0 before a buggy increment.
        if (KEYLESS_PROXY_SECRET) {
          const strayCharge = await waitForSingleRow(
            async () =>
              Number(
                (await redisRateLimitClient.get(`keyless_credits:${ip}`)) ??
                  "0",
              ) > creditsBefore || null,
            6000,
            500,
          );
          expect(strayCharge).toBeNull();
        }
      },
      120000,
    );

    // Failure path: ID enumeration — the exact shape of the incident — mostly
    // produces upstream misses. The charge path must run there too (credits
    // are 0 on every non-2xx path) and stay equally free of DB writes.
    itIf(config.USE_DB_AUTHENTICATION === true)(
      "a keyless paper lookup miss also writes no usage row",
      async ctx => {
        const forwardedIp = testNetIp(1);
        const afterId = await maxKeylessUsageRowId();

        const { res, ip } = await issueAndResolveKeylessIp(forwardedIp, () =>
          researchRaw(
            "/v2/search/research/papers/0000.00000",
            undefined,
            undefined,
            keylessHeaders(forwardedIp),
          ),
        );

        if (!KEYLESS_PROXY_SECRET && res.statusCode === 429) {
          ctx.skip();
          return;
        }
        // The upstream shape for a nonexistent ID is not pinned here (mostly
        // a 4xx miss, but a 200-with-empty or redirect is possible): the
        // contract under test is only that keyless auth admitted the request
        // and that NO usage row lands regardless of outcome shape.
        expect(res.statusCode).not.toBe(401);
        // Same polled absence check as the success path: a late write must
        // fail the test, not slip past a fixed sleep.
        const strayRow = await waitForSingleRow(
          async () => (await keylessUsageRowsAfter(ip, afterId)) > 0 || null,
          6000,
          500,
        );
        expect(strayRow).toBeNull();
      },
      120000,
    );
  });

  describeIf(KEYLESS_INSPECT_DISABLED)("keyless research disabled", () => {
    it("refuses keyless paper inspect with a 401 telling the caller to use an API key", async () => {
      const res = await researchRaw(
        "/v2/search/research/papers/1706.03762",
        undefined,
      );

      expect(res.statusCode).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("API key");
      expect(res.body.results).toBeUndefined();
    }, 120000);

    it("keeps serving the same paper inspect to an API key holder", async () => {
      const identity = await idmux({
        name: "research/keyed inspect while keyless disabled",
        credits: 100,
      });

      const res = await researchRaw(
        "/v2/search/research/papers/1706.03762",
        undefined,
        identity,
      );

      expect(res.statusCode).toBe(200);
    }, 120000);
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
