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

const dispatchers = new Map<number, Agent>();
function dispatcherFor(timeout: number): Agent {
  let agent = dispatchers.get(timeout);
  if (!agent) {
    agent = new Agent({
      connectTimeout: timeout,
      headersTimeout: timeout,
      bodyTimeout: timeout,
    });
    dispatchers.set(timeout, agent);
  }
  return agent;
}

export function exchangeUpstreamBase(): string | null {
  if (!config.FIRE_EXCHANGE_URL) return null;
  return config.FIRE_EXCHANGE_URL.replace(/\/+$/, "");
}

export async function forwardToExchange(input: {
  teamId: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  timeoutMs: number;
  accept?: string;
  requestId?: string;
}): Promise<ExchangeUpstream> {
  const base = exchangeUpstreamBase();
  if (!base) throw new ExchangeProxyError("unconfigured");

  const hasBody = input.method !== "GET";
  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(base + input.path, {
      method: input.method,
      headers: {
        ...(input.accept === undefined ? {} : { accept: input.accept }),
        ...(input.requestId === undefined
          ? {}
          : { "x-request-id": input.requestId }),
        ...(hasBody ? { "content-type": "application/json" } : {}),
        "x-exchange-team-id": input.teamId,
      },
      body: hasBody ? JSON.stringify(input.body ?? {}) : undefined,
      signal: AbortSignal.timeout(input.timeoutMs),
      dispatcher: dispatcherFor(input.timeoutMs),
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new ExchangeProxyError("timeout", error);
    }
    throw new ExchangeProxyError("unreachable", error);
  }

  const text = await upstream.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return {
    status: upstream.status,
    body,
    contentType: upstream.headers.get("content-type"),
    requestId: upstream.headers.get("x-request-id"),
  };
}
