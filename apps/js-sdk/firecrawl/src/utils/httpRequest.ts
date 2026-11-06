import type { Dispatcher } from "undici";
import { version } from "../../package.json";

// Node's fetch caps headers and body at 300 s and ignores HTTP(S)_PROXY; AbortSignal.timeout owns the deadline.
async function createNodeDispatcher(): Promise<Dispatcher | undefined> {
  if (typeof process === "undefined" || !process.versions?.node) return undefined;
  // Loaded lazily and mapped to false in package.json "browser" so browser bundles never pull in undici.
  const { Agent, EnvHttpProxyAgent } = await import("undici");
  const { HTTP_PROXY, http_proxy, HTTPS_PROXY, https_proxy } = process.env;
  const options = { headersTimeout: 0, bodyTimeout: 0 };
  // EnvHttpProxyAgent logs an experimental warning on construction, so only proxy users pay for it.
  return HTTP_PROXY || http_proxy || HTTPS_PROXY || https_proxy ? new EnvHttpProxyAgent(options) : new Agent(options);
}

let nodeDispatcher: Promise<Dispatcher | undefined> | undefined;

export interface HttpResponse<T = any> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

/** Thrown for non-2xx responses (with `response`) and for network or timeout failures (without). */
export class HttpError extends Error {
  readonly isHttpError = true;

  constructor(
    message: string,
    readonly code?: string,
    readonly response?: HttpResponse,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

interface HttpRequestOptions {
  method: string;
  headers?: Record<string, string>;
  /** FormData is sent as multipart; anything else is sent as JSON. */
  body?: unknown;
  timeoutMs?: number;
}

function transportError(err: any, timeoutMs?: number): HttpError {
  if (err?.name === "TimeoutError" && timeoutMs !== undefined) {
    return new HttpError(`timeout of ${timeoutMs}ms exceeded`, "ETIMEDOUT");
  }
  const cause = err?.cause;
  const code = cause?.code === "UND_ERR_SOCKET" ? "ECONNRESET" : cause?.code;
  return new HttpError(cause?.message || err?.message || "Network Error", code ?? "ERR_NETWORK");
}

/** `fetch` that rejects on non-2xx and parses JSON bodies, falling back to text. */
export async function httpRequest<T = any>(
  url: string,
  { method, headers = {}, body, timeoutMs }: HttpRequestOptions,
): Promise<HttpResponse<T>> {
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  const hasBody = body !== undefined && body !== null;
  const requestHeaders = new Headers({
    Accept: "application/json, text/plain, */*",
    "User-Agent": `firecrawl-js/${version}`,
    ...(hasBody && !isForm ? { "Content-Type": "application/json" } : {}),
  });
  for (const [name, value] of Object.entries(headers)) requestHeaders.set(name, value);
  const init: RequestInit & { dispatcher?: Dispatcher } = {
    method: method.toUpperCase(),
    headers: requestHeaders,
    body: !hasBody ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    dispatcher: await (nodeDispatcher ??= createNodeDispatcher()),
  };
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, init);
    text = await res.text();
  } catch (err) {
    throw transportError(err, timeoutMs);
  }

  let data: any = text;
  try {
    if (text) data = JSON.parse(text);
  } catch {
    // Not JSON: keep the raw text.
  }
  const response: HttpResponse<T> = {
    status: res.status,
    data,
    headers: Object.fromEntries(res.headers),
  };
  if (res.ok) return response;
  throw new HttpError(
    `Request failed with status code ${res.status}`,
    res.status >= 500 ? "ERR_BAD_RESPONSE" : res.status >= 400 ? "ERR_BAD_REQUEST" : undefined,
    response,
  );
}
