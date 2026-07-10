import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { describe, expect, test, vi } from "vitest";
import {
  createNuqFdbWorkerOptions,
  type NuqFdbWorkerComponent,
  type NuqFdbWorkerMode,
} from "./nuq-fdb-worker-service";
import { runNuqWorker, type WorkerQueue } from "./nuq-worker-runner";

vi.mock("./scrape-worker", () => ({ processJobInternal: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const MAINTENANCE_METRICS = `nuq_fdb_queue_scrape_job_count{status="queued"} 1
nuq_fdb_queue_crawl_finished_job_count{status="queued"} 2
firecrawl_nuq_fdb_sweeper_oldest_overdue_seconds{queue="scrape",index="delay",partition="0"} 3
`;

function controlledComponent(name: string) {
  const completion = deferred<void>();
  let healthy = true;
  const component: NuqFdbWorkerComponent = {
    name,
    stop: vi.fn(() => {
      healthy = false;
    }),
    forceStop: vi.fn(),
    done: completion.promise,
    isHealthy: () => healthy,
    metrics: () =>
      name === "maintenance" ? MAINTENANCE_METRICS : `${name}_metric 1\n`,
  };
  return { component, completion };
}

function makeScrapeQueue(dequeue: Promise<null>): WorkerQueue {
  return {
    getJobToProcess: vi.fn(() => dequeue),
    renewLock: vi.fn().mockResolvedValue(true),
    jobFinish: vi.fn().mockResolvedValue(true),
    jobFail: vi.fn().mockResolvedValue(true),
  };
}

type RunningWorker = {
  server: Server;
  signals: EventEmitter;
  exitCode: Promise<number>;
  running: Promise<void>;
};

async function startWorker(
  mode: NuqFdbWorkerMode,
  options: {
    dependencyReady: () => boolean;
    scrapeDequeue: Promise<null>;
    maintenance: ReturnType<typeof controlledComponent>;
    crawlFinished: ReturnType<typeof controlledComponent>;
    shutdownGraceMs?: number;
  },
): Promise<RunningWorker> {
  const workerOptions = createNuqFdbWorkerOptions(mode, {
    scrapeQueue: makeScrapeQueue(options.scrapeDequeue),
    healthCheck: async () => options.dependencyReady(),
    startMaintenance: () => options.maintenance.component,
    startCrawlFinished: () => options.crawlFinished.component,
  });
  workerOptions.shutdownGraceMs = options.shutdownGraceMs ?? 1_000;

  const signals = new EventEmitter();
  const listening = deferred<Server>();
  const exited = deferred<number>();
  const running = runNuqWorker(workerOptions, {
    initialize: async () => undefined,
    signalSource: signals,
    port: 0,
    onServerStarted: server => listening.resolve(server),
    exit: code => exited.resolve(code),
  });

  return {
    server: await listening.promise,
    signals,
    exitCode: exited.promise,
    running,
  };
}

describe.each<NuqFdbWorkerMode>([
  "all",
  "scrape",
  "maintenance",
  "crawl-finished",
])("NuQ FDB %s process lifecycle", mode => {
  test("keeps live backend-independent and flips ready through SIGTERM drain", async () => {
    let dependencyReady = true;
    const scrapeDequeue = deferred<null>();
    const maintenance = controlledComponent("maintenance");
    const crawlFinished = controlledComponent("crawl-finished");
    const worker = await startWorker(mode, {
      dependencyReady: () => dependencyReady,
      scrapeDequeue: scrapeDequeue.promise,
      maintenance,
      crawlFinished,
    });

    await request(worker.server).get("/ready").expect(200, "OK");
    await request(worker.server).get("/health").expect(200, "OK");
    const metrics = await request(worker.server).get("/metrics").expect(200);
    const runsMaintenance = mode === "all" || mode === "maintenance";
    const runsCrawlFinished = mode === "all" || mode === "crawl-finished";
    expect(metrics.text.includes("nuq_fdb_queue_scrape_job_count")).toBe(
      runsMaintenance,
    );
    expect(
      metrics.text.includes("nuq_fdb_queue_crawl_finished_job_count"),
    ).toBe(runsMaintenance);
    expect(
      metrics.text.includes("firecrawl_nuq_fdb_sweeper_oldest_overdue_seconds"),
    ).toBe(runsMaintenance);
    expect(metrics.text.includes("crawl-finished_metric")).toBe(
      runsCrawlFinished,
    );

    dependencyReady = false;
    await request(worker.server).get("/live").expect(200, "OK");
    await request(worker.server).get("/ready").expect(503, "Not Ready");
    dependencyReady = true;

    worker.signals.emit("SIGTERM");
    await request(worker.server).get("/ready").expect(503, "Not Ready");
    await request(worker.server).get("/live").expect(200, "OK");

    scrapeDequeue.resolve(null);
    maintenance.completion.resolve();
    crawlFinished.completion.resolve();
    await expect(worker.exitCode).resolves.toBe(0);
    await worker.running;
  });
});

describe("NuQ worker fatal and deadline lifecycle", () => {
  test("exits nonzero when a required loop dies", async () => {
    const scrapeDequeue = deferred<null>();
    const maintenance = controlledComponent("maintenance");
    const crawlFinished = controlledComponent("crawl-finished");
    const worker = await startWorker("crawl-finished", {
      dependencyReady: () => true,
      scrapeDequeue: scrapeDequeue.promise,
      maintenance,
      crawlFinished,
    });

    crawlFinished.completion.reject(new Error("required loop died"));
    await expect(worker.exitCode).resolves.toBe(1);
    await worker.running;
  });

  test("forces an over-deadline component and exits after bounded drain", async () => {
    const scrapeDequeue = deferred<null>();
    const maintenance = controlledComponent("maintenance");
    const crawlFinished = controlledComponent("crawl-finished");
    const worker = await startWorker("maintenance", {
      dependencyReady: () => true,
      scrapeDequeue: scrapeDequeue.promise,
      maintenance,
      crawlFinished,
      shutdownGraceMs: 200,
    });

    worker.signals.emit("SIGTERM");
    await request(worker.server).get("/ready").expect(503, "Not Ready");
    await request(worker.server).get("/live").expect(200, "OK");
    await expect(worker.exitCode).resolves.toBe(0);
    expect(maintenance.component.forceStop).toHaveBeenCalledOnce();
    await worker.running;
  });
});
