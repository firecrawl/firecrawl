import { getVersion } from "./getVersion";
import { pinToApiOrigin } from "../../utils/apiOrigin";
import { httpRequest, type HttpResponse } from "../../utils/httpRequest";

interface RequestConfig {
  method: string;
  url: string;
  data?: unknown;
  headers?: Record<string, string>;
  timeout?: number;
}

export interface HttpClientOptions {
  apiKey: string;
  apiUrl: string;
  timeoutMs?: number;
  maxRetries?: number;
  backoffFactor?: number; // seconds factor for 0.5, 1, 2...
  origin?: string;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class HttpClient {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly maxRetries: number;
  private readonly backoffFactor: number;
  private readonly origin: string;
  private readonly timeoutMs: number;

  constructor(options: HttpClientOptions) {
    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
    this.maxRetries = options.maxRetries ?? 3;
    this.backoffFactor = options.backoffFactor ?? 0.5;
    this.origin = options.origin || `js-sdk@${getVersion()}`;
    this.timeoutMs = options.timeoutMs ?? 300000;
  }

  getApiUrl(): string {
    return this.apiUrl;
  }

  getApiKey(): string {
    return this.apiKey;
  }

  /** The attribution origin stamped into requests that do not set their own. */
  getOrigin(): string {
    return this.origin;
  }

  /** The client-wide default request timeout, for callers that need to
   * extend a specific request beyond it (e.g. scrape auto-resume). */
  getTimeoutMs(): number {
    return this.timeoutMs;
  }

  private async request<T = any>(
    config: RequestConfig,
  ): Promise<HttpResponse<T>> {
    config.headers = {
      ...(config.headers || {}),
    };
    if (config.url) config.url = pinToApiOrigin(this.apiUrl, config.url);

    let lastError: any;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const cfg: RequestConfig = { ...config };
        const isFormDataBody =
          typeof FormData !== "undefined" && cfg.data instanceof FormData;
        const isPlainObjectBody =
          !isFormDataBody &&
          cfg.data != null &&
          typeof cfg.data === "object" &&
          !Array.isArray(cfg.data);

        // For JSON POST/PUT/PATCH, ensure origin is present in body
        if (
          isPlainObjectBody &&
          cfg.method &&
          ["post", "put", "patch"].includes(cfg.method.toLowerCase())
        ) {
          const data = (cfg.data ?? {}) as Record<string, unknown>;
          cfg.data = {
            ...data,
            origin:
              typeof data.origin === "string" && data.origin
                ? data.origin
                : this.origin,
          };
        }

        if (isFormDataBody) {
          cfg.headers = { ...(cfg.headers || {}) };
          delete (cfg.headers as Record<string, unknown>)["Content-Type"];
          delete (cfg.headers as Record<string, unknown>)["content-type"];
        }

        const res = await httpRequest<T>(this.resolveUrl(cfg.url), {
          method: cfg.method,
          headers: {
            // Omit the Authorization header entirely when no API key is set so that
            // scrape/search/interact can use the keyless free tier (the cloud only
            // grants it when no Authorization header is present).
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
            ...cfg.headers,
          },
          body: cfg.data,
          timeoutMs: cfg.timeout ?? this.timeoutMs,
        });
        if (res.status === 502 && attempt < this.maxRetries - 1) {
          await this.sleep(this.backoffFactor * Math.pow(2, attempt));
          continue;
        }
        return res;
      } catch (err: any) {
        lastError = err;
        const status = err?.response?.status;
        if (status === 502 && attempt < this.maxRetries - 1) {
          await this.sleep(this.backoffFactor * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }
    }
    throw lastError ?? new Error("Unexpected HTTP client error");
  }

  private resolveUrl(url: string): string {
    return /^([a-z][a-z\d+\-.]*:)?\/\//i.test(url) ? url : `${this.apiUrl}/${url.replace(/^\/+/, "")}`;
  }

  private sleep(seconds: number): Promise<void> {
    return new Promise(r => setTimeout(r, seconds * 1000));
  }

  post<T = any>(
    endpoint: string,
    body: Record<string, unknown>,
    options?: RequestOptions,
  ) {
    return this.request<T>({
      method: "post",
      url: endpoint,
      data: body,
      headers: options?.headers,
      timeout: options?.timeoutMs,
    });
  }

  postMultipart<T = any>(
    endpoint: string,
    formData: FormData,
    options?: RequestOptions,
  ) {
    return this.request<T>({
      method: "post",
      url: endpoint,
      data: formData,
      headers: options?.headers,
      timeout: options?.timeoutMs,
    });
  }

  get<T = any>(endpoint: string, headers?: Record<string, string>) {
    return this.request<T>({ method: "get", url: endpoint, headers });
  }

  delete<T = any>(endpoint: string, headers?: Record<string, string>) {
    return this.request<T>({ method: "delete", url: endpoint, headers });
  }

  patch<T = any>(
    endpoint: string,
    body: Record<string, unknown>,
    options?: RequestOptions,
  ) {
    return this.request<T>({
      method: "patch",
      url: endpoint,
      data: body,
      headers: options?.headers,
      timeout: options?.timeoutMs,
    });
  }

  prepareHeaders(idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers["x-idempotency-key"] = idempotencyKey;
    return headers;
  }
}
