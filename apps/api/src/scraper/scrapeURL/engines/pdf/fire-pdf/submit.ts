import type { Meta } from "../../..";
import type { PDFMode } from "../../../../../controllers/v2/types";
import { fetch as undiciFetch } from "undici";
import { AbortManagerThrownError } from "../../../lib/abortManager";
import { firePdfAsyncSubmittedTotal } from "./metrics";
import { submitResponseSchema } from "./schema";
import { failAsync, firePdfHeaders } from "./utils";

type SubmitOutcome = {
  lane: string | undefined;
  retryAfterMs: number | undefined;
  alreadyDone: boolean;
};

type SubmitArgs = {
  meta: Meta;
  baseUrl: string;
  base64Content: string;
  maxPages: number | undefined;
  pagesProcessed: number | undefined;
  mode: PDFMode | undefined;
  deadlineAt: string;
  /** Team's sold concurrency from the ACUC (ENG-5049 account context).
   * Optional: entitlement lookup must never block or fail a scrape. */
  teamConcurrency: number | undefined;
  fetchImpl: typeof undiciFetch;
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
    base64Content,
    maxPages,
    pagesProcessed,
    mode,
    deadlineAt,
    teamConcurrency,
    fetchImpl,
  } = args;
  const scrapeId = meta.id;

  const body = {
    pdf_b64: base64Content,
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
    options: {
      ...(pagesProcessed !== undefined && { pages_estimate: pagesProcessed }),
      ...(maxPages !== undefined && { max_pages: maxPages }),
      ...(mode !== undefined && { mode }),
    },
  };

  let status: number;
  let json: unknown;
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
    failPossiblyAccepted(meta, "network_error", { error: String(error) });
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
