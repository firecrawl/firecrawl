/**
 * The hosted MCP credits rolling window, end to end through the credit check
 * middleware: the real middleware, gate, window counter and AutumnService,
 * against a stand-in billing service (fetch) and Redis. Set
 * MCP_WINDOW_TEST_REDIS_URL to run the counter on a real Redis.
 */

import type { NextFunction } from "express";
import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  afterEach,
} from "vitest";
import IORedis from "ioredis";

const { fakeRedis, clients } = vi.hoisted(() => {
  process.env.FIREBILL_URL = "http://firebill.test";
  process.env.FIREBILL_SECRET = "fb-secret";
  process.env.MCP_WINDOW_HOURS = "5";
  process.env.MCP_WINDOW_CREDITS = "500";

  const store = new Map<string, { value: number; expiresAt?: number }>();
  const live = (key: string) => {
    const entry = store.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };
  // Mirrors the RECORD script in services/autumn/mcp-window.ts.
  const fakeRedis = {
    on() {},
    async get(key: string) {
      const entry = live(key);
      return entry ? String(entry.value) : null;
    },
    async pttl(key: string) {
      const entry = live(key);
      if (!entry) return -2;
      return entry.expiresAt === undefined ? -1 : entry.expiresAt - Date.now();
    },
    async pexpire(key: string, ms: number) {
      const entry = live(key);
      if (entry) entry.expiresAt = Date.now() + ms;
      return entry ? 1 : 0;
    },
    async eval(
      _s: string,
      _n: number,
      key: string,
      delta: number,
      ttl: number,
    ) {
      let entry = live(key);
      if (delta < 0 && !entry) return 0;
      if (!entry) {
        entry = { value: 0 };
        store.set(key, entry);
      }
      entry.value = Math.max(0, entry.value + Number(delta));
      if (entry.expiresAt === undefined)
        entry.expiresAt = Date.now() + Number(ttl);
      return entry.value;
    },
  };
  return { fakeRedis, clients: { real: null as any } };
});

const realUrl = process.env.MCP_WINDOW_TEST_REDIS_URL;
const realRedis = realUrl ? new IORedis(realUrl) : null;
clients.real = realRedis;
const redis: any = realRedis ?? fakeRedis;

// Read on every use, so the window counter gets the real client when one is set.
vi.mock("../../services/rate-limiter", () => ({
  get redisRateLimitClient() {
    return clients.real ?? fakeRedis;
  },
}));

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../../services/autumn/client", () => ({ autumnClient: {} }));
vi.mock("../../services/queue-service", () => ({
  getFirebillTrackRetryQueue: () => ({ add: vi.fn() }),
}));
vi.mock("../../db/connection", () => ({
  dbRr: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
  },
}));
vi.mock("../../services/autumn/usage", () => ({ getTeamBalance: vi.fn() }));
vi.mock("../../lib/api-key-spend-limit", () => ({
  getApiKeySpendLimit: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../lib/http-metrics", () => ({
  httpRequestDurationSeconds: { observe: vi.fn() },
  getRoutePattern: vi.fn(() => "/v2/scrape"),
}));
vi.mock("../../controllers/auth", () => ({ authenticateUser: vi.fn() }));
vi.mock("../../services/idempotency/create", () => ({
  createIdempotencyKey: vi.fn(),
}));
vi.mock("../../services/idempotency/validate", () => ({
  validateIdempotencyKey: vi.fn(),
}));
vi.mock("geoip-country", () => ({ lookup: vi.fn(() => null) }));

import { checkCreditsMiddleware } from "../../routes/shared";
import {
  autumnService,
  MCP_CREDITS_FEATURE_ID,
  CREDITS_FEATURE_ID,
} from "../../services/autumn/autumn.service";

// A stand-in billing service: one balance per customer, entity and feature.
const WEEK_RESET = Date.now() + 6 * 24 * 60 * 60 * 1000;
const balances = new Map<string, number>();
const asked: { path: string; feature: string; value: number }[] = [];
const balanceKey = (b: any) =>
  `${b.customer_id}|${b.entity_id ?? ""}|${b.feature_id}`;
const billing = vi.fn(async (url: any, init?: any) => {
  const path = new URL(String(url)).pathname;
  const body = JSON.parse(init.body);
  asked.push({ path, feature: body.feature_id, value: body.value });
  const key = balanceKey(body);
  const balance = balances.get(key) ?? 0;
  if (path === "/v1/check")
    return new Response(
      JSON.stringify({
        success: true,
        allowed: balance >= body.value,
        remaining: balance,
        ...(body.feature_id === MCP_CREDITS_FEATURE_ID
          ? { resets_at: WEEK_RESET }
          : {}),
      }),
    );
  balances.set(key, balance - body.value);
  return new Response(JSON.stringify({ success: true }));
});

let org = "";
let n = 0;
const team = "team-1";

function fund(feature: string, credits: number) {
  const entity = feature === MCP_CREDITS_FEATURE_ID ? "" : team;
  balances.set(`${org}|${entity}|${feature}`, credits);
}

/** A hosted MCP scrape reaching the middleware: what it answers, and the request after. */
function scrape(credits: number) {
  const req: any = {
    path: "/v2/scrape",
    body: {},
    auth: { team_id: team, org_id: org, hostedMcp: true },
    acuc: {},
  };
  return new Promise<{
    req: any;
    status?: number;
    body?: any;
    passed: boolean;
  }>(resolve => {
    const res: any = {
      locals: {},
      headersSent: false,
      status: vi.fn((status: number) => {
        res.statusCode = status;
        return res;
      }),
      json: vi.fn((body: any) => {
        resolve({ req, status: res.statusCode, body, passed: false });
        return res;
      }),
    };
    const next: NextFunction = () => resolve({ req, passed: true });
    checkCreditsMiddleware(credits, undefined, { mcpCredits: true })(
      req,
      res,
      next,
    );
  });
}

/** Bills a finished request the way the billing workers do. */
async function bill(req: any, credits: number) {
  const featureId = req.auth.hostedMcp
    ? await autumnService.hostedMcpFeatureId(team, CREDITS_FEATURE_ID)
    : CREDITS_FEATURE_ID;
  expect(
    await autumnService.trackCredits({
      teamId: team,
      orgId: org,
      value: credits,
      featureId,
    }),
  ).toBe(true);
  return featureId;
}

beforeEach(() => {
  org = `org-mw-${process.pid}-${Date.now()}-${n++}`;
  balances.clear();
  asked.length = 0;
  billing.mockClear();
  vi.stubGlobal("fetch", billing);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await realRedis?.quit();
});

describe(`MCP window through the credit check middleware (${realRedis ? "real Redis" : "in-memory"})`, () => {
  it("lets a free team spend 500 MCP credits, then refuses with the window's reset", async () => {
    fund(MCP_CREDITS_FEATURE_ID, 1500); // weekly allowance, team has no credits

    for (let i = 0; i < 5; i++) {
      const call = await scrape(100);
      expect(call.passed).toBe(true);
      expect(call.req.auth.hostedMcp).toBe(true);
      expect(await bill(call.req, 100)).toBe(MCP_CREDITS_FEATURE_ID);
    }

    asked.length = 0;
    const refused = await scrape(100);
    expect(refused.passed).toBe(false);
    expect(refused.status).toBe(402);
    expect(refused.body.code).toBe("mcp_credits_exhausted");
    expect(refused.body.requested_credits).toBe(100);

    const resetsAt = Date.parse(refused.body.resets_at);
    const fiveHours = 5 * 60 * 60 * 1000;
    expect(resetsAt).toBeGreaterThan(Date.now() + fiveHours - 10_000);
    expect(resetsAt).toBeLessThanOrEqual(Date.now() + fiveHours);
    expect(refused.body.error).toMatch(
      /the allowance resets in (4h 59m|5h) \(at /,
    );
    expect(refused.body.error).not.toContain("daily");

    // The window refused before billing was asked about MCP credits; only the
    // team's own credits were checked. 1,000 of the weekly allowance is left.
    expect(asked.map(a => a.feature)).toEqual([CREDITS_FEATURE_ID]);
    expect(balances.get(`${org}||${MCP_CREDITS_FEATURE_ID}`)).toBe(1000);
  });

  it("still allows a smaller call that fits what is left in the window", async () => {
    fund(MCP_CREDITS_FEATURE_ID, 1500);
    const first = await scrape(450);
    await bill(first.req, 450);
    expect((await scrape(51)).status).toBe(402);
    expect((await scrape(50)).passed).toBe(true);
  });

  it("moves a paid team onto its own credits past the window, without a refusal", async () => {
    fund(MCP_CREDITS_FEATURE_ID, 3500);
    fund(CREDITS_FEATURE_ID, 10_000);

    const first = await scrape(500);
    expect(await bill(first.req, 500)).toBe(MCP_CREDITS_FEATURE_ID);

    const second = await scrape(200);
    expect(second.passed).toBe(true);
    expect(second.req.auth.hostedMcp).toBe(false);
    expect(await bill(second.req, 200)).toBe(CREDITS_FEATURE_ID);

    expect(balances.get(`${org}||${MCP_CREDITS_FEATURE_ID}`)).toBe(3000);
    expect(balances.get(`${org}|${team}|${CREDITS_FEATURE_ID}`)).toBe(9800);
    // Team-credit charges don't count toward the window.
    expect(Number(await redis.get(`mcp_window:{${org}}`))).toBe(500);
  });

  it("opens a fresh window once the old one closes", async () => {
    fund(MCP_CREDITS_FEATURE_ID, 1500);
    const first = await scrape(500);
    await bill(first.req, 500);
    expect((await scrape(1)).status).toBe(402);

    await redis.pexpire(`mcp_window:{${org}}`, 40); // the five hours pass
    await new Promise(resolve => setTimeout(resolve, 120));

    const again = await scrape(500);
    expect(again.passed).toBe(true);
    expect(again.req.auth.hostedMcp).toBe(true);
  });

  it("refuses on the weekly allowance, with its reset, when that runs out first", async () => {
    fund(MCP_CREDITS_FEATURE_ID, 120);
    const first = await scrape(100);
    await bill(first.req, 100);

    const refused = await scrape(100);
    expect(refused.status).toBe(402);
    expect(refused.body.code).toBe("mcp_credits_exhausted");
    expect(Date.parse(refused.body.resets_at)).toBe(WEEK_RESET);
  });

  it("gives room back when a charge is refunded", async () => {
    fund(MCP_CREDITS_FEATURE_ID, 1500);
    const first = await scrape(500);
    await bill(first.req, 500);
    expect((await scrape(100)).status).toBe(402);

    await autumnService.refundCredits({
      teamId: team,
      orgId: org,
      value: 100,
      featureId: MCP_CREDITS_FEATURE_ID,
    });
    expect((await scrape(100)).passed).toBe(true);
  });
});
