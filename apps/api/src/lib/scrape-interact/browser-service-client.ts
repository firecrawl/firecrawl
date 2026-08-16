import { config } from "../../config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowserServiceCreateResponse {
  sessionId: string;
  cdpUrl: string;
  viewUrl: string;
  iframeUrl: string;
  interactiveIframeUrl: string;
  expiresAt: string;
}

export interface BrowserServiceExecResponse {
  stdout: string;
  result: string;
  stderr: string;
  exitCode: number;
  killed: boolean;
}

export interface BrowserServiceDeleteResponse {
  ok: boolean;
  sessionDurationMs: number;
  cleanupQueued: boolean;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class BrowserServiceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

function browserServiceHeaders(
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(extra ?? {}),
  };
  if (config.BROWSER_SERVICE_API_KEY) {
    headers["Authorization"] = `Bearer ${config.BROWSER_SERVICE_API_KEY}`;
  }
  return headers;
}

/**
 * Call the browser service and return parsed JSON.
 * Throws `BrowserServiceError` on non-2xx responses.
 */
export async function browserServiceRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${config.BROWSER_SERVICE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: browserServiceHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new BrowserServiceError(
      res.status,
      `Browser service ${method} ${path} failed (${res.status}): ${text}`,
    );
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/**
 * Call the browser service and return the raw response body as text
 * (used for HLS playlists). Throws `BrowserServiceError` on non-2xx.
 */
export async function browserServiceRequestText(
  method: string,
  path: string,
): Promise<{ body: string; contentType: string | null }> {
  const url = `${config.BROWSER_SERVICE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: browserServiceHeaders(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new BrowserServiceError(
      res.status,
      `Browser service ${method} ${path} failed (${res.status}): ${text}`,
    );
  }

  return {
    body: await res.text(),
    contentType: res.headers.get("content-type"),
  };
}
