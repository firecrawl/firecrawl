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
import { failAsync, firePdfHeaders, nextPollDelay } from "./utils";

type PollDeps = {
  baseUrl: string;
  scrapeId: string;
  initialDelay: number;
  pollingDeadline: number;
  meta: Meta;
  fetchImpl: typeof undiciFetch;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  random?: () => number;
};

type PollOk = { poll: PollResponse; pollCount: number };

export async function pollUntilTerminal(deps: PollDeps): Promise<PollOk> {
  const { baseUrl, scrapeId, pollingDeadline, meta, fetchImpl, sleep, now } =
    deps;
  let pollCount = 0;
  const random = deps.random ?? Math.random;
  let lastDelay = nextPollDelay(0, deps.initialDelay, random);

  while (true) {
    if (now() > pollingDeadline) {
      firePdfAsyncPollCount.observe(pollCount);
      failAsync(meta, "polling_timeout", { pollCount });
    }

    meta.abort.throwIfAborted();
    await sleep(lastDelay, meta.abort.asSignal());
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

    lastDelay = nextPollDelay(lastDelay, parsed.data.retry_after_ms, random);
  }
}
