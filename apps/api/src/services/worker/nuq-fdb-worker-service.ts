import type { RunNuqWorkerOptions, WorkerQueue } from "./nuq-worker-runner";
import type { RequiredWorkerLoop } from "./nuq-worker-runtime";

export type NuqFdbWorkerMode =
  | "all"
  | "scrape"
  | "maintenance"
  | "crawl-finished";

export type NuqFdbWorkerComponent = {
  name: string;
  stop(): void;
  forceStop?(): void;
  done: Promise<void>;
  isHealthy(): boolean;
  metrics?(): string | Promise<string>;
};

export type NuqFdbWorkerDependencies = {
  scrapeQueue: WorkerQueue;
  healthCheck: () => Promise<boolean>;
  startMaintenance: () => NuqFdbWorkerComponent;
  startCrawlFinished: () => NuqFdbWorkerComponent;
};

const idleQueue: WorkerQueue = {
  async getJobToProcess() {
    return null;
  },
  async renewLock() {
    return false;
  },
  async jobFinish() {
    return false;
  },
  async jobFail() {
    return false;
  },
};

export function createNuqFdbWorkerOptions(
  mode: NuqFdbWorkerMode,
  dependencies: NuqFdbWorkerDependencies,
): RunNuqWorkerOptions {
  const runsScrapes = mode === "all" || mode === "scrape";
  const runsMaintenance = mode === "all" || mode === "maintenance";
  const runsCrawlFinished = mode === "all" || mode === "crawl-finished";
  const components: NuqFdbWorkerComponent[] = [];

  return {
    serviceName: mode === "all" ? "nuq-fdb-worker" : `nuq-fdb-worker-${mode}`,
    queue: runsScrapes ? dependencies.scrapeQueue : idleQueue,
    healthCheck: dependencies.healthCheck,
    beforeStart: () => {
      if (runsMaintenance) {
        components.push(dependencies.startMaintenance());
      }
      if (runsCrawlFinished) {
        components.push(dependencies.startCrawlFinished());
      }
    },
    requiredLoops: () =>
      components.map(
        (component): RequiredWorkerLoop => ({
          name: component.name,
          done: component.done,
          isHealthy: () => component.isHealthy(),
        }),
      ),
    metrics: async () => {
      const metrics = await Promise.all(
        components.map(component => component.metrics?.() ?? ""),
      );
      return metrics.filter(Boolean).join("\n");
    },
    onShutdownRequested: () => {
      for (const component of components) component.stop();
    },
    drain: async () => {
      await Promise.all(components.map(component => component.done));
    },
    onShutdownDeadline: () => {
      for (const component of components) component.forceStop?.();
    },
  };
}
