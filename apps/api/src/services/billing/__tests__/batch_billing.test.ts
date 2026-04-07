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
jest.mock("../../autumn/autumn.service", () => ({
  autumnService: {
    trackCredits,
  },
}));

const rpc = jest.fn<(name: string, args: any) => Promise<any>>();
jest.mock("../../supabase", () => ({
  supabase_service: {
    rpc,
  },
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
  rpc.mockResolvedValue({ data: [], error: null });
  trackCredits.mockResolvedValue(true);
});

describe("processBillingBatch", () => {
  it("tracks Autumn usage after successful billing", async () => {
    queue = [makeOp()];

    await processBillingBatch();

    expect(rpc).toHaveBeenCalled();
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

  it("skips Autumn tracking when billing returns an error", async () => {
    queue = [makeOp()];
    rpc.mockResolvedValueOnce({ data: null, error: new Error("db failed") });

    await processBillingBatch();

    expect(trackCredits).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("captures exceptions when billing throws", async () => {
    queue = [makeOp()];
    rpc.mockRejectedValueOnce(new Error("rpc exploded"));

    await processBillingBatch();

    expect(trackCredits).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalled();
  });

  it("continues processing later groups when earlier group fails", async () => {
    queue = [
      makeOp({
        team_id: "team-1",
        subscription_id: "sub-1",
      }),
      makeOp({
        team_id: "team-2",
        subscription_id: "sub-2",
      }),
    ];
    rpc
      .mockResolvedValueOnce({ data: null, error: new Error("db failed") })
      .mockResolvedValueOnce({ data: [], error: null });

    await processBillingBatch();

    expect(rpc).toHaveBeenCalledTimes(2);
    // First group failed, so no Autumn tracking for it
    // Second group succeeded, so Autumn tracking happens
    expect(trackCredits).toHaveBeenCalledTimes(1);
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
  });
});
