import express from "express";
import request from "supertest";

// The real exchangeRouter, authMiddleware and auth.ts; only I/O is mocked.
const mocks = vi.hoisted(() => ({
  authChunk: vi.fn(),
  upstreamFetch: vi.fn(),
  exchangeRequest: vi.fn(),
  acceptedProviders: vi.fn(),
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
vi.mock("../../services/alexandria/client", () => ({
  exchangeRequest: mocks.exchangeRequest,
}));
vi.mock("../../services/alexandria/terms", async importOriginal => ({
  ...(await importOriginal<typeof import("../../services/alexandria/terms")>()),
  acceptedProviders: mocks.acceptedProviders,
}));
vi.mock("undici", async importOriginal => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: mocks.upstreamFetch,
}));

import { config } from "../../config";
import { exchangeRouter } from "../../routes/exchange";

const MANAGED_KEY = "22222222-2222-4222-8222-222222222222";
const SECRET = "agent-secret";
const TERMS = { key: "fred-terms", version: "2026-01", digest: "abc" };

function managedRow(flags: Record<string, unknown> | null = null) {
  return {
    api_key: MANAGED_KEY,
    api_key_id: 7,
    api_key_id_text: "7",
    team_id: "team-mcp",
    org_id: "org-mcp",
    is_banned: false,
    flags: { exchangeRetrieve: true, ...flags },
    credential_purpose: "hosted_mcp_oauth",
  };
}

// auth_chunk_2 answers only when the key's purpose matches the lookup's.
function keyResolvesAs(flags?: Record<string, unknown>) {
  mocks.authChunk.mockImplementation(
    async (_db: unknown, key: string, purpose = "general") =>
      key === MANAGED_KEY && purpose === "hosted_mcp_oauth"
        ? [managedRow(flags)]
        : [],
  );
}

const app = express();
app.use(express.json());
app.use("/exchange", exchangeRouter);

const retrieveCall = { provider: "fred", capability: "series/observations" };

type Interop = "none" | "header" | "body" | "wrong";

function send(
  method: "get" | "post",
  path: string,
  interop: Interop,
  body: Record<string, unknown> = {},
) {
  let req = request(app)
    [method](path)
    .set("authorization", `Bearer ${MANAGED_KEY}`);
  if (interop === "header") req = req.set("x-firecrawl-agent-interop", SECRET);
  if (interop === "wrong")
    req = req.set("x-firecrawl-agent-interop", "not-the-secret");
  const payload =
    interop === "body"
      ? {
          ...body,
          __agentInterop: {
            auth: SECRET,
            requestId: "req-1",
            shouldBill: true,
          },
        }
      : body;
  return method === "post" ? req.send(payload) : req;
}

const OPTED_IN = [
  {
    name: "GET /exchange/discover",
    method: "get" as const,
    path: "/exchange/discover",
  },
  {
    name: "GET /exchange/discover/:cohort",
    method: "get" as const,
    path: "/exchange/discover/finance?expand=all",
  },
  {
    name: "GET /exchange/discover?q=",
    method: "get" as const,
    path: "/exchange/discover?q=gdp&limit=10",
  },
  {
    name: "POST /exchange/retrieve",
    method: "post" as const,
    path: "/exchange/retrieve",
    body: retrieveCall,
  },
  {
    name: "POST /exchange/publisher/bounties",
    method: "post" as const,
    path: "/exchange/publisher/bounties",
    body: { title: "Find GDP", description: "Quarterly figures" },
  },
];

describe("hosted MCP keys on the Exchange routes the agent calls", () => {
  const original = {
    USE_DB_AUTHENTICATION: config.USE_DB_AUTHENTICATION,
    AGENT_INTEROP_SECRET: config.AGENT_INTEROP_SECRET,
    FIRE_EXCHANGE_URL: config.FIRE_EXCHANGE_URL,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    config.USE_DB_AUTHENTICATION = true;
    config.AGENT_INTEROP_SECRET = SECRET;
    config.FIRE_EXCHANGE_URL = "https://exchange.test";
    keyResolvesAs();
    mocks.upstreamFetch.mockImplementation(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    mocks.acceptedProviders.mockResolvedValue(new Map());
    // Terms requirements answer, then a quote that stops before execution.
    mocks.exchangeRequest.mockImplementation(async ({ path }) =>
      path === "/v1/provider-terms/requirements"
        ? {
            status: 200,
            body: {
              providers: [{ provider: "fred", required: true, terms: TERMS }],
            },
          }
        : { status: 409, body: { success: false, error: "stop here" } },
    );
  });

  afterEach(() => {
    Object.assign(config, original);
  });

  for (const route of OPTED_IN) {
    it(`${route.name}: 401 without interop`, async () => {
      const response = await send(route.method, route.path, "none", route.body);
      expect(response.status).toBe(401);
      expect(mocks.upstreamFetch).not.toHaveBeenCalled();
      expect(mocks.exchangeRequest).not.toHaveBeenCalled();
    });

    it(`${route.name}: 401 with a wrong interop secret`, async () => {
      const response = await send(
        route.method,
        route.path,
        "wrong",
        route.body,
      );
      expect(response.status).toBe(401);
      expect(mocks.upstreamFetch).not.toHaveBeenCalled();
      expect(mocks.exchangeRequest).not.toHaveBeenCalled();
    });

    // The legacy /exchange/retrieve body is strict and cannot carry the block.
    const modes: Interop[] =
      route.method === "post" && route.path !== "/exchange/retrieve"
        ? ["header", "body"]
        : ["header"];
    for (const mode of modes) {
      it(`${route.name}: authenticated with a valid interop ${mode}`, async () => {
        const response = await send(route.method, route.path, mode, route.body);
        expect(response.status).not.toBe(401);
        expect(
          mocks.upstreamFetch.mock.calls.length +
            mocks.exchangeRequest.mock.calls.length,
        ).toBeGreaterThan(0);
      });
    }
  }

  it("proxies discover and bounties under the key's own team", async () => {
    await send("get", "/exchange/discover?q=gdp", "header");
    await send("post", "/exchange/publisher/bounties", "header", {
      title: "t",
      description: "d",
      team_id: "attacker-team",
    });
    for (const [, init] of mocks.upstreamFetch.mock.calls) {
      expect(init.headers["x-exchange-team-id"]).toBe("team-mcp");
    }
    expect(mocks.upstreamFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "POST /exchange/provider-terms/accept",
      "post",
      "/exchange/provider-terms/accept",
    ],
    ["GET /exchange/analytics", "get", "/exchange/analytics"],
    [
      "POST /exchange/publisher/bounties/:id/claim",
      "post",
      "/exchange/publisher/bounties/b-1/claim",
    ],
    ["POST /exchange/records/fetch", "post", "/exchange/records/fetch"],
  ] as const)(
    "%s is not opted in: 401 even with the secret",
    async (_name, method, path) => {
      const response = await send(method, path, "header");
      expect(response.status).toBe(401);
      expect(mocks.upstreamFetch).not.toHaveBeenCalled();
    },
  );

  describe("provider terms gate", () => {
    it("blocks retrieve when the key's team has not accepted the terms", async () => {
      const response = await send(
        "post",
        "/exchange/retrieve",
        "header",
        retrieveCall,
      );

      expect(response.status).toBe(403);
      expect(JSON.stringify(response.body)).toContain("fred-terms");
      // Only the requirements lookup ran; no quote, no execution.
      expect(mocks.exchangeRequest.mock.calls.map(([arg]) => arg.path)).toEqual(
        ["/v1/provider-terms/requirements"],
      );
      expect(mocks.acceptedProviders).toHaveBeenCalledWith(
        "team-mcp",
        "org-mcp",
      );
    });

    it("blocks retrieve when access is disabled for the key's organization", async () => {
      keyResolvesAs({
        organizationDataSourceAccess: {
          fred: { status: "disabled", disabledReason: "admin" },
        },
      });

      const response = await send(
        "post",
        "/exchange/retrieve",
        "header",
        retrieveCall,
      );

      expect(response.status).toBe(403);
      expect(mocks.exchangeRequest.mock.calls.map(([arg]) => arg.path)).toEqual(
        ["/v1/provider-terms/requirements"],
      );
    });

    it("lets retrieve past the gate only once the key's team has accepted", async () => {
      keyResolvesAs({
        organizationDataSourceAccess: {
          fred: {
            status: "enabled",
            termsKey: TERMS.key,
            termsVersion: TERMS.version,
          },
        },
      });

      await send("post", "/exchange/retrieve", "header", retrieveCall);

      expect(mocks.exchangeRequest.mock.calls.map(([arg]) => arg.path)).toEqual(
        ["/v1/provider-terms/requirements", "/v1/retrieve/quote"],
      );
      expect(mocks.exchangeRequest).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: "team-mcp" }),
      );
    });
  });
});
