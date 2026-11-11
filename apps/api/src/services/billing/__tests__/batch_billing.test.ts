import { vi } from "vitest";

// vi.mock is hoisted above the file's static imports, so any value a factory
// reads at build time must be created in vi.hoisted(). The `redis` stub below
// stays module-level: its factory only captures it lazily.
const {
  logger,
  trackCredits,
  refundCredits,
  reportExchangeBilling,
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
    trackCredits: vi.fn<(args: any) => Promise<boolean>>(),
    refundCredits: vi.fn<(args: any) => Promise<void>>(),
    reportExchangeBilling: vi.fn<(args: any) => Promise<void>>(),
    getACUCTeam: vi.fn<(teamId: string) => Promise<any>>(),
  };
});

vi.mock("../../../lib/logger", () => ({
  logger,
}));

vi.mock("../../autumn/autumn.service", () => ({
  autumnService: {
    trackCredits,
    refundCredits,
    hostedMcpFeatureId: async () => "MCP_CREDITS",
  },
  featureIdForBillingEndpoint: (endpoint?: string) =>
    endpoint === "search" ? "SEARCH_CREDITS" : "CREDITS",
}));

vi.mock("../../../lib/exchange", () => ({
  reportExchangeBilling,
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
  trackCredits.mockResolvedValue(true);
  refundCredits.mockResolvedValue(undefined);
  getACUCTeam.mockResolvedValue({ team_id: "team-1", org_id: "org-legacy" });
});

describe("processBillingBatch", () => {
  it("finalizes the group without re-tracking or refunding the Autumn charge", async () => {
    // Request-time tracking is the charge. The batch must not track again
    // and must not refund a charge that finalized.
    queue = [makeOp()];

    await processBillingBatch();

    expect(trackCredits).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
    expect(queue).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      "✅ Successfully billed team team-1 for 10 credits",
    );
  });

  it("does not re-track or refund when the op was already tracked at request time", async () => {
    queue = [makeOp({ autumnTrackInRequest: true })];

    await processBillingBatch();

    expect(trackCredits).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
  });

  it("confirms Exchange accesses for a committed group", async () => {
    queue = [
      makeOp({
        autumnTrackInRequest: true,
        exchange_access_event_id: "evt-1",
        billing_reference: "ref-1",
      }),
    ];

    await processBillingBatch();

    expect(refundCredits).not.toHaveBeenCalled();
    expect(reportExchangeBilling).toHaveBeenCalledWith({
      accessEventId: "evt-1",
      status: "confirmed",
      billingReference: "ref-1",
    });
  });

  it("finalizes every group without refunding", async () => {
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

    await processBillingBatch();

    expect(refundCredits).not.toHaveBeenCalled();
    expect(trackCredits).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "✅ Successfully billed team team-1 for 10 credits",
    );
    expect(logger.info).toHaveBeenCalledWith(
      "✅ Successfully billed team team-2 for 10 credits",
    );
  });

  it("refunds when finalization throws and still finalizes the next group if the refund fails", async () => {
    queue = [
      makeOp({
        team_id: "team-1",
        autumnTrackInRequest: true,
        exchange_access_event_id: "evt-failed",
      }),
      makeOp({
        team_id: "team-2",
        autumnTrackInRequest: true,
        exchange_access_event_id: "evt-ok",
      }),
    ];
    logger.info.mockImplementation((message: string) => {
      if (message === "✅ Successfully billed team team-1 for 10 credits") {
        throw new Error("finalization failed");
      }
    });
    refundCredits.mockRejectedValueOnce(new Error("refund failed"));

    try {
      await processBillingBatch();

      expect(refundCredits).toHaveBeenCalledExactlyOnceWith({
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
      expect(logger.warn).toHaveBeenCalledWith(
        "Failed to refund Autumn request-tracked credits",
        expect.objectContaining({ team_id: "team-1", credits: 10 }),
      );
      expect(reportExchangeBilling).toHaveBeenCalledExactlyOnceWith({
        accessEventId: "evt-ok",
        status: "confirmed",
      });
      expect(logger.info).toHaveBeenCalledWith(
        "✅ Successfully billed team team-2 for 10 credits",
      );
      expect(trackCredits).not.toHaveBeenCalled();
    } finally {
      logger.info.mockReset();
    }
  });

  // Transitional: operations enqueued before org_id was carried. Remove with
  // the lookup they exist for, after one deploy.
  it("resolves the org once for operations that predate the field", async () => {
    queue = [
      makeOp({ org_id: undefined, autumnTrackInRequest: true }),
      makeOp({ org_id: undefined, autumnTrackInRequest: true }),
    ];

    await processBillingBatch();

    expect(getACUCTeam).toHaveBeenCalledTimes(1);
    expect(refundCredits).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "✅ Successfully billed team team-1 for 20 credits",
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
    expect(refundCredits).not.toHaveBeenCalled();
    expect(queue).toHaveLength(2);
    expect(JSON.parse(queue[0])).not.toHaveProperty("org_id");
    expect(logger.warn).toHaveBeenCalledWith(
      "Requeueing legacy billing operations whose org could not be resolved",
      { count: 2 },
    );
  });

  it("finalizes a legacy operation whose team is confirmed to have no org", async () => {
    queue = [makeOp({ org_id: undefined, autumnTrackInRequest: true })];
    getACUCTeam.mockResolvedValue({ team_id: "team-1", org_id: null });

    await processBillingBatch();

    // A confirmed null is an org-less team: nothing is refunded, and the
    // charge was never tracked to Autumn for lack of an org.
    expect(refundCredits).not.toHaveBeenCalled();
    expect(queue).toHaveLength(0);
  });

  it("does not look anything up for an operation that carries its org", async () => {
    queue = [makeOp({ org_id: "org-1", autumnTrackInRequest: true })];

    await processBillingBatch();

    expect(getACUCTeam).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
  });

  it("finalizes an operation that recorded a null org without a refund lookup", async () => {
    queue = [makeOp({ org_id: null, autumnTrackInRequest: true })];

    await processBillingBatch();

    expect(getACUCTeam).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
    expect(queue).toHaveLength(0);
  });
});

describe("hosted MCP charges", () => {
  const hosted = (overrides: Record<string, unknown> = {}) =>
    makeOp({
      credits: 5,
      billing: { endpoint: "scrape", hostedMcp: true },
      autumnTrackInRequest: true,
      ...overrides,
    });

  it("finalizes a hosted charge without refunding it", async () => {
    queue = [hosted(), makeOp({ autumnTrackInRequest: true })];

    await processBillingBatch();

    expect(refundCredits).not.toHaveBeenCalled();
    expect(trackCredits).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "✅ Successfully billed team team-1 for 5 credits",
    );
    expect(logger.info).toHaveBeenCalledWith(
      "✅ Successfully billed team team-1 for 10 credits",
    );
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
    expect(refundCredits).not.toHaveBeenCalled();
    expect(queue).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      "✅ Successfully billed team team-1 for 10 credits",
    );
  });
});
