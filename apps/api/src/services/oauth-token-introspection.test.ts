import { beforeEach, describe, expect, it, vi } from "vitest";

const { getValue, setValue } = vi.hoisted(() => ({
  getValue: vi.fn(),
  setValue: vi.fn(),
}));

vi.mock("./redis", () => ({ getValue, setValue }));

import {
  FIRECRAWL_REST_RESOURCE,
  OAuthIntrospectionUnavailableError,
  resolveOAuthToken,
} from "./oauth-token-introspection";

const ACTIVE = {
  active: true,
  api_key: "fc-11111111111111118111111111111111",
  scope: "firecrawl:global",
  client_id: "client-1",
  team_id: "team-1",
  exp: Math.floor(Date.now() / 1000) + 3600,
  aud: FIRECRAWL_REST_RESOURCE,
  credential_purpose: "general" as const,
};

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OAuth token introspection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getValue.mockResolvedValue(null);
    setValue.mockResolvedValue(undefined);
  });

  it("sends and enforces the expected resource", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        response({ ...ACTIVE, aud: "https://mcp.firecrawl.dev/v2/mcp" }),
      );
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: FIRECRAWL_REST_RESOURCE,
        fetchFn,
      }),
    ).resolves.toBeNull();
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({
      token: "fco_token",
      resource: FIRECRAWL_REST_RESOURCE,
    });
  });

  it("keeps legacy audience-less REST tokens compatible", async () => {
    const { aud: _aud, credential_purpose: _purpose, ...legacy } = ACTIVE;
    const fetchFn = vi.fn().mockResolvedValue(response(legacy));
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: FIRECRAWL_REST_RESOURCE,
        fetchFn,
      }),
    ).resolves.toEqual(legacy);
  });

  it("rejects audience-less managed credentials", async () => {
    const { aud: _aud, ...managed } = {
      ...ACTIVE,
      credential_purpose: "hosted_mcp_oauth" as const,
    };
    const fetchFn = vi.fn().mockResolvedValue(response(managed));
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: FIRECRAWL_REST_RESOURCE,
        fetchFn,
      }),
    ).resolves.toBeNull();
  });

  it("does not positive-cache ordinary credentials", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(ACTIVE));
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: FIRECRAWL_REST_RESOURCE,
        fetchFn,
      }),
    ).resolves.toEqual(ACTIVE);
    expect(setValue).not.toHaveBeenCalled();
  });

  it("never positive-caches managed credentials", async () => {
    const managed = {
      ...ACTIVE,
      credential_purpose: "hosted_mcp_oauth" as const,
    };
    const fetchFn = vi.fn().mockResolvedValue(response(managed));
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: FIRECRAWL_REST_RESOURCE,
        fetchFn,
      }),
    ).resolves.toEqual(managed);
    expect(setValue).not.toHaveBeenCalled();
  });

  it("ignores stale managed cache entries and re-introspects", async () => {
    const managed = {
      ...ACTIVE,
      credential_purpose: "hosted_mcp_oauth" as const,
    };
    getValue.mockResolvedValue(JSON.stringify(managed));
    const fetchFn = vi.fn().mockResolvedValue(response({ active: false }));
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: FIRECRAWL_REST_RESOURCE,
        fetchFn,
      }),
    ).resolves.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("ignores an active general cache entry and observes live revocation", async () => {
    getValue.mockResolvedValue(JSON.stringify(ACTIVE));
    const fetchFn = vi.fn().mockResolvedValue(response({ active: false }));

    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: FIRECRAWL_REST_RESOURCE,
        fetchFn,
      }),
    ).resolves.toBeNull();

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("bypasses an unavailable cache and uses live introspection", async () => {
    getValue.mockRejectedValue(new Error("Redis unavailable"));
    const fetchFn = vi.fn().mockResolvedValue(response(ACTIVE));
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: FIRECRAWL_REST_RESOURCE,
        fetchFn,
      }),
    ).resolves.toEqual(ACTIVE);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not fail authentication when a cache write fails", async () => {
    setValue.mockRejectedValue(new Error("Redis unavailable"));
    const fetchFn = vi.fn().mockResolvedValue(response({ active: false }));
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: FIRECRAWL_REST_RESOURCE,
        fetchFn,
      }),
    ).resolves.toBeNull();
    expect(setValue).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown credential purposes from live introspection", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(response({ ...ACTIVE, credential_purpose: "admin" }));
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: FIRECRAWL_REST_RESOURCE,
        fetchFn,
      }),
    ).rejects.toBeInstanceOf(OAuthIntrospectionUnavailableError);
  });

  it("never trusts an unknown credential purpose from cache", async () => {
    getValue.mockResolvedValue(
      JSON.stringify({ ...ACTIVE, credential_purpose: "admin" }),
    );
    const fetchFn = vi.fn().mockResolvedValue(response({ active: false }));
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: FIRECRAWL_REST_RESOURCE,
        fetchFn,
      }),
    ).resolves.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("fails closed for expired tokens", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        response({ ...ACTIVE, exp: Math.floor(Date.now() / 1000) - 1 }),
      );
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: FIRECRAWL_REST_RESOURCE,
        fetchFn,
      }),
    ).resolves.toBeNull();
  });

  it("aborts a stalled introspection request", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const resolving = resolveOAuthToken("fco_token", {
      introspectUrl: "https://example.test/introspect",
      introspectSecret: "secret",
      expectedResource: FIRECRAWL_REST_RESOURCE,
      fetchFn,
    });
    const rejection = expect(resolving).rejects.toBeInstanceOf(
      OAuthIntrospectionUnavailableError,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    vi.useRealTimers();
  });

  it("distinguishes an unavailable introspection service from an inactive token", async () => {
    const unavailableFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: FIRECRAWL_REST_RESOURCE,
        fetchFn: unavailableFetch,
      }),
    ).rejects.toBeInstanceOf(OAuthIntrospectionUnavailableError);

    const inactiveFetch = vi
      .fn()
      .mockResolvedValue(response({ active: false }));
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: FIRECRAWL_REST_RESOURCE,
        fetchFn: inactiveFetch,
      }),
    ).resolves.toBeNull();
  });

  it("treats malformed introspection responses as unavailable", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(response({ ...ACTIVE, active: "true" }));
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: FIRECRAWL_REST_RESOURCE,
        fetchFn,
      }),
    ).rejects.toBeInstanceOf(OAuthIntrospectionUnavailableError);
  });
});
