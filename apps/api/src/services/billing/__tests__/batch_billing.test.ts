import { vi } from "vitest";

// vi.mock is hoisted above the file's static imports, so any value a factory
// reads at build time must be created in vi.hoisted(). (Jest left jest.mock
// un-hoisted here because `jest` was imported from @jest/globals.) The `redis`
// stub below stays module-level: its factory only captures it lazily.
const {
  logger,
  withAuth,
  trackCredits,
  refundCredits,
  billTeam7,
  getACUCTeam,
} = vi.hoisted(() => {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return {
    logger,
    withAuth: vi.fn((fn: any) => fn),
    trackCredits: vi.fn<(args: any) => Promise<boolean>>(),
    refundCredits: vi.fn<(args: any) => Promise<void>>(),
    billTeam7: vi.fn<(params: any) => Promise<{ api_key: string }[]>>(),
    getACUCTeam: vi.fn<(teamId: string) => Promise<any>>(),
  };
});

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

vi.mock("../../../controllers/auth", () => ({
  getACUCTeam,
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
  rpush: vi.fn(async (key: string, ...values: string[]) => {
    if (key !== "billing_batch") {
      throw new Error("unexpected redis.rpush key");
    }
    queue.push(...values);
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
  // `org_id: undefined` in an override drops the key entirely, which is the
  // shape of an operation enqueued before the field existed.
  return JSON.stringify({
    team_id: "team-1",
    org_id: "org-1",
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
  getACUCTeam.mockResolvedValue({ team_id: "team-1", org_id: "org-legacy" });
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
      orgId: "org-1",
      value: 10,
      properties: {
        source: "processBillingBatch",
        endpoint: "extract",
        apiKeyId: 123,
      },
      featureId: "CREDITS",
    });
  });

  it("refunds when billing throws", async () => {
    queue = [makeOp({ autumnTrackInRequest: true })];
    billTeam7.mockRejectedValueOnce(new Error("rpc exploded"));

    await processBillingBatch();

    expect(refundCredits).toHaveBeenCalledWith({
      teamId: "team-1",
      orgId: "org-1",
      value: 10,
      properties: {
        source: "processBillingBatch",
        endpoint: "extract",
        apiKeyId: 123,
      },
      featureId: "CREDITS",
    });
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
      orgId: "org-1",
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
  });

  // Transitional: operations enqueued before org_id was carried. Remove with
  // the lookup they exist for, after one deploy.
  it("resolves the org once for operations that predate the field", async () => {
    queue = [
      makeOp({ org_id: undefined, autumnTrackInRequest: true }),
      makeOp({ org_id: undefined, autumnTrackInRequest: true }),
    ];
    billTeam7.mockRejectedValue(new Error("db failed"));

    await processBillingBatch();

    expect(getACUCTeam).toHaveBeenCalledTimes(1);
    expect(refundCredits).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team-1", orgId: "org-legacy" }),
    );
  });

  it("requeues legacy operations when the org lookup throws", async () => {
    queue = [
      makeOp({ org_id: undefined, autumnTrackInRequest: true }),
      makeOp({ org_id: undefined, autumnTrackInRequest: true }),
    ];
    getACUCTeam.mockRejectedValue(new Error("acuc unavailable"));

    await processBillingBatch();

    // Nothing billed and nothing refunded for them; both are back on the
    // queue in their original shape, still without org_id.
    expect(billTeam7).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
    expect(queue).toHaveLength(2);
    expect(JSON.parse(queue[0])).not.toHaveProperty("org_id");
    expect(logger.warn).toHaveBeenCalledWith(
      "Requeueing legacy billing operations whose org could not be resolved",
      { count: 2 },
    );
  });

  it("bills a legacy operation whose team is confirmed to have no org", async () => {
    queue = [makeOp({ org_id: undefined, autumnTrackInRequest: true })];
    getACUCTeam.mockResolvedValue({ team_id: "team-1", org_id: null });
    billTeam7.mockRejectedValueOnce(new Error("db failed"));

    await processBillingBatch();

    expect(billTeam7).toHaveBeenCalled();
    // A confirmed null is an org-less team: the refund is skipped, not deferred.
    expect(refundCredits).not.toHaveBeenCalled();
    expect(queue).toHaveLength(0);
  });

  it("does not look anything up for an operation whose org is a known null", async () => {
    queue = [makeOp({ org_id: null, autumnTrackInRequest: true })];
    billTeam7.mockRejectedValueOnce(new Error("db failed"));

    await processBillingBatch();

    expect(getACUCTeam).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
  });
});
