import { afterEach, describe, expect, test, vi } from "vitest";
import {
  encodeI64,
  encodeJson,
  METRIC_SHARDS,
  NuqFdbMetricControl,
} from "./keyspace";
import { crawlFinishedQueueFdb, nuqFdbGetMetrics, scrapeQueueFdb } from ".";
import { NuQFdbQueue, NuqFdbMetricsInitializingError } from "./queue";

const READINESS = `# HELP firecrawl_nuq_fdb_metrics_ready Whether maintained FDB queue metrics are fully initialized
# TYPE firecrawl_nuq_fdb_metrics_ready gauge
`;
const WORKER_LOAD = `# HELP firecrawl_nuq_fdb_pending_jobs Number of FDB scrape jobs currently admitted to workers or waiting in ready shards
# TYPE firecrawl_nuq_fdb_pending_jobs gauge
firecrawl_nuq_fdb_pending_jobs 5
`;

const SCRAPE_METRICS = `# HELP nuq_fdb_queue_scrape_job_count Number of FDB jobs in each status
# TYPE nuq_fdb_queue_scrape_job_count gauge
nuq_fdb_queue_scrape_job_count{status="queued"} 2
nuq_fdb_queue_scrape_job_count{status="active"} 3
nuq_fdb_queue_scrape_job_count{status="completed"} 6
nuq_fdb_queue_scrape_job_count{status="failed"} 7
nuq_fdb_queue_scrape_job_count{status="backlog"} 4
`;

const CRAWL_FINISHED_METRICS = `# HELP nuq_fdb_queue_crawl_finished_job_count Number of FDB jobs in each status
# TYPE nuq_fdb_queue_crawl_finished_job_count gauge
nuq_fdb_queue_crawl_finished_job_count{status="queued"} 7
nuq_fdb_queue_crawl_finished_job_count{status="active"} 0
nuq_fdb_queue_crawl_finished_job_count{status="completed"} 8
nuq_fdb_queue_crawl_finished_job_count{status="failed"} 1
nuq_fdb_queue_crawl_finished_job_count{status="backlog"} 0
`;

const CONTROL: NuqFdbMetricControl = {
  format: 3,
  generation: "generation",
  phase: "ready",
  shards: 32,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NuQ FDB metrics", () => {
  test("READY output performs exactly one control plus 5x32 point reads", async () => {
    const queue = new NuQFdbQueue("scrape", { hasGroups: false });
    const get = vi.fn(async (key: Buffer) => {
      const parts = queue.ks.unpack(key);
      if (parts[2] === "metrics" && parts[4] === "ctl") {
        return encodeJson(CONTROL);
      }
      if (
        parts[2] !== "metrics" ||
        parts[4] !== "gen" ||
        parts[5] !== CONTROL.generation ||
        parts[6] !== "n" ||
        parts[8] !== 0
      ) {
        return undefined;
      }
      const values: Record<string, number> = {
        pending: 4,
        queued: 2,
        active: 3,
        completed: 6,
        failed: 7,
      };
      return encodeI64(values[String(parts[7])] ?? 0);
    });
    const getRangeAll = vi.fn(async () => {
      throw new Error("fixed collector must not range-read");
    });
    Object.defineProperty(queue, "db", {
      value: {
        doTn: async (fn: (tn: unknown) => unknown) =>
          fn({ snapshot: () => ({ get, getRangeAll }) }),
      },
    });

    expect(await queue.getMetrics()).toBe(SCRAPE_METRICS);
    expect(get).toHaveBeenCalledTimes(1 + 5 * METRIC_SHARDS);
    expect(getRangeAll).not.toHaveBeenCalled();
  });

  test("non-READY output reads only control and exposes no fixed family", async () => {
    const queue = new NuQFdbQueue("scrape", { hasGroups: false });
    const get = vi.fn(async () =>
      encodeJson({ ...CONTROL, phase: "backfill-jobs" }),
    );
    Object.defineProperty(queue, "db", {
      value: {
        doTn: async (fn: (tn: unknown) => unknown) =>
          fn({ snapshot: () => ({ get }) }),
      },
    });

    await expect(queue.getMetrics()).rejects.toThrow(
      "NuQ FDB metrics are initializing",
    );
    await expect(queue.getWorkerLoadCount()).rejects.toThrow(
      "NuQ FDB metrics are initializing",
    );
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("negative fixed counters surface corruption instead of being clamped", async () => {
    const queue = new NuQFdbQueue("scrape", { hasGroups: false });
    const get = vi.fn(async (key: Buffer) => {
      const parts = queue.ks.unpack(key);
      if (parts[4] === "ctl") return encodeJson(CONTROL);
      return parts[7] === "queued" && parts[8] === 0
        ? encodeI64(-1)
        : undefined;
    });
    Object.defineProperty(queue, "db", {
      value: {
        doTn: async (fn: (tn: unknown) => unknown) =>
          fn({ snapshot: () => ({ get }) }),
      },
    });

    await expect(queue.getMetrics()).rejects.toThrow(
      "Corrupt NuQ FDB metric counter queued: -1",
    );
  });

  test("exported collector composes READY fixed families", async () => {
    vi.spyOn(scrapeQueueFdb, "getMetrics").mockResolvedValue(SCRAPE_METRICS);
    vi.spyOn(crawlFinishedQueueFdb, "getMetrics").mockResolvedValue(
      CRAWL_FINISHED_METRICS,
    );
    vi.spyOn(scrapeQueueFdb, "getWorkerLoadCount").mockResolvedValue(5);

    await expect(nuqFdbGetMetrics()).resolves.toBe(
      `${READINESS}firecrawl_nuq_fdb_metrics_ready 1\n${SCRAPE_METRICS}${CRAWL_FINISHED_METRICS}${WORKER_LOAD}`,
    );
  });

  test("release A exposes only readiness while fixed counters build", async () => {
    vi.spyOn(scrapeQueueFdb, "getMetrics").mockRejectedValue(
      new NuqFdbMetricsInitializingError("initializing"),
    );
    vi.spyOn(crawlFinishedQueueFdb, "getMetrics").mockResolvedValue(
      CRAWL_FINISHED_METRICS,
    );
    vi.spyOn(scrapeQueueFdb, "getWorkerLoadCount").mockRejectedValue(
      new NuqFdbMetricsInitializingError("initializing"),
    );

    const output = await nuqFdbGetMetrics();
    expect(output).toBe(`${READINESS}firecrawl_nuq_fdb_metrics_ready 0\n`);
    expect(output).not.toContain("firecrawl_nuq_fdb_pending_jobs");
    expect(output).not.toContain("nuq_fdb_queue_scrape_job_count");
    expect(output).not.toContain("nuq_fdb_queue_crawl_finished_job_count");
  });
});
