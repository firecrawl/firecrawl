const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
}));
vi.mock("./redis", () => ({
  nuqRedis: {
    scripts: {
      semaphore: {
        acquire: "acquire",
        heartbeat: "heartbeat",
        release: "release",
      },
    },
    runScript: mocks.run,
    ensure: async () => {},
  },
  semaphoreKeys: () => ({ leases: "test" }),
}));
vi.mock("../../lib/concurrency-limit", () => ({
  pushConcurrencyLimitActiveJob: mocks.acquire,
  removeConcurrencyLimitActiveJob: mocks.release,
}));
vi.mock("./nuq-router", () => ({ isFdbTeam: async () => false }));
vi.mock("./nuq-fdb", () => ({
  externalSlotsFdb: {},
  nuqFdbHealthCheck: vi.fn(),
  withFdbTimeout: vi.fn(),
}));
vi.mock("../../lib/deployment", () => ({ isSelfHosted: () => false }));
import { teamConcurrencySemaphore } from "./team-semaphore";

beforeEach(() => {
  mocks.acquire.mockReset().mockResolvedValue(undefined);
  mocks.release.mockReset().mockResolvedValue(undefined);
  mocks.run
    .mockReset()
    .mockImplementation(async script => (script === "acquire" ? [1, 1, 0] : 1));
});
const run = (work: () => Promise<string>) =>
  teamConcurrencySemaphore.withSemaphore(
    "team",
    "holder",
    1,
    new AbortController().signal,
    1000,
    work,
  );
it("returns the work result and releases both Redis records", async () => {
  await expect(run(async () => "done")).resolves.toBe("done");
  expect(mocks.release).toHaveBeenCalled();
  expect(mocks.run).toHaveBeenCalledWith(
    "release",
    expect.anything(),
    expect.anything(),
  );
});
it("propagates the original heartbeat error and still releases both records", async () => {
  const error = new Error("original heartbeat error");
  mocks.acquire.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
  await expect(run(() => new Promise(() => {}))).rejects.toBe(error);
  expect(mocks.release).toHaveBeenCalled();
  expect(mocks.run).toHaveBeenCalledWith(
    "release",
    expect.anything(),
    expect.anything(),
  );
});
it("propagates mirror release failure while still releasing the semaphore", async () => {
  const error = new Error("original release error");
  mocks.release.mockRejectedValueOnce(error);
  await expect(run(async () => "done")).rejects.toBe(error);
  expect(mocks.run).toHaveBeenCalledWith(
    "release",
    expect.anything(),
    expect.anything(),
  );
});
it("retains work and cleanup failures together", async () => {
  const workError = new Error("work failed");
  const cleanupError = new Error("cleanup failed");
  mocks.release.mockRejectedValueOnce(cleanupError);
  await expect(
    run(async () => {
      throw workError;
    }),
  ).rejects.toMatchObject({ errors: [workError, cleanupError] });
});
