const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  fdbTeam: vi.fn(),
  fdbAcquire: vi.fn(),
  fdbRelease: vi.fn(),
  fdbTimeout: vi.fn(),
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
vi.mock("./nuq-router", () => ({ isFdbTeam: mocks.fdbTeam }));
vi.mock("./nuq-fdb", () => ({
  externalSlotsFdb: { acquire: mocks.fdbAcquire, release: mocks.fdbRelease },
  nuqFdbHealthCheck: async () => true,
  withFdbTimeout: mocks.fdbTimeout,
}));
vi.mock("../../lib/deployment", () => ({ isSelfHosted: () => false }));
import { teamConcurrencySemaphore } from "./team-semaphore";

vi.mock("../../config", () => ({ config: { NUQ_BACKEND: "pg" } }));
beforeEach(() => {
  mocks.fdbTeam.mockReset().mockResolvedValue(false);
  mocks.fdbAcquire.mockReset().mockResolvedValue(undefined);
  mocks.fdbRelease.mockReset().mockResolvedValue(undefined);
  mocks.fdbTimeout.mockReset().mockImplementation(promise => promise);
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

it("joins a timed-out FDB acquire before releasing its slot", async () => {
  const timeout = new Error("FDB timeout");
  let finish!: () => void;
  let timedOut!: () => void;
  const timeoutObserved = new Promise<void>(resolve => {
    timedOut = resolve;
  });
  const order: string[] = [];
  mocks.fdbTeam.mockResolvedValue(true);
  mocks.fdbAcquire.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        finish = () => {
          order.push("commit");
          resolve();
        };
      }),
  );
  mocks.fdbTimeout.mockImplementationOnce(async () => {
    timedOut();
    throw timeout;
  });
  mocks.fdbRelease.mockImplementation(async () => {
    order.push("release");
  });
  const result = run(async () => "unused");
  const rejected = expect(result).rejects.toBe(timeout);
  await timeoutObserved;
  await Promise.resolve();
  expect(mocks.fdbRelease).not.toHaveBeenCalled();
  finish();
  await rejected;
  expect(order).toEqual(["commit", "release"]);
});
it("retains a timeout and late FDB rejection", async () => {
  const timeout = new Error("FDB timeout"),
    original = new Error("FDB operation failed");
  let reject!: (error: Error) => void;
  let timedOut!: () => void;
  const timeoutObserved = new Promise<void>(resolve => {
    timedOut = resolve;
  });
  mocks.fdbTeam.mockResolvedValue(true);
  mocks.fdbAcquire.mockImplementation(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  mocks.fdbTimeout.mockImplementationOnce(async () => {
    timedOut();
    throw timeout;
  });
  const result = run(async () => "unused");
  const rejected = expect(result).rejects.toMatchObject({
    errors: [timeout, original],
  });
  await timeoutObserved;
  reject(original);
  await rejected;
  expect(mocks.fdbRelease).toHaveBeenCalledTimes(1);
});
