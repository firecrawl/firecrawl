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

const { rows, errors, dbChain } = vi.hoisted(() => {
  const rows = {
    replica: [] as unknown[],
    primary: [] as unknown[],
  };
  const errors = {
    replica: null as Error | null,
    primary: null as Error | null,
  };
  const dbChain = (which: "replica" | "primary") => {
    const chain = {
      select: vi.fn(() => chain),
      from: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(async () => {
        if (errors[which]) throw errors[which];
        return rows[which];
      }),
    };
    return chain;
  };
  return { rows, errors, dbChain };
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
  DEFAULT_TEAM_LIMITS: {
    concurrency_limit: 2,
    rate_limit_multiplier: 1,
    is_paid_plan: false,
  },
  autumnService: { getTeamLimits: vi.fn() },
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
    kid?: string;
    key?: KeyPair["privateKey"];
    expSecondsFromNow?: number;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    act: { sub: "owner:team_vercel:project:prj_1:environment:production" },
    environment: "production",
  })
    .setProtectedHeader({
      alg: overrides.alg ?? "RS256",
      kid: overrides.kid ?? "k1",
    })
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? "icfg_1")
    .setSubject(overrides.resource ?? "res_1")
    .setIssuedAt(now)
    .setNotBefore(now)
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
    errors.replica = null;
    errors.primary = null;
    rows.replica = [{ teamId: TEAM_ID, apiKey: API_KEY }];
    rows.primary = [];
    vi.mocked(getValue).mockResolvedValue(null);
    vi.mocked(setValue).mockResolvedValue(undefined as never);
    vi.mocked(autumnService.getTeamLimits).mockResolvedValue({
      concurrency_limit: 2,
      rate_limit_multiplier: 1,
      is_paid_plan: false,
    });
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
    vi.useRealTimers();
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

  it("re-verifies a token when a cached rejection has no reason", async () => {
    const integrationId = "oac_malformed_cache";
    config.VERCEL_MARKETPLACE_INTEGRATION_ID = integrationId;
    vi.mocked(getValue).mockImplementation(async key =>
      key.startsWith("vercel_oidc_token:")
        ? JSON.stringify({ ok: false })
        : null,
    );

    const auth = await authenticateUser(
      request(
        await sign({
          iss: `https://integrations.vercel.com/${integrationId}`,
        }),
      ),
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth.success).toBe(true);
    expect(jwksFetch).toHaveBeenCalledWith(
      `https://integrations.vercel.com/${integrationId}/jwks.json`,
      expect.any(Object),
    );
  });

  it("scopes cached resolutions to the configured integration", async () => {
    await authenticateUser(request(await sign()), {}, RateLimiterMode.Scrape);
    const cached = vi
      .mocked(setValue)
      .mock.calls.find(([key]) => key.startsWith("vercel_oidc_token:"));
    expect(cached).toBeDefined();
    vi.mocked(getValue).mockImplementation(async key =>
      key === cached?.[0] ? cached![1] : null,
    );
    config.VERCEL_MARKETPLACE_INTEGRATION_ID = "oac_other";

    const auth = await authenticateUser(
      request(await sign()),
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth).toEqual(UNAUTHORIZED);
    expect(getValue).toHaveBeenCalledWith(
      expect.stringMatching(/^vercel_oidc_token:oac_other:/),
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
    expect(logger.warn).toHaveBeenCalledWith(
      "Request denied",
      expect.objectContaining({
        canonicalLog: "auth/denied",
        reason: "invalid_vercel_oidc_token",
        status: 401,
      }),
    );
    expect(authCreditUsageChunk).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(setValue)
        .mock.calls.some(([key]) => key.startsWith("vercel_oidc_token:")),
    ).toBe(false);
  });

  it("does not cache an unknown-kid rejection and accepts the key after a refetch", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const integrationId = "oac_rotation";
    config.VERCEL_MARKETPLACE_INTEGRATION_ID = integrationId;
    const rotated = await generateKeyPair("RS256");
    const rotatedJwk = {
      ...(await exportJWK(rotated.publicKey)),
      kid: "k2",
      alg: "RS256",
    };
    const token = await sign({
      iss: `https://integrations.vercel.com/${integrationId}`,
      kid: "k2",
      key: rotated.privateKey,
    });

    expect(
      await authenticateUser(request(token), {}, RateLimiterMode.Scrape),
    ).toEqual(UNAUTHORIZED);
    expect(
      vi
        .mocked(setValue)
        .mock.calls.some(([key]) => key.startsWith("vercel_oidc_token:")),
    ).toBe(false);

    jwksFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ keys: [jwk, rotatedJwk] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.setSystemTime(Date.now() + 31_000);

    const auth = await authenticateUser(
      request(token),
      {},
      RateLimiterMode.Scrape,
    );
    expect(auth.success).toBe(true);
    expect(jwksFetch).toHaveBeenCalledTimes(2);
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

  it("falls back to the primary when the resource replica query fails", async () => {
    errors.replica = new Error("replica unavailable");
    rows.primary = [{ teamId: TEAM_ID, apiKey: API_KEY }];

    const auth = await authenticateUser(
      request(await sign()),
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth.success).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "Vercel OIDC resource replica lookup failed",
      expect.any(Object),
    );
  });

  it("falls back to the primary when the replica row has no team", async () => {
    rows.replica = [{ teamId: null, apiKey: API_KEY }];
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
    expect(logger.warn).toHaveBeenCalledWith(
      "Request denied",
      expect.objectContaining({
        canonicalLog: "auth/denied",
        reason: "vercel_oidc_team_mismatch",
        status: 401,
      }),
    );
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

  it("does not enter the Marketplace auth path without DB authentication", async () => {
    config.USE_DB_AUTHENTICATION = false;

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
