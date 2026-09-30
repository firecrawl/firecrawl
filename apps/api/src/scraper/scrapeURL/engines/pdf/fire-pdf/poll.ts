import type { Meta } from "../../..";
import { fetch as undiciFetch } from "undici";
import { AbortManagerThrownError } from "../../../lib/abortManager";
import {
  firePdfAsyncCompletedTotal,
  firePdfAsyncPollCount,
  type FallbackReason,
} from "./metrics";
import {
  pollResponseSchema,
  TERMINAL_STATUSES,
  type PollResponse,
} from "./schema";
import { earlyPollDelay } from "./early-poll";
import {
  alignPollDelay,
  failAsync,
  firePdfHeaders,
  nextPollDelay,
} from "./utils";

type PollDeps = {
  baseUrl: string;
  scrapeId: string;
  /** fire-pdf's `retry_after_ms` from the submit response, when it sent one. */
  initialDelay?: number;
  /** Page count of the document, when the caller has one. Selects the early
   * poll schedule (see early-poll.ts); absent, plain backoff applies. */
  pagesEstimate?: number;
  pollingDeadline: number;
  meta: Meta;
  fetchImpl: typeof undiciFetch;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  random?: () => number;
  /** When the job is expected to finish (its `deadline_at`). Polls are
   * pulled forward to land just after it and run at the floor past it —
   * see alignPollDelay. Absent, plain backoff applies throughout. */
  jobDeadlineAtMs?: number;
  /** Observes each non-terminal status seen while polling — lets the
   * caller keep a live "where is this job" snapshot (used to enrich
   * timeout errors for by-reference jobs that outlive the scrape).
   * `estimatedRemainingMs` is fire-pdf's live estimate when present. */
  onNonTerminalStatus?: (
    status: "queued" | "published" | "running",
    estimatedRemainingMs?: number,
  ) => void;
};

type PollOk = { poll: PollResponse; pollCount: number };

export async function pollUntilTerminal(deps: PollDeps): Promise<PollOk> {
  const { baseUrl, scrapeId, pollingDeadline, meta, fetchImpl, sleep, now } =
    deps;
  let pollCount = 0;
  const random = deps.random ?? Math.random;
  let lastDelay = nextPollDelay(0, deps.initialDelay, random);
  const startedAt = now();
  let retryAfterMs = deps.initialDelay;
  let fastPollCount = 0;
  let inEarlySchedule = false;

  while (true) {
    if (now() > pollingDeadline) {
      firePdfAsyncPollCount.observe(pollCount);
      failAsync(meta, "polling_timeout", { pollCount });
    }

    meta.abort.throwIfAborted();
    const early = earlyPollDelay({
      pagesEstimate: deps.pagesEstimate,
      elapsedMs: now() - startedAt,
      pollCount,
      fastPollCount,
      retryAfterMs,
      random,
    });
    if (early !== undefined && pollCount > 0) fastPollCount++;
    if (early !== undefined) {
      inEarlySchedule = true;
    } else if (inEarlySchedule) {
      // Handover: backoff restarts from the floor (or the latest hint),
      // not from the seed computed before the early polls began.
      inEarlySchedule = false;
      lastDelay = nextPollDelay(0, retryAfterMs, random);
    }
    await sleep(
      alignPollDelay(early ?? lastDelay, now(), deps.jobDeadlineAtMs),
      meta.abort.asSignal(),
    );
    pollCount++;

    let pollResp;
    try {
      pollResp = await fetchImpl(`${baseUrl}/jobs/${scrapeId}`, {
        method: "GET",
        headers: firePdfHeaders(),
        signal: meta.abort.asSignal(),
      });
    } catch (error) {
      if (error instanceof AbortManagerThrownError) throw error;
      firePdfAsyncPollCount.observe(pollCount);
      failAsync(meta, "network_error", {
        error: String(error),
        pollCount,
      });
    }

    const pollStatus = pollResp.status;
    const pollBody = await pollResp.json().catch(() => ({}));

    if (pollStatus === 401) {
      firePdfAsyncPollCount.observe(pollCount);
      failAsync(meta, "http_401", { pollCount });
    }

    if (pollStatus === 404) {
      firePdfAsyncPollCount.observe(pollCount);
      throw new Error(
        "fire-pdf async GET /jobs/:id 404: scrape_id missing after successful submit",
      );
    }

    if (pollStatus === 410) {
      firePdfAsyncPollCount.observe(pollCount);
      const parsed = pollResponseSchema.safeParse(pollBody);
      const status = parsed.success ? parsed.data.status : "expired";
      firePdfAsyncCompletedTotal.labels(status).inc();
      failAsync(
        meta,
        status === "cancelled" ? "terminal_cancelled" : "terminal_expired",
        { status, pollCount, body: pollBody },
      );
    }

    if (pollStatus === 502) {
      firePdfAsyncPollCount.observe(pollCount);
      firePdfAsyncCompletedTotal.labels("failed").inc();
      failAsync(meta, "terminal_failed", {
        pollCount,
        body: pollBody,
      });
    }

    if (pollStatus !== 200 && pollStatus !== 202) {
      firePdfAsyncPollCount.observe(pollCount);
      failAsync(meta, "http_5xx", {
        status: pollStatus,
        body: pollBody,
        pollCount,
      });
    }

    const parsed = pollResponseSchema.safeParse(pollBody);
    if (!parsed.success) {
      firePdfAsyncPollCount.observe(pollCount);
      failAsync(meta, "http_5xx", {
        error: String(parsed.error),
        body: pollBody,
        pollCount,
      });
    }

    if (TERMINAL_STATUSES.has(parsed.data.status)) {
      firePdfAsyncPollCount.observe(pollCount);
      firePdfAsyncCompletedTotal.labels(parsed.data.status).inc();
      if (parsed.data.status !== "done") {
        const reason: FallbackReason =
          parsed.data.status === "failed"
            ? "terminal_failed"
            : parsed.data.status === "expired"
              ? "terminal_expired"
              : "terminal_cancelled";
        failAsync(meta, reason, {
          status: parsed.data.status,
          errorClass: parsed.data.error_class,
          errorMessage: parsed.data.error_message,
          pollCount,
        });
      }
      return { poll: parsed.data, pollCount };
    }

    if (
      parsed.data.status === "queued" ||
      parsed.data.status === "published" ||
      parsed.data.status === "running"
    ) {
      deps.onNonTerminalStatus?.(
        parsed.data.status,
        parsed.data.estimated_remaining_ms,
      );
    }

    retryAfterMs = parsed.data.retry_after_ms;
    // Backoff advances only while it is the schedule in use.
    if (early === undefined) {
      lastDelay = nextPollDelay(lastDelay, retryAfterMs, random);
    }
  }
}
