import type { Meta } from "../../..";
import type { PDFMode } from "../../../../../controllers/v2/types";
import { fetch as undiciFetch } from "undici";
import { AbortManagerThrownError } from "../../../lib/abortManager";
import {
  firePdfAsyncSubmitRetriesTotal,
  firePdfAsyncSubmittedTotal,
  type SubmitRetryTrigger,
} from "./metrics";
import {
  SUBMIT_TRANSIENT_RETRY_DELAY_MS,
  fastifyClosingBodySchema,
  firePdfSubmit503BodySchema,
  submitResponseSchema,
} from "./schema";
import {
  buildFirePdfJobOptions,
  defaultSleep,
  failAsync,
  firePdfHeaders,
} from "./utils";

type SubmitOutcome = {
  lane: string | undefined;
  retryAfterMs: number | undefined;
  alreadyDone: boolean;
};

/** How the PDF bytes reach fire-pdf: inline base64 for small files, or a
 * GCS reference (pre-uploaded to fire-pdf's input bucket) for large ones.
 * By-reference submits require a positive `pages_estimate` — fire-pdf has
 * no bytes to probe at admission time. */
type FirePdfSubmitInput =
  | { kind: "inline"; base64Content: string }
  | { kind: "byReference"; gcsUri: string; sha256: string };

type SubmitArgs = {
  meta: Meta;
  baseUrl: string;
  input: FirePdfSubmitInput;
  maxPages: number | undefined;
  pagesProcessed: number | undefined;
  mode: PDFMode | undefined;
  includePageMarkdown: boolean;
  includeBlocks: boolean;
  pageMarkers: boolean;
  deadlineAt: string;
  /** Team's sold concurrency from the ACUC (ENG-5049 account context).
   * Optional: entitlement lookup must never block or fail a scrape. */
  teamConcurrency: number | undefined;
  fetchImpl: typeof undiciFetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/**
 * The submit request may have reached FirePDF even though Firecrawl could not
 * observe a valid success response. The caller should best-effort DELETE the
 * idempotent scrape_id before falling back, then rethrow `originalError`.
 */
export class SubmitJobMayHaveBeenAcceptedError extends Error {
  constructor(public readonly originalError: unknown) {
    super("FirePDF submit may have been accepted");
    this.name = "SubmitJobMayHaveBeenAcceptedError";
  }
}

/**
 * A 503 is retryable when it did not come from a fire-pdf handler: the
 * handlers answer with one of their documented codes
 * (firePdfSubmit503BodySchema), so a 503 carrying anything else was produced
 * in front of them — Fastify's shutdown reply on a terminating instance, or a
 * proxy — and the request was never processed. Returns the retry trigger, or
 * null for a real fire-pdf 503 (admission and storage failures keep their
 * existing handling).
 */
export function classifyTransient503(
  status: number,
  body: unknown,
): Extract<SubmitRetryTrigger, `http_503_${string}`> | null {
  if (status !== 503) return null;
  if (firePdfSubmit503BodySchema.safeParse(body).success) return null;
  return fastifyClosingBodySchema.safeParse(body).success
    ? "http_503_closing"
    : "http_503_unattributed";
}

function failPossiblyAccepted(
  meta: Meta,
  reason: Parameters<typeof failAsync>[1],
  extra: Record<string, unknown> = {},
): never {
  try {
    failAsync(meta, reason, extra);
  } catch (error) {
    throw new SubmitJobMayHaveBeenAcceptedError(error);
  }
}

export async function submitJob(args: SubmitArgs): Promise<SubmitOutcome> {
  const {
    meta,
    baseUrl,
    input,
    maxPages,
    pagesProcessed,
    mode,
    includePageMarkdown,
    includeBlocks,
    pageMarkers,
    deadlineAt,
    teamConcurrency,
    fetchImpl,
  } = args;
  const scrapeId = meta.id;

  if (
    input.kind === "byReference" &&
    (pagesProcessed === undefined || pagesProcessed <= 0)
  ) {
    // fire-pdf rejects by-reference submits without a positive
    // pages_estimate (400 missing_pages_estimate); fail here with the
    // clearer local error instead of a wire round-trip.
    throw new Error(
      "fire-pdf by-reference submit requires a positive pages estimate",
    );
  }

  const body = {
    ...(input.kind === "inline"
      ? { pdf_b64: input.base64Content }
      : { input_gcs_uri: input.gcsUri, input_sha256: input.sha256 }),
    scrape_id: scrapeId,
    source: "firecrawl" as const,
    zdr: false as const,
    deadline_at: deadlineAt,
    ...(meta.internalOptions.teamId && {
      team_id: meta.internalOptions.teamId,
    }),
    ...(meta.internalOptions.crawlId && {
      crawl_id: meta.internalOptions.crawlId,
    }),
    // FirePDF per-team admission observation (its ENG-5049): sold
    // concurrency from the account context. Absence means FirePDF
    // skips team observation for this submit — never a rejection.
    ...(teamConcurrency !== undefined && {
      team_concurrency: teamConcurrency,
    }),
    // Shared with the POST /jobs/lookup adoption client — the two must
    // build identical options or adoption never matches this job.
    options: buildFirePdfJobOptions({
      maxPages,
      pagesProcessed,
      mode,
      includePageMarkdown,
      includeBlocks,
      pageMarkers,
    }),
  };

  // The retry does reach a different instance: Fastify's shutdown 503
  // arrives with `Connection: close`, and a transport failure leaves a dead
  // socket, so undici cannot reuse either connection — the next request
  // opens a new one, which the Service routes to a pod still in its
  // endpoints. The short pause lets endpoint updates propagate.
  const sleep = args.sleep ?? defaultSleep;
  const retryAfterTransient = async (
    trigger: SubmitRetryTrigger,
    extra: Record<string, unknown>,
  ) => {
    firePdfAsyncSubmitRetriesTotal.labels(trigger).inc();
    meta.logger.info("FirePDF async POST /jobs retrying once", {
      scrapeId,
      event: "fire_pdf_async_submit_retry",
      trigger,
      ...extra,
    });
    await sleep(SUBMIT_TRANSIENT_RETRY_DELAY_MS, meta.abort.asSignal());
  };

  let status: number;
  let json: unknown;
  for (let attempt = 1; ; attempt++) {
    try {
      const resp = await fetchImpl(`${baseUrl}/jobs`, {
        method: "POST",
        headers: firePdfHeaders(true),
        body: JSON.stringify(body),
        signal: meta.abort.asSignal(),
      });
      status = resp.status;
      json = await resp.json().catch(() => ({}));
    } catch (error) {
      if (error instanceof AbortManagerThrownError) {
        throw new SubmitJobMayHaveBeenAcceptedError(error);
      }
      if (attempt === 1) {
        // The request may have landed (idempotent replay makes the retry
        // safe either way); an abort during the pause keeps that ambiguity.
        try {
          await retryAfterTransient("transport_error", {
            error: String(error),
          });
        } catch (pauseError) {
          throw new SubmitJobMayHaveBeenAcceptedError(pauseError);
        }
        continue;
      }
      failPossiblyAccepted(meta, "network_error", { error: String(error) });
    }
    const transient503 = attempt === 1 && classifyTransient503(status, json);
    if (transient503) {
      await retryAfterTransient(transient503, { body: json });
      continue;
    }
    break;
  }

  if (status === 401) failAsync(meta, "http_401");
  if (status === 404) failAsync(meta, "http_404");
  if (status === 410) failAsync(meta, "http_410", { body: json });
  if (status === 413) failAsync(meta, "http_413");
  if (status === 429) failAsync(meta, "http_429");
  if (status === 502) failAsync(meta, "http_502", { body: json });
  if (status === 503) failAsync(meta, "http_503");

  if (status === 409) {
    meta.logger.error(
      "FirePDF async POST /jobs returned 409 scrape_id_conflict",
      {
        scrapeId,
        body: json,
      },
    );
    throw new Error(
      "fire-pdf async POST /jobs conflict: scrape_id reused with different inputs",
    );
  }

  if (status === 400) {
    meta.logger.error(
      "FirePDF async POST /jobs returned 400 validation error",
      {
        scrapeId,
        body: json,
      },
    );
    throw new Error("fire-pdf async POST /jobs validation error");
  }

  if (status !== 200 && status !== 202) {
    failAsync(meta, "http_5xx", { status, body: json });
  }

  const parsed = submitResponseSchema.safeParse(json);
  if (!parsed.success) {
    // A 2xx response means the server accepted this scrape_id even when the
    // response body is incompatible. Mark it cancellation-worthy before
    // surfacing the existing fallback reason.
    failPossiblyAccepted(meta, "http_5xx", {
      error: String(parsed.error),
      body: json,
      status,
    });
  }

  firePdfAsyncSubmittedTotal.labels(parsed.data.lane ?? "unknown").inc();
  meta.logger.info("FirePDF async POST /jobs accepted", {
    scrapeId,
    status: parsed.data.status,
    httpStatus: status,
    lane: parsed.data.lane,
    deadlineAt,
  });

  return {
    lane: parsed.data.lane,
    retryAfterMs: parsed.data.retry_after_ms,
    alreadyDone: status === 200 && parsed.data.status === "done",
  };
}
