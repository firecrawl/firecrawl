const { dbInsert, insertValues, redisIncrby, redisExpire } = vi.hoisted(() => {
  const insertValues = vi.fn().mockResolvedValue(undefined);
  return {
    insertValues,
    dbInsert: vi.fn(() => ({ values: insertValues })),
    redisIncrby: vi.fn().mockResolvedValue(1),
    redisExpire: vi.fn().mockResolvedValue(1),
  };
});

vi.mock("../../db/connection", () => ({
  db: { insert: dbInsert },
  dbRr: { select: vi.fn() },
  dbIndex: { select: vi.fn() },
}));

vi.mock("../../services/rate-limiter", () => ({
  redisRateLimitClient: {
    incrby: redisIncrby,
    expire: redisExpire,
    get: vi.fn().mockResolvedValue(null),
    incr: vi.fn().mockResolvedValue(1),
    ttl: vi.fn().mockResolvedValue(-1),
    eval: vi.fn().mockResolvedValue([1, 1]),
  },
}));

import { config } from "../../config";
import {
  chargeKeylessCredits,
  keylessTeamId,
  logKeylessCreditUsage,
} from "../keyless";
import { logger } from "../logger";

const IP = "203.0.113.99";
const KEYLESS_TEAM = keylessTeamId(IP);
const KEYLESS_PSEUDONYM = "preview_keyless_hmac_v1_2bb3385506da49adb864dfd3";

let previousDbAuth: boolean | undefined;
let previousHmacSecret: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  insertValues.mockResolvedValue(undefined);
  previousDbAuth = config.USE_DB_AUTHENTICATION;
  previousHmacSecret = config.KEYLESS_CONVERSION_HMAC_SECRET;
  config.USE_DB_AUTHENTICATION = true;
  config.KEYLESS_CONVERSION_HMAC_SECRET = "a".repeat(32);
});

afterEach(() => {
  config.USE_DB_AUTHENTICATION = previousDbAuth;
  config.KEYLESS_CONVERSION_HMAC_SECRET = previousHmacSecret;
});

describe("logKeylessCreditUsage", () => {
  it("logs a pseudonym for a zero-credit keyless operation without a DB write", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => logger);

    await logKeylessCreditUsage(KEYLESS_TEAM, 0);

    expect(dbInsert).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("Keyless zero-credit usage", {
      canonicalLog: "keyless/usage",
      teamId: KEYLESS_PSEUDONYM,
      creditsUsed: 0,
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain(IP);
  });

  it("logs no zero-credit line when DB auth is off (same gate as billable rows)", async () => {
    config.USE_DB_AUTHENTICATION = false;
    const info = vi.spyOn(logger, "info").mockImplementation(() => logger);

    await logKeylessCreditUsage(KEYLESS_TEAM, 0);

    expect(dbInsert).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("still records the actual credits for a billable keyless operation", async () => {
    await logKeylessCreditUsage(KEYLESS_TEAM, 2.1);

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ ip: IP, credits_used: 3 }),
    );
  });

  it("treats a reconciliation refund as zero-credit: log line, no negative row", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => logger);

    await logKeylessCreditUsage(KEYLESS_TEAM, -5);

    expect(dbInsert).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("Keyless zero-credit usage"),
      expect.objectContaining({ creditsUsed: 0 }),
    );
  });

  it("writes and logs nothing for a team that is not keyless", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => logger);

    await logKeylessCreditUsage("some-real-team-id", 0);

    expect(dbInsert).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("writes no billable row when DB auth is off", async () => {
    config.USE_DB_AUTHENTICATION = false;

    await logKeylessCreditUsage(KEYLESS_TEAM, 3);

    expect(dbInsert).not.toHaveBeenCalled();
  });

  it("swallows insert failures so the request is unaffected", async () => {
    insertValues.mockRejectedValue(new Error("db down"));

    await expect(
      logKeylessCreditUsage(KEYLESS_TEAM, 3),
    ).resolves.toBeUndefined();
  });
});

describe("chargeKeylessCredits", () => {
  it("records a zero-credit request without drawing down the credit budget", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => logger);

    await chargeKeylessCredits(KEYLESS_TEAM, 0);

    expect(redisIncrby).not.toHaveBeenCalled();
    expect(dbInsert).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("Keyless zero-credit usage"),
      expect.objectContaining({
        teamId: KEYLESS_PSEUDONYM,
        creditsUsed: 0,
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain(IP);
  });

  it("charges the credit budget for a billable request", async () => {
    await chargeKeylessCredits(KEYLESS_TEAM, 4);

    expect(redisIncrby).toHaveBeenCalledWith(`keyless_credits:${IP}`, 4);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ ip: IP, credits_used: 4 }),
    );
  });

  it("does nothing at all for a team that is not keyless", async () => {
    await chargeKeylessCredits("some-real-team-id", 5);

    expect(redisIncrby).not.toHaveBeenCalled();
    expect(dbInsert).not.toHaveBeenCalled();
  });
});
