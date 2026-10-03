import { vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { authenticateUser } from "../auth";
import { config } from "../../config";
import { RateLimiterMode } from "../../types";
import { authCreditUsageChunk } from "../../db/rpc";
import { getValue, setValue } from "../../services/redis";
import { getAutumnRateLimiter } from "../../services/rate-limiter";
import { autumnService } from "../../services/autumn/autumn.service";
import { logger } from "../../lib/logger";

const { rows, dbChain } = vi.hoisted(() => {
  const rows = {
    replica: [] as unknown[],
    primary: [] as unknown[],
  };
  const dbChain = (which: "replica" | "primary") => {
    const chain = {
      select: vi.fn(() => chain),
      from: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(async () => rows[which]),
    };
    return chain;
  };
  return { rows, dbChain };
});

vi.mock("../../db/connection", () => ({
  db: dbChain("primary"),
  dbRr: dbChain("replica"),
}));

vi.mock("../../services/queue-service", () => ({
  getRedisConnection: vi.fn(() => ({ sadd: vi.fn() })),
}));

vi.mock("../../services/redis", () => ({
  getValue: vi.fn(),
  setValue: vi.fn(),
  deleteKey: vi.fn(),
}));

vi.mock("../../services/redlock", () => ({
  redlock: { using: vi.fn() },
}));

vi.mock("../../db/rpc", () => ({
  authCreditUsageChunk: vi.fn(),
  authCreditUsageChunkFromTeam: vi.fn(),
}));

vi.mock("ioredis", () => ({ default: class {} }));

vi.mock("../../services/rate-limiter", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../services/rate-limiter")>();
  return {
    ...actual,
    getRateLimiter: vi.fn(),
    getAutumnRateLimiter: vi.fn(),
  };
});

vi.mock("../../lib/spur", () => ({
  isKeylessIpSuspicious: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../services/autumn/autumn.service", () => ({
  autumnService: { getRateLimitMultiplier: vi.fn() },
}));

vi.mock("../../services/agent-sponsor", () => ({
  getAgentSponsorStatus: vi.fn(),
}));

const INTEGRATION_ID = "oac_authtest";
const ISSUER = `https://integrations.vercel.com/${INTEGRATION_ID}`;
const API_KEY = "11111111-1111-4111-8111-111111111111";
const TEAM_ID = "22222222-2222-4222-8222-222222222222";

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let signing: KeyPair;
let jwk: JWK;

beforeAll(async () => {
  signing = await generateKeyPair("RS256");
  jwk = { ...(await exportJWK(signing.publicKey)), kid: "k1", alg: "RS256" };
});

async function sign(
  overrides: {
    iss?: string;
    aud?: string;
    resource?: string;
    alg?: string;
    key?: KeyPair["privateKey"];
    expSecondsFromNow?: number;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    resource: overrides.resource ?? "res_1",
    owner: "team_vercel",
    project: "prj_1",
    environment: "production",
  })
    .setProtectedHeader({ alg: overrides.alg ?? "RS256", kid: "k1" })
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? "icfg_1")
    .setSubject(overrides.resource ?? "res_1")
    .setIssuedAt(now)
    .setExpirationTime(now + (overrides.expSecondsFromNow ?? 300))
    .sign(overrides.key ?? signing.privateKey);
}

function request(token: string) {
  return {
    headers: { authorization: `Bearer ${token}` },
    socket: { remoteAddress: "127.0.0.1" },
  };
}

const UNAUTHORIZED = {
  success: false,
  error: "Unauthorized: Invalid token",
  status: 401,
};

describe("authenticateUser with Vercel Marketplace OIDC tokens", () => {
  const originalUseDbAuth = config.USE_DB_AUTHENTICATION;
  const originalIntegrationId = config.VERCEL_MARKETPLACE_INTEGRATION_ID;
  let jwksFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    config.USE_DB_AUTHENTICATION = true;
    config.VERCEL_MARKETPLACE_INTEGRATION_ID = INTEGRATION_ID;
    rows.replica = [{ teamId: TEAM_ID, apiKey: API_KEY }];
    rows.primary = [];
    vi.mocked(getValue).mockResolvedValue(null);
    vi.mocked(setValue).mockResolvedValue(undefined as never);
    vi.mocked(autumnService.getRateLimitMultiplier).mockResolvedValue(1);
    vi.mocked(getAutumnRateLimiter).mockReturnValue({
      consume: vi.fn().mockResolvedValue(undefined),
    } as never);
    vi.mocked(authCreditUsageChunk).mockResolvedValue([
      {
        api_key: API_KEY,
        api_key_id: 7,
        team_id: TEAM_ID,
        org_id: "org-1",
        flags: null,
      },
    ] as never);
    jwksFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", jwksFetch);
    vi.spyOn(logger, "warn").mockImplementation(() => logger);
    vi.spyOn(logger, "info").mockImplementation(() => logger);
  });

  afterEach(() => {
    config.USE_DB_AUTHENTICATION = originalUseDbAuth;
    config.VERCEL_MARKETPLACE_INTEGRATION_ID = originalIntegrationId;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("resolves a valid token to the resource's API key and team", async () => {
    const auth = await authenticateUser(
      request(await sign()),
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth).toEqual(
      expect.objectContaining({
        success: true,
        team_id: TEAM_ID,
        org_id: "org-1",
        chunk: expect.objectContaining({ api_key_id: 7, team_id: TEAM_ID }),
      }),
    );
    expect(jwksFetch).toHaveBeenCalledWith(
      `${ISSUER}/jwks.json`,
      expect.any(Object),
    );
    expect(authCreditUsageChunk).toHaveBeenCalledWith(
      expect.anything(),
      API_KEY,
      "general",
    );
    const cacheWrite = vi
      .mocked(setValue)
      .mock.calls.find(([key]) => key.startsWith("vercel_oidc_token:"));
    expect(cacheWrite).toBeDefined();
    expect(JSON.parse(cacheWrite![1])).toMatchObject({
      ok: true,
      apiKey: API_KEY,
    });
    expect(cacheWrite![2]).toBeGreaterThan(0);
    expect(cacheWrite![2]).toBeLessThanOrEqual(300);
  });

  it("serves a cached resolution without re-verifying or reading the database", async () => {
    vi.mocked(getValue).mockImplementation(async key =>
      key.startsWith("vercel_oidc_token:")
        ? JSON.stringify({
            ok: true,
            apiKey: API_KEY,
            teamId: TEAM_ID,
            installationId: "icfg_1",
            resourceId: "res_1",
          })
        : null,
    );
    rows.replica = [];

    const auth = await authenticateUser(
      request(await sign()),
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth.success).toBe(true);
    expect(authCreditUsageChunk).toHaveBeenCalledWith(
      expect.anything(),
      API_KEY,
      "general",
    );
  });

  it.each([
    [
      "another integration's issuer",
      { iss: "https://integrations.vercel.com/oac_other" },
    ],
    ["an expired token", { expSecondsFromNow: -120 }],
  ])("rejects %s with 401", async (_label, overrides) => {
    const auth = await authenticateUser(
      request(await sign(overrides)),
      {},
      RateLimiterMode.Scrape,
    );
    expect(auth).toEqual(UNAUTHORIZED);
    expect(authCreditUsageChunk).not.toHaveBeenCalled();
    const negative = vi
      .mocked(setValue)
      .mock.calls.find(([key]) => key.startsWith("vercel_oidc_token:"));
    expect(negative?.[2]).toBe(60);
  });

  it("rejects a non-RS256 token with 401", async () => {
    const rs512 = await generateKeyPair("RS512");
    const auth = await authenticateUser(
      request(await sign({ alg: "RS512", key: rs512.privateKey })),
      {},
      RateLimiterMode.Scrape,
    );
    expect(auth).toEqual(UNAUTHORIZED);
    expect(authCreditUsageChunk).not.toHaveBeenCalled();
  });

  it("rejects an unknown installation or resource with 401 after checking the primary", async () => {
    rows.replica = [];
    rows.primary = [];

    const auth = await authenticateUser(
      request(await sign({ aud: "icfg_unknown", resource: "res_unknown" })),
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth).toEqual(UNAUTHORIZED);
    expect(authCreditUsageChunk).not.toHaveBeenCalled();
  });

  it("accepts a resource the replica has not caught up on yet", async () => {
    rows.replica = [];
    rows.primary = [{ teamId: TEAM_ID, apiKey: API_KEY }];

    const auth = await authenticateUser(
      request(await sign()),
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth.success).toBe(true);
  });

  it("rejects a resource whose api_key_id is null with 401", async () => {
    rows.replica = [{ teamId: TEAM_ID, apiKey: null }];
    rows.primary = [{ teamId: TEAM_ID, apiKey: null }];

    const auth = await authenticateUser(
      request(await sign()),
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth).toEqual(UNAUTHORIZED);
    expect(authCreditUsageChunk).not.toHaveBeenCalled();
  });

  it("rejects when the key's team differs from the resource's team", async () => {
    vi.mocked(authCreditUsageChunk).mockResolvedValue([
      {
        api_key: API_KEY,
        api_key_id: 7,
        team_id: "33333333-3333-4333-8333-333333333333",
        org_id: "org-2",
        flags: null,
      },
    ] as never);

    const auth = await authenticateUser(
      request(await sign()),
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth).toEqual(UNAUTHORIZED);
  });

  it("returns 503 when no signing keys can be fetched", async () => {
    config.VERCEL_MARKETPLACE_INTEGRATION_ID = "oac_jwksdown";
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    jwksFetch.mockImplementation(async () => new Response("", { status: 500 }));

    const auth = await authenticateUser(
      request(
        await sign({ iss: "https://integrations.vercel.com/oac_jwksdown" }),
      ),
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth).toEqual({
      success: false,
      error: "Vercel authentication is temporarily unavailable",
      status: 503,
    });
  });

  it("leaves fc- API keys on the existing path", async () => {
    const auth = await authenticateUser(
      request("fc-11111111111141118111111111111111"),
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth.success).toBe(true);
    expect(jwksFetch).not.toHaveBeenCalled();
    expect(authCreditUsageChunk).toHaveBeenCalledWith(
      expect.anything(),
      API_KEY,
      "general",
    );
  });

  it("treats JWTs as ordinary invalid keys when the integration is not configured", async () => {
    config.VERCEL_MARKETPLACE_INTEGRATION_ID = undefined;

    const auth = await authenticateUser(
      request(await sign()),
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth).toEqual(UNAUTHORIZED);
    expect(jwksFetch).not.toHaveBeenCalled();
    expect(authCreditUsageChunk).not.toHaveBeenCalled();
  });
});
