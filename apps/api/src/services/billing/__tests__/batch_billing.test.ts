import { vi } from "vitest";

// vi.mock is hoisted above the file's static imports, so any value a factory
// reads at build time must be created in vi.hoisted(). The `redis` stub below
// stays module-level: its factory only captures it lazily.
const {
  logger,
  withAuth,
  trackCredits,
  refundCredits,
  billTeam7,
  getACUCTeam,
  reportExchangeBilling,
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
    reportExchangeBilling: vi.fn<(args: any) => Promise<boolean>>(),
  };
});

vi.mock("../../../lib/exchange", () => ({
  reportExchangeBilling,
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
  MCP_CREDITS_FEATURE_ID: "MCP_CREDITS",
}));

vi.mock("../../../db/rpc", () => ({
  billTeam7,
}));

// orgIdFromAcuc answers null without it, so the legacy op resolves no org.
vi.mock("../../../config", () => ({ config: { USE_DB_AUTHENTICATION: true } }));

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

import {
  processBillingBatch,
  queueBillingOperation,
  startBillingBatchProcessing,
} from "../batch_billing";

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

  it("does not look anything up for an operation that carries its org", async () => {
    queue = [makeOp({ org_id: "org-1", autumnTrackInRequest: true })];
    billTeam7.mockRejectedValueOnce(new Error("db failed"));

    await processBillingBatch();

    expect(getACUCTeam).not.toHaveBeenCalled();
    expect(refundCredits).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team-1", orgId: "org-1" }),
    );
  });

  it("refunds against an org resolved at refund time when the op recorded null", async () => {
    queue = [makeOp({ org_id: null, autumnTrackInRequest: true })];
    billTeam7.mockRejectedValueOnce(new Error("db failed"));

    await processBillingBatch();

    expect(getACUCTeam).toHaveBeenCalledWith("team-1");
    expect(refundCredits).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team-1", orgId: "org-legacy" }),
    );
  });

  it("resolves the refund-time org once per team across a batch", async () => {
    queue = [
      makeOp({ org_id: null, autumnTrackInRequest: true }),
      makeOp({ org_id: null, autumnTrackInRequest: true, api_key_id: 456 }),
    ];
    billTeam7.mockRejectedValue(new Error("db failed"));

    await processBillingBatch();

    expect(getACUCTeam).toHaveBeenCalledTimes(1);
    expect(refundCredits).toHaveBeenCalledTimes(2);
  });

  it("skips the refund when the refund-time lookup confirms no org", async () => {
    queue = [makeOp({ org_id: null, autumnTrackInRequest: true })];
    getACUCTeam.mockResolvedValue({ team_id: "team-1", org_id: null });
    billTeam7.mockRejectedValueOnce(new Error("db failed"));

    await processBillingBatch();

    expect(refundCredits).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "Skipping Autumn refund: no org for the team",
      { team_id: "team-1", credits: 10 },
    );
  });

  it("retries at refund time past a lookup that failed earlier in the batch", async () => {
    queue = [
      // The legacy op's lookup throws and is memoized unresolved; the null-org
      // op that follows must not inherit that failure.
      makeOp({ org_id: undefined, autumnTrackInRequest: true }),
      makeOp({ org_id: null, autumnTrackInRequest: true, api_key_id: 456 }),
    ];
    getACUCTeam
      .mockRejectedValueOnce(new Error("acuc unavailable"))
      .mockResolvedValue({ team_id: "team-1", org_id: "org-legacy" });
    billTeam7.mockRejectedValue(new Error("db failed"));

    await processBillingBatch();

    expect(getACUCTeam).toHaveBeenCalledTimes(2);
    expect(refundCredits).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team-1", orgId: "org-legacy" }),
    );
  });

  it("spends the refund-time retry once per team across a batch", async () => {
    queue = [
      // The legacy op's lookup throws and is memoized unresolved; the two
      // null-org groups that follow share the single retry it earns, so an
      // outage costs one extra call rather than one per group.
      makeOp({ org_id: undefined, autumnTrackInRequest: true }),
      makeOp({ org_id: null, autumnTrackInRequest: true, api_key_id: 456 }),
      makeOp({ org_id: null, autumnTrackInRequest: true, api_key_id: 789 }),
    ];
    getACUCTeam.mockRejectedValue(new Error("acuc unavailable"));
    billTeam7.mockRejectedValue(new Error("db failed"));

    await processBillingBatch();

    expect(getACUCTeam).toHaveBeenCalledTimes(2);
    expect(refundCredits).not.toHaveBeenCalled();
  });

  it("skips the refund when the refund-time lookup throws", async () => {
    queue = [makeOp({ org_id: null, autumnTrackInRequest: true })];
    getACUCTeam.mockRejectedValue(new Error("acuc unavailable"));
    billTeam7.mockRejectedValueOnce(new Error("db failed"));

    await processBillingBatch();

    expect(refundCredits).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "Skipping Autumn refund: no org for the team",
      { team_id: "team-1", credits: 10 },
    );
    // The op still billed and is not requeued: only the legacy branch defers.
    expect(billTeam7).toHaveBeenCalled();
    expect(queue).toHaveLength(0);
  });
});

describe("startBillingBatchProcessing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs a Redis error on a tick and keeps processing on the next one", async () => {
    vi.useFakeTimers();
    const loadingError = new Error(
      "LOADING Redis is loading the dataset in memory",
    );
    redis.llen.mockRejectedValueOnce(loadingError);

    startBillingBatchProcessing();

    await vi.advanceTimersByTimeAsync(15000);
    expect(logger.error).toHaveBeenCalledWith(
      "Error in periodic billing batch processing",
      { error: loadingError },
    );
    expect(redis.set).not.toHaveBeenCalled();

    queue = [makeOp()];
    await vi.advanceTimersByTimeAsync(15000);
    expect(billTeam7).toHaveBeenCalledTimes(1);
    expect(queue).toHaveLength(0);
  });
});

describe("MCP credits on the ledger", () => {
  it("records the part MCP credits paid as its own tagged row", async () => {
    await queueBillingOperation(
      "team-1",
      "org-1",
      5,
      123,
      { endpoint: "scrape", hostedMcp: true, mcpCredits: 3 },
      false,
      true,
    );
    expect(queue).toHaveLength(1);

    await processBillingBatch();

    expect(billTeam7).toHaveBeenCalledTimes(2);
    expect(billTeam7).toHaveBeenCalledWith(
      expect.objectContaining({ credits: 2, subscription_id: null }),
    );
    expect(billTeam7).toHaveBeenCalledWith(
      expect.objectContaining({ credits: 3, subscription_id: "mcp_credits" }),
    );
  });

  it("records a charge MCP credits paid in full as one tagged row", async () => {
    await queueBillingOperation(
      "team-1",
      "org-1",
      5,
      123,
      { endpoint: "scrape", hostedMcp: true, mcpCredits: 5 },
      false,
      true,
    );
    await processBillingBatch();

    expect(billTeam7).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ credits: 5, subscription_id: "mcp_credits" }),
    );
  });

  it("records a charge MCP credits paid nothing of as today's untagged row", async () => {
    await queueBillingOperation(
      "team-1",
      "org-1",
      5,
      123,
      { endpoint: "scrape", hostedMcp: true },
      false,
      true,
    );
    await processBillingBatch();

    expect(billTeam7).toHaveBeenCalledExactlyOnceWith({
      team_id: "team-1",
      subscription_id: null,
      credits: 5,
      api_key_id: 123,
      is_extract: false,
    });
  });

  it("refunds each part to the balance it was tracked on when the ledger fails", async () => {
    await queueBillingOperation(
      "team-1",
      "org-1",
      5,
      123,
      { endpoint: "scrape", hostedMcp: true, mcpCredits: 3 },
      false,
      true,
    );
    billTeam7.mockRejectedValue(new Error("db failed"));

    await processBillingBatch();

    expect(refundCredits).toHaveBeenCalledTimes(2);
    expect(refundCredits).toHaveBeenCalledWith(
      expect.objectContaining({ value: 2, featureId: "CREDITS" }),
    );
    expect(refundCredits).toHaveBeenCalledWith(
      expect.objectContaining({ value: 3, featureId: "MCP_CREDITS" }),
    );
  });

  it("refunds only the MCP credits part when the rest was not tracked", async () => {
    await queueBillingOperation(
      "team-1",
      "org-1",
      5,
      123,
      { endpoint: "scrape", hostedMcp: true, mcpCredits: 3 },
      false,
      false,
    );
    billTeam7.mockRejectedValue(new Error("db failed"));

    await processBillingBatch();

    expect(refundCredits).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ value: 3, featureId: "MCP_CREDITS" }),
    );
  });

  it("confirms a split charge's Exchange access once, after both rows commit", async () => {
    await queueBillingOperation(
      "team-1",
      "org-1",
      5,
      123,
      { endpoint: "scrape", hostedMcp: true, mcpCredits: 3 },
      false,
      true,
      { accessEventId: "access-1", billingReference: "ref-1" },
    );
    await processBillingBatch();

    expect(reportExchangeBilling).toHaveBeenCalledExactlyOnceWith({
      accessEventId: "access-1",
      status: "confirmed",
      billingReference: "ref-1",
    });
  });

  it("leaves a split charge's Exchange access pending when one row fails", async () => {
    await queueBillingOperation(
      "team-1",
      "org-1",
      5,
      123,
      { endpoint: "scrape", hostedMcp: true, mcpCredits: 3 },
      false,
      true,
      { accessEventId: "access-1" },
    );
    billTeam7.mockImplementation(async ({ subscription_id }) => {
      if (subscription_id === "mcp_credits") throw new Error("db failed");
      return [];
    });

    await processBillingBatch();

    expect(billTeam7).toHaveBeenCalledTimes(2);
    expect(reportExchangeBilling).not.toHaveBeenCalled();
  });
});
