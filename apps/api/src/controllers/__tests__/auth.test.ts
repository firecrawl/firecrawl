import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearACUC,
  clearACUCTeam,
  getACUC,
  getACUCTeam,
  getApiKeyTeamFlags,
  keylessClientIp,
} from "../auth";
import { config } from "../../config";
import { RateLimiterMode } from "../../types";
import {
  authCreditUsageChunk,
  authCreditUsageChunkFromTeam,
} from "../../db/rpc";
import { redlock } from "../../services/redlock";
import { deleteKey, getValue, setValue } from "../../services/redis";
import { autumnService } from "../../services/autumn/autumn.service";

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

vi.mock("ioredis", () => ({
  default: class {},
  ReplyError: class ReplyError extends Error {},
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

describe("auth ACUC and helper functions", () => {
  const originalUseDbAuth = config.USE_DB_AUTHENTICATION;
  const originalKeylessProxySecret = config.KEYLESS_PROXY_SECRET;
  const originalPreviewToken = config.PREVIEW_TOKEN;

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

  beforeEach(() => {
    config.USE_DB_AUTHENTICATION = true;
    vi.mocked(getValue).mockResolvedValue(null);
    vi.mocked(deleteKey).mockResolvedValue(undefined);
    vi.mocked(redlock.using).mockImplementation(
      async (_keys, _ttl, _options, fn) => fn({ aborted: false } as never),
    );
    vi.mocked(authCreditUsageChunk).mockImplementation(
      async () => [{ ...keyRow }] as never,
    );
    vi.mocked(authCreditUsageChunkFromTeam).mockImplementation(
      async () => [{ ...keyRow }] as never,
    );
    vi.mocked(autumnService.getTeamLimits).mockResolvedValue(known);
  });

  afterEach(() => {
    config.USE_DB_AUTHENTICATION = originalUseDbAuth;
    config.KEYLESS_PROXY_SECRET = originalKeylessProxySecret;
    config.PREVIEW_TOKEN = originalPreviewToken;
    vi.clearAllMocks();
  });

  it("returns mock preview chunk for preview teams", async () => {
    const byTeamId = await getACUCTeam("preview_keyless_203.0.113.8");
    expect(byTeamId).toMatchObject({
      team_id: "preview_keyless_203.0.113.8",
      org_id: "preview",
      is_banned: false,
    });
  });

  it("treats corrupt ACUC team cache entries as a miss and deletes them", async () => {
    vi.mocked(getValue).mockResolvedValue("{not-json");
    vi.mocked(authCreditUsageChunkFromTeam).mockResolvedValue([
      { team_id: "team-1", org_id: "org-1" },
    ] as never);

    await expect(getACUCTeam("team-1")).resolves.toMatchObject({
      team_id: "team-1",
      org_id: "org-1",
    });
    expect(authCreditUsageChunkFromTeam).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(deleteKey).toHaveBeenCalledWith("acuc_team_team-1_scrape"),
    );
  });

  it("builds the key ACUC with the team's limits and caches it for the full TTL", async () => {
    const chunk = await getACUC(apiKey, false, true, RateLimiterMode.Scrape);

    expect(chunk).toMatchObject(known);
    expect(autumnService.getTeamLimits).toHaveBeenCalledTimes(1);
    expect(autumnService.getTeamLimits).toHaveBeenCalledWith("team-1", "org-1");
    await vi.waitFor(() => expect(setValue).toHaveBeenCalled());
    const [key, value, ttl] = vi.mocked(setValue).mock.calls[0];
    expect(key).toBe(`acuc_general_${apiKey}_scrape`);
    expect(JSON.parse(value)).toMatchObject(known);
    expect(ttl).toBe(600);
  });

  it("puts fail-open limits on the key chunk and caches it briefly when Autumn fails", async () => {
    vi.mocked(autumnService.getTeamLimits).mockRejectedValue(
      new Error("Autumn down"),
    );

    const chunk = await getACUC(apiKey, false, true, RateLimiterMode.Scrape);

    expect(chunk).toMatchObject(failOpen);
    await vi.waitFor(() => expect(setValue).toHaveBeenCalled());
    const [, value, ttl] = vi.mocked(setValue).mock.calls[0];
    expect(JSON.parse(value)).toMatchObject(failOpen);
    expect(ttl).toBe(60);
  });

  it("fills a cached ACUC that predates limits with one live read without writing back", async () => {
    vi.mocked(getValue).mockResolvedValue(JSON.stringify(keyRow));

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

  it("builds the team ACUC with fail-open limits cached briefly when Autumn fails", async () => {
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

    await expect(getACUCTeam("team-1")).resolves.toMatchObject(known);
    expect(row).toEqual(keyRow);
  });

  it("reads team flags via getApiKeyTeamFlags for a known API key", async () => {
    vi.mocked(authCreditUsageChunk).mockResolvedValue([
      { ...keyRow, flags: { skipCountryCheck: true } },
    ] as never);

    const flags = await getApiKeyTeamFlags({
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(flags).toEqual({ skipCountryCheck: true });
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

  it("clears team ACUC cache entries", async () => {
    await clearACUCTeam("team-1");

    expect(vi.mocked(deleteKey).mock.calls.map(([key]) => key)).toEqual(
      expect.arrayContaining([
        "acuc_team_team-1_extract",
        "acuc_team_team-1_scrape",
        "acuc_team_team-1",
      ]),
    );
  });

  it("resolves forwarded client IP only when the keyless proxy secret matches", () => {
    config.KEYLESS_PROXY_SECRET = "proxy-secret";

    expect(
      keylessClientIp({
        ip: "10.0.0.1",
        headers: {
          "x-firecrawl-keyless-secret": "proxy-secret",
          "x-firecrawl-keyless-ip": " 203.0.113.9 ",
        },
      }),
    ).toBe("203.0.113.9");

    expect(
      keylessClientIp({
        ip: "10.0.0.1",
        headers: {
          "x-firecrawl-keyless-secret": "wrong",
          "x-firecrawl-keyless-ip": "203.0.113.9",
        },
      }),
    ).toBe("10.0.0.1");
  });

  it("honors bypassWhenDbDisabled=false on uncached getACUC lookups", async () => {
    config.USE_DB_AUTHENTICATION = false;

    const result = await getACUC(
      apiKey,
      false,
      false,
      RateLimiterMode.Scrape,
      "hosted_mcp_oauth",
      false,
    );

    expect(result).toMatchObject({
      team_id: "team-1",
      ...known,
    });
    expect(authCreditUsageChunk).toHaveBeenCalledTimes(1);
    expect(authCreditUsageChunkFromTeam).toHaveBeenCalledTimes(1);
  });
});
