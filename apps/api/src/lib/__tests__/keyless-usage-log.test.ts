// The keyless usage log is the only place a keyless caller's IP is persisted —
// `requests.team_id` collapses all keyless traffic onto one preview team. The
// end-to-end coverage for the zero-credit Research Index endpoints lives in
// snips/v2/research.test.ts, but that suite only runs where a research upstream
// is configured. These tests pin the library-level contract everywhere: a
// zero-credit keyless request emits the canonical `keyless/usage` log line
// carrying the client IP (the durable `keyless_credit_usage` row is deferred
// to the firecrawl-db migration), writes no DB row, and charges nothing;
// billable requests keep writing rows exactly as before.
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
  keylessTeamUuid,
  logKeylessCreditUsage,
} from "../keyless";
import { logger } from "../logger";

const IP = "203.0.113.99";
const KEYLESS_TEAM = keylessTeamId(IP);

let previousDbAuth: boolean | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  insertValues.mockResolvedValue(undefined);
  previousDbAuth = config.USE_DB_AUTHENTICATION;
  config.USE_DB_AUTHENTICATION = true;
});

afterEach(() => {
  config.USE_DB_AUTHENTICATION = previousDbAuth;
});

describe("logKeylessCreditUsage", () => {
  // Zero-credit operations are recorded as a canonical log line for now; the
  // durable `keyless_credit_usage` row is deferred to the firecrawl-db
  // migration (high write volume needs its own review).
  it("logs the client IP for a zero-credit keyless operation without a DB write", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => logger);

    await logKeylessCreditUsage(KEYLESS_TEAM, 0);

    expect(dbInsert).not.toHaveBeenCalled();
    // The IP rides in the message body (console transports only serialize
    // metadata for warn/error) AND in the structured fields (the Cloud
    // Logging query contract).
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(`Keyless zero-credit usage ip=${IP}`),
      expect.objectContaining({
        canonicalLog: "keyless/usage",
        ip: IP,
        teamId: keylessTeamUuid(KEYLESS_TEAM),
        creditsUsed: 0,
      }),
    );
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
      expect.objectContaining({ ip: IP, creditsUsed: 0 }),
    );
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
