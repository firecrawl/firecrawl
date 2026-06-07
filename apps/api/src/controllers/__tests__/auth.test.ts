import { authenticateUser } from "../auth";
import { config } from "../../config";
import { RateLimiterMode } from "../../types";

jest.mock("../../services/queue-service", () => ({
  getRedisConnection: jest.fn(() => ({
    sadd: jest.fn(),
  })),
}));

jest.mock("uuid", () => ({
  validate: jest.fn(() => true),
}));

jest.mock("../../services/redis", () => ({
  getValue: jest.fn(),
  setValue: jest.fn(),
  deleteKey: jest.fn(),
}));

jest.mock("../../services/redlock", () => ({
  redlock: {
    using: jest.fn(),
  },
}));

jest.mock("../../db/connection", () => ({
  db: {},
  dbRr: {},
}));

jest.mock("../../db/rpc", () => ({
  authCreditUsageChunk: jest.fn(),
  authCreditUsageChunkFromTeam: jest.fn(),
}));

jest.mock("../../services/rate-limiter", () => ({
  getRateLimiter: jest.fn(),
}));

jest.mock("../../services/agent-sponsor", () => ({
  getAgentSponsorStatus: jest.fn(),
}));

describe("authenticateUser", () => {
  const originalUseDbAuth = config.USE_DB_AUTHENTICATION;

  afterEach(() => {
    config.USE_DB_AUTHENTICATION = originalUseDbAuth;
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
});
