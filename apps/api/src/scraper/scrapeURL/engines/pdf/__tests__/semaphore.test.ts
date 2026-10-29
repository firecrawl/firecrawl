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
});
