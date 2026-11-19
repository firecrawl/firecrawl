import { register } from "prom-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Queue } from "bullmq";
import {
  bullmqQueueDepth,
  bullmqQueueOldestOverdueSeconds,
  startBullmqQueueMetrics,
} from "./queue-metrics";

function fakeQueue(
  name: string,
  counts: Record<string, number>,
  earliestDelayed: string[],
) {
  const zrange = vi.fn(async (..._args: unknown[]) => earliestDelayed);
  const queue = {
    name,
    getJobCounts: vi.fn(async (..._states: string[]) => counts),
    toKey: (type: string) => `bull:${name}:${type}`,
    client: Promise.resolve({ zrange }),
  } as unknown as Queue;
  return { queue, zrange };
}

async function values(gauge: { get: () => Promise<{ values: any[] }> }) {
  return (await gauge.get()).values.map(v => ({ ...v.labels, value: v.value }));
}

describe("BullMQ queue metrics", () => {
  afterEach(() => {
    startBullmqQueueMetrics([]);
    vi.useRealTimers();
  });

  it("exports depth per queue and state", async () => {
    const { queue } = fakeQueue(
      "{firebillTrackRetryQueue}",
      { waiting: 2, delayed: 5, active: 1, failed: 3 },
      [],
    );
    startBullmqQueueMetrics([queue]);

    expect(await values(bullmqQueueDepth)).toEqual([
      { queue: "{firebillTrackRetryQueue}", state: "waiting", value: 2 },
      { queue: "{firebillTrackRetryQueue}", state: "delayed", value: 5 },
      { queue: "{firebillTrackRetryQueue}", state: "active", value: 1 },
      { queue: "{firebillTrackRetryQueue}", state: "failed", value: 3 },
    ]);
    expect(queue.getJobCounts).toHaveBeenCalledWith(
      "waiting",
      "delayed",
      "active",
      "failed",
    );
  });

  it("reports how long the earliest-due delayed job is past due", async () => {
    vi.useFakeTimers({ now: 1_700_000_600_000 });
    const dueAt = 1_700_000_000_000;
    const overdue = fakeQueue("{overdue}", {}, [
      "firebill|key",
      String(dueAt * 0x1000 + 7),
    ]);
    startBullmqQueueMetrics([
      overdue.queue,
      fakeQueue("{notYetDue}", {}, ["a", String((dueAt + 900_000) * 0x1000)])
        .queue,
      fakeQueue("{empty}", {}, []).queue,
    ]);

    expect(await values(bullmqQueueOldestOverdueSeconds)).toEqual([
      { queue: "{overdue}", value: 600 },
      { queue: "{notYetDue}", value: 0 },
      { queue: "{empty}", value: 0 },
    ]);
    expect(overdue.zrange).toHaveBeenCalledWith(
      "bull:{overdue}:delayed",
      0,
      0,
      "WITHSCORES",
    );
  });

  it("drops only the series of a queue that cannot be read", async () => {
    const broken = fakeQueue("{billingQueue}", { waiting: 1 }, []);
    const healthy = fakeQueue("{precrawlQueue}", { waiting: 4 }, []);
    startBullmqQueueMetrics([broken.queue, healthy.queue]);
    vi.mocked(broken.queue.getJobCounts).mockRejectedValueOnce(
      new Error("down"),
    );
    broken.zrange.mockRejectedValueOnce(new Error("down"));

    const depth = await values(bullmqQueueDepth);
    expect(depth).toHaveLength(4);
    expect(depth.every(v => v.queue === "{precrawlQueue}")).toBe(true);
    expect(await values(bullmqQueueOldestOverdueSeconds)).toEqual([
      { queue: "{precrawlQueue}", value: 0 },
    ]);
  });

  it("reuses a read that outlived the timeout instead of issuing another", async () => {
    vi.useFakeTimers();
    const { queue } = fakeQueue("{firebillTrackRetryQueue}", {}, []);
    let answer: (counts: Record<string, number>) => void = () => {};
    vi.mocked(queue.getJobCounts).mockImplementationOnce(
      () => new Promise(resolve => (answer = resolve)),
    );
    startBullmqQueueMetrics([queue]);

    for (let scrape = 0; scrape < 3; scrape++) {
      const collected = values(bullmqQueueDepth);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await collected).toEqual([]);
    }
    expect(queue.getJobCounts).toHaveBeenCalledTimes(1);

    answer({ waiting: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(await values(bullmqQueueDepth)).toHaveLength(4);
    expect(queue.getJobCounts).toHaveBeenCalledTimes(2);
  });

  it("is registered once in the default registry", () => {
    expect(register.getSingleMetric("firecrawl_bullmq_queue_depth")).toBe(
      bullmqQueueDepth,
    );
  });
});
