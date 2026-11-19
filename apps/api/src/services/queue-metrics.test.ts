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
  return {
    name,
    getJobCounts: vi.fn(async () => counts),
    toKey: (type: string) => `bull:${name}:${type}`,
    client: Promise.resolve({ zrange: vi.fn(async () => earliestDelayed) }),
  } as unknown as Queue;
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
    startBullmqQueueMetrics([
      fakeQueue(
        "{firebillTrackRetryQueue}",
        { waiting: 2, delayed: 5, active: 1, failed: 3 },
        [],
      ),
    ]);

    expect(await values(bullmqQueueDepth)).toEqual([
      { queue: "{firebillTrackRetryQueue}", state: "waiting", value: 2 },
      { queue: "{firebillTrackRetryQueue}", state: "delayed", value: 5 },
      { queue: "{firebillTrackRetryQueue}", state: "active", value: 1 },
      { queue: "{firebillTrackRetryQueue}", state: "failed", value: 3 },
    ]);
  });

  it("reports how long the earliest-due delayed job is past due", async () => {
    vi.useFakeTimers({ now: 1_700_000_600_000 });
    const dueAt = 1_700_000_000_000;
    startBullmqQueueMetrics([
      fakeQueue("{overdue}", {}, ["firebill|key", String(dueAt * 0x1000 + 7)]),
      fakeQueue("{notYetDue}", {}, ["a", String((dueAt + 900_000) * 0x1000)]),
      fakeQueue("{empty}", {}, []),
    ]);

    expect(await values(bullmqQueueOldestOverdueSeconds)).toEqual([
      { queue: "{overdue}", value: 600 },
      { queue: "{notYetDue}", value: 0 },
      { queue: "{empty}", value: 0 },
    ]);
  });

  it("drops the series when the queue cannot be read", async () => {
    const queue = fakeQueue("{billingQueue}", { waiting: 1 }, []);
    startBullmqQueueMetrics([queue]);
    expect(await values(bullmqQueueDepth)).toHaveLength(4);

    vi.mocked(queue.getJobCounts).mockRejectedValueOnce(new Error("down"));
    expect(await values(bullmqQueueDepth)).toEqual([]);
  });

  it("is registered once in the default registry", () => {
    expect(register.getSingleMetric("firecrawl_bullmq_queue_depth")).toBe(
      bullmqQueueDepth,
    );
  });
});
