import { vi } from "vitest";

// vi.mock is hoisted above the file's static imports, so any value a factory
// reads at build time must be created in vi.hoisted(). (Jest left jest.mock
// un-hoisted here because `jest` was imported from @jest/globals.) The `redis`
// stub below stays module-level: its factory only captures it lazily.
const {
  logger,
  getACUCTeam,
  reportExchangeBilling,
  legacyLedgerRpc,
  trackCredits,
  refundCredits,
} = vi.hoisted(() => {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return {
    logger,
    getACUCTeam: vi.fn<(teamId: string) => Promise<any>>(),
    reportExchangeBilling: vi.fn<(args: any) => Promise<void>>(),
    // Stands in for the database module: the batch must not reach it.
    legacyLedgerRpc: vi.fn(),
    trackCredits: vi.fn(),
    refundCredits: vi.fn(),
  };
});

vi.mock("../../../lib/logger", () => ({
  logger,
}));

vi.mock("../../../db/rpc", () => ({
  billTeam7: legacyLedgerRpc,
}));

vi.mock("../../autumn/autumn.service", () => ({
  autumnService: { trackCredits, refundCredits },
  featureIdForBillingEndpoint: () => "CREDITS",
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

import { processBillingBatch } from "../batch_billing";
import { billingUnrecordedUsageTotal } from "../metrics";

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

async function unrecordedByReason(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const v of (await billingUnrecordedUsageTotal.get()).values) {
    out[String(v.labels.reason)] = v.value;
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  queue = [];
  billedTeams.clear();
  locks.clear();
  billingUnrecordedUsageTotal.reset();
  reportExchangeBilling.mockResolvedValue(undefined);
  getACUCTeam.mockResolvedValue({ team_id: "team-1", org_id: "org-legacy" });
});

describe("processBillingBatch", () => {
  it("does not write to the database", async () => {
    queue = [
      makeOp({ autumnTrackInRequest: true }),
      makeOp({ autumnTrackInRequest: false, team_id: "team-2" }),
    ];

    await processBillingBatch();

    expect(legacyLedgerRpc).not.toHaveBeenCalled();
    // Request-time tracking is the single source: the batch never re-tracks.
    expect(trackCredits).not.toHaveBeenCalled();
    expect(queue).toHaveLength(0);
  });

  it("confirms Exchange events for tracked operations after the lock is released", async () => {
    queue = [
      makeOp({
        autumnTrackInRequest: true,
        exchange_access_event_id: "evt-1",
        billing_reference: "bill-1",
      }),
      makeOp({
        autumnTrackInRequest: true,
        api_key_id: 456,
        exchange_access_event_id: "evt-2",
      }),
      // Tracked, but no Exchange access behind it: nothing to confirm.
      makeOp({ autumnTrackInRequest: true, api_key_id: 789 }),
    ];
    reportExchangeBilling.mockImplementation(async () => {
      expect(locks.has("billing_batch_lock")).toBe(false);
    });

    await processBillingBatch();

    expect(reportExchangeBilling).toHaveBeenCalledTimes(2);
    expect(reportExchangeBilling).toHaveBeenCalledWith({
      accessEventId: "evt-1",
      status: "confirmed",
      billingReference: "bill-1",
    });
    expect(reportExchangeBilling).toHaveBeenCalledWith({
      accessEventId: "evt-2",
      status: "confirmed",
    });
    expect(await unrecordedByReason()).toEqual({});
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("counts untracked operations and leaves their Exchange events pending", async () => {
    queue = [
      makeOp({
        autumnTrackInRequest: false,
        exchange_access_event_id: "evt-untracked",
      }),
      // Absent flag: an operation enqueued without it was never tracked.
      makeOp({ api_key_id: 456 }),
      makeOp({
        autumnTrackInRequest: true,
        exchange_access_event_id: "evt-tracked",
      }),
    ];

    await processBillingBatch();

    expect(await unrecordedByReason()).toEqual({ track_failed: 2 });
    expect(refundCredits).not.toHaveBeenCalled();
    expect(reportExchangeBilling).toHaveBeenCalledTimes(1);
    expect(reportExchangeBilling).toHaveBeenCalledWith({
      accessEventId: "evt-tracked",
      status: "confirmed",
    });
    expect(logger.error).toHaveBeenCalledWith(
      "Billing operation usage is not recorded",
      expect.objectContaining({
        reason: "track_failed",
        team_id: "team-1",
        org_id: "org-1",
        credits: 10,
        exchange_access_event_id: "evt-untracked",
      }),
    );
  });

  it("counts a no-org operation with the no_org reason", async () => {
    queue = [makeOp({ org_id: null, autumnTrackInRequest: false })];

    await processBillingBatch();

    expect(await unrecordedByReason()).toEqual({ no_org: 1 });
    // The recorded null is the answer: no lookup is made for it.
    expect(getACUCTeam).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "Billing operation usage is not recorded",
      expect.objectContaining({ reason: "no_org", org_id: null }),
    );
  });

  it("skips preview teams without counting them", async () => {
    queue = [
      makeOp({ team_id: "preview", org_id: null }),
      makeOp({ team_id: "preview_abc", org_id: null }),
    ];

    await processBillingBatch();

    expect(await unrecordedByReason()).toEqual({});
    expect(reportExchangeBilling).not.toHaveBeenCalled();
  });

  // Transitional: operations enqueued before org_id was carried. Remove with
  // the lookup they exist for, after one deploy.
  it("resolves the org once for operations that predate the field", async () => {
    queue = [
      makeOp({ org_id: undefined, autumnTrackInRequest: false }),
      makeOp({ org_id: undefined, autumnTrackInRequest: false }),
    ];

    await processBillingBatch();

    expect(getACUCTeam).toHaveBeenCalledTimes(1);
    expect(await unrecordedByReason()).toEqual({ track_failed: 2 });
  });

  it("requeues legacy operations when the org lookup throws", async () => {
    queue = [
      makeOp({ org_id: undefined, autumnTrackInRequest: true }),
      makeOp({ org_id: undefined, autumnTrackInRequest: false }),
    ];
    getACUCTeam.mockRejectedValue(new Error("acuc unavailable"));

    await processBillingBatch();

    // Nothing confirmed and nothing counted for them; both are back on the
    // queue in their original shape, still without org_id.
    expect(reportExchangeBilling).not.toHaveBeenCalled();
    expect(await unrecordedByReason()).toEqual({});
    expect(queue).toHaveLength(2);
    expect(JSON.parse(queue[0])).not.toHaveProperty("org_id");
    expect(logger.warn).toHaveBeenCalledWith(
      "Requeueing legacy billing operations whose org could not be resolved",
      { count: 2 },
    );
  });

  it("counts a legacy operation whose team is confirmed to have no org as no_org", async () => {
    queue = [makeOp({ org_id: undefined, autumnTrackInRequest: false })];
    getACUCTeam.mockResolvedValue({ team_id: "team-1", org_id: null });

    await processBillingBatch();

    expect(await unrecordedByReason()).toEqual({ no_org: 1 });
    expect(queue).toHaveLength(0);
  });
});
