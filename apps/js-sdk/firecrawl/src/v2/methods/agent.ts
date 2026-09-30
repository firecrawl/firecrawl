import { type AgentEffort, type AgentExchangeOptions, type AgentListOptions, type AgentListResponse, type AgentMode, type AgentResponse, type AgentSnapshotResponse, type AgentStatusResponse, type AgentThreadResponse, type AgentTraceResponse, type AgentWebhookConfig, type AuditMetadata, type ThreatProtectionOptions } from "../types";
import { HttpClient } from "../utils/httpClient";
import { normalizeAxiosError, throwForBadResponse } from "../utils/errorHandler";
import { isZodSchema, zodSchemaToJsonSchema } from "../../utils/zodSchemaToJson";
import type { ZodTypeAny } from "zod";

function prepareAgentPayload(args: {
  urls?: string[];
  prompt: string;
  schema?: Record<string, unknown> | ZodTypeAny;
  integration?: string;
  origin?: string;
  maxCredits?: number;
  strictConstrainToURLs?: boolean;
  model?: "spark-1-pro" | "spark-1-mini" | "spark-2";
  effort?: AgentEffort;
  webhook?: string | AgentWebhookConfig;
  threatProtection?: ThreatProtectionOptions;
  auditMetadata?: AuditMetadata;
  threadId?: string;
  mode?: AgentMode;
  exchange?: AgentExchangeOptions;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.urls) body.urls = args.urls;
  body.prompt = args.prompt;
  if (args.schema != null) {
    body.schema = isZodSchema(args.schema) ? zodSchemaToJsonSchema(args.schema) : args.schema;
  }
  if (args.integration && args.integration.trim()) body.integration = args.integration.trim();
  if (args.origin) body.origin = args.origin;
  if (args.maxCredits !== null && args.maxCredits !== undefined) body.maxCredits = args.maxCredits;
  if (args.strictConstrainToURLs !== null && args.strictConstrainToURLs !== undefined) body.strictConstrainToURLs = args.strictConstrainToURLs;
  if (args.model !== null && args.model !== undefined) body.model = args.model;
  if (args.effort !== null && args.effort !== undefined) body.effort = args.effort;
  if (args.webhook != null) body.webhook = args.webhook;
  if (args.threatProtection != null)
    body.threatProtection = args.threatProtection;
  if (args.auditMetadata != null)
    body.auditMetadata = args.auditMetadata;
  if (args.threadId != null) body.threadId = args.threadId;
  if (args.mode != null) body.mode = args.mode;
  if (args.exchange != null) body.exchange = args.exchange;
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

export async function listAgents(http: HttpClient, options?: AgentListOptions): Promise<AgentListResponse> {
  try {
    const query = options?.before !== undefined ? `?before=${options.before}` : "";
    const res = await http.get<AgentListResponse>(`/v2/agent${query}`);
    if (res.status !== 200) throwForBadResponse(res, "list agents");
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "list agents");
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

export async function getAgentTrace(
  http: HttpClient,
  jobId: string,
  options?: { liveView?: boolean }
): Promise<AgentTraceResponse> {
  try {
    const query = options?.liveView ? "?liveView=true" : "";
    const res = await http.get<AgentTraceResponse>(`/v2/agent/${jobId}/trace${query}`);
    if (res.status !== 200) throwForBadResponse(res, "agent trace");
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "agent trace");
    throw err;
  }
}

export async function getAgentSnapshot(
  http: HttpClient,
  jobId: string,
  snapshotId: string
): Promise<AgentSnapshotResponse> {
  try {
    const res = await http.get<AgentSnapshotResponse>(`/v2/agent/${jobId}/snapshots/${snapshotId}`);
    if (res.status !== 200) throwForBadResponse(res, "agent snapshot");
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "agent snapshot");
    throw err;
  }
}

export async function getAgentThread(
  http: HttpClient,
  threadId: string,
  options?: { includeData?: boolean }
): Promise<AgentThreadResponse> {
  try {
    const query = options?.includeData ? "?includeData=true" : "";
    const res = await http.get<AgentThreadResponse>(`/v2/agent/threads/${threadId}${query}`);
    if (res.status !== 200) throwForBadResponse(res, "agent thread");
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "agent thread");
    throw err;
  }
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
