import { UnrecoverableError } from "bullmq";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  authorize: vi.fn(),
  lock: vi.fn(),
  finalize: vi.fn(),
  bill: vi.fn(),
}));
vi.mock("../../config", () => ({
  config: {
    USE_DB_AUTHENTICATION: true,
    FIRE_EXCHANGE_URL: "https://exchange.test",
    EXCHANGE_INTERNAL_SECRET: "test",
  },
}));
vi.mock("./client", () => ({ exchangeRequest: mocks.request }));
vi.mock("./access", () => ({ authorizeProviders: mocks.authorize }));
vi.mock("../../db/rpc", () => ({ billTeam7: mocks.bill }));
vi.mock("../autumn/autumn.service", () => ({
  autumnService: {
    lockCredits: mocks.lock,
    finalizeCreditsLock: mocks.finalize,
  },
  featureIdForBillingEndpoint: () => "credits",
}));
vi.mock("../autumn/firebill", () => ({
  firebillConfigured: () => true,
  firebillFinalize: vi.fn(),
}));
vi.mock("../queue-service", () => ({ getRedisConnection: vi.fn() }));
vi.mock("../../lib/concurrency-limit", () => ({
  getEffectiveConcurrencyLimit: async () => 2,
}));
vi.mock("../worker/team-semaphore", () => ({
  teamConcurrencySemaphore: {
    withSemaphore: async (
      _team: unknown,
      _id: unknown,
      _limit: unknown,
      _signal: unknown,
      _timeout: unknown,
      fn: () => Promise<unknown>,
    ) => fn(),
  },
}));
import { runProviderJob } from "./retrieve";

const call = {
  provider: "fred",
  capability: "series/observations",
  options: { series_id: "GDP" },
};
const answer = {
  success: true,
  creditsCost: 3,
  results: [
    {
      provider: call.provider,
      capability: call.capability,
      creditsCost: 3,
      data: { observations: [] },
    },
  ],
};
function job() {
  let persisted = {
    teamId: "team",
    orgId: "org",
    apiKeyId: 12,
    calls: [call],
    fingerprint: "hash",
    deadline: Date.now() + 50000,
    billable: true,
    phase: "new",
  };
  const create = () =>
    ({
      id: "request",
      token: "token",
      extendLock: vi.fn(async () => 1),
      data: structuredClone(persisted),
      updateData: vi.fn(async next => {
        persisted = structuredClone(next);
      }),
    }) as unknown as Parameters<typeof runProviderJob>[0];
  return { create, state: () => persisted };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(undefined);
  mocks.lock.mockResolvedValue({ status: "locked", lockId: "held" });
  mocks.finalize.mockResolvedValue(true);
  mocks.bill.mockResolvedValue([]);
  mocks.request.mockImplementation(async input => ({
    status: 200,
    body: input.path.endsWith("/quote")
      ? { maximumCredits: 5 }
      : input.path.endsWith("/billing")
        ? { success: true }
        : answer,
  }));
});
const executions = () =>
  mocks.request.mock.calls.filter(([input]) => input.path === "/v1/retrieve");

it("quotes, reserves, executes within budget, settles actual usage, and records once", async () => {
  const record = job();
  expect(await runProviderJob(record.create())).toEqual({
    status: 200,
    body: answer,
  });
  expect(mocks.lock).toHaveBeenCalledWith(
    expect.objectContaining({
      value: 5,
      lockId: "alexandria_request",
      featureId: "credits",
    }),
  );
  expect(executions()[0][0]).toEqual(
    expect.objectContaining({ maximumCredits: 5, requestId: "request" }),
  );
  expect(mocks.finalize).toHaveBeenCalledWith(
    expect.objectContaining({
      lockId: "held",
      action: "confirm",
      overrideValue: 3,
      heldValue: 5,
    }),
  );
  expect(mocks.bill).toHaveBeenCalledWith(
    expect.objectContaining({ credits: 3, api_key_id: 12, team_id: "team" }),
  );
  expect(mocks.request).toHaveBeenLastCalledWith(
    expect.objectContaining({
      internal: true,
      body: [
        {
          requestId: "request",
          status: "confirmed",
          billingReference: "alexandria:request",
        },
      ],
    }),
  );
  await runProviderJob(record.create());
  expect(executions()).toHaveLength(1);
  expect(mocks.lock).toHaveBeenCalledTimes(1);
  expect(mocks.finalize).toHaveBeenCalledTimes(1);
  expect(mocks.bill).toHaveBeenCalledTimes(1);
});

it.each(["denied", "skipped"])(
  "does not execute after a %s credit hold",
  async status => {
    mocks.lock.mockResolvedValue({ status });
    const response = await runProviderJob(job().create());
    expect(response.status).toBe(status === "denied" ? 402 : 503);
    expect(executions()).toHaveLength(0);
    expect(mocks.bill).not.toHaveBeenCalled();
  },
);

it("retries settlement without executing or tracking a second charge", async () => {
  mocks.finalize.mockResolvedValueOnce(false);
  const record = job();
  await expect(runProviderJob(record.create())).rejects.toThrow("settlement");
  expect(record.state().phase).toBe("settling");
  expect((await runProviderJob(record.create())).status).toBe(200);
  expect(executions()).toHaveLength(1);
  expect(mocks.bill).toHaveBeenCalledTimes(1);
});

it("retains ambiguous ledger writes instead of debiting twice or refunding settled work", async () => {
  mocks.bill.mockRejectedValueOnce(new Error("commit acknowledgement lost"));
  const record = job();
  await expect(runProviderJob(record.create())).rejects.toThrow(
    "acknowledgement",
  );
  expect(record.state().phase).toBe("recording");
  await expect(runProviderJob(record.create())).rejects.toBeInstanceOf(
    UnrecoverableError,
  );
  expect(mocks.bill).toHaveBeenCalledTimes(1);
  expect(mocks.finalize).toHaveBeenCalledTimes(1);
});

it("does not settle over-budget usage or repeat the provider execution", async () => {
  const invalid = {
    ...answer,
    creditsCost: 6,
    results: [{ ...answer.results[0], creditsCost: 6 }],
  };
  mocks.request.mockImplementation(async input => ({
    status: 200,
    body: input.path.endsWith("/quote") ? { maximumCredits: 5 } : invalid,
  }));
  const record = job();
  await expect(runProviderJob(record.create())).rejects.toThrow(
    "Invalid provider billing receipt",
  );
  await expect(runProviderJob(record.create())).rejects.toBeInstanceOf(
    UnrecoverableError,
  );
  expect(executions()).toHaveLength(1);
  expect(mocks.finalize).not.toHaveBeenCalled();
  expect(mocks.bill).not.toHaveBeenCalled();
});
