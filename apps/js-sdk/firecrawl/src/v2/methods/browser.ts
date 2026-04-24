import type {
  BrowserCreateResponse,
  BrowserExecuteResponse,
  BrowserDeleteResponse,
  BrowserListResponse,
} from "../types";
import { HttpClient } from "../utils/httpClient";
import {
  normalizeAxiosError,
  throwForBadResponse,
} from "../utils/errorHandler";

export async function browser(
  http: HttpClient,
  args: {
    ttl?: number;
    activityTtl?: number;
    streamWebView?: boolean;
    profile?: {
      name: string;
      saveChanges?: boolean;
    };
    integration?: string;
    origin?: string;
  } = {},
): Promise<BrowserCreateResponse> {
  const body: Record<string, unknown> = {};
  if (args.ttl != null) body.ttl = args.ttl;
  if (args.activityTtl != null) body.activityTtl = args.activityTtl;
  if (args.streamWebView != null) body.streamWebView = args.streamWebView;
  if (args.profile != null) body.profile = args.profile;
  if (args.integration != null) body.integration = args.integration;
  if (args.origin) body.origin = args.origin;

  try {
    const res = await http.post<BrowserCreateResponse>("/v2/browser", body);
    if (res.status !== 200) throwForBadResponse(res, "create browser session");
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError)
      return normalizeAxiosError(err, "create browser session");
    throw err;
  }
}

export async function browserExecute(
  http: HttpClient,
  sessionId: string,
  args: {
    code: string;
    language?: "python" | "node" | "bash";
    timeout?: number;
  },
): Promise<BrowserExecuteResponse> {
  const body: Record<string, unknown> = {
    code: args.code,
    language: args.language ?? "bash",
  };
  if (args.timeout != null) body.timeout = args.timeout;

  try {
    const res = await http.post<BrowserExecuteResponse>(
      `/v2/browser/${sessionId}/execute`,
      body,
      args.timeout != null ? { timeoutMs: args.timeout * 1000 + 5000 } : {},
    );
    if (res.status !== 200) throwForBadResponse(res, "execute browser code");
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError)
      return normalizeAxiosError(err, "execute browser code");
    throw err;
  }
}

export async function deleteBrowser(
  http: HttpClient,
  sessionId: string,
): Promise<BrowserDeleteResponse> {
  try {
    const res = await http.delete<BrowserDeleteResponse>(
      `/v2/browser/${sessionId}`,
    );
    if (res.status !== 200) throwForBadResponse(res, "delete browser session");
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError)
      return normalizeAxiosError(err, "delete browser session");
    throw err;
  }
}

export async function listBrowsers(
  http: HttpClient,
  args: {
    status?: "active" | "destroyed";
  } = {},
): Promise<BrowserListResponse> {
  let endpoint = "/v2/browser";
  if (args.status) endpoint += `?status=${args.status}`;

  try {
    const res = await http.get<BrowserListResponse>(endpoint);
    if (res.status !== 200) throwForBadResponse(res, "list browser sessions");
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError)
      return normalizeAxiosError(err, "list browser sessions");
    throw err;
  }
}
