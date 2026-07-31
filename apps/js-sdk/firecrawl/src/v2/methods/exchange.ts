import type {
  ExchangeInvokeData,
  ExchangeInvokeRequest,
  ExchangeResult,
} from "../types";
import { HttpClient } from "../utils/httpClient";
import {
  normalizeAxiosError,
  throwForBadResponse,
} from "../utils/errorHandler";

export async function exchangeInvoke(
  http: HttpClient,
  request: ExchangeInvokeRequest,
): Promise<ExchangeInvokeData> {
  if (!request.calls?.length) {
    throw new Error("At least one Exchange call is required");
  }

  try {
    const response = await http.post<{
      success: boolean;
      partial?: boolean;
      data?: { exchange?: ExchangeResult[] };
      creditsUsed?: number;
      id?: string;
      error?: string;
    }>(
      "/v2/exchange/invoke",
      {
        calls: request.calls,
        ...(request.timeout != null ? { timeout: request.timeout } : {}),
        ...(request.zeroDataRetention != null
          ? { zeroDataRetention: request.zeroDataRetention }
          : {}),
      },
      typeof request.timeout === "number"
        ? { timeoutMs: request.timeout + 5000 }
        : {},
    );

    if (response.status !== 200 || !response.data?.success) {
      throwForBadResponse(response, "exchange invoke");
    }

    return {
      exchange: response.data.data?.exchange ?? [],
      creditsUsed: response.data.creditsUsed ?? 0,
      id: response.data.id ?? "",
      partial: response.data.partial ?? false,
    };
  } catch (error: any) {
    if (error?.isAxiosError) {
      return normalizeAxiosError(error, "exchange invoke");
    }
    throw error;
  }
}
