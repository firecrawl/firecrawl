import type { Meta } from "../../..";
import { config } from "../../../../../config";
import { MAX_DEADLINE_MS, POLL_FLOOR_MS, POLL_CAP_MS } from "./schema";
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
  random: () => number = Math.random,
): number {
  const candidate = Math.max(prev * 2, retryAfterMs ?? 0, POLL_FLOOR_MS);
  const jittered = Math.round(candidate * (1 + random() * 0.2));
  return Math.min(POLL_CAP_MS, jittered);
}

export function computeDeadlineMs(scrapeTimeoutMs: number | undefined): number {
  // 5min default when there's no scrape budget (CLI/tests). Routing rejects
  // budgets that are too short; only cap the upper bound here so we never
  // advertise more time to FirePDF than the caller actually has.
  const fallback = 5 * 60 * 1_000;
  const candidate = scrapeTimeoutMs ?? fallback;
  return Math.min(MAX_DEADLINE_MS, candidate);
}

export function firePdfHeaders(includeJson = false): Record<string, string> {
  return {
    ...(includeJson && { "Content-Type": "application/json" }),
    ...(config.FIRE_PDF_API_KEY && {
      Authorization: `Bearer ${config.FIRE_PDF_API_KEY}`,
    }),
  };
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
