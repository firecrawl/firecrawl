import { vi } from "vitest";
import { createHmac } from "node:crypto";
import { authenticateUser, clearACUC } from "../auth";
import { config } from "../../config";
import { RateLimiterMode } from "../../types";
import { authCreditUsageChunk } from "../../db/rpc";
import { redlock } from "../../services/redlock";
import { deleteKey, getValue, setValue } from "../../services/redis";
import {
  getAutumnRateLimiter,
  getRateLimiter,
} from "../../services/rate-limiter";
import {
  consumeKeylessRequest,
  isKeylessConfigured,
  keylessConversionCohort,
} from "../../lib/keyless";
import { logger } from "../../lib/logger";
import { db } from "../../db/connection";
import { autumnService } from "../../services/autumn/autumn.service";

vi.mock("../../services/queue-service", () => ({
  getRedisConnection: vi.fn(() => ({
    sadd: vi.fn(),
  })),
}));

vi.mock("uuid", () => ({
  validate: vi.fn(() => true),
}));

vi.mock("../../services/redis", () => ({
  getValue: vi.fn(),
  setValue: vi.fn(),
  deleteKey: vi.fn(),
}));

vi.mock("../../services/redlock", () => ({
  redlock: {
    using: vi.fn(),
  },
}));

vi.mock("../../db/connection", () => ({
  db: {},
  dbRr: {},
}));

vi.mock("../../db/rpc", () => ({
  authCreditUsageChunk: vi.fn(),
  authCreditUsageChunkFromTeam: vi.fn(),
}));

// The limiter builders are mocked, but getRateLimitOverride is kept real: it is
// the single source of truth for override resolution, and auth.ts calls it to
// decide whether the Autumn multiplier is needed at all. Stub ioredis so
// importing the real module doesn't open a connection.
vi.mock("ioredis", () => ({
  default: class {},
}));

vi.mock("../../services/rate-limiter", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../services/rate-limiter")>();
  return {
    ...actual,
    getRateLimiter: vi.fn(),
    getAutumnRateLimiter: vi.fn(),
  };
});

vi.mock("../../lib/keyless", async importOriginal => {
  const actual = await importOriginal<typeof import("../../lib/keyless")>();
  return {
    ...actual,
    consumeKeylessRequest: vi.fn(),
    isKeylessConfigured: vi.fn(),
  };
});

vi.mock("../../lib/spur", () => ({
  isKeylessIpSuspicious: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../services/autumn/autumn.service", () => ({
  autumnService: {
    getRateLimitMultiplier: vi.fn(),
  },
}));

vi.mock("../../services/agent-sponsor", () => ({
  getAgentSponsorStatus: vi.fn(),
}));

describe("authenticateUser", () => {
  const originalUseDbAuth = config.USE_DB_AUTHENTICATION;
  const originalKeylessProxySecret = config.KEYLESS_PROXY_SECRET;
  const originalKeylessConversionHmacSecret =
    config.KEYLESS_CONVERSION_HMAC_SECRET;
  const originalMcpDelegatedCredentialSecret =
    config.MCP_DELEGATED_CREDENTIAL_SECRET;
  const originalIntrospectUrl = config.OAUTH_INTROSPECT_URL;
  const originalIntrospectSecret = config.OAUTH_INTROSPECT_SECRET;
  const originalPreviewToken = config.PREVIEW_TOKEN;

  beforeEach(() => {
    vi.mocked(isKeylessConfigured).mockReturnValue(false);
    vi.mocked(autumnService.getRateLimitMultiplier).mockResolvedValue(1);
    vi.mocked(getAutumnRateLimiter).mockReturnValue({
      consume: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  afterEach(() => {
    config.USE_DB_AUTHENTICATION = originalUseDbAuth;
    config.KEYLESS_PROXY_SECRET = originalKeylessProxySecret;
    config.KEYLESS_CONVERSION_HMAC_SECRET = originalKeylessConversionHmacSecret;
    config.MCP_DELEGATED_CREDENTIAL_SECRET =
      originalMcpDelegatedCredentialSecret;
    config.OAUTH_INTROSPECT_URL = originalIntrospectUrl;
    config.OAUTH_INTROSPECT_SECRET = originalIntrospectSecret;
    config.PREVIEW_TOKEN = originalPreviewToken;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const signDelegation = (
    overrides: Record<string, unknown> = {},
    secret = "mcp-delegation-secret",
  ) => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      v: 1,
      aud: "firecrawl-core",
      purpose: "hosted_mcp_oauth",
      api_key: "fc-11111111111111118111111111111111",
      iat: now,
      exp: now + 60,
      ...overrides,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", secret)
      .update(encoded)
      .digest("base64url");
    return `fcmcp_${encoded}.${signature}`;
  };

  it("keeps a mock ACUC chunk in no-auth mode", async () => {
    config.USE_DB_AUTHENTICATION = false;

    const auth = await authenticateUser(
      { headers: {}, socket: {} },
      {},
      RateLimiterMode.ExtractAgentPreview,
    );

    expect(auth.success).toBe(true);
    if (!auth.success) throw new Error("expected bypass auth to succeed");
    expect(auth.team_id).toBe("bypass");
    expect(auth.chunk).toEqual(
      expect.objectContaining({
        api_key: "bypass",
        api_key_id: 0,
        team_id: "bypass",
        is_extract: true,
      }),
    );
  });

  it("logs a conversion cohort for middleware keyless quota exhaustion", async () => {
    config.USE_DB_AUTHENTICATION = true;
    config.KEYLESS_CONVERSION_HMAC_SECRET = "a".repeat(32);
    vi.mocked(isKeylessConfigured).mockReturnValue(true);
    vi.mocked(consumeKeylessRequest).mockResolvedValue({
      ok: false,
      reason: "requests",
      requestsUsed: 10,
      creditsUsed: 2,
      retryAfterSeconds: 42,
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    const auth = await authenticateUser(
      {
        headers: {},
        socket: { remoteAddress: "203.0.113.8" },
      },
      {},
      RateLimiterMode.Scrape,
      { allowKeyless: true },
    );

    expect(auth).toEqual(
      expect.objectContaining({
        success: false,
        status: 429,
        keylessReason: "requests",
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      "Keyless request blocked",
      expect.objectContaining({
        event: "keyless_exhausted",
        reason: "requests",
        teamId: "preview_keyless_hmac_v1_bcd8d32706120436adde0e52",
        conversionCohort: keylessConversionCohort("203.0.113.8"),
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("203.0.113.8");
  });

  it("writes normal API-key ACUC entries to the general-purpose cache", async () => {
    config.USE_DB_AUTHENTICATION = true;
    vi.mocked(getValue).mockResolvedValue(null);
    vi.mocked(authCreditUsageChunk).mockResolvedValue([
      {
        api_key: "00000000-0000-4000-8000-000000000000",
        api_key_id: 1,
        team_id: "team-1",
        org_id: "org-1",
        flags: null,
      },
    ]);
    vi.mocked(redlock.using).mockImplementation(
      async (_keys, _ttl, _options, fn) => fn({ aborted: false } as never),
    );
    vi.mocked(getRateLimiter).mockReturnValue({
      consume: vi.fn().mockResolvedValue(undefined),
    } as never);

    const auth = await authenticateUser(
      {
        headers: {
          authorization: "Bearer 00000000-0000-4000-8000-000000000000",
        },
        socket: { remoteAddress: "127.0.0.1" },
      },
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth.success).toBe(true);
    await vi.waitFor(() =>
      expect(setValue).toHaveBeenCalledWith(
        "acuc_general_00000000-0000-4000-8000-000000000000_scrape",
        expect.any(String),
        600,
        true,
      ),
    );
  });

  it("rejects a banned team with 403", async () => {
    config.USE_DB_AUTHENTICATION = true;
    vi.mocked(getValue).mockResolvedValue(null);
    vi.mocked(authCreditUsageChunk).mockResolvedValue([
      {
        api_key: "00000000-0000-4000-8000-000000000000",
        api_key_id: 1,
        team_id: "team-banned",
        org_id: "org-1",
        is_banned: true,
        flags: null,
      },
    ]);
    vi.mocked(redlock.using).mockImplementation(
      async (_keys, _ttl, _options, fn) => fn({ aborted: false } as never),
    );
    vi.mocked(autumnService.getRateLimitMultiplier).mockResolvedValue(1);
    const consume = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getAutumnRateLimiter).mockReturnValue({ consume } as never);

    const auth = await authenticateUser(
      {
        headers: {
          authorization: "Bearer 00000000-0000-4000-8000-000000000000",
        },
        socket: { remoteAddress: "127.0.0.1" },
      },
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth).toEqual({
      success: false,
      error:
        "Unauthorized: This account has been banned. Contact support@firecrawl.com if you believe this is a mistake.",
      status: 403,
    });
    // Ban is rejected before the rate limiter is consumed.
    expect(consume).not.toHaveBeenCalled();
  });

  it("accepts a signed MCP delegation through the managed credential purpose without caching", async () => {
    config.USE_DB_AUTHENTICATION = true;
    config.MCP_DELEGATED_CREDENTIAL_SECRET = "mcp-delegation-secret";
    vi.mocked(authCreditUsageChunk).mockResolvedValue([
      {
        api_key: "11111111-1111-1111-8111-111111111111",
        api_key_id: 1,
        team_id: "team-1",
        org_id: "org-1",
        flags: null,
      },
    ]);
    vi.mocked(autumnService.getRateLimitMultiplier).mockResolvedValue(1);
    vi.mocked(getAutumnRateLimiter).mockReturnValue({
      consume: vi.fn().mockResolvedValue(undefined),
    } as never);

    const auth = await authenticateUser(
      {
        headers: { authorization: `Bearer ${signDelegation()}` },
        socket: { remoteAddress: "127.0.0.1" },
      },
      {},
      RateLimiterMode.Crawl,
    );

    expect(auth).toEqual(
      expect.objectContaining({ success: true, team_id: "team-1" }),
    );
    expect(authCreditUsageChunk).toHaveBeenCalledWith(
      db,
      "11111111-1111-1111-8111-111111111111",
      "hosted_mcp_oauth",
    );
    expect(getValue).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
  });

  it("returns 503 rather than 401 when OAuth introspection is unavailable", async () => {
    config.USE_DB_AUTHENTICATION = true;
    config.OAUTH_INTROSPECT_URL = "https://example.test/introspect";
    config.OAUTH_INTROSPECT_SECRET = "secret";
    vi.mocked(getValue).mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const auth = await authenticateUser(
      {
        headers: { authorization: "Bearer fco_access_token" },
        socket: { remoteAddress: "127.0.0.1" },
      },
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth).toEqual({
      success: false,
      error: "OAuth authentication is temporarily unavailable",
      status: 503,
    });
    expect(authCreditUsageChunk).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing shared secret", undefined, signDelegation()],
    ["a wrong signature", "mcp-delegation-secret", signDelegation({}, "wrong")],
    [
      "an expired assertion",
      "mcp-delegation-secret",
      signDelegation({ exp: Math.floor(Date.now() / 1000) }),
    ],
  ])("rejects an MCP delegation with %s", async (_label, secret, token) => {
    config.USE_DB_AUTHENTICATION = true;
    config.MCP_DELEGATED_CREDENTIAL_SECRET = secret;

    const auth = await authenticateUser(
      {
        headers: { authorization: `Bearer ${token}` },
        socket: { remoteAddress: "127.0.0.1" },
      },
      {},
      RateLimiterMode.Crawl,
    );

    expect(auth).toEqual({
      success: false,
      error: "Unauthorized: Invalid token",
      status: 401,
    });
    expect(authCreditUsageChunk).not.toHaveBeenCalled();
  });

  it("treats malformed ACUC cache JSON as a miss", async () => {
    config.USE_DB_AUTHENTICATION = true;
    vi.mocked(getValue).mockResolvedValue("{not-json");
    vi.mocked(deleteKey).mockResolvedValue(undefined);
    vi.mocked(authCreditUsageChunk).mockResolvedValue([]);

    const auth = await authenticateUser(
      {
        headers: {
          authorization: "Bearer 00000000-0000-4000-8000-000000000000",
        },
        socket: { remoteAddress: "127.0.0.1" },
      },
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth).toEqual({
      success: false,
      error: "Unauthorized: Invalid token",
      status: 401,
    });
    expect(authCreditUsageChunk).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-4000-8000-000000000000",
      "general",
    );
    await vi.waitFor(() =>
      expect(deleteKey).toHaveBeenCalledWith(
        "acuc_general_00000000-0000-4000-8000-000000000000_scrape",
      ),
    );
  });

  it("rejects a managed OAuth credential on the public REST token path", async () => {
    config.USE_DB_AUTHENTICATION = true;
    config.OAUTH_INTROSPECT_URL = "https://example.test/introspect";
    config.OAUTH_INTROSPECT_SECRET = "secret";
    vi.mocked(getValue).mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            active: true,
            api_key: "fc-11111111111111118111111111111111",
            scope: "firecrawl:global",
            client_id: "client-1",
            team_id: "team-1",
            exp: Math.floor(Date.now() / 1000) + 60,
            aud: "https://api.firecrawl.dev/",
            credential_purpose: "hosted_mcp_oauth",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const auth = await authenticateUser(
      {
        headers: { authorization: "Bearer fco_managed_token" },
        socket: { remoteAddress: "127.0.0.1" },
      },
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth).toEqual({
      success: false,
      error: "Unauthorized: Invalid token",
      status: 401,
    });
    expect(authCreditUsageChunk).not.toHaveBeenCalled();
  });

  it("rejects OAuth introspection and ACUC results for different teams", async () => {
    config.USE_DB_AUTHENTICATION = true;
    config.OAUTH_INTROSPECT_URL = "https://example.test/introspect";
    config.OAUTH_INTROSPECT_SECRET = "secret";
    vi.mocked(getValue).mockResolvedValue(null);
    vi.mocked(authCreditUsageChunk).mockResolvedValue([
      {
        api_key: "11111111-1111-1111-8111-111111111111",
        api_key_id: 1,
        team_id: "team-2",
        org_id: "org-2",
        flags: null,
      },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            active: true,
            api_key: "fc-11111111111111118111111111111111",
            scope: "firecrawl:global",
            client_id: "client-1",
            team_id: "team-1",
            exp: Math.floor(Date.now() / 1000) + 60,
            aud: "https://api.firecrawl.dev/",
            credential_purpose: "general",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const auth = await authenticateUser(
      {
        headers: { authorization: "Bearer fco_general_token" },
        socket: { remoteAddress: "127.0.0.1" },
      },
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth).toEqual({
      success: false,
      error: "Unauthorized: Invalid token",
      status: 401,
    });
  });

  it("passes the org rate-limit overrides to the API-key rate limiter", async () => {
    config.USE_DB_AUTHENTICATION = true;
    vi.mocked(getValue).mockResolvedValue(null);
    const flags = { rateLimitOverrides: { scrape: 42 } };
    vi.mocked(authCreditUsageChunk).mockResolvedValue([
      {
        api_key: "00000000-0000-4000-8000-000000000000",
        api_key_id: 1,
        team_id: "team-1",
        org_id: "org-1",
        flags,
      },
    ]);
    vi.mocked(redlock.using).mockImplementation(
      async (_keys, _ttl, _options, fn) => fn({ aborted: false } as never),
    );
    vi.mocked(autumnService.getRateLimitMultiplier).mockResolvedValue(50);

    const auth = await authenticateUser(
      {
        headers: {
          authorization: "Bearer 00000000-0000-4000-8000-000000000000",
        },
        socket: { remoteAddress: "127.0.0.1" },
      },
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth.success).toBe(true);
    // The override replaces the whole base × multiplier computation, so the
    // Autumn multiplier is never fetched and a neutral 1 is passed instead.
    expect(autumnService.getRateLimitMultiplier).not.toHaveBeenCalled();
    expect(getAutumnRateLimiter).toHaveBeenCalledWith(
      RateLimiterMode.Scrape,
      1,
      flags,
    );
  });

  it("still fetches the Autumn multiplier when no override covers the mode", async () => {
    config.USE_DB_AUTHENTICATION = true;
    vi.mocked(getValue).mockResolvedValue(null);
    const flags = { rateLimitOverrides: { crawl: 42 } };
    vi.mocked(authCreditUsageChunk).mockResolvedValue([
      {
        api_key: "00000000-0000-4000-8000-000000000000",
        api_key_id: 1,
        team_id: "team-1",
        org_id: "org-1",
        flags,
      },
    ]);
    vi.mocked(redlock.using).mockImplementation(
      async (_keys, _ttl, _options, fn) => fn({ aborted: false } as never),
    );
    vi.mocked(autumnService.getRateLimitMultiplier).mockResolvedValue(50);

    const auth = await authenticateUser(
      {
        headers: {
          authorization: "Bearer 00000000-0000-4000-8000-000000000000",
        },
        socket: { remoteAddress: "127.0.0.1" },
      },
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth.success).toBe(true);
    expect(autumnService.getRateLimitMultiplier).toHaveBeenCalledTimes(1);
    expect(getAutumnRateLimiter).toHaveBeenCalledWith(
      RateLimiterMode.Scrape,
      50,
      flags,
    );
  });

  it("leaves the preview token on the static rate limiter", async () => {
    config.USE_DB_AUTHENTICATION = true;
    config.PREVIEW_TOKEN = "preview-token";
    vi.mocked(getRateLimiter).mockReturnValue({
      consume: vi.fn().mockResolvedValue(undefined),
    } as never);

    const auth = await authenticateUser(
      {
        headers: { authorization: "Bearer preview-token" },
        socket: { remoteAddress: "127.0.0.1" },
      },
      {},
      RateLimiterMode.Scrape,
    );

    expect(auth.success).toBe(true);
    expect(getRateLimiter).toHaveBeenCalledWith(RateLimiterMode.Preview);
    expect(getAutumnRateLimiter).not.toHaveBeenCalled();
  });

  it("clears purpose-qualified and legacy ACUC cache entries", async () => {
    await clearACUC("api-key");

    expect(vi.mocked(deleteKey).mock.calls.map(([key]) => key)).toEqual(
      expect.arrayContaining([
        "acuc_api-key_extract",
        "acuc_api-key_scrape",
        "acuc_general_api-key_extract",
        "acuc_general_api-key_scrape",
        "acuc_hosted_mcp_oauth_api-key_extract",
        "acuc_hosted_mcp_oauth_api-key_scrape",
        "acuc_api-key",
      ]),
    );
  });
});
