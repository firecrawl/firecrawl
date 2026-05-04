import {
  type CreateMonitorRequest,
  type ListMonitorsOptions,
  type ListMonitorChecksOptions,
  type Monitor,
  type MonitorCheck,
  type MonitorCheckDetail,
  type UpdateMonitorRequest,
} from "../types";
import { HttpClient } from "../utils/httpClient";
import {
  throwForBadResponse,
  normalizeAxiosError,
} from "../utils/errorHandler";

type ApiResponse<T> = {
  success: boolean;
  data?: T;
  id?: string;
  error?: string;
};

function queryString(params?: Record<string, unknown>): string {
  if (!params) return "";
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  const str = query.toString();
  return str ? `?${str}` : "";
}

function dataOrThrow<T>(res: { status: number; data?: ApiResponse<T> }, action: string): T {
  if (res.status !== 200 || !res.data?.success || res.data.data == null) {
    throwForBadResponse(res as any, action);
  }
  return res.data.data;
}

export async function createMonitor(
  http: HttpClient,
  request: CreateMonitorRequest,
): Promise<Monitor> {
  try {
    const res = await http.post<ApiResponse<Monitor>>("/v2/monitor", request as any);
    return dataOrThrow(res, "create monitor");
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "create monitor");
    throw err;
  }
}

export async function listMonitors(
  http: HttpClient,
  options?: ListMonitorsOptions,
): Promise<Monitor[]> {
  try {
    const res = await http.get<ApiResponse<Monitor[]>>(
      `/v2/monitor${queryString(options as Record<string, unknown>)}`,
    );
    return dataOrThrow(res, "list monitors");
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "list monitors");
    throw err;
  }
}

export async function getMonitor(
  http: HttpClient,
  monitorId: string,
): Promise<Monitor> {
  try {
    const res = await http.get<ApiResponse<Monitor>>(`/v2/monitor/${monitorId}`);
    return dataOrThrow(res, "get monitor");
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "get monitor");
    throw err;
  }
}

export async function updateMonitor(
  http: HttpClient,
  monitorId: string,
  request: UpdateMonitorRequest,
): Promise<Monitor> {
  try {
    const res = await http.patch<ApiResponse<Monitor>>(
      `/v2/monitor/${monitorId}`,
      request as any,
    );
    return dataOrThrow(res, "update monitor");
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "update monitor");
    throw err;
  }
}

export async function deleteMonitor(
  http: HttpClient,
  monitorId: string,
): Promise<boolean> {
  try {
    const res = await http.delete<ApiResponse<unknown>>(`/v2/monitor/${monitorId}`);
    if (res.status !== 200 || !res.data?.success) {
      throwForBadResponse(res, "delete monitor");
    }
    return true;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "delete monitor");
    throw err;
  }
}

export async function runMonitor(
  http: HttpClient,
  monitorId: string,
): Promise<MonitorCheck> {
  try {
    const res = await http.post<ApiResponse<MonitorCheck>>(
      `/v2/monitor/${monitorId}/run`,
      {},
    );
    return dataOrThrow(res, "run monitor");
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "run monitor");
    throw err;
  }
}

export async function listMonitorChecks(
  http: HttpClient,
  monitorId: string,
  options?: ListMonitorChecksOptions,
): Promise<MonitorCheck[]> {
  try {
    const res = await http.get<ApiResponse<MonitorCheck[]>>(
      `/v2/monitor/${monitorId}/checks${queryString(options as Record<string, unknown>)}`,
    );
    return dataOrThrow(res, "list monitor checks");
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "list monitor checks");
    throw err;
  }
}

export async function getMonitorCheck(
  http: HttpClient,
  monitorId: string,
  checkId: string,
  options?: ListMonitorChecksOptions & { status?: MonitorCheckDetail["pages"][number]["status"] },
): Promise<MonitorCheckDetail> {
  try {
    const res = await http.get<ApiResponse<MonitorCheckDetail>>(
      `/v2/monitor/${monitorId}/checks/${checkId}${queryString(options as Record<string, unknown>)}`,
    );
    return dataOrThrow(res, "get monitor check");
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "get monitor check");
    throw err;
  }
}
