import { type ExtractResponse, type ScrapeOptions } from "../types";
import { HttpClient } from "../utils/httpClient";
import { ensureValidScrapeOptions } from "../utils/validation";
import { normalizeAxiosError, throwForBadResponse } from "../utils/errorHandler";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";

function prepareExtractPayload(args: {
  urls?: string[];
  prompt?: string;
  schema?: Record<string, unknown> | ZodTypeAny;
  systemPrompt?: string;
  allowExternalLinks?: boolean;
  enableWebSearch?: boolean;
  showSources?: boolean;
  scrapeOptions?: ScrapeOptions;
  ignoreInvalidURLs?: boolean;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.urls) body.urls = args.urls;
  if (args.prompt != null) body.prompt = args.prompt;
  if (args.schema != null) {
    const s: any = args.schema;
    const isZod = s && (typeof s.safeParse === "function" || typeof s.parse === "function") && s._def;
    body.schema = isZod ? zodToJsonSchema(s) : args.schema;
  }
  if (args.systemPrompt != null) body.systemPrompt = args.systemPrompt;
  if (args.allowExternalLinks != null) body.allowExternalLinks = args.allowExternalLinks;
  if (args.enableWebSearch != null) body.enableWebSearch = args.enableWebSearch;
  if (args.showSources != null) body.showSources = args.showSources;
  if (args.ignoreInvalidURLs != null) body.ignoreInvalidURLs = args.ignoreInvalidURLs;
  if (args.scrapeOptions) {
    ensureValidScrapeOptions(args.scrapeOptions);
    body.scrapeOptions = args.scrapeOptions;
  }
  return body;
}

export async function startExtract(http: HttpClient, args: Parameters<typeof prepareExtractPayload>[0]): Promise<ExtractResponse> {
  const payload = prepareExtractPayload(args);
  try {
    const res = await http.post<ExtractResponse>("/v2/extract", payload);
    if (res.status !== 200) throwForBadResponse(res, "extract");
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "extract");
    throw err;
  }
}

export async function getExtractStatus(http: HttpClient, jobId: string): Promise<ExtractResponse> {
  try {
    const res = await http.get<ExtractResponse>(`/v2/extract/${jobId}`);
    if (res.status !== 200) throwForBadResponse(res, "extract status");
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "extract status");
    throw err;
  }
}

export async function waitExtract(
  http: HttpClient,
  jobId: string,
  pollInterval = 2,
  timeout?: number
): Promise<ExtractResponse> {
  const start = Date.now();
  while (true) {
    const status = await getExtractStatus(http, jobId);
    if (["completed", "failed", "cancelled"].includes(status.status || "")) return status;
    if (timeout != null && Date.now() - start > timeout * 1000) return status;
    await new Promise((r) => setTimeout(r, Math.max(1000, pollInterval * 1000)));
  }
}

export async function extract(
  http: HttpClient,
  args: Parameters<typeof prepareExtractPayload>[0] & { pollInterval?: number; timeout?: number }
): Promise<ExtractResponse> {
  const started = await startExtract(http, args);
  const jobId = started.id;
  if (!jobId) return started;
  return waitExtract(http, jobId, args.pollInterval ?? 2, args.timeout);
}

