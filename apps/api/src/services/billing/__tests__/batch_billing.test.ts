import { jest } from "@jest/globals";

const captureException = jest.fn();
jest.mock("@sentry/node", () => ({
  captureException,
}));

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn(() => logger),
};
jest.mock("../../../lib/logger", () => ({
  logger,
}));

const withAuth = jest.fn((fn: any) => fn);
jest.mock("../../../lib/withAuth", () => ({
  withAuth,
}));

const trackCredits = jest.fn<(args: any) => Promise<boolean>>();
const refundCredits = jest.fn<(args: any) => Promise<void>>();
jest.mock("../../autumn/autumn.service", () => ({
  autumnService: {
    trackCredits,
    refundCredits,
  },
}));

const billTeam6 = jest.fn<(params: any) => Promise<{ api_key: string }[]>>();
jest.mock("../../../db/rpc", () => ({
  billTeam6,
}));

const setCachedACUC = jest.fn();
const setCachedACUCTeam = jest.fn();
jest.mock("../../../controllers/auth", () => ({
  setCachedACUC,
  setCachedACUCTeam,
}));

let queue: string[] = [];
const billedTeams = new Set<string>();
const locks = new Map<string, string>();
const redis = {
  set: jest.fn(
    async (
      key: string,
      value: string,
      mode: string,
      timeout: number,
      nx: string,
    ) => {
      if (
        key !== "billing_batch_lock" ||
        value !== "1" ||
        mode !== "PX" ||
        timeout !== 30000 ||
        nx !== "NX"
      ) {
        throw new Error("unexpected redis.set args");
      }
      if (locks.has(key)) return null;
      locks.set(key, value);
      return "OK";
    },
  ),
  del: jest.fn(async (key: string) => {
    if (key !== "billing_batch_lock") {
      throw new Error("unexpected redis.del key");
    }
    return locks.delete(key) ? 1 : 0;
  }),
  lpop: jest.fn(async (key: string) => {
    if (key !== "billing_batch") {
      throw new Error("unexpected redis.lpop key");
    }
    return queue.shift() ?? null;
  }),
  llen: jest.fn(async (key: string) => {
    if (key !== "billing_batch") {
      throw new Error("unexpected redis.llen key");
    }
    return queue.length;
  }),
  rpush: jest.fn(async (key: string, value: string) => {
    if (key !== "billing_batch") {
      throw new Error("unexpected redis.rpush key");
    }
    queue.push(value);
    return queue.length;
  }),
  sadd: jest.fn(async (key: string, teamId: string) => {
    if (key !== "billed_teams") {
      throw new Error("unexpected redis.sadd key");
    }
    billedTeams.add(teamId);
    return 1;
  }),
};
jest.mock("../../queue-service", () => ({
  getRedisConnection: () => redis,
}));

import { processBillingBatch } from "../batch_billing";

function makeOp(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    team_id: "team-1",
    subscription_id: "sub-1",
    credits: 10,
    billing: { endpoint: "extract" },
    is_extract: false,
    timestamp: "2026-03-13T00:00:00.000Z",
    api_key_id: 123,
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  queue = [];
  billedTeams.clear();
  locks.clear();
  billTeam6.mockResolvedValue([]);
  trackCredits.mockResolvedValue(true);
  refundCredits.mockResolvedValue(undefined);
});

describe("processBillingBatch", () => {
  it("tracks queued Autumn usage when the request path did not", async () => {
    queue = [makeOp()];

    await processBillingBatch();

    expect(billTeam6).toHaveBeenCalled();
    expect(trackCredits).toHaveBeenCalledWith({
      teamId: "team-1",
      value: 10,
      properties: {
        source: "processBillingBatch",
        endpoint: "extract",
        apiKeyId: 123,
        subscriptionId: "sub-1",
      },
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("skips Autumn tracking when the request path already tracked the op", async () => {
    queue = [makeOp({ autumnTrackInRequest: true })];

    await processBillingBatch();

    expect(billTeam6).toHaveBeenCalled();
    expect(trackCredits).not.toHaveBeenCalled();
  });

  it("continues when billing returns success false", async () => {
    queue = [makeOp({ autumnTrackInRequest: true })];
    billTeam6.mockRejectedValueOnce(new Error("db failed"));

    await processBillingBatch();

    expect(refundCredits).toHaveBeenCalledWith({
      teamId: "team-1",
      value: 10,
      properties: {
        source: "processBillingBatch",
        endpoint: "extract",
        apiKeyId: 123,
        subscriptionId: "sub-1",
      },
    });
    expect(captureException).toHaveBeenCalled();
  });

  it("captures exceptions when billing throws", async () => {
    queue = [makeOp({ autumnTrackInRequest: true })];
    billTeam6.mockRejectedValueOnce(new Error("rpc exploded"));

    await processBillingBatch();

    expect(refundCredits).toHaveBeenCalledWith({
      teamId: "team-1",
      value: 10,
      properties: {
        source: "processBillingBatch",
        endpoint: "extract",
        apiKeyId: 123,
        subscriptionId: "sub-1",
      },
    });
    expect(captureException).toHaveBeenCalled();
  });

  it("continues processing later groups when Autumn refund fails", async () => {
    queue = [
      makeOp({
        team_id: "team-1",
        subscription_id: "sub-1",
        autumnTrackInRequest: true,
      }),
      makeOp({
        team_id: "team-2",
        subscription_id: "sub-2",
        autumnTrackInRequest: false,
      }),
    ];
    billTeam6
      .mockRejectedValueOnce(new Error("db failed"))
      .mockResolvedValueOnce([]);
    refundCredits.mockRejectedValueOnce(new Error("refund failed"));

    await processBillingBatch();

    expect(refundCredits).toHaveBeenCalledWith({
      teamId: "team-1",
      value: 10,
      properties: {
        source: "processBillingBatch",
        endpoint: "extract",
        apiKeyId: 123,
        subscriptionId: "sub-1",
      },
    });
    expect(billTeam6).toHaveBeenCalledTimes(2);
    expect(trackCredits).toHaveBeenCalledWith({
      teamId: "team-2",
      value: 10,
      properties: {
        source: "processBillingBatch",
        endpoint: "extract",
        apiKeyId: 123,
        subscriptionId: "sub-2",
      },
    });
    expect(captureException).toHaveBeenCalled();
  });
});
