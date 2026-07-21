import { beforeEach, describe, expect, it, vi } from "vitest";

const { getValue, setValue } = vi.hoisted(() => ({
  getValue: vi.fn(),
  setValue: vi.fn(),
}));

vi.mock("./redis", () => ({ getValue, setValue }));

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

  it("caches ordinary credentials for at most five minutes", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(ACTIVE));
    await expect(
      resolveOAuthToken("fco_token", {
        introspectUrl: "https://example.test/introspect",
        introspectSecret: "secret",
        expectedResource: FIRECRAWL_REST_RESOURCE,
        fetchFn,
      }),
    ).resolves.toEqual(ACTIVE);
    expect(setValue).toHaveBeenCalledWith(
      expect.stringMatching(/^oauth_token:[0-9a-f]{32}$/),
      JSON.stringify(ACTIVE),
      300,
    );
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

  it("fails closed for malformed active values and expired tokens", async () => {
    for (const body of [
      { ...ACTIVE, active: "true" },
      { ...ACTIVE, exp: Math.floor(Date.now() / 1000) - 1 },
    ]) {
      const fetchFn = vi.fn().mockResolvedValue(response(body));
      await expect(
        resolveOAuthToken("fco_token", {
          introspectUrl: "https://example.test/introspect",
          introspectSecret: "secret",
          expectedResource: FIRECRAWL_REST_RESOURCE,
          fetchFn,
        }),
      ).resolves.toBeNull();
    }
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
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(resolving).resolves.toBeNull();
    vi.useRealTimers();
  });
});
