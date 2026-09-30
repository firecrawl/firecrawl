import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const returning = vi.fn();
  const onConflictDoUpdate = vi.fn((_conflict: unknown) => ({ returning }));
  const values = vi.fn((_row: unknown) => ({ onConflictDoUpdate }));
  const insert = vi.fn((_table: unknown) => ({ values }));
  return {
    insert,
    values,
    onConflictDoUpdate,
    returning,
    redisGet: vi.fn(),
    redisSet: vi.fn(),
  };
});

vi.mock("../db/connection", () => ({ db: { insert: mocks.insert } }));
vi.mock("../services/rate-limiter", () => ({
  redisRateLimitClient: { get: mocks.redisGet, set: mocks.redisSet },
}));

import { config } from "../config";
import { logger } from "./logger";
import {
  KEYLESS_SIGNUP_ID_PATTERN,
  existingKeylessSignupUrl,
  generateKeylessSignupId,
  issueKeylessSignupId,
  keylessFallbackSignupUrl,
  keylessSignupSurface,
  keylessSignupUrl,
  resetKeylessSignupLinkStateForTests,
} from "./keyless-signup-link";

const TEAM_UUID = "3adefd26-77ec-5968-8dcf-c94b5630d1de";

describe("generateKeylessSignupId", () => {
  it("returns 8 lowercase Crockford base32 characters", () => {
    for (let i = 0; i < 500; i++) {
      expect(generateKeylessSignupId()).toMatch(KEYLESS_SIGNUP_ID_PATTERN);
    }
  });

  it("does not repeat across many draws", () => {
    const ids = new Set(
      Array.from({ length: 5000 }, () => generateKeylessSignupId()),
    );
    expect(ids.size).toBe(5000);
  });
});

describe("keylessSignupSurface", () => {
  const originalSecret = config.KEYLESS_PROXY_SECRET;
  afterEach(() => {
    config.KEYLESS_PROXY_SECRET = originalSecret;
  });

  it.each([
    [{ body: { integration: "cli" } }, "cli"],
    [{ body: { origin: "cli" } }, "cli"],
    [{ body: {}, headers: { "x-origin": "cli" } }, "cli"],
    [{ body: { origin: "mcp-claude-code@3.24.1" } }, "mcp"],
    [{ body: {}, headers: { "x-origin": "mcp-fastmcp@3.24.1" } }, "mcp"],
    [{ body: { origin: "api" } }, "api"],
    [{ body: { origin: "js-sdk@4.3.0" } }, "api"],
    [{ body: { origin: "website" } }, "api"],
    [{ body: {} }, "api"],
    [{}, "api"],
    // Case-insensitive, like the warehouse classifier.
    [{ body: { origin: "CLI" } }, "cli"],
    [{ body: { integration: "Cli" } }, "cli"],
    [{ body: { origin: "MCP-Claude-Code@3.24.1" } }, "mcp"],
    [{ body: {}, headers: { "x-origin": "MCP-fastmcp@3.24.1" } }, "mcp"],
    // v1 schemas prefault a missing origin to "api"; the header still counts.
    [{ body: { origin: "api" }, headers: { "x-origin": "cli" } }, "cli"],
    [{ body: { origin: "api" }, headers: { "x-origin": "mcp-x@1" } }, "mcp"],
    // An explicit non-default body origin still wins over the header.
    [
      { body: { origin: "js-sdk@4.3.0" }, headers: { "x-origin": "cli" } },
      "api",
    ],
  ] as const)("classifies %j as %s", (req, surface) => {
    expect(keylessSignupSurface(req as never)).toBe(surface);
  });

  it("treats a request relayed with the proxy secret as MCP", () => {
    config.KEYLESS_PROXY_SECRET = "proxy-secret";
    expect(
      keylessSignupSurface({
        body: { origin: "api" },
        headers: { "x-firecrawl-keyless-secret": "proxy-secret" },
      }),
    ).toBe("mcp");
    expect(
      keylessSignupSurface({
        body: { origin: "api" },
        headers: { "x-firecrawl-keyless-secret": "wrong" },
      }),
    ).toBe("api");
  });
});

describe("issueKeylessSignupId", () => {
  const originalUseDbAuth = config.USE_DB_AUTHENTICATION;

  beforeEach(() => {
    config.USE_DB_AUTHENTICATION = true;
    resetKeylessSignupLinkStateForTests();
    mocks.redisGet.mockReset().mockResolvedValue(null);
    mocks.redisSet.mockReset().mockResolvedValue("OK");
    mocks.returning.mockReset();
    mocks.insert.mockClear();
    mocks.values.mockClear();
    mocks.onConflictDoUpdate.mockClear();
    vi.spyOn(logger, "warn").mockImplementation(() => logger);
  });

  afterEach(() => {
    config.USE_DB_AUTHENTICATION = originalUseDbAuth;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns the cached id without touching the database", async () => {
    mocks.redisGet.mockResolvedValue("7fq2xab9");

    await expect(issueKeylessSignupId(TEAM_UUID, "mcp")).resolves.toBe(
      "7fq2xab9",
    );
    expect(mocks.redisGet).toHaveBeenCalledWith(
      `keyless_signup_link:v1:${TEAM_UUID}:mcp`,
    );
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("upserts per (identity, surface) and caches the stored id", async () => {
    mocks.returning.mockResolvedValue([{ short_id: "k3m9q2zz" }]);

    await expect(issueKeylessSignupId(TEAM_UUID, "cli")).resolves.toBe(
      "k3m9q2zz",
    );
    const row = mocks.values.mock.calls[0][0] as Record<string, string>;
    expect(row).toMatchObject({
      keyless_team_id: TEAM_UUID,
      surface: "cli",
    });
    expect(row.short_id).toMatch(KEYLESS_SIGNUP_ID_PATTERN);
    // Nothing identifying goes into the row besides the team UUID.
    expect(Object.keys(row).sort()).toEqual(
      ["keyless_team_id", "short_id", "surface"].sort(),
    );
    const conflict = mocks.onConflictDoUpdate.mock.calls[0][0] as {
      target: unknown[];
    };
    expect(conflict.target).toHaveLength(2);
    expect(mocks.redisSet).toHaveBeenCalledWith(
      `keyless_signup_link:v1:${TEAM_UUID}:cli`,
      "k3m9q2zz",
      "EX",
      30 * 24 * 60 * 60,
    );
  });

  it("ignores a malformed cached value", async () => {
    mocks.redisGet.mockResolvedValue("not-an-id");
    mocks.returning.mockResolvedValue([{ short_id: "k3m9q2zz" }]);

    await expect(issueKeylessSignupId(TEAM_UUID, "api")).resolves.toBe(
      "k3m9q2zz",
    );
  });

  it("retries once with a fresh id after a short_id collision", async () => {
    mocks.returning
      .mockRejectedValueOnce(
        new Error("duplicate key keyless_signup_links_pkey"),
      )
      .mockResolvedValueOnce([{ short_id: "k3m9q2zz" }]);

    await expect(issueKeylessSignupId(TEAM_UUID, "api")).resolves.toBe(
      "k3m9q2zz",
    );
    const [first, second] = mocks.values.mock.calls.map(
      c => (c[0] as { short_id: string }).short_id,
    );
    expect(first).not.toBe(second);
  });

  it("still issues when Redis is down", async () => {
    mocks.redisGet.mockRejectedValue(new Error("redis down"));
    mocks.redisSet.mockRejectedValue(new Error("redis down"));
    mocks.returning.mockResolvedValue([{ short_id: "k3m9q2zz" }]);

    await expect(issueKeylessSignupId(TEAM_UUID, "api")).resolves.toBe(
      "k3m9q2zz",
    );
  });

  it("returns undefined and backs off when the database fails", async () => {
    mocks.returning.mockRejectedValue(new Error("db down"));

    await expect(issueKeylessSignupId(TEAM_UUID, "api")).resolves.toBe(
      undefined,
    );
    mocks.returning.mockResolvedValue([{ short_id: "k3m9q2zz" }]);
    await expect(issueKeylessSignupId(TEAM_UUID, "api")).resolves.toBe(
      undefined,
    );
    expect(mocks.insert).toHaveBeenCalledTimes(2);
  });

  it("gives up after its time budget instead of delaying the response", async () => {
    vi.useFakeTimers();
    mocks.returning.mockReturnValue(new Promise(() => {}));

    const pending = issueKeylessSignupId(TEAM_UUID, "api");
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toBe(undefined);
  });

  it("backs off after a timeout so a slow database is not queried per request", async () => {
    vi.useFakeTimers();
    mocks.returning.mockReturnValue(new Promise(() => {}));

    const first = issueKeylessSignupId(TEAM_UUID, "api");
    await vi.advanceTimersByTimeAsync(300);
    await expect(first).resolves.toBe(undefined);

    mocks.returning.mockResolvedValue([{ short_id: "k3m9q2zz" }]);
    await expect(issueKeylessSignupId(TEAM_UUID, "api")).resolves.toBe(
      undefined,
    );
    expect(mocks.insert).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(issueKeylessSignupId(TEAM_UUID, "api")).resolves.toBe(
      "k3m9q2zz",
    );
  });

  it("issues nothing without an identity or without the database", async () => {
    await expect(issueKeylessSignupId(null, "api")).resolves.toBe(undefined);
    config.USE_DB_AUTHENTICATION = false;
    await expect(issueKeylessSignupId(TEAM_UUID, "api")).resolves.toBe(
      undefined,
    );
    expect(mocks.redisGet).not.toHaveBeenCalled();
  });
});

describe("keylessSignupUrl", () => {
  beforeEach(() => {
    config.USE_DB_AUTHENTICATION = true;
    resetKeylessSignupLinkStateForTests();
  });

  it("builds a clean /k/<id> link with no query string", async () => {
    mocks.redisGet.mockResolvedValue("7fq2xab9");

    await expect(keylessSignupUrl(TEAM_UUID, "mcp")).resolves.toEqual({
      url: "https://firecrawl.dev/k/7fq2xab9",
      shortId: "7fq2xab9",
    });
  });

  it("falls back to the regular signup link, tagged with the surface", async () => {
    await expect(keylessSignupUrl(null, "mcp")).resolves.toEqual({
      url: "https://www.firecrawl.dev/signin?utm_source=keyless&utm_medium=mcp",
    });
    expect(keylessFallbackSignupUrl("cli")).toBe(
      "https://www.firecrawl.dev/signin?utm_source=keyless&utm_medium=cli",
    );
  });

  it("falls back to the regular signup link while issuance is backed off", async () => {
    mocks.redisGet.mockResolvedValue(null);
    mocks.returning.mockRejectedValue(new Error("db down"));
    await keylessSignupUrl(TEAM_UUID, "api");

    await expect(keylessSignupUrl(TEAM_UUID, "api")).resolves.toEqual({
      url: "https://www.firecrawl.dev/signin?utm_source=keyless&utm_medium=api",
    });
  });
});

describe("existingKeylessSignupUrl", () => {
  const originalUseDbAuth = config.USE_DB_AUTHENTICATION;
  beforeEach(() => {
    config.USE_DB_AUTHENTICATION = true;
    mocks.redisGet.mockReset().mockResolvedValue(null);
    mocks.insert.mockClear();
  });
  afterEach(() => {
    config.USE_DB_AUTHENTICATION = originalUseDbAuth;
    vi.useRealTimers();
  });

  it("returns the identity's cached link without touching the database", async () => {
    mocks.redisGet.mockResolvedValue("7fq2xab9");

    await expect(existingKeylessSignupUrl(TEAM_UUID, "cli")).resolves.toEqual({
      url: "https://firecrawl.dev/k/7fq2xab9",
      shortId: "7fq2xab9",
    });
    expect(mocks.redisGet).toHaveBeenCalledWith(
      `keyless_signup_link:v1:${TEAM_UUID}:cli`,
    );
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("never issues: a miss, a bad value, an error or a slow cache give the regular link", async () => {
    const regular = {
      url: "https://www.firecrawl.dev/signin?utm_source=keyless&utm_medium=api",
    };
    await expect(existingKeylessSignupUrl(TEAM_UUID, "api")).resolves.toEqual(
      regular,
    );
    mocks.redisGet.mockResolvedValue("not-an-id");
    await expect(existingKeylessSignupUrl(TEAM_UUID, "api")).resolves.toEqual(
      regular,
    );
    mocks.redisGet.mockRejectedValue(new Error("redis down"));
    await expect(existingKeylessSignupUrl(TEAM_UUID, "api")).resolves.toEqual(
      regular,
    );
    vi.useFakeTimers();
    mocks.redisGet.mockReturnValue(new Promise(() => {}));
    const slow = existingKeylessSignupUrl(TEAM_UUID, "api");
    await vi.advanceTimersByTimeAsync(50);
    await expect(slow).resolves.toEqual(regular);
    await expect(existingKeylessSignupUrl(null, "api")).resolves.toEqual(
      regular,
    );
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
