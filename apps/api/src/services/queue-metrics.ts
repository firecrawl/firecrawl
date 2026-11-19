import type { Queue } from "bullmq";
import { Gauge } from "prom-client";
import { logger } from "../lib/logger";

const STATES = ["waiting", "delayed", "active", "failed"] as const;

// A scrape must not hang on Redis: the queue clients retry forever while
// disconnected, and VMServiceScrape gives the whole endpoint 30s.
const COLLECT_TIMEOUT_MS = 5000;

let monitoredQueues: Queue[] = [];

/**
 * Exports depth and drain progress for these queues on every scrape. Call it
 * from one single-replica deployment only: the numbers are Redis-wide, so every
 * pod that exports them adds an identical copy of each series.
 */
export function startBullmqQueueMetrics(queues: Queue[]) {
  monitoredQueues = queues;
}

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("timed out reading queue state")),
          COLLECT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Jobs per queue and state, read with getJobCounts on each scrape. On a failed
 * read the series are dropped rather than left at their last value, so a queue
 * nobody can read shows up as absent instead of as healthy.
 */
export const bullmqQueueDepth = new Gauge({
  name: "firecrawl_bullmq_queue_depth",
  help: "Jobs in each BullMQ queue, by state",
  labelNames: ["queue", "state"] as const,
  async collect() {
    try {
      const counts = await withTimeout(
        Promise.all(
          monitoredQueues.map(queue => queue.getJobCounts(...STATES)),
        ),
      );
      this.reset();
      monitoredQueues.forEach((queue, i) => {
        for (const state of STATES) {
          this.labels(queue.name, state).set(counts[i][state] ?? 0);
        }
      });
    } catch (error) {
      this.reset();
      logger.warn("Failed to collect BullMQ queue depth", { error });
    }
  },
});

/**
 * Seconds since the earliest-due delayed job became due, 0 when none is due.
 * Workers are what promote delayed jobs, so a worker that has stopped taking
 * jobs leaves them in `delayed` past their due time while depth alone can
 * look flat. A healthy worker keeps this within a few seconds.
 */
export const bullmqQueueOldestOverdueSeconds = new Gauge({
  name: "firecrawl_bullmq_queue_oldest_overdue_seconds",
  help: "Seconds the earliest-due delayed job in each BullMQ queue is past due",
  labelNames: ["queue"] as const,
  async collect() {
    try {
      const earliest = await withTimeout(
        Promise.all(
          monitoredQueues.map(async queue => {
            const client = await queue.client;
            return client.zrange(queue.toKey("delayed"), 0, 0, "WITHSCORES");
          }),
        ),
      );
      const now = Date.now();
      this.reset();
      monitoredQueues.forEach((queue, i) => {
        const score = earliest[i][1];
        // BullMQ scores a delayed job as dueAtMs * 0x1000 plus a counter.
        const dueAt =
          score === undefined ? now : Math.floor(Number(score) / 0x1000);
        this.labels(queue.name).set(Math.max(0, (now - dueAt) / 1000));
      });
    } catch (error) {
      this.reset();
      logger.warn("Failed to collect BullMQ queue overdue age", { error });
    }
  },
});
