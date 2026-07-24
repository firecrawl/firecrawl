import { gzipSync } from "zlib";
import { randomUUID } from "crypto";
import {
  fetch as undiciFetch,
  ProxyAgent,
  type Dispatcher,
  type Response,
} from "undici";
import { config } from "../../config";
import type { AzureSentinelDestination, ScrapeActivityEvent } from "./types";
import { SiemDeliveryError } from "./types";

const MAX_COMPRESSED_BODY_BYTES = 1_000_000;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

type FetchImpl = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | Buffer;
    dispatcher?: Dispatcher;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface SenderDependencies {
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
  dispatcher?: Dispatcher;
  tokenUrl?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
let proxyDispatcher: ProxyAgent | undefined;
let proxyDispatcherUrl: string | undefined;

function getDispatcher(deps: SenderDependencies): Dispatcher | undefined {
  if (deps.dispatcher) return deps.dispatcher;
  if (!config.PARTNER_EGRESS_PROXY_URL) return undefined;
  if (
    !proxyDispatcher ||
    proxyDispatcherUrl !== config.PARTNER_EGRESS_PROXY_URL
  ) {
    proxyDispatcher = new ProxyAgent(config.PARTNER_EGRESS_PROXY_URL);
    proxyDispatcherUrl = config.PARTNER_EGRESS_PROXY_URL;
  }
  return proxyDispatcher;
}

function tokenCacheKey(destination: AzureSentinelDestination): string {
  return `${destination.tenantId}:${destination.clientId}`;
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

async function errorText(response: Response): Promise<string> {
  const text = await response.text();
  return text.slice(0, 2048) || response.statusText || "Request failed";
}

async function waitBeforeRetry(
  attempt: number,
  response: Response,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const delay =
    retryAfterMs(response) ?? Math.min(250 * 2 ** (attempt - 1), 2000);
  await sleep(delay);
}

function networkErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Network request failed";
}

async function getAccessToken(
  destination: AzureSentinelDestination,
  deps: SenderDependencies,
): Promise<string> {
  const cacheKey = tokenCacheKey(destination);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const fetchImpl = deps.fetchImpl ?? (undiciFetch as FetchImpl);
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const dispatcher = getDispatcher(deps);
  const tokenUrl =
    deps.tokenUrl ??
    config.SIEM_AUDIT_TOKEN_URL ??
    `https://login.microsoftonline.com/${encodeURIComponent(destination.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: destination.clientId,
    client_secret: destination.clientSecret,
    scope: "https://monitor.azure.com//.default",
    grant_type: "client_credentials",
  }).toString();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        dispatcher,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(Math.min(250 * 2 ** (attempt - 1), 2000));
        continue;
      }
      throw new SiemDeliveryError(
        "delivery_error",
        `Failed to obtain an Entra token: ${networkErrorMessage(error)}`,
      );
    }

    if (response.ok) {
      const payload = (await response.json()) as {
        access_token?: unknown;
        expires_in?: unknown;
      };
      if (typeof payload.access_token !== "string") {
        throw new SiemDeliveryError(
          "invalid_credentials",
          "Entra token response did not include an access token",
          response.status,
        );
      }
      const expiresIn =
        typeof payload.expires_in === "number" ? payload.expires_in : 3600;
      tokenCache.set(cacheKey, {
        token: payload.access_token,
        expiresAt: Date.now() + expiresIn * 1000,
      });
      return payload.access_token;
    }

    if (
      (response.status === 429 || response.status >= 500) &&
      attempt < MAX_ATTEMPTS
    ) {
      await waitBeforeRetry(attempt, response, sleep);
      continue;
    }

    const message = await errorText(response);
    if (
      response.status === 400 ||
      response.status === 401 ||
      response.status === 403
    ) {
      throw new SiemDeliveryError(
        "invalid_credentials",
        `Entra rejected the SIEM credentials: ${message}`,
        response.status,
      );
    }
    throw new SiemDeliveryError(
      response.status === 429 ? "rate_limited" : "delivery_error",
      `Failed to obtain an Entra token: ${message}`,
      response.status,
      retryAfterMs(response),
    );
  }

  throw new SiemDeliveryError(
    "delivery_error",
    "Failed to obtain an Entra token",
  );
}

export function buildCompressedBatches(
  events: ScrapeActivityEvent[],
  maxBytes = MAX_COMPRESSED_BODY_BYTES,
): Buffer[] {
  const batches: Buffer[] = [];
  let pending: ScrapeActivityEvent[] = [];

  for (const event of events) {
    const candidate = [...pending, event];
    const compressed = gzipSync(Buffer.from(JSON.stringify(candidate), "utf8"));
    if (compressed.byteLength <= maxBytes) {
      pending = candidate;
      continue;
    }

    if (pending.length === 0) {
      throw new SiemDeliveryError(
        "payload_too_large",
        `A single SIEM event exceeds the ${maxBytes}-byte compressed payload limit`,
      );
    }
    batches.push(gzipSync(Buffer.from(JSON.stringify(pending), "utf8")));
    pending = [event];
    const single = gzipSync(Buffer.from(JSON.stringify(pending), "utf8"));
    if (single.byteLength > maxBytes) {
      throw new SiemDeliveryError(
        "payload_too_large",
        `A single SIEM event exceeds the ${maxBytes}-byte compressed payload limit`,
      );
    }
  }

  if (pending.length > 0) {
    batches.push(gzipSync(Buffer.from(JSON.stringify(pending), "utf8")));
  }
  return batches;
}

async function sendBatch(
  destination: AzureSentinelDestination,
  token: string,
  body: Buffer,
  deps: SenderDependencies,
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? (undiciFetch as FetchImpl);
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const dispatcher = getDispatcher(deps);
  const url =
    `${destination.dceUrl.replace(/\/+$/, "")}/dataCollectionRules/` +
    `${encodeURIComponent(destination.dcrImmutableId)}/streams/` +
    `${encodeURIComponent(destination.streamName)}?api-version=2023-01-01`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-encoding": "gzip",
          "x-ms-client-request-id": randomUUID(),
        },
        body,
        dispatcher,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(Math.min(250 * 2 ** (attempt - 1), 2000));
        continue;
      }
      throw new SiemDeliveryError(
        "delivery_error",
        `Azure SIEM delivery failed: ${networkErrorMessage(error)}`,
      );
    }
    if (response.ok) return;

    if (
      (response.status === 429 || response.status >= 500) &&
      attempt < MAX_ATTEMPTS
    ) {
      await waitBeforeRetry(attempt, response, sleep);
      continue;
    }

    const message = await errorText(response);
    if (response.status >= 400 && response.status < 500) {
      throw new SiemDeliveryError(
        response.status === 401 || response.status === 403
          ? "invalid_credentials"
          : response.status === 429
            ? "rate_limited"
            : "schema_rejection",
        `Azure rejected the SIEM event batch: ${message}`,
        response.status,
        retryAfterMs(response),
      );
    }
    throw new SiemDeliveryError(
      "delivery_error",
      `Azure SIEM delivery failed: ${message}`,
      response.status,
    );
  }
}

export async function sendAzureSentinelEvents(
  destination: AzureSentinelDestination,
  events: ScrapeActivityEvent[],
  deps: SenderDependencies = {},
): Promise<void> {
  if (events.length === 0) return;
  const token = await getAccessToken(destination, deps);
  for (const body of buildCompressedBatches(events)) {
    await sendBatch(destination, token, body, deps);
  }
}

export function clearAzureTokenCache(): void {
  tokenCache.clear();
}
