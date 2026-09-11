import type {
  ExchangeCall,
  ExchangeOptions,
  ExchangeScrapeData,
  ExchangeScrapeResult,
  FindToolsData,
  FindToolsOptions,
} from "../types";
import { SdkError } from "../types";
import { HttpClient } from "../utils/httpClient";
import {
  normalizeAxiosError,
  throwForBadResponse,
} from "../utils/errorHandler";

const EXCHANGE_MAX_CALLS = 10;

function prepareExchangePayload(
  calls: ExchangeCall[],
  opts: ExchangeOptions,
): Record<string, unknown> {
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new Error("exchange requires at least one call");
  }
  if (calls.length > EXCHANGE_MAX_CALLS) {
    throw new Error(`exchange accepts at most ${EXCHANGE_MAX_CALLS} calls`);
  }
  const exchange = calls.map((call, index) => {
    if (!call || typeof call.provider !== "string" || !call.provider.trim()) {
      throw new Error(`exchange[${index}].provider cannot be empty`);
    }
    if (typeof call.capability !== "string" || !call.capability.trim()) {
      throw new Error(`exchange[${index}].capability cannot be empty`);
    }
    if (
      Object.keys(call).some(
        (key) => !["provider", "capability", "options"].includes(key),
      )
    )
      throw new Error("Unknown exchange call option");
    const item: Record<string, unknown> = {
      provider: call.provider.trim(),
      capability: call.capability.trim(),
    };
    if (call.options != null) {
      if (typeof call.options !== "object" || Array.isArray(call.options)) {
        throw new Error(`exchange[${index}].options must be an object`);
      }
      item.options = call.options;
    }
    return item;
  });
  if (
    opts.timeout != null &&
    (!Number.isInteger(opts.timeout) || opts.timeout <= 0)
  ) {
    throw new Error("timeout must be a positive integer");
  }
  const payload: Record<string, unknown> = { exchange };
  if (opts.timeout != null) payload.timeout = opts.timeout;
  if (opts.integration && opts.integration.trim())
    payload.integration = opts.integration.trim();
  if (opts.origin) payload.origin = opts.origin;
  return payload;
}

export async function scrapeExchange(
  http: HttpClient,
  calls: ExchangeCall[],
  opts: ExchangeOptions = {},
): Promise<ExchangeScrapeData> {
  const payload = prepareExchangePayload(calls, opts);
  const requestId = opts.requestId ?? crypto.randomUUID();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId))
    throw new Error("Invalid requestId");
  try {
    const res = await http.post<{
      success: boolean;
      scrape_id?: string;
      data?: { exchange?: ExchangeScrapeResult[]; creditsCost?: number };
      error?: string;
    }>("/v2/scrape", payload, {
      headers: { "x-request-id": requestId },
      ...(opts.timeout != null ? { timeoutMs: opts.timeout + 5000 } : {}),
    });
    if (res.status !== 200 || !res.data?.success) {
      throwForBadResponse(res, "exchange");
    }
    const data = res.data.data;
    if (
      !data ||
      !Array.isArray(data.exchange) ||
      typeof data.creditsCost !== "number" ||
      !Number.isInteger(data.creditsCost) ||
      data.creditsCost < 0
    ) {
      throw new SdkError("Invalid exchange response");
    }
    return {
      scrapeId: res.data.scrape_id ?? "",
      requestId,
      exchange: data.exchange,
      creditsCost: data.creditsCost,
    };
  } catch (err: any) {
    try {
      if (err?.isAxiosError) normalizeAxiosError(err, "exchange");
      throw err;
    } catch (error) {
      if (error && typeof error === "object")
        Object.assign(error, { requestId });
      throw error;
    }
  }
}

export async function findTools(
  http: HttpClient,
  options: FindToolsOptions = {},
): Promise<FindToolsData> {
  const result = await scrapeExchange(http, [
    {
      provider: "firecrawl-contextual-discovery",
      capability: "discovery/context",
      options: { ...options },
    },
  ]);
  const item = result.exchange[0];
  if (!item) throw new SdkError("Missing Find Tools result");
  if (item.error)
    throw Object.assign(
      new SdkError(item.error.message, item.error.status, item.error.code),
      { requestId: result.requestId },
    );
  return item.data as FindToolsData;
}
