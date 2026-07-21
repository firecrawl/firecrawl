import { vi } from "vitest";
import { authenticateUser, clearACUC } from "../auth";
import { config } from "../../config";
import { RateLimiterMode } from "../../types";
import { authCreditUsageChunk } from "../../db/rpc";
import { redlock } from "../../services/redlock";
import { deleteKey, getValue, setValue } from "../../services/redis";
import { getRateLimiter } from "../../services/rate-limiter";

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

vi.mock("../../services/rate-limiter", () => ({
  getRateLimiter: vi.fn(),
}));

vi.mock("../../services/agent-sponsor", () => ({
  getAgentSponsorStatus: vi.fn(),
}));

describe("authenticateUser", () => {
  const originalUseDbAuth = config.USE_DB_AUTHENTICATION;

  afterEach(() => {
    config.USE_DB_AUTHENTICATION = originalUseDbAuth;
    vi.clearAllMocks();
  });

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

  it("writes normal API-key ACUC entries to the general-purpose cache", async () => {
    config.USE_DB_AUTHENTICATION = true;
    vi.mocked(getValue).mockResolvedValue(null);
    vi.mocked(authCreditUsageChunk).mockResolvedValue([
      {
        api_key: "00000000-0000-4000-8000-000000000000",
        api_key_id: 1,
        team_id: "team-1",
        org_id: "org-1",
        rate_limits: { scrape: 10 },
        plan_priority: {},
        concurrency: 2,
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
