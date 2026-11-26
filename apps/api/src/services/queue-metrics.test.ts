import { register } from "prom-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bullmqQueueDepth,
  bullmqQueueOldestOverdueSeconds,
  resetBullmqQueueMetricsForTest,
  startBullmqQueueMetrics,
} from "./queue-metrics";

function fakeQueue(
  name: string,
  counts: Record<string, number>,
  earliestDelayed: Array<string>,
) {
  const zrange = vi.fn(async (..._args: Array<unknown>) => earliestDelayed);
  const queue = {
    name,
    getJobCounts: vi.fn(async (..._states: Array<string>) => counts),
    toKey: (type: string) => `bull:${name}:${type}`,
    client: Promise.resolve({ zrange }),
  };
  return { queue, zrange };
}

async function values<T extends string>(gauge: {
  get: () => Promise<{
    values: Array<{
      labels: Partial<Record<T, string | number>>;
      value: number;
    }>;
  }>;
}) {
  return (await gauge.get()).values.map(v => ({ ...v.labels, value: v.value }));
}

describe("BullMQ queue metrics", () => {
  afterEach(() => {
    resetBullmqQueueMetricsForTest();
    vi.useRealTimers();
  });

  it("merges multiple calls and deduplicates by queue name keeping the newest instance", async () => {
    const first = fakeQueue("{firstQueue}", { waiting: 1 }, []);
    const secondOld = fakeQueue("{secondQueue}", { waiting: 2 }, []);
    const secondNew = fakeQueue("{secondQueue}", { waiting: 7 }, []);

    startBullmqQueueMetrics([first.queue, secondOld.queue]);
    startBullmqQueueMetrics([secondNew.queue]);

    const depth = await values(bullmqQueueDepth);
    expect(depth.filter(v => v.state === "waiting")).toEqual([
      { queue: "{firstQueue}", state: "waiting", value: 1 },
      { queue: "{secondQueue}", state: "waiting", value: 7 },
    ]);
    expect(secondOld.queue.getJobCounts).not.toHaveBeenCalled();
    expect(secondNew.queue.getJobCounts).toHaveBeenCalledTimes(1);
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
      String(dueAt * 0x10_00 + 7),
    ]);
    startBullmqQueueMetrics([
      overdue.queue,
      fakeQueue("{notYetDue}", {}, ["a", String((dueAt + 900_000) * 0x10_00)])
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
    let answer: ((counts: Record<string, number>) => void) | undefined;
    vi.mocked(queue.getJobCounts).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          answer = resolve;
        }),
    );
    startBullmqQueueMetrics([queue]);

    for (let scrape = 0; scrape < 3; scrape++) {
      const collected = values(bullmqQueueDepth);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await collected).toEqual([]);
    }
    expect(queue.getJobCounts).toHaveBeenCalledTimes(1);

    if (!answer) {
      throw new Error("Expected getJobCounts resolver to be captured");
    }
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
