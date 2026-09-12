import { Job, UnrecoverableError } from "bullmq";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  authorize: vi.fn(),
  lock: vi.fn(),
  finalize: vi.fn(),
  bill: vi.fn(),
  partnerFinalize: vi.fn(),
  config: {
    USE_DB_AUTHENTICATION: true,
    FIRE_EXCHANGE_URL: "https://exchange.test",
    EXCHANGE_INTERNAL_SECRET: "test",
  },
}));
vi.mock("../../config", () => ({ config: mocks.config }));
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
  firebillFinalize: mocks.partnerFinalize,
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
function job(overrides: Record<string, unknown> = {}) {
  let persisted = {
    teamId: "team",
    orgId: "org",
    apiKeyId: 12,
    calls: [call],
    fingerprint: "hash",
    deadline: Date.now() + 50000,
    billable: true,
    phase: "new",
    ...overrides,
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
  mocks.config.USE_DB_AUTHENTICATION = true;
  mocks.config.EXCHANGE_INTERNAL_SECRET = "test";
  mocks.authorize.mockResolvedValue(undefined);
  mocks.lock.mockResolvedValue({ status: "locked", lockId: "held" });
  mocks.finalize.mockResolvedValue(true);
  mocks.partnerFinalize.mockResolvedValue(true);
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

it("keeps free discovery free", async () => {
  mocks.request.mockImplementation(async input => ({
    status: 200,
    body: input.path.endsWith("/quote")
      ? { maximumCredits: 0 }
      : input.path.endsWith("/billing")
        ? {}
        : {
            ...answer,
            creditsCost: 0,
            results: [{ ...answer.results[0], creditsCost: 0 }],
          },
  }));
  expect((await runProviderJob(job().create())).status).toBe(200);
  expect(mocks.lock).not.toHaveBeenCalled();
  expect(mocks.finalize).not.toHaveBeenCalled();
  expect(mocks.bill).not.toHaveBeenCalled();
});

it("fails closed when paid billing is not configured", async () => {
  mocks.config.EXCHANGE_INTERNAL_SECRET = "";
  expect((await runProviderJob(job().create())).status).toBe(503);
  expect(mocks.lock).not.toHaveBeenCalled();
  expect(executions()).toHaveLength(0);
});

it.each(["reserving", "executing", "recording"])(
  "never repeats an uncertain %s operation",
  async phase => {
    await expect(
      runProviderJob(job({ phase }).create()),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.bill).not.toHaveBeenCalled();
    expect(executions()).toHaveLength(0);
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

it("retries an idempotent billing report without re-debiting", async () => {
  let reports = 0;
  mocks.request.mockImplementation(async input => ({
    status: input.path.endsWith("/billing") && reports++ === 0 ? 503 : 200,
    body: input.path.endsWith("/quote")
      ? { maximumCredits: 5 }
      : input.path.endsWith("/billing")
        ? {}
        : answer,
  }));
  const record = job();
  await expect(runProviderJob(record.create())).rejects.toThrow("report");
  expect(record.state().phase).toBe("reporting");
  await runProviderJob(record.create());
  expect(mocks.finalize).toHaveBeenCalledTimes(1);
  expect(mocks.bill).toHaveBeenCalledTimes(1);
});

it.each([
  {
    ...answer,
    creditsCost: 6,
    results: [{ ...answer.results[0], creditsCost: 6 }],
  },
  { ...answer, creditsCost: 4 },
  { ...answer, results: [] },
  { ...answer, results: [{ ...answer.results[0], provider: "other" }] },
])("retains malformed or over-budget receipts for review", async invalid => {
  mocks.request.mockImplementation(async input => ({
    status: 200,
    body: input.path.endsWith("/quote") ? { maximumCredits: 5 } : invalid,
  }));
  const record = job();
  await expect(runProviderJob(record.create())).rejects.toThrow();
  await expect(runProviderJob(record.create())).rejects.toBeInstanceOf(
    UnrecoverableError,
  );
  expect(executions()).toHaveLength(1);
  expect(mocks.finalize).not.toHaveBeenCalled();
});

it("preserves partial-batch costs and releases unused credits", async () => {
  const partial = {
    ...answer,
    results: [
      ...answer.results,
      {
        provider: "other",
        capability: "lookup",
        error: { code: "unavailable", message: "Unavailable" },
        creditsCost: 0,
      },
    ],
  };
  mocks.request.mockImplementation(async input => ({
    status: 200,
    body: input.path.endsWith("/quote")
      ? { maximumCredits: 10 }
      : input.path.endsWith("/billing")
        ? {}
        : partial,
  }));
  await runProviderJob(
    job({
      calls: [call, { provider: "other", capability: "lookup", options: {} }],
    }).create(),
  );
  expect(mocks.finalize).toHaveBeenCalledWith(
    expect.objectContaining({ overrideValue: 3, heldValue: 10 }),
  );
});

it("releases an expired hold before any provider execution", async () => {
  const record = job({
    phase: "held",
    deadline: Date.now() - 1,
    lockId: "held",
    maximumCredits: 5,
  });
  expect((await runProviderJob(record.create())).status).toBe(504);
  expect(mocks.finalize).toHaveBeenCalledWith(
    expect.objectContaining({ action: "release" }),
  );
  expect(executions()).toHaveLength(0);
});

it("rechecks organization access before executing queued work", async () => {
  mocks.authorize.mockResolvedValue({
    status: 403,
    body: { error: "disabled" },
  });
  expect((await runProviderJob(job().create())).status).toBe(403);
  expect(mocks.lock).not.toHaveBeenCalled();
  expect(executions()).toHaveLength(0);
});

it("keeps partner attribution on the original hold", async () => {
  mocks.lock.mockResolvedValue({
    status: "locked",
    lockId: "partner-hold",
    operationToken: "partner-token",
  });
  await runProviderJob(job().create());
  expect(mocks.finalize).not.toHaveBeenCalled();
  expect(mocks.partnerFinalize).toHaveBeenCalledWith(
    expect.objectContaining({
      customerId: "org",
      lockId: "partner-hold",
      externalRequestId: "partner-token",
      heldValue: 5,
      overrideValue: 3,
    }),
  );
});

it("does not execute after a reservation checkpoint failure", async () => {
  const record = job();
  const current = record.create();
  const update = current.updateData;
  current.updateData = vi.fn(async next => {
    if (next.phase === "held") throw new Error("storage lost");
    return update(next);
  });
  await expect(runProviderJob(current)).rejects.toThrow("storage lost");
  await expect(runProviderJob(record.create())).rejects.toBeInstanceOf(
    UnrecoverableError,
  );
  expect(executions()).toHaveLength(0);
});

it.each(["new", "held", "settling", "recording"])(
  "does not overlap a stalled owner in phase %s",
  async phase => {
    const current = job({
      phase,
      answer,
      lockId: "held",
      maximumCredits: 5,
    }).create();
    current.stalledCounter = 1;
    await expect(runProviderJob(current)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(executions()).toHaveLength(0);
    expect(mocks.bill).not.toHaveBeenCalled();
  },
);

it("cannot reserve or execute after losing the BullMQ lease", async () => {
  const current = job().create();
  current.extendLock = vi.fn(async () => 0);
  await expect(runProviderJob(current)).rejects.toThrow("lease lost");
  expect(mocks.lock).not.toHaveBeenCalled();
  expect(executions()).toHaveLength(0);
});
