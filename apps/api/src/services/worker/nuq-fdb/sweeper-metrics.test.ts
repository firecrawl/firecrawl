import { describe, expect, it } from "vitest";
import type { NuqFdbKeyspace } from "./keyspace";
import type { NuQFdbQueue } from "./queue";
import { NuqFdbSweeper } from "./sweeper";

function makeSweeper() {
  const ks = { queueName: 'queue"with\\escapes' } as NuqFdbKeyspace;
  const queue = { ks } as NuQFdbQueue;
  return { ks, sweeper: new NuqFdbSweeper([queue]) };
}

function observeDelay(
  sweeper: NuqFdbSweeper,
  ks: NuqFdbKeyspace,
  dueAtMs: number,
  expiresAt: number,
) {
  (sweeper as any).observeDue(
    {
      ks,
      phase: "delay",
      partition: 3,
      generation: "test",
      expiresAt,
    },
    "delay",
    [[Buffer.alloc(0), Buffer.alloc(0)]],
    () => dueAtMs,
  );
}

describe("NuqFdbSweeper overdue metrics", () => {
  it("collects an owned observation without touching FoundationDB", () => {
    const { ks, sweeper } = makeSweeper();
    Object.defineProperty(sweeper as any, "db", {
      get() {
        throw new Error("metric collection must not access FoundationDB");
      },
    });
    observeDelay(sweeper, ks, 1_000, 10_000);

    expect(sweeper.getMetrics(6_000)).toContain(
      'firecrawl_nuq_fdb_sweeper_oldest_overdue_seconds{queue="queue\\"with\\\\escapes",index="delay",partition="3"} 5',
    );
  });

  it("removes labels after an empty scan, local lease expiry, or stop", () => {
    const { ks, sweeper } = makeSweeper();
    observeDelay(sweeper, ks, 1_000, 10_000);
    (sweeper as any).observeDue(
      {
        ks,
        phase: "delay",
        partition: 3,
        generation: "test",
        expiresAt: 10_000,
      },
      "delay",
      [],
      () => 0,
    );
    expect(sweeper.getMetrics(2_000)).not.toContain('index="delay"');

    observeDelay(sweeper, ks, 1_000, 3_000);
    expect(sweeper.getMetrics(3_000)).not.toContain('index="delay"');

    observeDelay(sweeper, ks, 1_000, 10_000);
    sweeper.stop();
    expect(sweeper.getMetrics(2_000)).not.toContain('index="delay"');
  });
});
