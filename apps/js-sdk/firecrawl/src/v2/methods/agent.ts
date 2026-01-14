import { type AgentResponse, type AgentStatusResponse, type AgentWebhookConfig } from "../types";
import { HttpClient } from "../utils/httpClient";
import { normalizeAxiosError, throwForBadResponse } from "../utils/errorHandler";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";

function prepareAgentPayload(args: {
  urls?: string[];
  prompt: string;
  schema?: Record<string, unknown> | ZodTypeAny;
  integration?: string;
  maxCredits?: number;
  strictConstrainToURLs?: boolean;
  webhook?: string | AgentWebhookConfig;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.urls) body.urls = args.urls;
  body.prompt = args.prompt;
  if (args.schema != null) {
    const s: any = args.schema;
    const isZod = s && (typeof s.safeParse === "function" || typeof s.parse === "function") && s._def;
    body.schema = isZod ? zodToJsonSchema(s) : args.schema;
  }
  if (args.integration && args.integration.trim()) body.integration = args.integration.trim();
  if (args.maxCredits !== null && args.maxCredits !== undefined) body.maxCredits = args.maxCredits;
  if (args.strictConstrainToURLs !== null && args.strictConstrainToURLs !== undefined) body.strictConstrainToURLs = args.strictConstrainToURLs;
  if (args.webhook !== null && args.webhook !== undefined) body.webhook = args.webhook;
  return body;
}

export async function startAgent(http: HttpClient, args: Parameters<typeof prepareAgentPayload>[0]): Promise<AgentResponse> {
  const payload = prepareAgentPayload(args);
  try {
    const res = await http.post<AgentResponse>("/v2/agent", payload);
    if (res.status !== 200) throwForBadResponse(res, "agent");
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "agent");
    throw err;
  }
}

export async function getAgentStatus(http: HttpClient, jobId: string): Promise<AgentStatusResponse> {
  try {
    const res = await http.get<AgentStatusResponse>(`/v2/agent/${jobId}`);
    if (res.status !== 200) throwForBadResponse(res, "agent status");
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "agent status");
    throw err;
  }
}

export async function waitAgent(
  http: HttpClient,
  jobId: string,
  pollInterval = 2,
  timeout?: number
): Promise<AgentStatusResponse> {
  const start = Date.now();
  while (true) {
    const status = await getAgentStatus(http, jobId);
    if (["completed", "failed", "cancelled"].includes(status.status || "")) return status;
    if (timeout != null && Date.now() - start > timeout * 1000) return status;
    await new Promise((r) => setTimeout(r, Math.max(1000, pollInterval * 1000)));
  }
}

export async function agent(
  http: HttpClient,
  args: Parameters<typeof prepareAgentPayload>[0] & { pollInterval?: number; timeout?: number }
): Promise<AgentStatusResponse> {
  const started = await startAgent(http, args);
  const jobId = started.id;
  if (!jobId) return started as unknown as AgentStatusResponse;
  return waitAgent(http, jobId, args.pollInterval ?? 2, args.timeout);
}

export async function cancelAgent(http: HttpClient, jobId: string): Promise<boolean> {
  try {
    const res = await http.delete<{ success: boolean }>(`/v2/agent/${jobId}`);
    if (res.status !== 200) throwForBadResponse(res, "cancel agent");
    return res.data?.success === true;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "cancel agent");
    throw err;
  }
}
