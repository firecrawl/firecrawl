import { type AxiosError, type AxiosResponse } from "axios";
import { SdkError, JobTimeoutError, parseRequiresAction } from "../types";
import { agentHintMetadata } from "./agentHints";

/** Names the fields a validation error rejected, so a bare "Bad Request" says what to change. */
function describeValidationIssues(details: unknown): string | undefined {
  if (!Array.isArray(details)) return undefined;
  const parts = details.slice(0, 3).flatMap((issue) => {
    if (!issue || typeof issue !== "object") return [];
    const { path, message, keys } = issue as { path?: unknown; message?: unknown; keys?: unknown };
    const what = Array.isArray(keys) && keys.length > 0
      ? `unrecognized key(s) ${keys.join(", ")}`
      : typeof message === "string" ? message : undefined;
    if (!what) return [];
    return Array.isArray(path) && path.length > 0 ? [`${path.join(".")}: ${what}`] : [what];
  });
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function withIssues(message: unknown, details: unknown): string {
  const text = typeof message === "string" ? message : JSON.stringify(message);
  const issues = describeValidationIssues(details);
  return issues && !text.includes(issues) ? `${text} (${issues})` : text;
}

export function throwForBadResponse(resp: AxiosResponse, action: string): never {
  const status = resp.status;
  const body = resp.data || {};
  const msg = body?.error || body?.message || `Request failed (${status}) while trying to ${action}`;
  throw Object.assign(new SdkError(
    withIssues(msg, body?.details),
    status,
    body?.code,
    body?.details,
    undefined,
    body?.chargeId,
    parseRequiresAction(body?.requiresAction),
  ), agentHintMetadata(body));
}

export function normalizeAxiosError(err: AxiosError, action: string): never {
  const status = err.response?.status;
  const body: any = err.response?.data;
  const message = body?.error || err.message || `Request failed${status ? ` (${status})` : ""} while trying to ${action}`;
  const code = (body?.code as string) || err.code;
  throw Object.assign(new SdkError(
    withIssues(message, body?.details),
    status,
    code,
    body?.details ?? body,
    undefined,
    body?.chargeId,
    parseRequiresAction(body?.requiresAction),
  ), agentHintMetadata(body));
}

export function isRetryableError(err: any): boolean {
  // JobTimeoutError should never be retried - it's the overall timeout
  if (err instanceof JobTimeoutError) {
    return false;
  }
  
  // If it's an SdkError with a status code, check if it's retryable
  if (err instanceof SdkError || (err && typeof err === 'object' && 'status' in err)) {
    const status = err.status;
    // 4xx errors are client errors and shouldn't be retried
    if (status && status >= 400 && status < 500) {
      return false; // Don't retry client errors (401, 404, etc.)
    }
    // 5xx errors are server errors and can be retried
    if (status && status >= 500) {
      return true;
    }
  }
  
  // Network errors (no response) are retryable
  if (err?.isAxiosError && !err.response) {
    return true;
  }
  
  // HTTP timeout errors are retryable (different from JobTimeoutError)
  if (err?.code === 'ECONNABORTED' || err?.message?.includes('timeout')) {
    return true;
  }
  
  // Default: retry on unknown errors (safer than not retrying)
  return true;
}
