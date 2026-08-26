import {
  type Document,
  type ScrapeBrowserDeleteResponse,
  type ScrapeExecuteRequest,
  type ScrapeExecuteResponse,
  type ScrapeOptions,
} from "../types";
import { HttpClient } from "../utils/httpClient";
import { ensureValidScrapeOptions } from "../utils/validation";
import {
  throwForBadResponse,
  normalizeAxiosError,
} from "../utils/errorHandler";

/** Auto-resume bounds: a resume only ever follows the server's explicit
 * "processing continues" signal, and stops after this many resumes or
 * this much total sleeping — whichever comes first. */
const RESUME_MAX_ATTEMPTS = 5;
const RESUME_MAX_TOTAL_WAIT_MS = 20 * 60 * 1000;
const RESUME_MIN_DELAY_MS = 5 * 1000;
const RESUME_MAX_DELAY_MS = 10 * 60 * 1000;

/**
 * When a request failed because the document is still processing
 * server-side (large PDFs outlive their request window by design), the
 * error carries `details.state === "processing_continues"` plus a retry
 * delay. Returns that delay in ms, or undefined for every other error.
 */
export function processingContinuesDelayMs(err: unknown): number | undefined {
  const response = (err as { isAxiosError?: boolean; response?: any })
    ?.isAxiosError
    ? (err as { response?: any }).response
    : undefined;
  if (!response || response.status !== 408) return undefined;
  const body = response.data as
    | { code?: string; details?: { state?: string; retryAfterSeconds?: number } }
    | undefined;
  if (
    body?.code !== "SCRAPE_TIMEOUT" ||
    body?.details?.state !== "processing_continues"
  ) {
    return undefined;
  }
  const headerSeconds = Number(response.headers?.["retry-after"]);
  const seconds =
    typeof body.details.retryAfterSeconds === "number" &&
    Number.isFinite(body.details.retryAfterSeconds)
      ? body.details.retryAfterSeconds
      : Number.isFinite(headerSeconds)
        ? headerSeconds
        : 60;
  return Math.min(RESUME_MAX_DELAY_MS, Math.max(RESUME_MIN_DELAY_MS, seconds * 1000));
}

/**
 * Options for a direct scrape call. `autoResume` lives here — NOT on the
 * shared ScrapeOptions — because that type is reused verbatim inside
 * batch/crawl/search/extract payloads, where an SDK-only key would leak
 * onto the wire and fail strict endpoints.
 */
export type ScrapeCallOptions = ScrapeOptions & {
  /**
   * SDK-only (never sent to the API). Large documents (big PDFs) that
   * outlive the request window keep processing server-side; the API's
   * timeout error then carries `details.state === "processing_continues"`
   * and a Retry-After. When this is not `false`, the SDK sleeps that
   * long and re-issues the same request — the retry attaches to the
   * in-flight job and returns the finished result, so a large document
   * behaves like one slow successful call. Bounded (at most 5 resumes /
   * 20 minutes total wait); set `false` to surface the timeout error
   * immediately instead.
   */
  autoResume?: boolean;
};

export async function scrape(
  http: HttpClient,
  url: string,
  options?: ScrapeCallOptions,
  deps: { sleepImpl?: (ms: number) => Promise<void> } = {},
): Promise<Document> {
  const sleep =
    deps.sleepImpl ??
    ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  if (!url || !url.trim()) {
    throw new Error("URL cannot be empty");
  }
  if (options) ensureValidScrapeOptions(options);

  // autoResume is SDK behavior, never part of the wire payload.
  const { autoResume, ...requestOptions } = options ?? {};
  const payload: Record<string, unknown> = { url: url.trim() };
  Object.assign(payload, requestOptions);

  let resumes = 0;
  let resumeWaitedMs = 0;
  while (true) {
    try {
      const res = await http.post<{
        success: boolean;
        data?: Document;
        error?: string;
      }>(
        "/v2/scrape",
        payload,
        // The client-side timeout must outlast the server's own wall
        // (which equals options.timeout, or the API's 5-minute default),
        // otherwise axios can abort in a photo-finish with the server's
        // processing_continues response and the resume signal is lost
        // exactly when it matters.
        { timeoutMs: (typeof options?.timeout === "number" ? options.timeout : 300_000) + 30_000 },
      );
      if (res.status !== 200 || !res.data?.success) {
        throwForBadResponse(res, "scrape");
      }
      return (res.data.data || {}) as Document;
    } catch (err: any) {
      const delayMs = autoResume !== false ? processingContinuesDelayMs(err) : undefined;
      if (
        delayMs !== undefined &&
        resumes < RESUME_MAX_ATTEMPTS &&
        resumeWaitedMs + delayMs <= RESUME_MAX_TOTAL_WAIT_MS
      ) {
        // The document keeps processing server-side; the retry attaches
        // to the same in-flight job (content adoption) and returns the
        // finished result instead of restarting the work.
        resumes += 1;
        resumeWaitedMs += delayMs;
        await sleep(delayMs);
        continue;
      }
      if (err?.isAxiosError) return normalizeAxiosError(err, "scrape");
      throw err;
    }
  }
}

export async function interact(
  http: HttpClient,
  jobId: string,
  args: ScrapeExecuteRequest,
): Promise<ScrapeExecuteResponse> {
  if (!jobId || !jobId.trim()) {
    throw new Error("Job ID cannot be empty");
  }
  const hasCode = args?.code && args.code.trim();
  const hasPrompt = args?.prompt && args.prompt.trim();
  if (!hasCode && !hasPrompt) {
    throw new Error("Either 'code' or 'prompt' must be provided");
  }

  const body: Record<string, unknown> = {};
  if (hasCode) body.code = args.code;
  if (hasPrompt) body.prompt = args.prompt;
  body.language = args.language ?? "node";
  if (args.timeout != null) body.timeout = args.timeout;
  if (args.origin) body.origin = args.origin;

  try {
    const res = await http.post<ScrapeExecuteResponse>(
      `/v2/scrape/${jobId}/interact`,
      body,
      args.timeout != null ? { timeoutMs: args.timeout * 1000 + 5000 } : {},
    );
    if (res.status !== 200)
      throwForBadResponse(res, "interact with scrape browser");
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError)
      return normalizeAxiosError(err, "interact with scrape browser");
    throw err;
  }
}

export async function stopInteraction(
  http: HttpClient,
  jobId: string,
): Promise<ScrapeBrowserDeleteResponse> {
  if (!jobId || !jobId.trim()) {
    throw new Error("Job ID cannot be empty");
  }

  try {
    const res = await http.delete<ScrapeBrowserDeleteResponse>(
      `/v2/scrape/${jobId}/interact`,
    );
    if (res.status !== 200) throwForBadResponse(res, "stop interaction");
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "stop interaction");
    throw err;
  }
}

/** @deprecated Use interact(). */
export async function scrapeExecute(
  http: HttpClient,
  jobId: string,
  args: ScrapeExecuteRequest,
): Promise<ScrapeExecuteResponse> {
  return interact(http, jobId, args);
}

/** @deprecated Use stopInteraction(). */
export async function stopInteractiveBrowser(
  http: HttpClient,
  jobId: string,
): Promise<ScrapeBrowserDeleteResponse> {
  return stopInteraction(http, jobId);
}

/** @deprecated Use stopInteraction(). */
export async function deleteScrapeBrowser(
  http: HttpClient,
  jobId: string,
): Promise<ScrapeBrowserDeleteResponse> {
  return stopInteraction(http, jobId);
}
