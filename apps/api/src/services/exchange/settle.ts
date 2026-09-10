import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Logger } from "winston";
import {
  ExchangeProxyError,
  forwardToExchange,
} from "../../lib/exchange-proxy";
import { queueBillingOperation } from "../billing/batch_billing";
import {
  autumnService,
  featureIdForBillingEndpoint,
} from "../autumn/autumn.service";
import { getRedisConnection } from "../queue-service";
import { getEffectiveConcurrencyLimit } from "../../lib/concurrency-limit";
import { ConcurrencyQueueTimeoutError } from "../../lib/error";
import { teamConcurrencySemaphore } from "../worker/team-semaphore";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import { config } from "../../config";
import {
  exchangeRetrieveBatchResponseSchema,
  exchangeRetrieveResponseSchema,
  type TeamFlags,
} from "../../controllers/v2/types";

const requestIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const callSchema = z.strictObject({
  provider: z.string().min(1).max(200),
  capability: z.string().min(1).max(200),
  options: z.record(z.string(), z.unknown()).optional(),
});
const requestSchema = z.union([
  callSchema,
  z.strictObject({ requests: z.array(callSchema).min(1).max(10) }),
]);
type Upstream = Awaited<ReturnType<typeof forwardToExchange>>;
type Input = {
  teamId: string;
  apiKeyId: number | null;
  orgId?: string | null;
  flags: TeamFlags | undefined;
  body: unknown;
  timeoutMs: number;
  requestId?: string;
  bypassBilling?: boolean;
  logger: Logger;
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, canonical(value)]),
    );
  return value;
}
function refusal(status: number, error: string): Upstream {
  return {
    status,
    body: { success: false, error },
    contentType: "application/json",
    requestId: null,
  };
}

export async function settleExchangeCall(input: Input): Promise<Upstream> {
  if (getScrapeZDR(input.flags) === "forced")
    return refusal(
      403,
      "Exchange provider retrieval does not support zero data retention.",
    );
  if (!requestIdSchema.safeParse(input.requestId).success)
    return refusal(
      400,
      "Provide x-request-id: 1–128 letters, digits, dots, underscores, colons or hyphens. Reuse it only when retrying the same request.",
    );
  const parsed = requestSchema.safeParse(input.body);
  if (!parsed.success)
    return refusal(
      400,
      "Provide a provider, capability and options, or a batch of 1–10 such calls.",
    );
  const body = parsed.data;
  const chargeId = hash([input.teamId, input.requestId]);
  const payloadHash = hash([canonical(body), input.bypassBilling === true]);
  const key = `exchange:provider-request:v2:${chargeId}`;
  const redis = getRedisConnection();
  try {
    if (
      (await redis.set(
        key,
        JSON.stringify({ payloadHash, state: "pending" }),
        "EX",
        86400,
        "NX",
      )) !== "OK"
    ) {
      const raw = await redis.get(key);
      if (!raw)
        return refusal(
          409,
          "Request state changed. Retry with the same x-request-id.",
        );
      const previous = JSON.parse(raw);
      if (previous.payloadHash !== payloadHash)
        return refusal(
          409,
          "This x-request-id belongs to a different request.",
        );
      if (previous.state === "complete" && previous.response)
        return previous.response;
      if (previous.state === "complete")
        return refusal(
          409,
          "This request completed, but its response was too large to retain for replay. It will not execute again.",
        );
      return refusal(
        409,
        "This request is still processing or awaiting reconciliation. Do not retry with a new x-request-id.",
      );
    }
  } catch {
    return refusal(
      503,
      "Unable to establish request identity. Retry with the same x-request-id.",
    );
  }
  const forget = async () => {
    try {
      await redis.del(key);
    } catch (error) {
      input.logger.warn("Exchange request identity cleanup failed", {
        chargeId,
        error,
      });
    }
  };
  const finish = async (response: Upstream) => {
    response = { ...response, requestId: input.requestId! };
    try {
      const stored = JSON.stringify({
        payloadHash,
        state: "complete",
        response,
      });
      if (Buffer.byteLength(stored) <= 5 * 1024 * 1024)
        await redis.set(key, stored, "EX", 86400);
      else
        await redis.set(
          key,
          JSON.stringify({ payloadHash, state: "complete" }),
          "EX",
          86400,
        );
    } catch (error) {
      input.logger.error("Exchange result replay storage failed", {
        chargeId,
        error,
      });
    }
    return response;
  };
  const billable =
    config.USE_DB_AUTHENTICATION &&
    input.teamId !== "preview" &&
    !input.teamId.startsWith("preview_") &&
    !input.bypassBilling;
  const featureId = featureIdForBillingEndpoint("scrape");
  const properties = {
    source: "exchangeRetrieve",
    endpoint: "scrape",
    apiKeyId: input.apiKeyId,
    chargeId,
  };
  let lockId: string | undefined;
  let maximumCredits = 0;
  let started = false;
  const release = async () => {
    if (!lockId) return true;
    try {
      return await autumnService.finalizeCreditsLock({
        lockId,
        teamId: input.teamId,
        featureId,
        heldValue: maximumCredits,
        action: "release",
        properties,
      });
    } catch (error) {
      input.logger.error("Exchange credit hold release failed", {
        chargeId,
        error,
      });
      return false;
    }
  };
  const deadline = Date.now() + input.timeoutMs;
  let upstream: Upstream;
  try {
    const quote = await forwardToExchange({
      teamId: input.teamId,
      hasExtendedCatalogAccess: input.flags?.exchangeRetrieve === true,
      method: "POST",
      path: "/v1/retrieve/quote",
      body,
      timeoutMs: Math.min(input.timeoutMs, 10000),
    });
    if (quote.status < 200 || quote.status >= 300) {
      await forget();
      return quote;
    }
    const quoted = z
      .object({ maximumCredits: z.number().int().min(0).max(1000) })
      .safeParse(quote.body);
    if (!quoted.success) {
      await forget();
      return refusal(502, "Exchange returned an invalid credit quote.");
    }
    maximumCredits = quoted.data.maximumCredits;
    if (billable && maximumCredits > 0) {
      const hold = await autumnService.lockCredits({
        teamId: input.teamId,
        value: maximumCredits,
        lockId: `exchange_${chargeId}`,
        expiresAt: Date.now() + 60 * 60 * 1000,
        featureId,
        properties,
      });
      if (hold.status !== "locked") {
        // A skipped hold can mean a billing outage; it never authorizes paid provider work.
        if (hold.status === "skipped") {
          lockId = `exchange_${chargeId}`;
          if (await release()) await forget();
        } else await forget();
        return refusal(
          hold.status === "denied" && hold.reason !== "gate_unavailable"
            ? 402
            : 503,
          hold.status === "denied" && hold.reason !== "gate_unavailable"
            ? "Insufficient credits for this provider request."
            : "Credit reservation is unavailable. No provider was executed.",
        );
      }
      lockId = hold.lockId;
    }
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
          hasExtendedCatalogAccess: input.flags?.exchangeRetrieve === true,
          method: "POST",
          path: "/v1/retrieve",
          body,
          timeoutMs,
          requestId: chargeId,
          maxCredits: maximumCredits,
          deadline:
            Date.now() + timeoutMs - Math.min(2000, Math.floor(timeoutMs / 10)),
        });
      },
    );
  } catch (error) {
    if (
      !started ||
      (error instanceof ExchangeProxyError && error.requestNotSent)
    ) {
      if (await release()) await forget();
    } else {
      input.logger.error(
        "Exchange execution outcome needs reconciliation; credit hold will expire",
        { chargeId, lockId },
      );
    }
    if (error instanceof ConcurrencyQueueTimeoutError)
      return refusal(
        429,
        "Provider concurrency limit reached. Retry with the same x-request-id.",
      );
    throw error;
  }
  if (upstream.status < 200 || upstream.status >= 300) {
    await release();
    return finish(upstream);
  }
  const schema =
    "requests" in body
      ? exchangeRetrieveBatchResponseSchema.refine(
          answer =>
            answer.results.length === body.requests.length &&
            answer.results.reduce(
              (sum, result) => sum + (result.creditsCost ?? 0),
              0,
            ) === answer.creditsCost,
        )
      : exchangeRetrieveResponseSchema;
  const answer = schema.safeParse(upstream.body);
  if (!answer.success || answer.data.creditsCost > maximumCredits) {
    await release();
    return finish(
      refusal(
        502,
        "Exchange returned an invalid response or exceeded its reserved credit budget.",
      ),
    );
  }
  if (billable) {
    const credits = answer.data.creditsCost;
    if (lockId) {
      const confirmed = await autumnService.finalizeCreditsLock({
        lockId,
        teamId: input.teamId,
        featureId,
        heldValue: maximumCredits,
        action: "confirm",
        overrideValue: credits,
        properties,
      });
      if (!confirmed)
        return finish(
          refusal(
            503,
            "Billing confirmation needs reconciliation. This request will not execute again.",
          ),
        );
    }
    const queued = await queueBillingOperation(
      input.teamId,
      credits,
      input.apiKeyId,
      { endpoint: "scrape", chargeId: `exchange:${chargeId}` },
      false,
      Boolean(lockId),
      { usageRequestId: chargeId, billingReference: `exchange:${chargeId}` },
    );
    if (!queued.success)
      return finish(
        refusal(
          503,
          "Billing needs reconciliation. This request will not execute again.",
        ),
      );
  }
  return finish(upstream);
}
