import { getTableName } from "drizzle-orm";

// A fake of the few drizzle chains access-record and access-backfill use,
// keyed by table: one stored access row, the accepting key, memberships and
// the org's teams.
const mocks = vi.hoisted(() => {
  const state = {
    row: null as Record<string, any> | null,
    key: null as { owner: string | null; team: string; org: string } | null,
    roles: new Map<string, string>(),
    teams: [{ id: "team-a" }, { id: "team-b" }],
    failWrites: 0,
    conflicts: 0,
    writes: [] as { kind: string; values: Record<string, any> }[],
    clock: 0,
  };
  return {
    state,
    request: vi.fn(),
    clear: vi.fn(),
  };
});

vi.mock("./client", () => ({ exchangeRequest: mocks.request }));
vi.mock("../../controllers/auth", () => ({ clearACUCForTeam: mocks.clear }));
vi.mock("../../db/connection", () => {
  const { state } = mocks;
  const nextUpdatedAt = () =>
    `2026-09-25 00:00:${String(++state.clock).padStart(2, "0")}.123456+00`;
  const selectResult = (table: string, joined: string | null) => {
    if (table === "api_keys") return state.key ? [state.key] : [];
    if (table === "user_teams") {
      const role = state.roles.get(joined ? "any-team" : "key-team");
      return role ? [{ role }] : [];
    }
    if (table === "organization_data_source_access")
      return state.row ? [{ ...state.row }] : [];
    if (table === "teams") return state.teams;
    return [];
  };
  const chain = (run: (c: any) => unknown) => {
    const c: any = { table: "", joined: null, payload: undefined };
    c.from = (t: any) => ((c.table = getTableName(t)), c);
    c.innerJoin = (t: any) => ((c.joined = getTableName(t)), c);
    c.where = () => c;
    c.limit = () => c;
    c.onConflictDoNothing = () => c;
    c.values = (v: any) => ((c.payload = v), c);
    c.set = (v: any) => ((c.payload = v), c);
    c.returning = () => c;
    c.then = (resolve: any, reject: any) => {
      try {
        return Promise.resolve(run(c)).then(resolve, reject);
      } catch (error) {
        return Promise.reject(error).then(resolve, reject);
      }
    };
    return c;
  };
  const write = (kind: string) => (c: any) => {
    if (state.failWrites > 0) {
      state.failWrites--;
      throw new Error("connection reset");
    }
    if (state.conflicts > 0) {
      state.conflicts--;
      state.row = { ...(state.row ?? {}), updated_at: nextUpdatedAt() };
      return [];
    }
    if (kind === "insert" && state.row) return [];
    state.writes.push({ kind, values: c.payload });
    state.row = {
      ...(state.row ?? { created_at: "2026-09-25 00:00:00+00" }),
      ...c.payload,
      updated_at: nextUpdatedAt(),
    };
    return [{ id: state.row!.data_source_id }];
  };
  return {
    db: {
      select: () => chain(c => selectResult(c.table, c.joined)),
      insert: (t: any) => chain(write("insert")),
      update: (t: any) => chain(write("update")),
    },
  };
});

import { mirrorLedgerAcceptance, planAccessRecord } from "./access-record";
import { backfillProviderAccess } from "./access-backfill";

const DIGEST = "b".repeat(64);
const terms = { key: "benzinga", version: "C-1.0.0", digest: DIGEST };
const acceptance = {
  provider: "benzinga",
  version: "C-1.0.0",
  digest: DIGEST,
  acceptedAt: "2026-09-25T12:00:00.000Z",
  eventId: "event-1",
  apiKeyId: "42",
  actorType: "agent",
  surface: "api",
};
const admin = {
  userId: "owner",
  actorType: "human" as const,
  basis: "admin" as const,
};
const row = (patch: Record<string, unknown> = {}) => ({
  org_id: "org",
  data_source_id: "benzinga",
  status: "enabled",
  terms_key: "benzinga",
  terms_version: "C-0.9.0",
  terms_accepted_at: "2026-09-20 12:00:00.123456+00",
  terms_accepted_by: "someone",
  terms_acceptance_history: [],
  enabled_at: "2026-09-20 12:00:00.123456+00",
  enabled_by: "someone",
  disabled_at: null,
  disabled_by: null,
  disabled_reason: null,
  settings: { terms_digest: "a".repeat(64) },
  created_at: "2026-09-20 12:00:00+00",
  updated_at: "2026-09-20 12:00:00.654321+00",
  ...patch,
});

let elected = false;
const exchange = (overrides: Record<string, unknown> = {}) =>
  mocks.request.mockImplementation(async ({ path }: { path: string }) => {
    if (path.includes("requirements"))
      return (
        overrides.requirements ?? {
          status: 200,
          body: {
            providers: [{ provider: "benzinga", required: true, terms }],
          },
        }
      );
    if (path.includes("status"))
      return {
        status: 200,
        body: { providers: [], agentAcceptance: { enabled: elected } },
      };
    if (path.includes("events"))
      return overrides.events ?? { status: 200, body: { events: [] } };
    return { status: 404, body: {} };
  });

const mirror = () =>
  mirrorLedgerAcceptance({ teamId: "team-a", orgId: "org", acceptance });

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.state, {
    row: null,
    key: { owner: "owner", team: "team-a", org: "org" },
    roles: new Map([["key-team", "admin"]]),
    teams: [{ id: "team-a" }, { id: "team-b" }],
    failWrites: 0,
    conflicts: 0,
    writes: [],
  });
  elected = false;
  mocks.clear.mockResolvedValue(undefined);
  exchange();
});

describe("mirrorLedgerAcceptance", () => {
  it("writes the record the dashboard writes on accept and clears every team's auth cache", async () => {
    expect(await mirror()).toEqual({ outcome: "written", action: "insert" });
    expect(mocks.state.writes).toHaveLength(1);
    const values = mocks.state.writes[0].values;
    expect(values).toMatchObject({
      org_id: "org",
      data_source_id: "benzinga",
      status: "enabled",
      terms_key: "benzinga",
      terms_version: "C-1.0.0",
      terms_accepted_at: acceptance.acceptedAt,
      terms_accepted_by: "owner",
      enabled_at: acceptance.acceptedAt,
      enabled_by: "owner",
      disabled_at: null,
      disabled_by: null,
      disabled_reason: null,
      settings: {
        terms_digest: DIGEST,
        terms_receipt: expect.objectContaining({
          eventId: "event-1",
          source: "exchange_ledger",
          apiKeyId: "42",
          actorType: "human",
          acceptedAt: acceptance.acceptedAt,
        }),
      },
    });
    expect(values.terms_acceptance_history).toHaveLength(1);
    expect(mocks.clear.mock.calls.map(([team]) => team)).toEqual([
      "team-a",
      "team-b",
    ]);
  });

  it("is idempotent: repeating the same accept writes nothing and leaves the cache", async () => {
    await mirror();
    mocks.clear.mockClear();
    expect(await mirror()).toEqual({
      outcome: "noop",
      reason: "already_recorded",
    });
    expect(mocks.state.writes).toHaveLength(1);
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it("moves an enabled record to a newer terms version and keeps its history", async () => {
    mocks.state.row = row();
    expect(await mirror()).toEqual({ outcome: "written", action: "update" });
    const values = mocks.state.writes[0].values;
    expect(values).toMatchObject({
      terms_version: "C-1.0.0",
      settings: { terms_digest: DIGEST },
      status: "enabled",
    });
    expect(values.terms_acceptance_history).toEqual([
      expect.objectContaining({
        terms_version: "C-0.9.0",
        accepted_by: "someone",
        digest: "a".repeat(64),
      }),
      expect.objectContaining({ eventId: "event-1" }),
    ]);
  });

  it("does not regress a record accepted after this acceptance", async () => {
    mocks.state.row = row({ terms_accepted_at: "2026-09-25 13:00:00+00" });
    expect(await mirror()).toEqual({
      outcome: "noop",
      reason: "record_is_newer",
    });
    expect(mocks.state.writes).toHaveLength(0);
  });

  it.each([
    [{ status: "suspended" }, "suspended"],
    [
      { status: "disabled", disabled_reason: "revoked_by_staff" },
      "revoked_by_staff",
    ],
    [
      { status: "disabled", disabled_reason: "disabled_by_organization_admin" },
      "disabled_by_organization_admin",
    ],
    [{ status: "disabled", disabled_reason: "fraud_review" }, "fraud_review"],
    [{ status: "disabled", disabled_reason: null }, "status_disabled"],
    [
      {
        status: "suspended",
        disabled_reason: "revoked_by_organization_admin",
        disabled_at: "2026-09-21 00:00:00+00",
      },
      "suspended",
    ],
  ])("never re-enables %j", async (patch, reason) => {
    mocks.state.row = row({ disabled_at: "2026-09-21 00:00:00+00", ...patch });
    expect(await mirror()).toEqual({ outcome: "blocked", reason });
    expect(mocks.state.writes).toHaveLength(0);
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it("lifts an org admin's revocation only with an acceptance made after it", async () => {
    const revoked = {
      status: "disabled",
      disabled_reason: "revoked_by_organization_admin",
      disabled_by: "admin",
      settings: { terms_digest: DIGEST, terms_revocation: { eventId: "r" } },
      terms_version: "C-1.0.0",
    };
    mocks.state.row = row({
      ...revoked,
      disabled_at: "2026-09-25 12:30:00+00",
    });
    expect(await mirror()).toEqual({
      outcome: "blocked",
      reason: "revoked_by_organization_admin",
    });
    mocks.state.row = row({ ...revoked, disabled_at: "invalid" });
    expect((await mirror()).outcome).toBe("blocked");
    mocks.state.row = row({
      ...revoked,
      disabled_at: "2026-09-25 11:00:00+00",
    });
    expect(await mirror()).toEqual({ outcome: "written", action: "update" });
    expect(mocks.state.writes[0].values).toMatchObject({
      status: "enabled",
      disabled_at: null,
      disabled_by: null,
      disabled_reason: null,
    });
  });

  it("refuses an acceptance of terms that are no longer current", async () => {
    exchange({
      requirements: {
        status: 200,
        body: {
          providers: [
            {
              provider: "benzinga",
              required: true,
              terms: { ...terms, version: "C-2.0.0" },
            },
          ],
        },
      },
    });
    expect(await mirror()).toEqual({
      outcome: "blocked",
      reason: "stale_acceptance",
    });
    expect(mocks.state.writes).toHaveLength(0);
  });

  describe("who may accept (the dashboard's API-key rule)", () => {
    it("accepts as the owner when the key belongs to a team admin", async () => {
      await mirror();
      expect(mocks.state.writes[0].values.settings.terms_receipt).toMatchObject(
        { actorType: "human", basis: "admin", acceptedBy: "owner" },
      );
      expect(
        mocks.request.mock.calls.some(([arg]) => arg.path.includes("status")),
      ).toBe(false);
    });

    it("does not write for a member's key unless the organization allows agent acceptance", async () => {
      mocks.state.roles = new Map([["key-team", "member"]]);
      expect(await mirror()).toEqual({
        outcome: "skipped",
        reason: "not_authorized",
      });
      expect(mocks.state.writes).toHaveLength(0);
      elected = true;
      expect(await mirror()).toEqual({ outcome: "written", action: "insert" });
      expect(mocks.state.writes[0].values.settings.terms_receipt).toMatchObject(
        { actorType: "agent", basis: "organization_election" },
      );
    });

    it("refuses a key of another organization, an unknown key and a malformed id", async () => {
      mocks.state.key = { owner: "owner", team: "x", org: "other-org" };
      expect((await mirror()).outcome).toBe("skipped");
      mocks.state.key = null;
      expect((await mirror()).outcome).toBe("skipped");
      mocks.state.key = { owner: "owner", team: "team-a", org: "org" };
      expect(
        (
          await mirrorLedgerAcceptance({
            teamId: "team-a",
            orgId: "org",
            acceptance: { ...acceptance, apiKeyId: "1 OR 1=1" },
          })
        ).outcome,
      ).toBe("skipped");
      expect(mocks.state.writes).toHaveLength(0);
    });
  });

  describe("failures never fail the accept", () => {
    it("retries a failed write, then reports failure without throwing", async () => {
      mocks.state.failWrites = 1;
      expect(await mirror()).toEqual({ outcome: "written", action: "insert" });
      mocks.state.row = null;
      mocks.state.writes = [];
      mocks.state.failWrites = 10;
      expect(await mirror()).toMatchObject({
        outcome: "failed",
        reason: "connection reset",
      });
      expect(mocks.clear).toHaveBeenCalledTimes(2);
    });

    it("re-reads and replans when the record changed underneath it", async () => {
      mocks.state.row = row();
      mocks.state.conflicts = 1;
      expect(await mirror()).toEqual({ outcome: "written", action: "update" });
      mocks.state.row = row();
      mocks.state.conflicts = 50;
      expect((await mirror()).outcome).toBe("failed");
    });

    it("reports failure when the Exchange cannot say which terms are current", async () => {
      exchange({ requirements: { status: 503, body: "down" } });
      expect((await mirror()).outcome).toBe("failed");
      expect(mocks.state.writes).toHaveLength(0);
    });

    it("keeps the written record when the cache clear fails", async () => {
      mocks.clear.mockRejectedValue(new Error("redis down"));
      expect(await mirror()).toEqual({ outcome: "written", action: "insert" });
    });
  });
});

describe("planAccessRecord", () => {
  it("rejects an acceptance without a parseable time", () => {
    expect(
      planAccessRecord({
        orgId: "org",
        row: null,
        terms,
        acceptance: { ...acceptance, acceptedAt: "yesterday" },
        actor: admin,
      }),
    ).toEqual({ action: "blocked", reason: "invalid_acceptance_time" });
  });

  it("updates the digest of a non-material revision under the same version", () => {
    const plan = planAccessRecord({
      orgId: "org",
      row: row({ terms_version: "C-1.0.0" }) as any,
      terms,
      acceptance,
      actor: admin,
    });
    expect(plan).toMatchObject({
      action: "update",
      values: { settings: { terms_digest: DIGEST } },
    });
  });
});

describe("backfillProviderAccess", () => {
  const event = (patch: Record<string, unknown>) => ({
    id: "e",
    dataSourceId: "benzinga",
    eventType: "accepted",
    version: "C-1.0.0",
    textHash: DIGEST,
    actorType: "agent",
    actorUserId: null,
    credentialId: "42",
    surface: "api",
    occurredAt: "2026-09-25T12:00:00.000Z",
    ...patch,
  });
  const ledger = (events: unknown[]) =>
    exchange({ events: { status: 200, body: { events, nextCursor: null } } });
  const run = (dryRun: boolean) =>
    backfillProviderAccess({ orgIds: ["org"], dryRun });

  it("dry run reports what it would write and writes nothing", async () => {
    ledger([event({ id: "e1" })]);
    expect((await run(true)).results).toEqual([
      {
        orgId: "org",
        provider: "benzinga",
        outcome: "would_write",
        action: "insert",
      },
    ]);
    expect(mocks.state.writes).toHaveLength(0);
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it("writes once, then finds the record current on a second run", async () => {
    ledger([event({ id: "e1" })]);
    expect((await run(false)).results[0]).toMatchObject({
      outcome: "written",
    });
    expect(mocks.state.writes[0].values.settings.terms_receipt.eventId).toBe(
      "e1",
    );
    expect(mocks.clear).toHaveBeenCalledTimes(2);
    expect((await run(false)).results[0]).toMatchObject({
      outcome: "noop",
      reason: "already_recorded",
    });
    expect(mocks.state.writes).toHaveLength(1);
  });

  it("skips a provider whose latest ledger event is a revocation, and never re-enables a staff revocation", async () => {
    ledger([
      event({ id: "r", eventType: "staff_revoked" }),
      event({ id: "a", occurredAt: "2026-09-24T00:00:00.000Z" }),
    ]);
    expect((await run(false)).results[0]).toMatchObject({
      outcome: "skipped",
      reason: "ledger_revoked",
    });
    ledger([event({ id: "a" })]);
    mocks.state.row = row({
      status: "disabled",
      disabled_reason: "revoked_by_staff",
      disabled_at: "2026-09-20 00:00:00+00",
    });
    expect((await run(false)).results[0]).toMatchObject({
      outcome: "blocked",
      reason: "revoked_by_staff",
    });
    expect(mocks.state.writes).toHaveLength(0);
  });

  it("reads the agent-acceptance election as it stood when a member's key accepted", async () => {
    mocks.state.roles = new Map([["key-team", "member"]]);
    elected = true; // current status must not matter
    ledger([
      event({
        id: "on",
        eventType: "election_enabled",
        dataSourceId: null,
        occurredAt: "2026-09-26T00:00:00.000Z",
      }),
      event({ id: "a" }),
      event({
        id: "off",
        eventType: "election_disabled",
        dataSourceId: null,
        occurredAt: "2026-09-24T00:00:00.000Z",
      }),
    ]);
    expect((await run(false)).results[0]).toMatchObject({
      outcome: "skipped",
      reason: "not_authorized",
    });
    ledger([
      event({ id: "a" }),
      event({
        id: "on",
        eventType: "election_enabled",
        dataSourceId: null,
        occurredAt: "2026-09-24T00:00:00.000Z",
      }),
    ]);
    expect((await run(false)).results[0]).toMatchObject({
      outcome: "written",
    });
  });

  it("accepts a keyless dashboard acceptance only from an admin of the organization", async () => {
    ledger([
      event({ credentialId: null, actorType: "human", actorUserId: "u" }),
    ]);
    expect((await run(true)).results[0]).toMatchObject({
      outcome: "skipped",
      reason: "not_authorized",
    });
    mocks.state.roles = new Map([["any-team", "admin"]]);
    expect((await run(true)).results[0]).toMatchObject({
      outcome: "would_write",
    });
  });

  it("reports an organization whose ledger cannot be read without stopping the run", async () => {
    exchange({ events: { status: 503, body: "down" } });
    expect(
      (await backfillProviderAccess({ orgIds: ["org", "org"], dryRun: false }))
        .results,
    ).toEqual([
      expect.objectContaining({ outcome: "error" }),
      expect.objectContaining({ outcome: "error" }),
    ]);
  });
});
