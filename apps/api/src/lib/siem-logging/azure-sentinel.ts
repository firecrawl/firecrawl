import { gzipSync } from "zlib";
import { createHash, randomUUID } from "crypto";
import {
  fetch as undiciFetch,
  ProxyAgent,
  type Dispatcher,
  type Response,
} from "undici";
import { config } from "../../config";
import { logger as _logger } from "../logger";
import {
  siemLoggingDeliveryBatchesTotal,
  siemLoggingEventsTotal,
} from "./metrics";
import type { AzureSentinelDestination, ScrapeActivityEvent } from "./types";
import { SiemDeliveryError } from "./types";

const logger = _logger.child({ module: "siem-logging-azure-sentinel" });

const MAX_COMPRESSED_BODY_BYTES = 1_000_000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_TOKEN_CACHE_ENTRIES = 1000;
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
  const credentialDigest = createHash("sha256")
    .update(destination.clientSecret)
    .digest("base64url");
  return `${destination.tenantId}:${destination.clientId}:${credentialDigest}`;
}

function cacheToken(cacheKey: string, token: CachedToken): void {
  const now = Date.now();
  for (const [key, cached] of tokenCache) {
    if (cached.expiresAt <= now) tokenCache.delete(key);
  }
  tokenCache.delete(cacheKey);
  while (tokenCache.size >= MAX_TOKEN_CACHE_ENTRIES) {
    const oldestKey = tokenCache.keys().next().value;
    if (oldestKey === undefined) break;
    tokenCache.delete(oldestKey);
  }
  tokenCache.set(cacheKey, token);
}

function invalidateToken(destination: AzureSentinelDestination): void {
  tokenCache.delete(tokenCacheKey(destination));
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(0, seconds * 1000), MAX_RETRY_DELAY_MS);
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_DELAY_MS);
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
  await response.body?.cancel();
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
      cacheToken(cacheKey, {
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

function gzipEvents(events: ScrapeActivityEvent[]): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(events), "utf8"));
}

/**
 * A gzipped request body plus how many events it carries, so the caller can
 * report what was actually delivered rather than what it was handed — a batch
 * can contain fewer events than the input if any were skipped as undeliverable.
 */
interface CompressedBatch {
  body: Buffer;
  eventCount: number;
}

function compressedBatch(events: ScrapeActivityEvent[]): CompressedBatch {
  return { body: gzipEvents(events), eventCount: events.length };
}

export function* buildCompressedBatches(
  events: ScrapeActivityEvent[],
  maxBytes = MAX_COMPRESSED_BODY_BYTES,
): Generator<CompressedBatch> {
  let pending: ScrapeActivityEvent[] = [];

  for (const event of events) {
    const candidate = [...pending, event];
    if (gzipEvents(candidate).byteLength <= maxBytes) {
      pending = candidate;
      continue;
    }

    // The event doesn't fit alongside what's pending — close that batch out and
    // consider the event on its own.
    if (pending.length > 0) {
      yield compressedBatch(pending);
      pending = [];
    }

    if (gzipEvents([event]).byteLength > maxBytes) {
      // Undeliverable at any batch size, and no retry will change that. Skip it
      // and keep going: failing the call here would take down every other event
      // in the batch, and dead-lettering the batch would duplicate the ones
      // already POSTed in earlier chunks.
      siemLoggingEventsTotal.inc({ result: "dropped_oversized" });
      logger.error("Dropping a SIEM event larger than the payload limit", {
        maxBytes,
        scrapeId: event.scrape_id,
        orgId: event.org_id,
      });
      continue;
    }
    pending = [event];
  }

  if (pending.length > 0) yield compressedBatch(pending);
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

/**
 * Returns how many events were actually accepted by the destination, which is
 * fewer than `events.length` when any were skipped as undeliverable. Callers
 * must attribute their `delivered` metric to this count, not to what they
 * passed in, or a skipped event gets counted as both dropped and delivered.
 */
export async function sendAzureSentinelEvents(
  destination: AzureSentinelDestination,
  events: ScrapeActivityEvent[],
  deps: SenderDependencies = {},
): Promise<number> {
  if (events.length === 0) return 0;
  let token: string | undefined;
  let delivered = 0;
  for (const { body, eventCount } of buildCompressedBatches(events)) {
    try {
      token ??= await getAccessToken(destination, deps);
      try {
        await sendBatch(destination, token, body, deps);
      } catch (error) {
        if (
          error instanceof SiemDeliveryError &&
          (error.statusCode === 401 || error.statusCode === 403)
        ) {
          invalidateToken(destination);
          token = await getAccessToken(destination, deps);
          await sendBatch(destination, token, body, deps);
        } else {
          throw error;
        }
      }
      delivered += eventCount;
      siemLoggingDeliveryBatchesTotal.inc({ result: "success" });
    } catch (error) {
      if (error instanceof SiemDeliveryError) {
        if (error.statusCode === 401 || error.statusCode === 403) {
          invalidateToken(destination);
        }
        // Tell the caller what already landed, so the chunks Azure accepted
        // aren't counted as failures on the way out.
        error.deliveredEvents = delivered;
      }
      siemLoggingDeliveryBatchesTotal.inc({ result: "failure" });
      throw error;
    }
  }
  return delivered;
}

export function clearAzureTokenCache(): void {
  tokenCache.clear();
}
