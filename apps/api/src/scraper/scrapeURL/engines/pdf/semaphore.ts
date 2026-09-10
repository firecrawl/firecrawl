import { Gauge, Histogram } from "prom-client";
import { config } from "../../../../config";

/**
 * In-process semaphore bounding concurrent native PDF extractions
 * (`processPdf` / `detectPdf` via @mendable/firecrawl-rs).
 *
 * Why this exists: those calls run on tokio's blocking thread pool, which is
 * unbounded — under bursty PDF load, a single pod could have many extractions
 * in flight at once, each holding the (≤50MB) PDF plus parsed text/markdown in
 * memory. That piled up and OOM-killed app pods. This semaphore caps
 * per-process concurrency; callers queue for a permit instead of all piling
 * onto the heap at once.
 *
 * Metrics let us watch queue depth and wait time to tune the limit.
 */

const active = new Gauge({
  name: "pdf_extraction_semaphore_active",
  help: "PDF extractions currently holding a permit",
});

const waiting = new Gauge({
  name: "pdf_extraction_semaphore_waiting",
  help: "PDF extractions queued waiting for a permit",
});

const waitSeconds = new Histogram({
  name: "pdf_extraction_semaphore_wait_seconds",
  help: "Time spent queued waiting for a PDF extraction permit",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});

const holdSeconds = new Histogram({
  name: "pdf_extraction_semaphore_hold_seconds",
  help: "Time a PDF extraction permit is held (≈ extraction duration)",
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
});

class PdfExtractionSemaphore {
  private inFlight = 0;
  private readonly queue: { resolve: () => void; enqueuedAt: number }[] = [];

  constructor(private readonly max: number) {}

  /** Acquire a permit; resolves to a release function (call exactly once). */
  acquire(): Promise<() => void> {
    // Fast path: free permit and nobody queued (no barging past waiters).
    if (this.inFlight < this.max && this.queue.length === 0) {
      this.inFlight++;
      active.set(this.inFlight);
      return Promise.resolve(this.makeRelease());
    }

    return new Promise<() => void>(resolve => {
      this.queue.push({
        resolve: () => resolve(this.makeRelease()),
        enqueuedAt: Date.now(),
      });
      waiting.set(this.queue.length);
    });
  }

  private makeRelease(): () => void {
    const acquiredAt = Date.now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holdSeconds.observe((Date.now() - acquiredAt) / 1000);

      // Hand the permit directly to the oldest waiter (FIFO), keeping
      // inFlight constant; otherwise free it.
      const next = this.queue.shift();
      if (next) {
        waiting.set(this.queue.length);
        waitSeconds.observe((Date.now() - next.enqueuedAt) / 1000);
        next.resolve();
      } else {
        this.inFlight--;
        active.set(this.inFlight);
      }
    };
  }
}

export const pdfExtractionSemaphore = new PdfExtractionSemaphore(
  config.PDF_EXTRACTION_CONCURRENCY,
);

/** Run `fn` holding a PDF extraction permit. */
export async function withPdfExtractionPermit<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const release = await pdfExtractionSemaphore.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
