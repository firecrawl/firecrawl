import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getOAuthTokenCacheState,
  hashOAuthToken,
  isOAuthTokenRevoked,
  setOAuthTokenCache,
} = vi.hoisted(() => ({
  getOAuthTokenCacheState: vi.fn(),
  hashOAuthToken: vi.fn(() => "a".repeat(64)),
  isOAuthTokenRevoked: vi.fn(),
  setOAuthTokenCache: vi.fn(),
}));

vi.mock("./oauth-token-cache", () => ({
  getOAuthTokenCacheState,
  hashOAuthToken,
  isOAuthTokenRevoked,
  setOAuthTokenCache,
}));

import {
  FIRECRAWL_REST_RESOURCE,
  resolveOAuthToken,
} from "./oauth-token-introspection";

const ACTIVE = {
  active: true,
  api_key: "fc-test",
  scope: "firecrawl:global",
  client_id: "client-1",
  team_id: "team-1",
  exp: Math.floor(Date.now() / 1000) + 3600,
  aud: FIRECRAWL_REST_RESOURCE,
};

describe("OAuth token introspection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOAuthTokenCacheState.mockResolvedValue({ revoked: false, cached: null });
    isOAuthTokenRevoked.mockResolvedValue(false);
    setOAuthTokenCache.mockResolvedValue(undefined);
  });

  it("never uses a cached positive result when a tombstone exists", async () => {
    getOAuthTokenCacheState.mockResolvedValue({ revoked: true, cached: null });
    const fetchFn = vi.fn();
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: "https://api.firecrawl.dev/",
        fetchFn,
      }),
    ).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("re-checks revocation immediately before returning cached active data", async () => {
    getOAuthTokenCacheState.mockResolvedValue({
      revoked: false,
      cached: JSON.stringify(ACTIVE),
    });
    isOAuthTokenRevoked.mockResolvedValue(true);
    const fetchFn = vi.fn();
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: "https://api.firecrawl.dev/",
        fetchFn,
      }),
    ).resolves.toBeNull();
    expect(isOAuthTokenRevoked).toHaveBeenCalledWith("a".repeat(64));
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects a cached active token for an MCP audience", async () => {
    getOAuthTokenCacheState.mockResolvedValue({
      revoked: false,
      cached: JSON.stringify({
        ...ACTIVE,
        aud: "https://mcp.firecrawl.dev/v2/mcp",
      }),
    });
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: "https://api.firecrawl.dev/",
      }),
    ).resolves.toBeNull();
  });

  it("rejects truthy non-boolean active values from cache", async () => {
    getOAuthTokenCacheState.mockResolvedValue({
      revoked: false,
      cached: JSON.stringify({ ...ACTIVE, active: "false" }),
    });
    const fetchFn = vi.fn();

    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: FIRECRAWL_REST_RESOURCE,
        fetchFn,
      }),
    ).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects cached tokens whose embedded expiry has passed", async () => {
    getOAuthTokenCacheState.mockResolvedValue({
      revoked: false,
      cached: JSON.stringify({
        ...ACTIVE,
        exp: Math.floor(Date.now() / 1000) - 1,
      }),
    });

    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: FIRECRAWL_REST_RESOURCE,
      }),
    ).resolves.toBeNull();
    expect(isOAuthTokenRevoked).not.toHaveBeenCalled();
  });

  it("rejects a result revoked while introspection is in flight", async () => {
    let finish: (() => void) | undefined;
    const fetchFn = vi.fn(
      () =>
        new Promise<Response>(resolve => {
          finish = () =>
            resolve(
              new Response(JSON.stringify(ACTIVE), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
            );
        }),
    );
    const resolving = resolveOAuthToken("fco_token", {
      introspectUrl: "https://example.test/introspect",
      introspectSecret: "secret",
      expectedResource: "https://api.firecrawl.dev/",
      fetchFn,
    });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    isOAuthTokenRevoked.mockResolvedValue(true);
    finish?.();
    await expect(resolving).resolves.toBeNull();
    expect(setOAuthTokenCache).not.toHaveBeenCalled();
  });

  it("aborts introspection after ten seconds", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    const resolving = resolveOAuthToken("fco_token", {
      introspectUrl: "https://example.test/introspect",
      introspectSecret: "secret",
      expectedResource: "https://api.firecrawl.dev/",
      fetchFn,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(resolving).resolves.toBeNull();
    expect(fetchFn.mock.calls[0][1]?.signal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("sends and enforces the canonical REST resource", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...ACTIVE,
          aud: "https://mcp.firecrawl.dev/v2/mcp-oauth",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: "https://api.firecrawl.dev/",
        fetchFn,
      }),
    ).resolves.toBeNull();
    expect(JSON.parse(fetchFn.mock.calls[0][1]?.body as string)).toEqual({
      token: "fco_token",
      resource: "https://api.firecrawl.dev/",
    });
    expect(setOAuthTokenCache).not.toHaveBeenCalled();
  });

  it("accepts a legacy active response with no audience as REST-compatible", async () => {
    const { aud: _aud, ...legacy } = ACTIVE;
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(legacy), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: "https://api.firecrawl.dev/",
        fetchFn,
      }),
    ).resolves.toEqual(legacy);
  });

  it("accepts a cached legacy response with no audience for REST", async () => {
    const { aud: _aud, ...legacy } = ACTIVE;
    getOAuthTokenCacheState.mockResolvedValue({
      revoked: false,
      cached: JSON.stringify(legacy),
    });

    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: FIRECRAWL_REST_RESOURCE,
      }),
    ).resolves.toEqual(legacy);
  });

  it("rejects a cached response with no audience for an MCP resource", async () => {
    const { aud: _aud, ...legacy } = ACTIVE;
    getOAuthTokenCacheState.mockResolvedValue({
      revoked: false,
      cached: JSON.stringify(legacy),
    });

    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: "https://mcp.firecrawl.dev/v2/mcp",
      }),
    ).resolves.toBeNull();
  });

  it("rejects a fresh response with no audience for an MCP resource", async () => {
    const { aud: _aud, ...legacy } = ACTIVE;
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(legacy), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: "https://mcp.firecrawl.dev/v2/mcp",
        fetchFn,
      }),
    ).resolves.toBeNull();
    expect(setOAuthTokenCache).not.toHaveBeenCalled();
  });

  it("caches active introspection for at most 300 seconds", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(ACTIVE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: "https://api.firecrawl.dev/",
        fetchFn,
      }),
    ).resolves.toEqual(ACTIVE);
    expect(setOAuthTokenCache).toHaveBeenCalledWith(
      "a".repeat(64),
      JSON.stringify(ACTIVE),
      300,
    );
  });

  it("caches inactive introspection for 60 seconds", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ active: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: "https://api.firecrawl.dev/",
        fetchFn,
      }),
    ).resolves.toBeNull();
    expect(setOAuthTokenCache).toHaveBeenCalledWith(
      "a".repeat(64),
      JSON.stringify({ active: false }),
      60,
    );
  });

  it("fails closed on a truthy non-boolean active response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...ACTIVE, active: "false" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: FIRECRAWL_REST_RESOURCE,
        fetchFn,
      }),
    ).resolves.toBeNull();
    expect(setOAuthTokenCache).toHaveBeenCalledWith(
      "a".repeat(64),
      JSON.stringify({ active: false }),
      60,
    );
  });
});
