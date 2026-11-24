import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loggerError: vi.fn(),
  initializeEngineForcing: vi.fn(),
}));

vi.mock("../../config", () => ({
  config: {
    NUQ_WORKER_PORT: 0,
    NUQ_RABBITMQ_URL: undefined,
  },
}));

vi.mock("../../otel", () => ({
  shutdownTracing: vi.fn(async () => {}),
}));

vi.mock("../../lib/otel-tracer", () => ({
  withZeroDataRetention: (_zdr: boolean, fn: () => unknown) => fn(),
}));

vi.mock("../../lib/logger", () => ({
  logger: {
    error: mocks.loggerError,
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../../lib/job-metrics", () => ({
  jobDurationSeconds: { observe: vi.fn() },
}));

vi.mock("../../lib/node-runtime-metrics", () => ({
  startNodeRuntimeMetrics: vi.fn(),
}));

vi.mock("./scrape-worker", () => ({
  processJobInternal: vi.fn(),
}));

vi.mock("../../scraper/WebScraper/utils/engine-forcing", () => ({
  initializeEngineForcing: mocks.initializeEngineForcing,
}));

vi.mock("../logging/log_job", () => ({
  shutdownPubSubLogging: vi.fn(async () => {}),
}));

import { defaultModules, noBlocklist } from "../../service/defaults";
import { replaceService, type CoreParts } from "../../service/service";
import { testService, withService } from "../../service/testing";
import { runNuqWorker, type WorkerQueue } from "./nuq-worker-runner";

const parts: CoreParts = {
  core: { name: "core" },
  logger: { error: vi.fn() },
};

const stubQueue: WorkerQueue = {
  getJobToProcess: vi.fn(async () => null),
  renewLock: vi.fn(async () => true),
  jobFinish: vi.fn(async () => true),
  jobFail: vi.fn(async () => true),
};

afterEach(() => {
  replaceService(undefined);
  vi.restoreAllMocks();
  mocks.loggerError.mockReset();
  mocks.initializeEngineForcing.mockReset();
});

describe("runNuqWorker blocklist startup init", () => {
  it("awaits service.modules.blocklist.init() before running beforeStart()", async () => {
    const events: string[] = [];
    mocks.initializeEngineForcing.mockImplementation(() => {
      events.push("engine-forcing");
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    const svc = testService(defaultModules(), parts, {
      blocklist: {
        ...noBlocklist(),
        async init() {
          events.push("blocklist.init:start");
          await Promise.resolve();
          events.push("blocklist.init:end");
        },
      },
    });

    await withService(svc, async () => {
      await expect(
        runNuqWorker({
          serviceName: "nuq-test",
          queue: stubQueue,
          healthCheck: async () => true,
          beforeStart() {
            events.push("beforeStart");
            throw new Error("stop-before-listen");
          },
        }),
      ).rejects.toThrow("process.exit:1");
    });

    expect(events).toEqual([
      "blocklist.init:start",
      "blocklist.init:end",
      "engine-forcing",
      "beforeStart",
    ]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("logs and exits with code 1 when service.modules.blocklist.init() rejects", async () => {
    const failure = new Error("blocklist load failed");
    const beforeStart = vi.fn();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    const svc = testService(defaultModules(), parts, {
      blocklist: {
        ...noBlocklist(),
        async init() {
          throw failure;
        },
      },
    });

    await withService(svc, async () => {
      await expect(
        runNuqWorker({
          serviceName: "nuq-test",
          queue: stubQueue,
          healthCheck: async () => true,
          beforeStart,
        }),
      ).rejects.toThrow("process.exit:1");
    });

    expect(mocks.initializeEngineForcing).not.toHaveBeenCalled();
    expect(beforeStart).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Failed to initialize NuQ worker",
      {
        module: "nuq-test",
        error: failure,
      },
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
