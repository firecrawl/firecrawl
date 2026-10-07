import { vi } from "vitest";
import { createHmac } from "node:crypto";
import { authenticateUser, clearACUC, getACUCTeam } from "../auth";
import { config } from "../../config";
import { RateLimiterMode } from "../../types";
import {
  authCreditUsageChunk,
  authCreditUsageChunkFromTeam,
} from "../../db/rpc";
import { redlock } from "../../services/redlock";
import { deleteKey, getValue, setValue } from "../../services/redis";
import {
  getAutumnRateLimiter,
  getRateLimiter,
  HOBBY_RATE_LIMIT_MULTIPLIER,
} from "../../services/rate-limiter";
import {
  consumeKeylessRequest,
  isKeylessConfigured,
  keylessConversionCohort,
} from "../../lib/keyless";
import { decryptKeylessSignupToken } from "../../lib/keyless-signup-link";
import { logger } from "../../lib/logger";
import { isKeylessIpSuspicious } from "../../lib/spur";
import { trackKeylessPromptShown } from "../../lib/keyless-prompt-analytics";
import { db } from "../../db/connection";
import { autumnService } from "../../services/autumn/autumn.service";

vi.mock("../../services/queue-service", () => ({
  getRedisConnection: vi.fn(() => ({
    sadd: vi.fn(),
  })),
}));

vi.mock("uuid", async importOriginal => ({
  // keyless prompts derive their analytics team id with the real v5.
  ...(await importOriginal<typeof import("uuid")>()),
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

vi.mock("../../lib/keyless-prompt-analytics", () => ({
  trackKeylessPromptShown: vi.fn(),
}));

vi.mock("../../lib/spur", () => ({
  isKeylessIpSuspicious: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../services/autumn/autumn.service", () => ({
  DEFAULT_TEAM_LIMITS: {
    concurrency_limit: 2,
    rate_limit_multiplier: 1,
    is_paid_plan: false,
  },
  autumnService: {
    getTeamLimits: vi.fn(),
  },
}));

vi.mock("../../services/agent-sponsor", () => ({
  getAgentSponsorStatus: vi.fn(),
}));

function mockMultiplier(rate_limit_multiplier: number) {
  vi.mocked(autumnService.getTeamLimits).mockResolvedValue({
    concurrency_limit: 2,
    rate_limit_multiplier,
    is_paid_plan: false,
  });
}

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
  const originalAgentInteropSecret = config.AGENT_INTEROP_SECRET;
  const originalKeylessSignupLinkKeys = config.KEYLESS_SIGNUP_LINK_KEYS;

  beforeEach(() => {
    vi.mocked(isKeylessConfigured).mockReturnValue(false);
    mockMultiplier(1);
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
    config.AGENT_INTEROP_SECRET = originalAgentInteropSecret;
    config.KEYLESS_SIGNUP_LINK_KEYS = originalKeylessSignupLinkKeys;
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
        conversionCohort: keylessConversionCohort("203.0.113.8"),
      }),
    );
  });

  // The prompt a /k link carries, or null for any other link.
  const decodedLink = (url: unknown) => {
    const match = /^https:\/\/firecrawl\.dev\/k\/([0-9a-z]{12})$/.exec(
      String(url),
    );
    return match ? decryptKeylessSignupToken(match[1]) : null;
  };

  it("links every keyless prompt to the caller's own token, tagged with the prompt reason", async () => {
    config.USE_DB_AUTHENTICATION = true;
    config.KEYLESS_SIGNUP_LINK_KEYS = "AAECAwQFBgcICQoLDA0ODw==";
    vi.mocked(isKeylessConfigured).mockReturnValue(true);
    vi.mocked(consumeKeylessRequest).mockResolvedValue({
      ok: false,
      reason: "credits",
      requestsUsed: 1,
      creditsUsed: 100,
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const keylessRequest = () => ({
      headers: {},
      socket: { remoteAddress: "::ffff:203.0.113.8" },
    });

    const limited = await authenticateUser(
      keylessRequest(),
      {},
      RateLimiterMode.Scrape,
      { allowKeyless: true },
    );
    const unsupported = await authenticateUser(
      keylessRequest(),
      {},
      RateLimiterMode.Scrape,
      { allowKeyless: false },
    );
    vi.mocked(isKeylessIpSuspicious).mockResolvedValueOnce(true);
    const suspicious = await authenticateUser(
      keylessRequest(),
      {},
      RateLimiterMode.Scrape,
      { allowKeyless: true },
    );

    for (const [auth, status, reason] of [
      [limited, 429, "limit"],
      [unsupported, 401, "unsupported_endpoint"],
      [suspicious, 403, "suspicious_ip"],
    ] as const) {
      const signupUrl = (auth as { signupUrl?: string }).signupUrl;
      expect(decodedLink(signupUrl)).toEqual({
        ipv4: "203.0.113.8",
        surface: "api",
        reason,
      });
      expect(auth).toEqual(
        expect.objectContaining({
          success: false,
          status,
          // The URL is followed by whitespace, never punctuation.
          error: expect.stringContaining(
            `${signupUrl}${status === 429 ? "\n" : " "}`,
          ),
        }),
      );
      // Nothing about the surface or the identity is visible in the link.
      expect(signupUrl).not.toContain("utm_");
      expect((auth as { error: string }).error).not.toContain("203.0.113.8");
      // Each prompt is reported for the funnel, keyed on the web's team id.
      expect(trackKeylessPromptShown).toHaveBeenCalledWith({
        keylessTeamId: "abd15a03-d147-557e-801b-005da8c69bbf",
        surface: "api",
        reason,
        httpStatus: status,
        tokenLink: true,
      });
    }
    expect(trackKeylessPromptShown).toHaveBeenCalledTimes(3);
    for (const [message, auth] of [
      ["Keyless request blocked", limited],
      ["Keyless request blocked: suspicious IP", suspicious],
    ] as const) {
      expect(warn).toHaveBeenCalledWith(
        message,
        expect.objectContaining({
          signupRef: (auth as { signupUrl: string }).signupUrl.split("/k/")[1],
        }),
      );
    }
  });

  it.each([
    [{ integration: "cli" }, {}, "cli"],
    [{ origin: "mcp-cursor@3.24.1" }, {}, "mcp"],
    [{}, { "x-origin": "cli" }, "cli"],
    [{ origin: "js-sdk@4.3.0" }, {}, "api"],
  ] as const)(
    "tags the keyless limit link for body %j headers %j with the %s surface",
    async (body, headers, surface) => {
      config.USE_DB_AUTHENTICATION = true;
      config.KEYLESS_SIGNUP_LINK_KEYS = "AAECAwQFBgcICQoLDA0ODw==";
      vi.mocked(isKeylessConfigured).mockReturnValue(true);
      vi.mocked(consumeKeylessRequest).mockResolvedValue({
        ok: false,
        reason: "requests",
        requestsUsed: 11,
        creditsUsed: 0,
      });
      vi.spyOn(logger, "warn").mockImplementation(() => logger);

      const auth = await authenticateUser(
        { body, headers, socket: { remoteAddress: "203.0.113.8" } },
        {},
        RateLimiterMode.Scrape,
        { allowKeyless: true },
      );

      expect(decodedLink((auth as { signupUrl?: string }).signupUrl)).toEqual({
        ipv4: "203.0.113.8",
        surface,
        reason: "limit",
      });
    },
  );

  it("keys the hosted MCP's link on the forwarded end-user IP and the mcp surface", async () => {
    config.USE_DB_AUTHENTICATION = true;
    config.KEYLESS_PROXY_SECRET = "proxy-secret";
    config.KEYLESS_SIGNUP_LINK_KEYS = "AAECAwQFBgcICQoLDA0ODw==";
    vi.mocked(isKeylessConfigured).mockReturnValue(true);
    vi.mocked(consumeKeylessRequest).mockResolvedValue({
      ok: false,
      reason: "credits",
      requestsUsed: 1,
      creditsUsed: 100,
    });
    vi.spyOn(logger, "warn").mockImplementation(() => logger);

    const auth = await authenticateUser(
      {
        body: { origin: "api" },
        headers: {
          "x-firecrawl-keyless-secret": "proxy-secret",
          "x-firecrawl-keyless-ip": "198.51.100.7",
        },
        socket: { remoteAddress: "10.0.0.1" },
      },
      {},
      RateLimiterMode.Search,
      { allowKeyless: true },
    );

    expect(decodedLink((auth as { signupUrl?: string }).signupUrl)).toEqual({
      ipv4: "198.51.100.7",
      surface: "mcp",
      reason: "limit",
    });
  });

  it("falls back to the regular signup link and still returns the 429 when no key is configured", async () => {
    config.USE_DB_AUTHENTICATION = true;
    config.KEYLESS_SIGNUP_LINK_KEYS = undefined;
    vi.mocked(isKeylessConfigured).mockReturnValue(true);
    vi.mocked(consumeKeylessRequest).mockResolvedValue({
      ok: false,
      reason: "credits",
      requestsUsed: 1,
      creditsUsed: 100,
    });
    vi.spyOn(logger, "warn").mockImplementation(() => logger);

    const auth = await authenticateUser(
      { headers: {}, socket: { remoteAddress: "203.0.113.8" } },
      {},
      RateLimiterMode.Scrape,
      { allowKeyless: true },
    );

    expect(auth).toEqual(
      expect.objectContaining({
        status: 429,
        signupUrl:
          "https://www.firecrawl.dev/signin?utm_source=keyless&utm_medium=api",
        error: expect.stringContaining(
          "https://www.firecrawl.dev/signin?utm_source=keyless&utm_medium=api\n",
        ),
      }),
    );
  });

  it("gives a non-IPv4 caller on an unsupported endpoint the regular signup link", async () => {
    config.USE_DB_AUTHENTICATION = true;
    config.KEYLESS_SIGNUP_LINK_KEYS = "AAECAwQFBgcICQoLDA0ODw==";
    vi.mocked(isKeylessConfigured).mockReturnValue(true);

    const auth = await authenticateUser(
      { headers: {}, socket: { remoteAddress: "2001:db8::1" } },
      {},
      RateLimiterMode.Crawl,
      { allowKeyless: false },
    );

    expect(auth).toEqual(
      expect.objectContaining({
        status: 401,
        signupUrl:
          "https://www.firecrawl.dev/signin?utm_source=keyless&utm_medium=api",
      }),
    );
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
    mockMultiplier(1);
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
    mockMultiplier(1);
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
    // The team's limits may come from the team ACUC, but the credential's
    // own ACUC is never read from or written to Redis.
    expect(getValue).not.toHaveBeenCalledWith(
      expect.stringMatching(/^acuc_(general|hosted_mcp_oauth)_/),
    );
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
    mockMultiplier(50);

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
    // The override replaces the whole base × multiplier computation, so a
    // neutral 1 is passed instead of the team's multiplier.
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
    mockMultiplier(50);

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
    expect(autumnService.getTeamLimits).toHaveBeenCalledTimes(1);
    expect(getAutumnRateLimiter).toHaveBeenCalledWith(
      RateLimiterMode.Scrape,
      50,
      flags,
    );
  });

  describe("agent interop rate-limit floor", () => {
    const flags = {};
    const agentRequest = (auth: string) => ({
      headers: {
        authorization: "Bearer 00000000-0000-4000-8000-000000000000",
      },
      socket: { remoteAddress: "127.0.0.1" },
      body: { __agentInterop: { auth, requestId: "req-1", shouldBill: true } },
    });

    beforeEach(() => {
      config.USE_DB_AUTHENTICATION = true;
      config.AGENT_INTEROP_SECRET = "agent-secret";
      vi.mocked(getValue).mockResolvedValue(null);
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
    });

    it("floors a free team's multiplier at hobby for a trusted agent request", async () => {
      mockMultiplier(1);

      const auth = await authenticateUser(
        agentRequest("agent-secret"),
        {},
        RateLimiterMode.Scrape,
      );

      expect(auth.success).toBe(true);
      expect(getAutumnRateLimiter).toHaveBeenCalledWith(
        RateLimiterMode.Scrape,
        HOBBY_RATE_LIMIT_MULTIPLIER,
        flags,
      );
    });

    it("leaves a paid plan's multiplier alone for a trusted agent request", async () => {
      mockMultiplier(50);

      await authenticateUser(
        agentRequest("agent-secret"),
        {},
        RateLimiterMode.Scrape,
      );

      expect(getAutumnRateLimiter).toHaveBeenCalledWith(
        RateLimiterMode.Scrape,
        50,
        flags,
      );
    });

    it("does not floor the multiplier when the agent interop secret is wrong", async () => {
      mockMultiplier(1);

      await authenticateUser(
        agentRequest("not-the-secret"),
        {},
        RateLimiterMode.Scrape,
      );

      expect(getAutumnRateLimiter).toHaveBeenCalledWith(
        RateLimiterMode.Scrape,
        1,
        flags,
      );
    });

    it("does not floor the multiplier when no agent interop secret is configured", async () => {
      config.AGENT_INTEROP_SECRET = undefined;
      mockMultiplier(1);

      await authenticateUser(
        agentRequest("agent-secret"),
        {},
        RateLimiterMode.Scrape,
      );

      expect(getAutumnRateLimiter).toHaveBeenCalledWith(
        RateLimiterMode.Scrape,
        1,
        flags,
      );
    });

    it("lets a per-team override win over the floor for a trusted agent request", async () => {
      const overrideFlags = { rateLimitOverrides: { scrape: 42 } };
      vi.mocked(authCreditUsageChunk).mockResolvedValue([
        {
          api_key: "00000000-0000-4000-8000-000000000000",
          api_key_id: 1,
          team_id: "team-1",
          org_id: "org-1",
          flags: overrideFlags,
        },
      ]);
      mockMultiplier(1);

      await authenticateUser(
        agentRequest("agent-secret"),
        {},
        RateLimiterMode.Scrape,
      );

      // The override replaces the whole base × multiplier computation, so the
      // floor never applies.
      expect(getAutumnRateLimiter).toHaveBeenCalledWith(
        RateLimiterMode.Scrape,
        1,
        overrideFlags,
      );
    });
  });

  describe("agent-managed key fallback", () => {
    const managedKey = "22222222-2222-4222-8222-222222222222";
    const managedRow = {
      api_key: managedKey,
      api_key_id: 7,
      team_id: "team-mcp",
      org_id: "org-mcp",
      flags: null,
      credential_purpose: "hosted_mcp_oauth",
    };
    const request = ({
      key = managedKey,
      body,
      headers = {},
    }: {
      key?: string;
      body?: unknown;
      headers?: Record<string, unknown>;
    } = {}) => ({
      headers: { authorization: `Bearer ${key}`, ...headers },
      socket: { remoteAddress: "127.0.0.1" },
      body,
    });
    const interopBody = (auth: string) => ({
      __agentInterop: { auth, requestId: "req-1", shouldBill: true },
    });
    const allow = { allowAgentManagedKey: true };
    const lookupsFor = (purpose: string) =>
      vi
        .mocked(authCreditUsageChunk)
        .mock.calls.filter(([, , p]) => (p ?? "general") === purpose);

    beforeEach(() => {
      config.USE_DB_AUTHENTICATION = true;
      config.AGENT_INTEROP_SECRET = "agent-secret";
      vi.mocked(getValue).mockResolvedValue(null);
      vi.mocked(redlock.using).mockImplementation(
        async (_keys, _ttl, _options, fn) => fn({ aborted: false } as never),
      );
      // Mirrors auth_chunk_2: a row only when the key's purpose matches.
      vi.mocked(authCreditUsageChunk).mockImplementation(
        async (_db, key, purpose = "general") =>
          key === managedKey && purpose === "hosted_mcp_oauth"
            ? [{ ...managedRow }]
            : [],
      );
    });

    it("rejects a hosted_mcp_oauth key without agent interop", async () => {
      const auth = await authenticateUser(
        request(),
        {},
        RateLimiterMode.Browser,
        allow,
      );

      expect(auth).toEqual({
        success: false,
        error: "Unauthorized: Invalid token",
        status: 401,
      });
      expect(lookupsFor("hosted_mcp_oauth")).toHaveLength(0);
    });

    it("accepts a hosted_mcp_oauth key with a valid interop body", async () => {
      const auth = await authenticateUser(
        request({ body: interopBody("agent-secret") }),
        {},
        RateLimiterMode.Browser,
        allow,
      );

      expect(auth).toEqual(
        expect.objectContaining({
          success: true,
          team_id: "team-mcp",
          org_id: "org-mcp",
        }),
      );
      if (!auth.success) throw new Error("expected fallback auth to succeed");
      expect(auth.chunk?.api_key).toBe(managedKey);
      // The managed lookup reads the primary and never touches the cache.
      expect(authCreditUsageChunk).toHaveBeenLastCalledWith(
        db,
        managedKey,
        "hosted_mcp_oauth",
      );
      expect(setValue).not.toHaveBeenCalledWith(
        expect.stringContaining("hosted_mcp_oauth"),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("accepts a hosted_mcp_oauth key with a valid interop header on a bodiless call", async () => {
      const auth = await authenticateUser(
        request({ headers: { "x-firecrawl-agent-interop": "agent-secret" } }),
        {},
        RateLimiterMode.BrowserExecute,
        allow,
      );

      expect(auth).toEqual(
        expect.objectContaining({ success: true, team_id: "team-mcp" }),
      );
    });

    it("still bills and rate-limits against the key's own team", async () => {
      const consume = vi.fn().mockResolvedValue(undefined);
      vi.mocked(getAutumnRateLimiter).mockReturnValue({ consume } as never);

      await authenticateUser(
        request({ body: interopBody("agent-secret") }),
        {},
        RateLimiterMode.Browser,
        allow,
      );

      expect(autumnService.getTeamLimits).toHaveBeenCalledWith(
        "team-mcp",
        "org-mcp",
      );
      expect(consume).toHaveBeenCalledWith("team-mcp");
    });

    it.each([
      ["body", { body: interopBody("not-the-secret") }],
      [
        "header",
        { headers: { "x-firecrawl-agent-interop": "not-the-secret" } },
      ],
      [
        "repeated header",
        { headers: { "x-firecrawl-agent-interop": ["agent-secret"] } },
      ],
    ])("rejects a wrong interop secret in the %s", async (_where, parts) => {
      const auth = await authenticateUser(
        request(parts),
        {},
        RateLimiterMode.Browser,
        allow,
      );

      expect(auth).toEqual(expect.objectContaining({ status: 401 }));
      expect(lookupsFor("hosted_mcp_oauth")).toHaveLength(0);
    });

    it("rejects when no interop secret is configured", async () => {
      config.AGENT_INTEROP_SECRET = undefined;

      const auth = await authenticateUser(
        request({ body: interopBody("agent-secret") }),
        {},
        RateLimiterMode.Browser,
        allow,
      );

      expect(auth).toEqual(expect.objectContaining({ status: 401 }));
      expect(lookupsFor("hosted_mcp_oauth")).toHaveLength(0);
    });

    it("rejects on a route that has not opted in", async () => {
      const auth = await authenticateUser(
        request({ body: interopBody("agent-secret") }),
        {},
        RateLimiterMode.Crawl,
      );

      expect(auth).toEqual(expect.objectContaining({ status: 401 }));
      expect(lookupsFor("hosted_mcp_oauth")).toHaveLength(0);
    });

    it("rejects an unknown or revoked key even with valid interop", async () => {
      // Revoking a grant deletes its managed key, so both lookups miss.
      const auth = await authenticateUser(
        request({
          key: "33333333-3333-4333-8333-333333333333",
          body: interopBody("agent-secret"),
        }),
        {},
        RateLimiterMode.Browser,
        allow,
      );

      expect(auth).toEqual({
        success: false,
        error: "Unauthorized: Invalid token",
        status: 401,
      });
      expect(lookupsFor("hosted_mcp_oauth")).toHaveLength(1);
    });

    it("still rejects a banned team reached through the fallback", async () => {
      vi.mocked(authCreditUsageChunk).mockImplementation(
        async (_db, key, purpose = "general") =>
          key === managedKey && purpose === "hosted_mcp_oauth"
            ? [{ ...managedRow, is_banned: true }]
            : [],
      );

      const auth = await authenticateUser(
        request({ body: interopBody("agent-secret") }),
        {},
        RateLimiterMode.Browser,
        allow,
      );

      expect(auth).toEqual(expect.objectContaining({ status: 403 }));
    });

    it("resolves a general key through the general lookup only", async () => {
      const generalKey = "00000000-0000-4000-8000-000000000000";
      vi.mocked(authCreditUsageChunk).mockImplementation(
        async (_db, key, purpose = "general") =>
          key === generalKey && purpose === "general"
            ? [{ ...managedRow, api_key: generalKey, team_id: "team-1" }]
            : [],
      );

      for (const parts of [{}, { body: interopBody("agent-secret") }]) {
        const auth = await authenticateUser(
          request({ key: generalKey, ...parts }),
          {},
          RateLimiterMode.Browser,
          allow,
        );
        expect(auth).toEqual(
          expect.objectContaining({ success: true, team_id: "team-1" }),
        );
      }
      expect(lookupsFor("hosted_mcp_oauth")).toHaveLength(0);
    });

    it("takes the team only from the key's row, never from the request", async () => {
      const consume = vi.fn().mockResolvedValue(undefined);
      vi.mocked(getAutumnRateLimiter).mockReturnValue({ consume } as never);

      const auth = await authenticateUser(
        request({
          body: {
            team_id: "attacker-team",
            teamId: "attacker-team",
            __agentInterop: {
              auth: "agent-secret",
              requestId: "req-1",
              shouldBill: true,
              team_id: "attacker-team",
              teamId: "attacker-team",
            },
          },
          headers: {
            "x-firecrawl-team-id": "attacker-team",
            "x-team-id": "attacker-team",
          },
        }),
        {},
        RateLimiterMode.Browser,
        allow,
      );

      expect(auth).toEqual(
        expect.objectContaining({
          success: true,
          team_id: "team-mcp",
          org_id: "org-mcp",
        }),
      );
      if (!auth.success) throw new Error("expected fallback auth to succeed");
      expect(auth.chunk?.team_id).toBe("team-mcp");
      expect(autumnService.getTeamLimits).toHaveBeenCalledWith(
        "team-mcp",
        "org-mcp",
      );
      expect(consume).toHaveBeenCalledWith("team-mcp");
      expect(JSON.stringify(auth)).not.toContain("attacker-team");
    });

    it("leaves shouldBill: false untouched for the controllers", async () => {
      const body = {
        __agentInterop: {
          auth: "agent-secret",
          requestId: "req-1",
          shouldBill: false,
        },
      };
      const req = request({ body });

      const auth = await authenticateUser(
        req,
        {},
        RateLimiterMode.Scrape,
        allow,
      );

      // Auth resolves the team as for a billed request and never rewrites the
      // block; scrape/search/batch-scrape/parse read shouldBill from it later.
      expect(auth).toEqual(
        expect.objectContaining({ success: true, team_id: "team-mcp" }),
      );
      expect(req.body).toBe(body);
      expect(body.__agentInterop).toEqual({
        auth: "agent-secret",
        requestId: "req-1",
        shouldBill: false,
      });
    });

    it("treats shouldBill: false on a general key exactly as before", async () => {
      const generalKey = "00000000-0000-4000-8000-000000000000";
      vi.mocked(authCreditUsageChunk).mockImplementation(
        async (_db, key, purpose = "general") =>
          key === generalKey && purpose === "general"
            ? [{ ...managedRow, api_key: generalKey, team_id: "team-1" }]
            : [],
      );

      const results: Awaited<ReturnType<typeof authenticateUser>>[] = [];
      for (const shouldBill of [true, false]) {
        results.push(
          await authenticateUser(
            request({
              key: generalKey,
              body: {
                __agentInterop: {
                  auth: "agent-secret",
                  requestId: "req-1",
                  shouldBill,
                },
              },
            }),
            {},
            RateLimiterMode.Scrape,
            allow,
          ),
        );
      }

      expect(results[0]).toEqual(results[1]);
      expect(results[1]).toEqual(
        expect.objectContaining({ success: true, team_id: "team-1" }),
      );
      expect(lookupsFor("hosted_mcp_oauth")).toHaveLength(0);
    });

    it("floors the rate multiplier for a header-only trusted request", async () => {
      await authenticateUser(
        request({ headers: { "x-firecrawl-agent-interop": "agent-secret" } }),
        {},
        RateLimiterMode.BrowserExecute,
        allow,
      );

      expect(getAutumnRateLimiter).toHaveBeenCalledWith(
        RateLimiterMode.BrowserExecute,
        HOBBY_RATE_LIMIT_MULTIPLIER,
        null,
      );
    });
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

  it("treats a malformed team ACUC cache entry as a miss", async () => {
    config.USE_DB_AUTHENTICATION = true;
    vi.mocked(getValue).mockResolvedValue("{not-json");
    vi.mocked(deleteKey).mockResolvedValue(undefined);
    vi.mocked(authCreditUsageChunkFromTeam).mockResolvedValue([
      { team_id: "team-1", org_id: "org-1" },
    ] as never);

    // The DB answers, rather than the corrupt entry failing the caller: every
    // `.catch(() => null)` on this lookup would otherwise fail open.
    await expect(getACUCTeam("team-1")).resolves.toMatchObject({
      team_id: "team-1",
      org_id: "org-1",
    });
    expect(authCreditUsageChunkFromTeam).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(deleteKey).toHaveBeenCalledWith("acuc_team_team-1_scrape"),
    );
  });

  describe("Autumn limits on the ACUC", () => {
    const apiKey = "00000000-0000-4000-8000-000000000000";
    const keyRow = {
      api_key: apiKey,
      api_key_id: 1,
      team_id: "team-1",
      org_id: "org-1",
      flags: null,
    };
    const known = {
      concurrency_limit: 7,
      rate_limit_multiplier: 25,
      is_paid_plan: false,
    };
    const failOpen = {
      concurrency_limit: 200,
      rate_limit_multiplier: 2500,
      is_paid_plan: true,
    };
    const authRequest = {
      headers: { authorization: `Bearer ${apiKey}` },
      socket: { remoteAddress: "127.0.0.1" },
    };

    beforeEach(() => {
      config.USE_DB_AUTHENTICATION = true;
      vi.mocked(getValue).mockResolvedValue(null);
      vi.mocked(redlock.using).mockImplementation(
        async (_keys, _ttl, _options, fn) => fn({ aborted: false } as never),
      );
      vi.mocked(authCreditUsageChunk).mockImplementation(
        async () => [{ ...keyRow }] as never,
      );
      vi.mocked(authCreditUsageChunkFromTeam).mockImplementation(
        async () => [{ ...keyRow }] as never,
      );
    });

    it("builds the key ACUC with the team's limits and caches it for the full TTL", async () => {
      vi.mocked(autumnService.getTeamLimits).mockResolvedValue(known);

      const auth = await authenticateUser(
        authRequest,
        {},
        RateLimiterMode.Scrape,
      );

      expect(auth.success).toBe(true);
      expect(autumnService.getTeamLimits).toHaveBeenCalledTimes(1);
      expect(autumnService.getTeamLimits).toHaveBeenCalledWith(
        "team-1",
        "org-1",
      );
      expect(getAutumnRateLimiter).toHaveBeenCalledWith(
        RateLimiterMode.Scrape,
        25,
        null,
      );
      await vi.waitFor(() => expect(setValue).toHaveBeenCalled());
      const [key, value, ttl] = vi.mocked(setValue).mock.calls[0];
      expect(key).toBe(`acuc_general_${apiKey}_scrape`);
      expect(JSON.parse(value)).toMatchObject(known);
      expect(ttl).toBe(600);
    });

    it("puts the fail-open limits on the chunk and caches it only briefly when Autumn fails", async () => {
      vi.mocked(autumnService.getTeamLimits).mockRejectedValue(
        new Error("Autumn down"),
      );

      await authenticateUser(authRequest, {}, RateLimiterMode.Scrape);

      expect(getAutumnRateLimiter).toHaveBeenCalledWith(
        RateLimiterMode.Scrape,
        2500,
        null,
      );
      await vi.waitFor(() => expect(setValue).toHaveBeenCalled());
      const [, value, ttl] = vi.mocked(setValue).mock.calls[0];
      expect(JSON.parse(value)).toMatchObject(failOpen);
      expect(ttl).toBe(60);
    });

    it("reads the limits off a cached ACUC without asking Autumn", async () => {
      vi.mocked(getValue).mockResolvedValue(
        JSON.stringify({ ...keyRow, ...known }),
      );

      await authenticateUser(authRequest, {}, RateLimiterMode.Scrape);

      expect(autumnService.getTeamLimits).not.toHaveBeenCalled();
      expect(getAutumnRateLimiter).toHaveBeenCalledWith(
        RateLimiterMode.Scrape,
        25,
        null,
      );
    });

    it("fills a cached ACUC that predates the limits with one live read, writing nothing back", async () => {
      vi.mocked(getValue).mockResolvedValue(JSON.stringify(keyRow));
      vi.mocked(autumnService.getTeamLimits).mockResolvedValue(known);

      await expect(getACUCTeam("team-1")).resolves.toMatchObject(known);

      expect(autumnService.getTeamLimits).toHaveBeenCalledTimes(1);
      expect(setValue).not.toHaveBeenCalled();
    });

    it("fills a cached ACUC that predates is_paid_plan with one live read", async () => {
      vi.mocked(getValue).mockResolvedValue(
        JSON.stringify({
          ...keyRow,
          concurrency_limit: 7,
          rate_limit_multiplier: 25,
        }),
      );
      vi.mocked(autumnService.getTeamLimits).mockResolvedValue({
        ...known,
        is_paid_plan: true,
      });

      await expect(getACUCTeam("team-1")).resolves.toMatchObject({
        is_paid_plan: true,
      });
      expect(autumnService.getTeamLimits).toHaveBeenCalledTimes(1);
    });

    it("builds the team ACUC with the fail-open limits cached only briefly", async () => {
      vi.mocked(autumnService.getTeamLimits).mockRejectedValue(
        new Error("Autumn down"),
      );

      await expect(getACUCTeam("team-1")).resolves.toMatchObject(failOpen);

      await vi.waitFor(() => expect(setValue).toHaveBeenCalled());
      const [key, value, ttl] = vi.mocked(setValue).mock.calls[0];
      expect(key).toBe("acuc_team_team-1_scrape");
      expect(JSON.parse(value)).toMatchObject(failOpen);
      expect(ttl).toBe(60);
    });

    it("builds a new chunk instead of mutating the row it read", async () => {
      const row = { ...keyRow };
      vi.mocked(authCreditUsageChunkFromTeam).mockResolvedValue([row] as never);
      vi.mocked(autumnService.getTeamLimits).mockResolvedValue(known);

      await expect(getACUCTeam("team-1")).resolves.toMatchObject(known);
      expect(row).toEqual(keyRow);
    });

    it("gives an uncached key chunk the team ACUC's limits without asking Autumn", async () => {
      config.MCP_DELEGATED_CREDENTIAL_SECRET = "mcp-delegation-secret";
      vi.mocked(getValue).mockImplementation(async key =>
        key === "acuc_team_team-1_scrape"
          ? JSON.stringify({ ...keyRow, ...known })
          : null,
      );

      await authenticateUser(
        {
          headers: { authorization: `Bearer ${signDelegation()}` },
          socket: { remoteAddress: "127.0.0.1" },
        },
        {},
        RateLimiterMode.Scrape,
      );

      expect(autumnService.getTeamLimits).not.toHaveBeenCalled();
      expect(getAutumnRateLimiter).toHaveBeenCalledWith(
        RateLimiterMode.Scrape,
        25,
        null,
      );
    });
  });

  describe("auth/denied log", () => {
    const unknownKey = "fc-3c9a0d5e7b1f4a2c8d6e9f0a1b2c3d4e";
    const clientIp = "198.51.100.23";

    const deniedLines = () =>
      (vi.mocked(logger.warn).mock.calls as unknown as [string, any][])
        .filter(([, meta]) => meta?.canonicalLog === "auth/denied")
        .map(([message, meta]) => ({ message, meta }));

    beforeEach(() => {
      config.USE_DB_AUTHENTICATION = true;
      vi.mocked(getValue).mockResolvedValue(null);
      vi.mocked(authCreditUsageChunk).mockResolvedValue([]);
      vi.mocked(redlock.using).mockImplementation(
        async (_keys, _ttl, _options, fn) => fn({ aborted: false } as never),
      );
      vi.spyOn(logger, "warn").mockImplementation(() => logger);
    });

    it.each([
      ["missing_credentials", {}, "Unauthorized"],
      [
        "malformed_authorization",
        { authorization: "Bearer" },
        "Unauthorized: Token missing",
      ],
      [
        "malformed_key",
        { authorization: "Bearer not-a-real-key" },
        "Unauthorized: Invalid token",
      ],
      [
        "unknown_key",
        { authorization: `Bearer ${unknownKey}` },
        "Unauthorized: Invalid token",
      ],
    ] as const)(
      "logs one %s line and returns the same 401",
      async (reason, headers, error) => {
        const auth = await authenticateUser(
          {
            method: "POST",
            baseUrl: "/v2",
            path: "/scrape",
            route: { path: "/scrape" },
            headers,
            socket: { remoteAddress: clientIp },
          },
          {},
          RateLimiterMode.Scrape,
        );

        expect(auth).toEqual({ success: false, error, status: 401 });
        expect(deniedLines()).toEqual([
          {
            message: "Request denied",
            meta: {
              canonicalLog: "auth/denied",
              reason,
              status: 401,
              method: "POST",
              route: "/v2/scrape",
            },
          },
        ]);
      },
    );

    it("redacts the admin secret from an admin route", async () => {
      const originalBullAuthKey = config.BULL_AUTH_KEY;
      config.BULL_AUTH_KEY = "bull-admin-secret";
      try {
        await authenticateUser(
          {
            method: "POST",
            baseUrl: "",
            path: "/admin/bull-admin-secret/crawl-monitor",
            route: { path: "/admin/bull-admin-secret/crawl-monitor" },
            headers: { authorization: `Bearer ${unknownKey}` },
            socket: { remoteAddress: clientIp },
          },
          {},
          RateLimiterMode.Crawl,
        );
      } finally {
        config.BULL_AUTH_KEY = originalBullAuthKey;
      }

      expect(deniedLines()).toEqual([
        expect.objectContaining({
          meta: expect.objectContaining({
            reason: "unknown_key",
            route: "/admin/:bullAuthKey/crawl-monitor",
          }),
        }),
      ]);
      expect(JSON.stringify(deniedLines())).not.toContain("bull-admin-secret");
    });

    it("names the team and key id of a banned team's key", async () => {
      vi.mocked(authCreditUsageChunk).mockResolvedValue([
        {
          api_key: "00000000-0000-4000-8000-000000000000",
          api_key_id: 9,
          team_id: "team-banned",
          org_id: "org-1",
          is_banned: true,
          flags: null,
        },
      ]);

      const auth = await authenticateUser(
        {
          headers: {
            authorization: "Bearer 00000000-0000-4000-8000-000000000000",
          },
          socket: { remoteAddress: clientIp },
        },
        {},
        RateLimiterMode.Scrape,
      );

      expect(auth).toEqual(expect.objectContaining({ status: 403 }));
      expect(deniedLines()).toEqual([
        {
          message: "Request denied",
          meta: {
            canonicalLog: "auth/denied",
            reason: "team_banned",
            status: 403,
            teamId: "team-banned",
            apiKeyId: 9,
          },
        },
      ]);
    });

    it("never logs the credential, the Authorization header, or the client IP", async () => {
      await authenticateUser(
        {
          headers: {
            authorization: `Bearer ${unknownKey}`,
            "x-forwarded-for": clientIp,
          },
          socket: { remoteAddress: clientIp },
          ip: clientIp,
        },
        {},
        RateLimiterMode.Scrape,
      );

      const logged = JSON.stringify(deniedLines());
      expect(deniedLines()).toHaveLength(1);
      expect(logged).not.toContain(unknownKey.slice(3, 11));
      expect(logged).not.toContain(unknownKey.slice(-8));
      expect(logged).not.toContain("Bearer");
      expect(logged).not.toContain(clientIp);
    });

    it("logs a suspicious keyless IP as denied but not a keyless quota 429", async () => {
      vi.mocked(isKeylessConfigured).mockReturnValue(true);
      vi.mocked(isKeylessIpSuspicious).mockResolvedValueOnce(true);
      const keylessRequest = () => ({
        headers: {},
        socket: { remoteAddress: "203.0.113.8" },
      });

      const suspicious = await authenticateUser(
        keylessRequest(),
        {},
        RateLimiterMode.Scrape,
        { allowKeyless: true },
      );
      vi.mocked(consumeKeylessRequest).mockResolvedValue({
        ok: false,
        reason: "requests",
        requestsUsed: 10,
        creditsUsed: 2,
      });
      const limited = await authenticateUser(
        keylessRequest(),
        {},
        RateLimiterMode.Scrape,
        { allowKeyless: true },
      );

      expect(suspicious).toEqual(expect.objectContaining({ status: 403 }));
      expect(limited).toEqual(expect.objectContaining({ status: 429 }));
      expect(deniedLines()).toEqual([
        {
          message: "Request denied",
          meta: {
            canonicalLog: "auth/denied",
            reason: "keyless_ip_suspicious",
            status: 403,
          },
        },
      ]);
    });
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
