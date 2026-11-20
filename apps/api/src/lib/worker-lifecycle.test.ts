import { getEventListeners } from "node:events";
import {
  DEPENDENCY_BACKOFF_MS,
  guardDependencyCall,
  installWorkerLifecycle,
  retryDependency,
} from "./worker-lifecycle";

const FAST_BACKOFF = [1, 1] as const;

test("retries a rejected dependency call and returns its value", async () => {
  let calls = 0;
  const result = await retryDependency(async () => {
    calls++;
    if (calls < 3) {
      throw new Error("connect ECONNREFUSED 10.0.0.1:5432");
    }
    return "job";
  }, FAST_BACKOFF);

  expect(calls).toBe(3);
  expect(result).toEqual({ value: "job" });
});

test("gives up after the backoff budget instead of throwing", async () => {
  let calls = 0;
  const result = await retryDependency(async () => {
    calls++;
    throw new Error("getaddrinfo ENOTFOUND firecrawl-db-rw");
  }, FAST_BACKOFF);

  expect(calls).toBe(FAST_BACKOFF.length + 1);
  expect(result).toBeNull();
});

test("treats a null result as an answer, not a failure", async () => {
  let calls = 0;
  const result = await retryDependency(async () => {
    calls++;
    return null;
  }, FAST_BACKOFF);

  expect(calls).toBe(1);
  expect(result).toEqual({ value: null });
});

test("a shutdown cuts the backoff short", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = retryDependency(
    async () => {
      throw new Error("connect ETIMEDOUT");
    },
    DEPENDENCY_BACKOFF_MS,
    controller.signal,
  );

  controller.abort();

  expect(await pending).toBeNull();
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("repeated backoffs do not pile up abort listeners", async () => {
  const controller = new AbortController();

  for (let attempt = 0; attempt < 20; attempt++) {
    await retryDependency(
      async () => {
        throw new Error("connect ECONNREFUSED");
      },
      [1],
      controller.signal,
    );
  }

  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

test("waits out a dependency outage for at least five minutes", () => {
  const totalMs = DEPENDENCY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0);

  expect(totalMs).toBeGreaterThanOrEqual(5 * 60_000);
});

test("a failing jobFinish is logged, and the loop survives", async () => {
  const logged: string[] = [];
  const log = {
    error: (message: string) => {
      logged.push(message);
    },
  };
  const queue = {
    jobFinish: async () => {
      throw new Error("Connection terminated unexpectedly");
    },
  };

  const succeeded = await guardDependencyCall(
    () => queue.jobFinish(),
    log,
    "Could not record job outcome; continuing",
  );

  expect(succeeded).toBe(false);
  expect(logged).toEqual(["Could not record job outcome; continuing"]);
});

test("a successful dependency call reports success and logs nothing", async () => {
  const log = { error: vi.fn() };

  const succeeded = await guardDependencyCall(async () => "ok", log, "unused");

  expect(succeeded).toBe(true);
  expect(log.error).not.toHaveBeenCalled();
});

test("an unhandled rejection is logged, not fatal", () => {
  const before = process.listenerCount("unhandledRejection");
  installWorkerLifecycle("test-worker");

  expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
  expect(() =>
    process.emit("unhandledRejection", new Error("boom"), Promise.resolve()),
  ).not.toThrow();
});
