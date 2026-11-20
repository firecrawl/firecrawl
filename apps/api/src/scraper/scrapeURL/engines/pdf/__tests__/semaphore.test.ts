import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// config.PDF_EXTRACTION_CONCURRENCY drives the semaphore size at module load.
// Pin it to 2 so the test exercises queueing deterministically.
// (Path is relative to this test file: __tests__ -> pdf -> engines ->
// scrapeURL -> scraper -> src.)
vi.mock("../../../../../config", () => ({
  config: { PDF_EXTRACTION_CONCURRENCY: 2 },
}));

import { pdfExtractionSemaphore, withPdfExtractionPermit } from "../semaphore";

describe("pdfExtractionSemaphore", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds concurrency to the configured limit and queues the rest", async () => {
    let active = 0;
    let maxActive = 0;
    const started: number[] = [];

    const work = (i: number) =>
      withPdfExtractionPermit(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        started.push(i);
        await new Promise(r => setTimeout(r, 25));
        active--;
      });

    // 6 concurrent callers on a limit of 2.
    await Promise.all([0, 1, 2, 3, 4, 5].map(work));

    expect(maxActive).toBe(2);
    // FIFO: all six started, in order.
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("release is idempotent and a throw still frees the permit", async () => {
    const release = await pdfExtractionSemaphore.acquire();
    release();
    release(); // double-release must not free extra permits

    // If double-release leaked a permit, this would deadlock on a limit of 2.
    await expect(
      withPdfExtractionPermit(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // And the semaphore is fully drained for subsequent callers.
    let ran = 0;
    await Promise.all([
      withPdfExtractionPermit(async () => {
        ran++;
      }),
      withPdfExtractionPermit(async () => {
        ran++;
      }),
      withPdfExtractionPermit(async () => {
        ran++;
      }),
    ]);
    expect(ran).toBe(3);
  });

  it("exposes active/waiting gauges and wait-time histogram", async () => {
    const { register } = await import("prom-client");

    // Force queueing: occupy both permits with slow work, then add a third.
    const slow = () =>
      withPdfExtractionPermit(() => new Promise(r => setTimeout(r, 60)));
    const p1 = slow();
    const p2 = slow();
    const p3 = slow();

    // Let the queue form.
    await new Promise(r => setTimeout(r, 10));
    const mid = await register.getSingleMetricAsString(
      "pdf_extraction_semaphore_waiting",
    );
    expect(mid).toContain("pdf_extraction_semaphore_waiting 1");

    await Promise.all([p1, p2, p3]);

    const activeAfter = await register.getSingleMetricAsString(
      "pdf_extraction_semaphore_active",
    );
    expect(activeAfter).toContain("pdf_extraction_semaphore_active 0");
    const waitingAfter = await register.getSingleMetricAsString(
      "pdf_extraction_semaphore_waiting",
    );
    expect(waitingAfter).toContain("pdf_extraction_semaphore_waiting 0");

    // The queued caller paid a real wait; the histogram must have observed it.
    // (Histograms expose *_bucket/*_sum/*_count as derived series, so read the
    // aggregated metrics text rather than a single-metric getter.)
    const allMetrics = await register.metrics();
    const waitCountLine = allMetrics
      .split("\n")
      .find(l => l.startsWith("pdf_extraction_semaphore_wait_seconds_count"));
    expect(waitCountLine).toBeDefined();
    expect(Number(waitCountLine!.split(" ").pop())).toBeGreaterThan(0);
  });

  it("rejects an already aborted operation without starting work", async () => {
    const controller = new AbortController();
    const reason = new Error("scrape expired");
    controller.abort(reason);
    const work = vi.fn(async () => "unused");

    await expect(withPdfExtractionPermit(work, controller.signal)).rejects.toBe(
      reason,
    );
    expect(work).not.toHaveBeenCalled();
  });

  it("removes an aborted waiter before an active extraction finishes", async () => {
    const releases = await Promise.all([
      pdfExtractionSemaphore.acquire(),
      pdfExtractionSemaphore.acquire(),
    ]);
    const controller = new AbortController();
    const reason = new Error("scrape expired while queued");
    const work = vi.fn(async () => "unused");
    let rejection: unknown;
    const queued = withPdfExtractionPermit(work, controller.signal).catch(
      error => {
        rejection = error;
      },
    );

    try {
      controller.abort(reason);
      await vi.waitFor(() => expect(rejection).toBe(reason));
      const { register } = await import("prom-client");
      expect(
        await register.getSingleMetricAsString(
          "pdf_extraction_semaphore_waiting",
        ),
      ).toContain("pdf_extraction_semaphore_waiting 0");
      expect(
        await register.getSingleMetricAsString(
          "pdf_extraction_semaphore_active",
        ),
      ).toContain("pdf_extraction_semaphore_active 2");
      expect(work).not.toHaveBeenCalled();
    } finally {
      releases.forEach(release => release());
      await queued;
    }
  });

  it("keeps surviving waiters in FIFO order after a queued abort", async () => {
    const releases = await Promise.all([
      pdfExtractionSemaphore.acquire(),
      pdfExtractionSemaphore.acquire(),
    ]);
    const controller = new AbortController();
    const started: string[] = [];
    const cancelled = withPdfExtractionPermit(async () => {
      started.push("cancelled");
    }, controller.signal).catch(() => {});
    const first = withPdfExtractionPermit(async () => {
      started.push("first");
    });
    const second = withPdfExtractionPermit(async () => {
      started.push("second");
    });

    controller.abort();
    releases.forEach(release => release());
    await Promise.all([cancelled, first, second]);
    expect(started).toEqual(["first", "second"]);
  });

  it("records a cancelled wait exactly once in the queue-time histogram", async () => {
    const { register } = await import("prom-client");
    const metric = "pdf_extraction_semaphore_wait_seconds";
    const sample = async () => {
      const lines = (await register.getSingleMetricAsString(metric)).split(
        "\n",
      );
      const value = (suffix: string) =>
        Number(
          lines
            .find(line => line.startsWith(`${metric}_${suffix} `))!
            .split(" ")
            .pop(),
        );
      return { count: value("count"), sum: value("sum") };
    };
    const before = await sample();
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const releases = await Promise.all([
      pdfExtractionSemaphore.acquire(),
      pdfExtractionSemaphore.acquire(),
    ]);
    const controller = new AbortController();
    const reason = new Error("queued deadline");
    const queued = pdfExtractionSemaphore.acquire(controller.signal);
    const settled = queued.catch(() => {});
    try {
      clock.mockReturnValue(12_500);
      controller.abort(reason);
      await expect(queued).rejects.toBe(reason);
      const after = await sample();
      expect(after.count - before.count).toBe(1);
      expect(after.sum - before.sum).toBeCloseTo(2.5);
      releases.forEach(release => release());
      expect(await sample()).toEqual(after);
    } finally {
      releases.forEach(release => release());
      clock.mockRestore();
      await settled;
    }
  });

  it("releases a permit when cancellation wins the grant-to-work race", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled after permit grant");
    const work = vi.fn(async () => "unused");
    const operation = withPdfExtractionPermit(work, controller.signal);
    controller.abort(reason);

    await expect(operation).rejects.toBe(reason);
    expect(work).not.toHaveBeenCalled();
    await expect(withPdfExtractionPermit(async () => "next")).resolves.toBe(
      "next",
    );
  });

  it("retains an active permit until non-cancellable native work settles", async () => {
    const releaseOther = await pdfExtractionSemaphore.acquire();
    const controller = new AbortController();
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => {
      finish = resolve;
    });
    let enter!: () => void;
    const entered = new Promise<void>(resolve => {
      enter = resolve;
    });
    const activeWork = withPdfExtractionPermit(async () => {
      enter();
      await blocked;
      return "finished";
    }, controller.signal);
    await entered;
    controller.abort();

    const nextWork = vi.fn(async () => "next");
    const next = withPdfExtractionPermit(nextWork);
    try {
      await Promise.resolve();
      expect(nextWork).not.toHaveBeenCalled();
      finish();
      await expect(activeWork).resolves.toBe("finished");
      await expect(next).resolves.toBe("next");
    } finally {
      finish();
      releaseOther();
      await Promise.all([activeWork, next]);
    }
  });
});
