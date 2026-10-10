import { PgDialect } from "drizzle-orm/pg-core";

const {
  primarySelect,
  replicaSelect,
  primaryUpdate,
  where,
  set,
  limit,
  returning,
  orderBy,
} = vi.hoisted(() => {
  const where = vi.fn();
  const set = vi.fn();
  const limit = vi.fn();
  const returning = vi.fn();
  const orderBy = vi.fn();
  const chain = {
    from: vi.fn(() => chain),
    set: set.mockImplementation(() => chain),
    where: where.mockImplementation(() => chain),
    orderBy: orderBy.mockImplementation(() => chain),
    limit,
    returning,
  };
  return {
    primarySelect: vi.fn(() => chain),
    replicaSelect: vi.fn(() => chain),
    primaryUpdate: vi.fn(() => chain),
    where,
    set,
    limit,
    returning,
    orderBy,
  };
});

vi.mock("../../db/connection", () => ({
  db: { select: primarySelect, update: primaryUpdate },
  dbRr: { select: replicaSelect },
}));
vi.mock("../../db/rpc", () => ({ monitoringClaimDueMonitors: vi.fn() }));

import {
  getMonitorCheckForUpdate,
  listRunningMonitorChecks,
  updateMonitorCheckIfRunning,
  updateMonitorCheckIfStatus,
} from "./store";

const teamId = "11111111-1111-4111-8111-111111111111";
const monitorId = "22222222-2222-4222-8222-222222222222";
const checkId = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  limit.mockResolvedValue([]);
  returning.mockResolvedValue([]);
});

function queryPredicate() {
  expect(where).toHaveBeenCalledTimes(1);
  return new PgDialect().sqlToQuery(where.mock.calls[0][0]);
}

describe("monitor check finalization storage", () => {
  it("selects a bounded keyset page using the indexed timestamp range and unique tie breaker", async () => {
    const through = { created_at: "2026-01-01T01:00:00.000001Z", id: checkId };
    const after = { created_at: "2026-01-01T00:00:00.000Z", id: checkId };
    expect(await listRunningMonitorChecks(50, { through, after })).toEqual([]);
    expect(replicaSelect).toHaveBeenCalledTimes(1);
    expect(primarySelect).not.toHaveBeenCalled();
    expect(primaryUpdate).not.toHaveBeenCalled();
    expect(limit).toHaveBeenCalledWith(50);
    const predicate = queryPredicate();
    expect(predicate.sql).toBe(
      '(("monitor_checks"."status" = $1) and ("monitor_checks"."created_at" <= $2) and (("monitor_checks"."created_at", "monitor_checks"."id") <= ($3::timestamptz, $4::uuid)) and ("monitor_checks"."created_at" >= $5) and (("monitor_checks"."created_at", "monitor_checks"."id") > ($6::timestamptz, $7::uuid)))',
    );
    expect(predicate.params).toEqual([
      "running",
      through.created_at,
      through.created_at,
      through.id,
      after.created_at,
      after.created_at,
      checkId,
    ]);
    const dialect = new PgDialect();
    expect(
      orderBy.mock.calls[0].map(column => dialect.sqlToQuery(column).sql),
    ).toEqual([
      '"monitor_checks"."created_at" asc',
      '"monitor_checks"."id" asc',
    ]);
  });

  it("reads the current check from primary scoped to its team and monitor", async () => {
    const confirmed = {
      id: checkId,
      monitor_id: monitorId,
      team_id: teamId,
      status: "completed",
      billing_status: "confirmed",
    };
    limit.mockResolvedValue([confirmed]);

    expect(await getMonitorCheckForUpdate(teamId, monitorId, checkId)).toEqual(
      confirmed,
    );
    expect(primarySelect).toHaveBeenCalledTimes(1);
    expect(replicaSelect).not.toHaveBeenCalled();
    expect(limit).toHaveBeenCalledWith(1);
    const predicate = queryPredicate();
    expect(predicate.sql).toBe(
      '(("monitor_checks"."id" = $1) and ("monitor_checks"."monitor_id" = $2) and ("monitor_checks"."team_id" = $3))',
    );
    expect(predicate.params).toEqual([checkId, monitorId, teamId]);
  });

  it("returns null when the authoritative check no longer exists", async () => {
    expect(
      await getMonitorCheckForUpdate(teamId, monitorId, checkId),
    ).toBeNull();
    expect(primarySelect).toHaveBeenCalledTimes(1);
    expect(replicaSelect).not.toHaveBeenCalled();
  });

  it("claims finalization with one conditional update while the check is running", async () => {
    const completed = { id: checkId, status: "completed" };
    returning.mockResolvedValue([completed]);

    expect(
      await updateMonitorCheckIfRunning(checkId, {
        status: "completed",
        billing_status: "reserved",
      }),
    ).toEqual(completed);
    expect(primarySelect).not.toHaveBeenCalled();
    expect(replicaSelect).not.toHaveBeenCalled();
    expect(primaryUpdate).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({
      status: "completed",
      billing_status: "reserved",
      updated_at: expect.any(String),
    });
    const predicate = queryPredicate();
    expect(predicate.sql).toBe(
      '(("monitor_checks"."id" = $1) and ("monitor_checks"."status" = $2))',
    );
    expect(predicate.params).toEqual([checkId, "running"]);
  });

  it("returns null to a finalizer that lost the terminal-state claim", async () => {
    expect(
      await updateMonitorCheckIfRunning(checkId, {
        status: "failed",
        billing_status: "released",
      }),
    ).toBeNull();
    expect(primaryUpdate).toHaveBeenCalledTimes(1);
    expect(queryPredicate().params).toEqual([checkId, "running"]);
  });

  it("conditions a queued check transition on the queued state it observed", async () => {
    const failed = { id: checkId, status: "failed" };
    returning.mockResolvedValue([failed]);

    expect(
      await updateMonitorCheckIfStatus(checkId, "queued", {
        status: "failed",
      }),
    ).toEqual(failed);
    expect(primarySelect).not.toHaveBeenCalled();
    expect(replicaSelect).not.toHaveBeenCalled();
    expect(primaryUpdate).toHaveBeenCalledTimes(1);
    const predicate = queryPredicate();
    expect(predicate.sql).toBe(
      '(("monitor_checks"."id" = $1) and ("monitor_checks"."status" = $2))',
    );
    expect(predicate.params).toEqual([checkId, "queued"]);
  });
});
