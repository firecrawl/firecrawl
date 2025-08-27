import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from "axios";
import { getVersion } from "./getVersion";

export interface HttpClientOptions {
  apiKey: string;
  apiUrl: string;
  timeoutMs?: number;
  maxRetries?: number;
  backoffFactor?: number; // seconds factor for 0.5, 1, 2...
}

export class HttpClient {
  private instance: AxiosInstance;
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly maxRetries: number;
  private readonly backoffFactor: number;

  constructor(options: HttpClientOptions) {
    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
    this.maxRetries = options.maxRetries ?? 3;
    this.backoffFactor = options.backoffFactor ?? 0.5;
    this.instance = axios.create({
      baseURL: this.apiUrl,
      timeout: options.timeoutMs ?? 60000,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      transitional: { clarifyTimeoutError: true },
    });
  }

  getApiUrl(): string {
    return this.apiUrl;
  }

  getApiKey(): string {
    return this.apiKey;
  }

  private async request<T = any>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    const version = getVersion();
    config.headers = {
      ...(config.headers || {}),
    };

    let lastError: any;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const cfg: AxiosRequestConfig = { ...config };
        // For POST/PUT, ensure origin is present in JSON body too
        if (cfg.method && ["post", "put", "patch"].includes(cfg.method.toLowerCase())) {
          const data = (cfg.data ?? {}) as Record<string, unknown>;
          cfg.data = { ...data, origin: `js-sdk@${version}` };
        }
        const res = await this.instance.request<T>(cfg);
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

  private sleep(seconds: number): Promise<void> {
    return new Promise((r) => setTimeout(r, seconds * 1000));
  }

  post<T = any>(endpoint: string, body: Record<string, unknown>, headers?: Record<string, string>) {
    return this.request<T>({ method: "post", url: endpoint, data: body, headers });
  }

  get<T = any>(endpoint: string, headers?: Record<string, string>) {
    return this.request<T>({ method: "get", url: endpoint, headers });
  }

  delete<T = any>(endpoint: string, headers?: Record<string, string>) {
    return this.request<T>({ method: "delete", url: endpoint, headers });
  }

  prepareHeaders(idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers["x-idempotency-key"] = idempotencyKey;
    return headers;
  }
}

