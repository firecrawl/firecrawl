import { config } from "../../config";
import type { ExchangeSearchResult } from "../../lib/entities";

/** A call once the executor has guaranteed it an idempotency key. */
export type ResolvedExchangeCall = ExchangeCall & { idempotencyKey: string };

export interface ExchangeCall {
  provider: string;
  capability: string;
  options: Record<string, unknown>;
  providerApiKey?: string;
  idempotencyKey?: string;
}

interface ExchangeInvokeResponse {
  success: true;
  accessEventId: string;
  exchangeRequestId: string;
  data: {
    provider: string;
    capability: string;
    delivery: "direct";
    creditsCost: number;
    result: unknown;
  };
}

interface ExchangeUpstreamError {
  success?: false;
  code?: unknown;
  error?:
    | unknown
    | {
        code?: unknown;
        message?: unknown;
        retryable?: unknown;
      };
  message?: unknown;
  retryable?: unknown;
}

interface ExchangeQuote {
  call: ExchangeCall;
  creditsCost?: number;
  delivery?: "direct";
  readOnly?: true;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    status?: number;
  };
}

export function redactExchangeCredentials<T>(body: T): T {
  const calls = (body as { exchange?: unknown } | null)?.exchange;
  if (!Array.isArray(calls)) return body;
  const hasCredential = calls.some(
    call =>
      typeof call === "object" &&
      call !== null &&
      (call as Record<string, unknown>).providerApiKey !== undefined,
  );
  if (!hasCredential) return body;
  return {
    ...body,
    exchange: calls.map(call =>
      typeof call === "object" &&
      call !== null &&
      (call as Record<string, unknown>).providerApiKey !== undefined
        ? { ...(call as Record<string, unknown>), providerApiKey: "<redacted>" }
        : call,
    ),
  } as T;
}

export async function quoteExchangeCalls(
  calls: ExchangeCall[],
): Promise<ExchangeQuote[]> {
  if (!calls.length) return [];
  if (!config.EXCHANGE_API_URL) {
    return calls.map(call => ({
      call,
      error: {
        code: "exchange_unavailable",
        message: "Exchange is not configured.",
        retryable: true,
      },
    }));
  }

  return Promise.all(
    calls.map(async call => {
      try {
        const response = await fetch(
          new URL(
            `/v1/router/providers/${encodeURIComponent(call.provider)}/${encodeURIComponent(call.capability)}`,
            config.EXCHANGE_API_URL,
          ),
          {
            headers: {
              Accept: "application/json",
              ...(config.EXCHANGE_API_TOKEN
                ? { Authorization: `Bearer ${config.EXCHANGE_API_TOKEN}` }
                : {}),
            },
            signal: AbortSignal.timeout(10_000),
          },
        );
        const payload = (await response.json().catch(() => null)) as {
          creditsPerCall?: unknown;
          delivery?: unknown;
          readOnly?: unknown;
        } | null;
        if (!response.ok) {
          return {
            call,
            error: upstreamError(
              payload,
              response.status,
              "exchange_quote_unavailable",
              "The Exchange capability price could not be determined.",
            ),
          };
        }
        if (
          typeof payload?.creditsPerCall !== "number" ||
          !Number.isSafeInteger(payload.creditsPerCall) ||
          payload.creditsPerCall < 0 ||
          payload.delivery !== "direct" ||
          payload.readOnly !== true
        ) {
          return {
            call,
            error: {
              code: "exchange_capability_not_supported",
              message:
                "This capability is not available through the direct read-only Exchange beta.",
              retryable: false,
            },
          };
        }
        return {
          call,
          creditsCost: payload.creditsPerCall,
          delivery: "direct",
          readOnly: true,
        };
      } catch {
        return {
          call,
          error: {
            code: "exchange_quote_unavailable",
            message: "The Exchange capability price could not be determined.",
            retryable: true,
          },
        };
      }
    }),
  );
}

/** Executes independent provider calls without mixing them into web search result handling. */
export async function invokeExchangeCalls(input: {
  calls: ResolvedExchangeCall[];
  quotes: ExchangeQuote[];
  teamId: string;
  timeoutMs: number;
  zeroDataRetention: boolean;
}): Promise<ExchangeSearchResult[]> {
  if (!input.calls.length) return [];
  if (!config.EXCHANGE_API_URL) {
    return input.calls.map(call =>
      unavailable(call, "Exchange is not configured."),
    );
  }

  return Promise.all(
    input.calls.map(async (call, index) => {
      const quote = input.quotes[index];
      if (quote?.error || quote?.creditsCost === undefined) {
        return {
          provider: call.provider,
          capability: call.capability,
          error: quote?.error ?? {
            code: "exchange_quote_unavailable",
            message: "The Exchange capability price could not be determined.",
            retryable: true,
          },
        };
      }
      try {
        const response = await fetch(
          new URL("/v1/invoke", config.EXCHANGE_API_URL),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(config.EXCHANGE_API_TOKEN
                ? { Authorization: `Bearer ${config.EXCHANGE_API_TOKEN}` }
                : {}),
            },
            body: JSON.stringify({
              provider: call.provider,
              capability: call.capability,
              options: call.options,
              ...(call.providerApiKey === undefined
                ? {}
                : { providerApiKey: call.providerApiKey }),
              requestId: call.idempotencyKey,
              teamId: input.teamId,
              zeroDataRetention: input.zeroDataRetention,
            }),
            signal: AbortSignal.timeout(input.timeoutMs),
          },
        );
        const payload = (await response.json().catch(() => null)) as
          | ExchangeInvokeResponse
          | ExchangeUpstreamError
          | null;
        if (!response.ok || payload?.success !== true) {
          return {
            provider: call.provider,
            capability: call.capability,
            error: upstreamError(
              payload,
              response.status,
              "exchange_invoke_failed",
              "The Exchange provider could not complete the request.",
            ),
          };
        }
        if (
          payload.data.provider !== call.provider ||
          payload.data.capability !== call.capability ||
          payload.data.delivery !== "direct" ||
          typeof payload.accessEventId !== "string" ||
          payload.accessEventId.length === 0 ||
          typeof payload.exchangeRequestId !== "string" ||
          payload.exchangeRequestId.length === 0 ||
          !Number.isSafeInteger(payload.data.creditsCost) ||
          payload.data.creditsCost < 0
        ) {
          return unavailable(
            call,
            "The Exchange provider returned an invalid response.",
          );
        }
        if (payload.data.creditsCost !== quote.creditsCost) {
          return {
            provider: payload.data.provider,
            capability: payload.data.capability,
            accessEventId: payload.accessEventId,
            exchangeRequestId: payload.exchangeRequestId,
            creditsCost: payload.data.creditsCost,
            error: {
              code: "exchange_price_changed",
              message:
                "The Exchange capability price changed before execution.",
              retryable: true,
            },
          };
        }
        return {
          provider: payload.data.provider,
          capability: payload.data.capability,
          accessEventId: payload.accessEventId,
          exchangeRequestId: payload.exchangeRequestId,
          delivery: payload.data.delivery,
          creditsCost: payload.data.creditsCost,
          data: payload.data.result,
        };
      } catch {
        return unavailable(
          call,
          "The Exchange provider could not be reached.",
          true,
        );
      }
    }),
  );
}

function unavailable(
  call: ExchangeCall,
  message: string,
  retryable = false,
): ExchangeSearchResult {
  return {
    provider: call.provider,
    capability: call.capability,
    error: { code: "exchange_unavailable", message, retryable },
  };
}

function upstreamError(
  payload: unknown,
  status: number,
  fallbackCode: string,
  fallbackMessage: string,
): {
  code: string;
  message: string;
  retryable: boolean;
  status: number;
} {
  const candidate = payload as ExchangeUpstreamError | null;
  const nested: {
    code?: unknown;
    message?: unknown;
    retryable?: unknown;
  } | null =
    candidate?.error &&
    typeof candidate.error === "object" &&
    !Array.isArray(candidate.error)
      ? (candidate.error as {
          code?: unknown;
          message?: unknown;
          retryable?: unknown;
        })
      : null;
  const code =
    typeof nested?.code === "string"
      ? nested.code
      : typeof candidate?.code === "string"
        ? candidate.code
        : fallbackCode;
  const message =
    typeof nested?.message === "string"
      ? nested.message
      : typeof candidate?.message === "string"
        ? candidate.message
        : typeof candidate?.error === "string"
          ? candidate.error
          : fallbackMessage;
  const retryable =
    typeof nested?.retryable === "boolean"
      ? nested.retryable
      : typeof candidate?.retryable === "boolean"
        ? candidate.retryable
        : status >= 500;
  return { code, message, retryable, status };
}
