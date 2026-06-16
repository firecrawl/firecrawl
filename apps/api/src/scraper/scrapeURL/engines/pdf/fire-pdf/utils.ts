import type { Meta } from "../../..";
import {
  MIN_DEADLINE_MS,
  MAX_DEADLINE_MS,
  POLL_FLOOR_MS,
  POLL_CAP_MS,
} from "./schema";
import { firePdfAsyncFallbackTotal, type FallbackReason } from "./metrics";

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const handle = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(handle);
      reject(
        signal?.reason instanceof Error ? signal.reason : new Error("Aborted"),
      );
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(handle);
        reject(
          signal.reason instanceof Error ? signal.reason : new Error("Aborted"),
        );
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function nextPollDelay(
  prev: number,
  retryAfterMs: number | undefined,
): number {
  const candidate = retryAfterMs ?? Math.max(prev * 2, POLL_FLOOR_MS);
  return Math.min(POLL_CAP_MS, Math.max(POLL_FLOOR_MS, candidate));
}

export function computeDeadlineMs(scrapeTimeoutMs: number | undefined): number {
  // 5min default when there's no scrape budget (CLI/tests). Anything outside
  // [5s, 30min] is clamped to satisfy the /jobs contract.
  const fallback = 5 * 60 * 1_000;
  const candidate = scrapeTimeoutMs ?? fallback;
  return Math.min(MAX_DEADLINE_MS, Math.max(MIN_DEADLINE_MS, candidate));
}

export class FirePdfAsyncFailure extends Error {
  constructor(
    public readonly reason: FallbackReason,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(`fire-pdf async failed: ${reason}`);
    this.name = "FirePdfAsyncFailure";
  }
}

export function failAsync(
  meta: Meta,
  reason: FallbackReason,
  extra: Record<string, unknown> = {},
): never {
  firePdfAsyncFallbackTotal.labels(reason).inc();
  meta.logger.warn("FirePDF async failed", {
    scrapeId: meta.id,
    reason,
    ...extra,
  });
  throw new FirePdfAsyncFailure(reason, extra);
}
