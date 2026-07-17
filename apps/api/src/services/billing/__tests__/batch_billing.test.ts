import { vi } from "vitest";

// vi.mock is hoisted above the file's static imports, so any value a factory
// reads at build time must be created in vi.hoisted(). (Jest left jest.mock
// un-hoisted here because `jest` was imported from @jest/globals.) The `redis`
// stub below stays module-level: its factory only captures it lazily.
const {
  captureException,
  logger,
  withAuth,
  trackCredits,
  refundCredits,
  billTeam7,
} = vi.hoisted(() => {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return {
    captureException: vi.fn(),
    logger,
    withAuth: vi.fn((fn: any) => fn),
    trackCredits: vi.fn<(args: any) => Promise<boolean>>(),
    refundCredits: vi.fn<(args: any) => Promise<void>>(),
    billTeam7: vi.fn<(params: any) => Promise<{ api_key: string }[]>>(),
  };
});

vi.mock("@sentry/node", () => ({
  captureException,
}));

vi.mock("../../../lib/logger", () => ({
  logger,
}));

vi.mock("../../../lib/withAuth", () => ({
  withAuth,
}));

vi.mock("../../autumn/autumn.service", () => ({
  autumnService: {
    trackCredits,
    refundCredits,
  },
  featureIdForBillingEndpoint: (endpoint?: string) =>
    endpoint === "search" ? "SEARCH_CREDITS" : "CREDITS",
}));

vi.mock("../../../db/rpc", () => ({
  billTeam7,
}));

let queue: string[] = [];
const billedTeams = new Set<string>();
const locks = new Map<string, string>();
const redis = {
  set: vi.fn(
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
  del: vi.fn(async (key: string) => {
    if (key !== "billing_batch_lock") {
      throw new Error("unexpected redis.del key");
    }
    return locks.delete(key) ? 1 : 0;
  }),
  lpop: vi.fn(async (key: string) => {
    if (key !== "billing_batch") {
      throw new Error("unexpected redis.lpop key");
    }
    return queue.shift() ?? null;
  }),
  llen: vi.fn(async (key: string) => {
    if (key !== "billing_batch") {
      throw new Error("unexpected redis.llen key");
    }
    return queue.length;
  }),
  rpush: vi.fn(async (key: string, value: string) => {
    if (key !== "billing_batch") {
      throw new Error("unexpected redis.rpush key");
    }
    queue.push(value);
    return queue.length;
  }),
  sadd: vi.fn(async (key: string, teamId: string) => {
    if (key !== "billed_teams") {
      throw new Error("unexpected redis.sadd key");
    }
    billedTeams.add(teamId);
    return 1;
  }),
};
vi.mock("../../queue-service", () => ({
  getRedisConnection: () => redis,
}));

import { processBillingBatch } from "../batch_billing";

function makeOp(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    team_id: "team-1",
    credits: 10,
    billing: { endpoint: "extract" },
    is_extract: false,
    timestamp: "2026-03-13T00:00:00.000Z",
    api_key_id: 123,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  queue = [];
  billedTeams.clear();
  locks.clear();
  billTeam7.mockResolvedValue([]);
  trackCredits.mockResolvedValue(true);
  refundCredits.mockResolvedValue(undefined);
});

describe("processBillingBatch", () => {
  it("commits the ledger but never re-tracks usage to Autumn", async () => {
    // Even when an op was not request-tracked, the batch must not track usage
    // to Autumn — request-time tracking is the single source, so re-tracking
    // here would double-count. The batch only commits the ledger.
    queue = [makeOp()];

    await processBillingBatch();

    expect(billTeam7).toHaveBeenCalled();
    expect(trackCredits).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("does not re-track even when the op was already tracked at request time", async () => {
    queue = [makeOp({ autumnTrackInRequest: true })];

    await processBillingBatch();

    expect(billTeam7).toHaveBeenCalled();
    expect(trackCredits).not.toHaveBeenCalled();
  });

  it("refunds request-tracked credits when billing returns success false", async () => {
    queue = [makeOp({ autumnTrackInRequest: true })];
    billTeam7.mockRejectedValueOnce(new Error("db failed"));

    await processBillingBatch();

    expect(refundCredits).toHaveBeenCalledWith({
      teamId: "team-1",
      value: 10,
      properties: {
        source: "processBillingBatch",
        endpoint: "extract",
        apiKeyId: 123,
      },
      featureId: "CREDITS",
    });
    expect(captureException).toHaveBeenCalled();
  });

  it("captures exceptions and refunds when billing throws", async () => {
    queue = [makeOp({ autumnTrackInRequest: true })];
    billTeam7.mockRejectedValueOnce(new Error("rpc exploded"));

    await processBillingBatch();

    expect(refundCredits).toHaveBeenCalledWith({
      teamId: "team-1",
      value: 10,
      properties: {
        source: "processBillingBatch",
        endpoint: "extract",
        apiKeyId: 123,
      },
      featureId: "CREDITS",
    });
    expect(captureException).toHaveBeenCalled();
  });

  it("continues processing later groups when an Autumn refund fails", async () => {
    queue = [
      makeOp({
        team_id: "team-1",
        autumnTrackInRequest: true,
      }),
      makeOp({
        team_id: "team-2",
        autumnTrackInRequest: true,
      }),
    ];
    billTeam7
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
      },
      featureId: "CREDITS",
    });
    expect(billTeam7).toHaveBeenCalledTimes(2);
    // The batch never tracks usage to Autumn, regardless of the request-time flag.
    expect(trackCredits).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalled();
  });
});
