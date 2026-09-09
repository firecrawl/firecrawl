import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Logger } from "winston";
import {
  ExchangeProxyError,
  forwardToExchange,
} from "../../lib/exchange-proxy";
import { billTeam } from "../billing/credit_billing";
import { getRedisConnection } from "../queue-service";
import { getEffectiveConcurrencyLimit } from "../../lib/concurrency-limit";
import { ConcurrencyQueueTimeoutError } from "../../lib/error";
import { teamConcurrencySemaphore } from "../worker/team-semaphore";
import {
  exchangeRetrieveBatchResponseSchema,
  exchangeRetrieveResponseSchema,
} from "../../controllers/v2/types";

const requestIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);

type Input = {
  teamId: string;
  apiKeyId: number | null;
  orgId?: string | null;
  body: unknown;
  timeoutMs: number;
  requestId?: string;
  bypassBilling?: boolean;
  logger: Logger;
};

function refusal(status: number, error: string) {
  return {
    status,
    body: { success: false, error },
    contentType: "application/json",
    requestId: null,
  };
}

export async function settleExchangeCall(input: Input) {
  if (
    input.requestId !== undefined &&
    !requestIdSchema.safeParse(input.requestId).success
  ) {
    return refusal(
      400,
      "x-request-id must contain 1–128 letters, digits, dots, underscores, colons or hyphens.",
    );
  }
  const requests = (input.body as { requests?: unknown } | null)?.requests;
  if (
    Array.isArray(requests) &&
    (requests.length === 0 || requests.length > 10)
  ) {
    return refusal(400, "An Exchange batch must contain 1–10 calls.");
  }
  const items = Array.isArray(requests) ? requests.length : 1;
  const hash = createHash("sha256")
    .update(JSON.stringify(input.body ?? {}))
    .digest("hex");
  const chargeId = createHash("sha256")
    .update(
      JSON.stringify([input.teamId, input.requestId ?? randomUUID(), hash]),
    )
    .digest("hex");
  const key = `exchange:provider-charge:${chargeId}`;
  const redis = getRedisConnection();
  const releaseClaim = async () => {
    try {
      await redis.del(key);
    } catch (error) {
      input.logger.warn("Exchange request identity cleanup failed", {
        chargeId,
        error,
      });
    }
  };
  try {
    const claimed = await redis.set(key, "pending", "EX", 86400, "NX");
    if (claimed !== "OK")
      return refusal(
        409,
        "This request is already in progress or has been processed.",
      );
  } catch {
    return refusal(
      503,
      "Unable to establish request identity. Retry with the same x-request-id.",
    );
  }
  const preview =
    input.teamId === "preview" || input.teamId.startsWith("preview_");
  const deadline = Date.now() + input.timeoutMs;
  let started = false;
  let upstream: Awaited<ReturnType<typeof forwardToExchange>>;
  try {
    const limit = await getEffectiveConcurrencyLimit(input.teamId, input.orgId);
    upstream = await teamConcurrencySemaphore.withSemaphore(
      input.teamId,
      randomUUID(),
      limit,
      AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      Math.max(1, deadline - Date.now()),
      async () => {
        const timeoutMs = deadline - Date.now();
        if (timeoutMs <= 0) throw new ConcurrencyQueueTimeoutError();
        started = true;
        return forwardToExchange({
          teamId: input.teamId,
          method: "POST",
          path: "/v1/retrieve",
          body: input.body,
          timeoutMs,
          requestId: chargeId,
          deadline:
            Date.now() + timeoutMs - Math.min(2000, Math.floor(timeoutMs / 10)),
        });
      },
    );
  } catch (error) {
    if (
      !started ||
      (error instanceof ExchangeProxyError && error.requestNotSent)
    )
      await releaseClaim();
    if (error instanceof ConcurrencyQueueTimeoutError)
      return refusal(
        429,
        "Provider concurrency limit reached. Retry with the same x-request-id.",
      );
    throw error;
  }
  if (upstream.status < 200 || upstream.status >= 300) {
    if (
      upstream.status >= 400 &&
      upstream.status < 500 &&
      upstream.status !== 408
    )
      await releaseClaim();
    return upstream;
  }
  const responseSchema = Array.isArray(requests)
    ? exchangeRetrieveBatchResponseSchema.refine(
        body =>
          body.results.length === items &&
          body.results.reduce(
            (sum, result) => sum + (result.creditsCost ?? 0),
            0,
          ) === body.creditsCost,
      )
    : exchangeRetrieveResponseSchema;
  const charge = responseSchema.safeParse(upstream.body);
  if (!charge.success || charge.data.creditsCost > 100 * items) {
    input.logger.error("Exchange returned an invalid response or charge", {
      chargeId,
    });
    return refusal(502, "Exchange returned an invalid response or charge.");
  }
  const credits = charge.data.creditsCost;
  if (!preview && !input.bypassBilling) {
    const result = await billTeam(
      input.teamId,
      credits,
      input.apiKeyId,
      { endpoint: "scrape", chargeId: `exchange:${chargeId}` },
      input.logger,
      { usageRequestId: chargeId, billingReference: `exchange:${chargeId}` },
    );
    if (!result.success) {
      input.logger.error("Exchange billing needs reconciliation", {
        chargeId,
        credits,
      });
      return refusal(
        503,
        "Billing could not be completed. This request will not be executed again with the same x-request-id.",
      );
    }
  }
  return upstream;
}
