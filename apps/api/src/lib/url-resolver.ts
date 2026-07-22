import safeRegex from "safe-regex2";
import { Agent, fetch } from "undici";
import * as winston from "winston";
import { config } from "../config";

const CAPABILITY_TIMEOUT_MS = 10_000;
const RESOLVE_TIMEOUT_MS = 5 * 60 * 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CAPABILITY_RESPONSE_BYTES = 16 * 1024;
const MAX_RESOLVE_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_RESOLVE_REGEX_LENGTH = 1_024;
const MAX_RESOLVER_URL_LENGTH = 4_096;

const agentOptions = {
  headersTimeout: 0,
  bodyTimeout: 0,
  connectTimeout: RESOLVE_TIMEOUT_MS,
};

const capabilityAgent = new Agent({
  ...agentOptions,
  maxResponseSize: MAX_CAPABILITY_RESPONSE_BYTES,
});
const resolverAgent = new Agent({
  ...agentOptions,
  maxResponseSize: MAX_RESOLVE_RESPONSE_BYTES,
});

let cachedResolveRegex: RegExp | null = null;
let cacheTimestamp = 0;
let pendingResolveRegex: Promise<RegExp> | null = null;

type ResolveUrlOptions = {
  requestBody?: Record<string, unknown>;
  signal?: AbortSignal;
  notFoundIsNull?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    const cleanup = () => signal.removeEventListener("abort", onAbort);

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function parseUrlResolverMetadataResponse(
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.metadata)) {
    throw new Error("URL resolver service returned invalid metadata");
  }

  return value.metadata;
}

export function parseUrlResolverErrorDetail(value: unknown): string {
  return isRecord(value) && typeof value.detail === "string"
    ? value.detail
    : "Unknown error";
}

export function mergeResolvedMetadata<T extends Record<string, unknown>>(
  resolvedMetadata: Record<string, unknown> | undefined,
  canonicalMetadata: T,
): T & Record<string, unknown> {
  return {
    ...(resolvedMetadata ?? {}),
    ...canonicalMetadata,
  };
}

export function compileResolveRegex(value: unknown): RegExp {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_RESOLVE_REGEX_LENGTH ||
    !safeRegex(value)
  ) {
    throw new Error("URL resolver service returned an unsafe URL pattern");
  }

  return new RegExp(value);
}

async function fetchResolveRegex(): Promise<RegExp> {
  const response = await fetch(`${config.AVGRAB_SERVICE_URL}/supported-urls`, {
    signal: AbortSignal.timeout(CAPABILITY_TIMEOUT_MS),
    dispatcher: capabilityAgent,
  });
  if (!response.ok) {
    throw new Error("Failed to fetch URL resolver service capabilities");
  }

  const data = await response.json().catch(() => null);
  if (!isRecord(data)) {
    throw new Error("URL resolver service returned invalid capabilities");
  }

  const regex = compileResolveRegex(data.resolve_regex);
  cachedResolveRegex = regex;
  cacheTimestamp = Date.now();
  return regex;
}

async function getResolveRegex(signal?: AbortSignal): Promise<RegExp | null> {
  if (!config.AVGRAB_SERVICE_URL) return null;

  if (cachedResolveRegex && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedResolveRegex;
  }

  if (!pendingResolveRegex) {
    pendingResolveRegex = fetchResolveRegex().finally(() => {
      pendingResolveRegex = null;
    });
  }

  return waitForSignal(pendingResolveRegex, signal);
}

async function supportsUrlResolver(
  url: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!config.AVGRAB_SERVICE_URL || url.length > MAX_RESOLVER_URL_LENGTH) {
    return false;
  }

  try {
    const regex = await getResolveRegex(signal);
    return regex !== null && regex.test(url);
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

export class UrlResolverHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UrlResolverHttpError";
  }
}

export async function resolveUrl(
  url: string,
  logger: winston.Logger,
  options: ResolveUrlOptions = {},
): Promise<Record<string, unknown> | null> {
  if (!(await supportsUrlResolver(url, options.signal))) return null;

  logger.info("URL matches resolver pattern, delegating to resolver service", {
    url,
  });

  const response = await fetch(`${config.AVGRAB_SERVICE_URL}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(options.requestBody ?? {}), url }),
    signal: withTimeout(options.signal, RESOLVE_TIMEOUT_MS),
    dispatcher: resolverAgent,
  });

  if (response.status === 404 && options.notFoundIsNull) {
    await response.body?.cancel();
    return null;
  }

  if (!response.ok) {
    const detail = parseUrlResolverErrorDetail(
      await response.json().catch(() => null),
    );
    logger.error("URL resolver service failed", {
      url,
      status: response.status,
      detail,
    });
    throw new UrlResolverHttpError(response.status, detail);
  }

  const data = await response.json().catch(() => null);
  if (!isRecord(data)) {
    throw new Error("URL resolver service returned an invalid response");
  }

  return data;
}

export async function resolveUrlMetadata(
  url: string,
  logger: winston.Logger,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const data = await resolveUrl(url, logger, {
    signal,
    notFoundIsNull: true,
  });
  return data === null ? null : parseUrlResolverMetadataResponse(data);
}

export function resetUrlResolverCacheForTest() {
  cachedResolveRegex = null;
  cacheTimestamp = 0;
  pendingResolveRegex = null;
}
