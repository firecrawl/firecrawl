import { Agent, fetch } from "undici";
import { config } from "../config";

type ExchangeUpstream = {
  status: number;
  body: unknown;
  contentType: string | null;
  requestId: string | null;
};

type ExchangeProxyFailure = "unconfigured" | "timeout" | "unreachable";

export class ExchangeProxyError extends Error {
  constructor(
    readonly kind: ExchangeProxyFailure,
    readonly cause?: unknown,
    readonly requestNotSent = false,
  ) {
    super(`exchange proxy: ${kind}`);
    this.name = "ExchangeProxyError";
  }
}

export function exchangeProxyFailureResponse(kind: ExchangeProxyFailure): {
  status: number;
  error: string;
} {
  switch (kind) {
    case "unconfigured":
      return { status: 503, error: "This endpoint is not available." };
    case "timeout":
      return { status: 504, error: "The request timed out." };
    case "unreachable":
      return { status: 502, error: "The request could not be completed." };
  }
}

export const EXCHANGE_DISCOVER_TIMEOUT_MS = 10_000;
export const EXCHANGE_RETRIEVE_TIMEOUT_MS = 50_000;

const dispatcher = new Agent({
  connectTimeout: EXCHANGE_RETRIEVE_TIMEOUT_MS,
  headersTimeout: EXCHANGE_RETRIEVE_TIMEOUT_MS,
  bodyTimeout: EXCHANGE_RETRIEVE_TIMEOUT_MS,
});

export function exchangeUpstreamBase(): string | null {
  if (!config.FIRE_EXCHANGE_URL) return null;
  return config.FIRE_EXCHANGE_URL.replace(/\/+$/, "");
}

const UNDICI_TIMEOUT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function isTimeout(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return true;
  }
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && UNDICI_TIMEOUT_CODES.has(code);
}

export async function forwardToExchange(input: {
  teamId: string;
  hasExtendedCatalogAccess?: boolean;
  method: string;
  path: string;
  body?: unknown;
  timeoutMs: number;
  accept?: string;
  requestId?: string;
  deadline?: number;
}): Promise<ExchangeUpstream> {
  const base = exchangeUpstreamBase();
  if (!base) throw new ExchangeProxyError("unconfigured", undefined, true);

  const method = input.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  let upstream: Awaited<ReturnType<typeof fetch>> | undefined;
  let text: string;
  try {
    upstream = await fetch(base + input.path, {
      method,
      redirect: "manual",
      headers: {
        ...(input.accept === undefined ? {} : { accept: input.accept }),
        ...(input.requestId === undefined
          ? {}
          : { "x-request-id": input.requestId }),
        ...(hasBody ? { "content-type": "application/json" } : {}),
        "x-exchange-team-id": input.teamId,
        "x-exchange-extended-catalog-access": String(
          input.hasExtendedCatalogAccess === true,
        ),
        ...(input.deadline === undefined
          ? {}
          : { "x-exchange-deadline": String(input.deadline) }),
      },
      body: hasBody ? JSON.stringify(input.body ?? {}) : undefined,
      signal: AbortSignal.timeout(input.timeoutMs),
      dispatcher,
    });
    text = await upstream.text();
  } catch (error: unknown) {
    const cause =
      (error as { cause?: { code?: string }; code?: string })?.cause ?? error;
    const code = (cause as { code?: string })?.code;
    const requestNotSent =
      upstream === undefined &&
      [
        "ECONNREFUSED",
        "ENOTFOUND",
        "EAI_AGAIN",
        "UND_ERR_CONNECT_TIMEOUT",
      ].includes(code ?? "");
    throw new ExchangeProxyError(
      isTimeout(error) || isTimeout(cause) ? "timeout" : "unreachable",
      error,
      requestNotSent,
    );
  }

  const contentType = upstream.headers.get("content-type");
  let body: unknown = text;
  try {
    if (
      !contentType ||
      /^(?:application\/json|[^;\s]+\+json)(?:\s*;|$)/i.test(contentType)
    ) {
      body = text ? JSON.parse(text) : null;
    }
  } catch {}
  return {
    status: upstream.status,
    body,
    contentType,
    requestId: upstream.headers.get("x-request-id"),
  };
}
