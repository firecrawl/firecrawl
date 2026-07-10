import request from "supertest";
import { describe, expect, test, vi } from "vitest";
import {
  createNuqFdbWorkerOptions,
  type NuqFdbWorkerComponent,
  type NuqFdbWorkerMode,
} from "./nuq-fdb-worker-service";
import { createNuqWorkerHttpApp } from "./nuq-worker-http";
import type { WorkerQueue } from "./nuq-worker-runner";

const scrapeQueue: WorkerQueue = {
  getJobToProcess: vi.fn().mockResolvedValue(null),
  renewLock: vi.fn().mockResolvedValue(true),
  jobFinish: vi.fn().mockResolvedValue(true),
  jobFail: vi.fn().mockResolvedValue(true),
};

function component(name: string): NuqFdbWorkerComponent {
  return {
    name,
    stop: vi.fn(),
    forceStop: vi.fn(),
    done: new Promise<void>(() => {}),
    isHealthy: vi.fn(() => true),
    metrics: vi.fn(() => `${name}_metric 1\n`),
  };
}

describe.each<{
  mode: NuqFdbWorkerMode;
  scrape: boolean;
  maintenance: boolean;
  crawlFinished: boolean;
}>([
  { mode: "scrape", scrape: true, maintenance: false, crawlFinished: false },
  {
    mode: "maintenance",
    scrape: false,
    maintenance: true,
    crawlFinished: false,
  },
  {
    mode: "crawl-finished",
    scrape: false,
    maintenance: false,
    crawlFinished: true,
  },
  { mode: "all", scrape: true, maintenance: true, crawlFinished: true },
])("NuQ FDB $mode mode", ({ mode, scrape, maintenance, crawlFinished }) => {
  test("exposes deterministic per-mode live, ready, and drain behavior", async () => {
    let dependencyReady = true;
    let draining = false;
    const maintenanceLoop = component("maintenance");
    const crawlFinishedLoop = component("crawl-finished");
    const options = createNuqFdbWorkerOptions(mode, {
      scrapeQueue,
      healthCheck: async () => dependencyReady,
      startMaintenance: () => maintenanceLoop,
      startCrawlFinished: () => crawlFinishedLoop,
    });
    await options.beforeStart?.();
    const app = createNuqWorkerHttpApp({
      isDraining: () => draining,
      dependencyReady: options.healthCheck,
      requiredLoopsReady: () =>
        options.requiredLoops?.().every(loop => loop.isHealthy()) ?? true,
      metrics: () => options.metrics?.() ?? "",
    });

    await request(app).get("/ready").expect(200, "OK");
    dependencyReady = false;
    await request(app).get("/live").expect(200, "OK");
    await request(app).get("/ready").expect(503, "Not Ready");

    dependencyReady = true;
    if (maintenance) {
      vi.mocked(maintenanceLoop.isHealthy!).mockReturnValue(false);
      await request(app).get("/ready").expect(503, "Not Ready");
      vi.mocked(maintenanceLoop.isHealthy!).mockReturnValue(true);
    }
    if (crawlFinished) {
      vi.mocked(crawlFinishedLoop.isHealthy!).mockReturnValue(false);
      await request(app).get("/ready").expect(503, "Not Ready");
      vi.mocked(crawlFinishedLoop.isHealthy!).mockReturnValue(true);
    }

    draining = true;
    await request(app).get("/ready").expect(503, "Not Ready");
    await request(app).get("/live").expect(200, "OK");
  });

  test("starts and supervises exactly its required topology", async () => {
    const maintenanceLoop = component("maintenance");
    const crawlFinishedLoop = component("crawl-finished");
    const startMaintenance = vi.fn(() => maintenanceLoop);
    const startCrawlFinished = vi.fn(() => crawlFinishedLoop);
    const options = createNuqFdbWorkerOptions(mode, {
      scrapeQueue,
      healthCheck: vi.fn().mockResolvedValue(true),
      startMaintenance,
      startCrawlFinished,
    });

    await options.beforeStart?.();

    expect(options.queue === scrapeQueue).toBe(scrape);
    expect(startMaintenance).toHaveBeenCalledTimes(maintenance ? 1 : 0);
    expect(startCrawlFinished).toHaveBeenCalledTimes(crawlFinished ? 1 : 0);
    expect(options.requiredLoops?.().map(loop => loop.name)).toEqual([
      ...(maintenance ? ["maintenance"] : []),
      ...(crawlFinished ? ["crawl-finished"] : []),
    ]);

    const metrics = await options.metrics?.();
    expect(metrics).toContain(maintenance ? "maintenance_metric 1" : "");
    expect(metrics).toContain(crawlFinished ? "crawl-finished_metric 1" : "");
    expect(maintenanceLoop.metrics).toHaveBeenCalledTimes(maintenance ? 1 : 0);
    expect(crawlFinishedLoop.metrics).toHaveBeenCalledTimes(
      crawlFinished ? 1 : 0,
    );

    await options.onShutdownRequested?.();
    expect(maintenanceLoop.stop).toHaveBeenCalledTimes(maintenance ? 1 : 0);
    expect(crawlFinishedLoop.stop).toHaveBeenCalledTimes(crawlFinished ? 1 : 0);
    await options.onShutdownDeadline?.();
    expect(maintenanceLoop.forceStop).toHaveBeenCalledTimes(
      maintenance ? 1 : 0,
    );
    expect(crawlFinishedLoop.forceStop).toHaveBeenCalledTimes(
      crawlFinished ? 1 : 0,
    );
  });
});
