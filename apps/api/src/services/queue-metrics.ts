import { Gauge } from "prom-client";
import { logger } from "../lib/logger";

const STATES = ["waiting", "delayed", "active", "failed"] as const;
type MonitoredQueueState = (typeof STATES)[number];

interface MonitoredQueueClient {
  zrange(
    key: string,
    start: number,
    stop: number,
    withScores: "WITHSCORES",
  ): Promise<Array<string>>;
}

interface MonitoredQueue {
  readonly name: string;
  getJobCounts(
    ...types: Array<MonitoredQueueState>
  ): Promise<Record<string, number>>;
  toKey(type: string): string;
  readonly client: Promise<MonitoredQueueClient>;
}

// A scrape must not hang on Redis: the queue clients retry forever while
// disconnected, and VMServiceScrape gives the whole endpoint 30s.
const COLLECT_TIMEOUT_MS = 5000;

let monitoredQueues: Array<MonitoredQueue> = [];

/**
 * Exports depth and drain progress for these queues on every scrape. Multiple
 * calls merge into the monitored set, deduplicated by queue name (keeping the
 * newest instance per name). Call it from one single-replica deployment only:
 * the numbers are Redis-wide, so every pod that exports them adds an identical
 * copy of each series.
 */
export function startBullmqQueueMetrics(queues: Array<MonitoredQueue>) {
  const byName = new Map(monitoredQueues.map(queue => [queue.name, queue]));
  for (const queue of queues) {
    byName.set(queue.name, queue);
  }
  monitoredQueues = [...byName.values()];
}

/** @internal Clears registered BullMQ queues between test runs. */
export function resetBullmqQueueMetricsForTest() {
  monitoredQueues = [];
}

const depthInFlight = new Map<string, Promise<Record<string, number>>>();
const overdueInFlight = new Map<string, Promise<Array<string>>>();

/**
 * Bounds a read to COLLECT_TIMEOUT_MS. A read that outlives it cannot be
 * cancelled, so later scrapes wait on that same read instead of queueing
 * another command behind a disconnected client.
 */
async function readOnce<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  let work = inFlight.get(key);
  if (!work) {
    work = read().finally(() => inFlight.delete(key));
    inFlight.set(key, work);
  }
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
 * Jobs per queue and state, read with getJobCounts on each scrape. A queue
 * whose read fails has its series dropped rather than left at their last
 * value, so a queue nobody can read shows up as absent instead of as healthy.
 */
export const bullmqQueueDepth = new Gauge({
  name: "firecrawl_bullmq_queue_depth",
  help: "Jobs in each BullMQ queue, by state",
  labelNames: ["queue", "state"] as const,
  async collect() {
    const queues = [...monitoredQueues];
    const results = await Promise.allSettled(
      queues.map(queue =>
        readOnce(depthInFlight, `depth:${queue.name}`, () =>
          queue.getJobCounts(...STATES),
        ),
      ),
    );
    this.reset();
    results.forEach((result, i) => {
      const queue = queues[i].name;
      if (result.status === "rejected") {
        const error: unknown = result.reason;
        logger.warn("Failed to collect BullMQ queue depth", {
          queue,
          error,
        });
        return;
      }
      for (const state of STATES) {
        this.labels(queue, state).set(result.value[state] ?? 0);
      }
    });
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
    const queues = [...monitoredQueues];
    const results = await Promise.allSettled(
      queues.map(queue =>
        readOnce(overdueInFlight, `overdue:${queue.name}`, async () => {
          const client = await queue.client;
          return client.zrange(queue.toKey("delayed"), 0, 0, "WITHSCORES");
        }),
      ),
    );
    const now = Date.now();
    this.reset();
    results.forEach((result, i) => {
      const queue = queues[i].name;
      if (result.status === "rejected") {
        const error: unknown = result.reason;
        logger.warn("Failed to collect BullMQ queue overdue age", {
          queue,
          error,
        });
        return;
      }
      const score = result.value[1];
      // BullMQ scores a delayed job as dueAtMs * 0x1000 plus a counter.
      const dueAt =
        score === undefined ? now : Math.floor(Number(score) / 0x10_00);
      this.labels(queue).set(Math.max(0, (now - dueAt) / 1000));
    });
  },
});
