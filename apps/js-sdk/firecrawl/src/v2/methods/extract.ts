import { type ExtractResponse, type ScrapeOptions, type AgentOptions } from "../types";
import { HttpClient } from "../utils/httpClient";
import { ensureValidScrapeOptions } from "../utils/validation";
import { normalizeAxiosError, throwForBadResponse } from "../utils/errorHandler";
import { isZodSchema, zodSchemaToJsonSchema } from "../../utils/zodSchemaToJson";
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
  integration?: string;
  origin?: string;
  agent?: AgentOptions;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.urls) body.urls = args.urls;
  if (args.prompt != null) body.prompt = args.prompt;
  if (args.schema != null) {
    body.schema = isZodSchema(args.schema) ? zodSchemaToJsonSchema(args.schema) : args.schema;
  }
  if (args.systemPrompt != null) body.systemPrompt = args.systemPrompt;
  if (args.allowExternalLinks != null) body.allowExternalLinks = args.allowExternalLinks;
  if (args.enableWebSearch != null) body.enableWebSearch = args.enableWebSearch;
  if (args.showSources != null) body.showSources = args.showSources;
  if (args.ignoreInvalidURLs != null) body.ignoreInvalidURLs = args.ignoreInvalidURLs;
  if (args.integration && args.integration.trim()) body.integration = args.integration.trim();
  if (args.origin) body.origin = args.origin;
  if (args.agent) body.agent = args.agent;
  if (args.scrapeOptions) {
    ensureValidScrapeOptions(args.scrapeOptions);
    body.scrapeOptions = args.scrapeOptions;
  }
  return body;
}

/**
 * @deprecated The extract endpoint is in maintenance mode and its use is discouraged.
 * Review https://docs.firecrawl.dev/developer-guides/usage-guides/choosing-the-data-extractor to find a replacement.
 */
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

/**
 * @deprecated The extract endpoint is in maintenance mode and its use is discouraged.
 * Review https://docs.firecrawl.dev/developer-guides/usage-guides/choosing-the-data-extractor to find a replacement.
 */
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

/**
 * @deprecated The extract endpoint is in maintenance mode and its use is discouraged.
 * Review https://docs.firecrawl.dev/developer-guides/usage-guides/choosing-the-data-extractor to find a replacement.
 */
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

/**
 * @deprecated The extract endpoint is in maintenance mode and its use is discouraged.
 * Review https://docs.firecrawl.dev/developer-guides/usage-guides/choosing-the-data-extractor to find a replacement.
 */
export async function extract(
  http: HttpClient,
  args: Parameters<typeof prepareExtractPayload>[0] & { pollInterval?: number; timeout?: number }
): Promise<ExtractResponse> {
  const started = await startExtract(http, args);
  const jobId = started.id;
  if (!jobId) return started;
  return waitExtract(http, jobId, args.pollInterval ?? 2, args.timeout);
}

