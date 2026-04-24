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

export async function scrape(
  http: HttpClient,
  url: string,
  options?: ScrapeOptions,
): Promise<Document> {
  if (!url || !url.trim()) {
    throw new Error("URL cannot be empty");
  }
  if (options) ensureValidScrapeOptions(options);

  const payload: Record<string, unknown> = { url: url.trim() };
  if (options) Object.assign(payload, options);

  try {
    const res = await http.post<{
      success: boolean;
      data?: Document;
      error?: string;
    }>(
      "/v2/scrape",
      payload,
      typeof options?.timeout === "number"
        ? { timeoutMs: options.timeout + 5000 }
        : {},
    );
    if (res.status !== 200 || !res.data?.success) {
      throwForBadResponse(res, "scrape");
    }
    return (res.data.data || {}) as Document;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "scrape");
    throw err;
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
