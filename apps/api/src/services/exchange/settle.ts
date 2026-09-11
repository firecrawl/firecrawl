import { authorizeExchangeProviders } from "../../lib/exchange-provider-access";
import { randomUUID } from "node:crypto";
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
import {
  beginExchangeRequest,
  refusal,
  MAX_REPLAY_BYTES,
} from "./request-state";
import { getEffectiveConcurrencyLimit } from "../../lib/concurrency-limit";
import { ConcurrencyQueueTimeoutError } from "../../lib/error";
import { teamConcurrencySemaphore } from "../worker/team-semaphore";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import { config } from "../../config";
import {
  exchangeCallRequestSchema,
  exchangeRetrieveBatchResponseSchema,
  exchangeRetrieveResponseSchema,
  type TeamFlags,
} from "../../controllers/v2/types";

const requestIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const requestSchema = z.union([
  exchangeCallRequestSchema,
  z.strictObject({
    requests: z.array(exchangeCallRequestSchema).min(1).max(10),
  }),
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
export async function settleExchangeCall(input: Input): Promise<Upstream> {
  if (getScrapeZDR(input.flags) === "forced")
    return refusal(
      403,
      "Exchange provider retrieval does not support zero data retention.",
    );
  const requestId = requestIdSchema.safeParse(input.requestId);
  if (!requestId.success)
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
  const state = await beginExchangeRequest({
    teamId: input.teamId,
    requestId: requestId.data,
    body,
    bypassBilling: input.bypassBilling,
    logger: input.logger,
  });
  if (state.response !== undefined) return state.response;
  const { chargeId, forget, finish } = state;
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
  const preserve = (
    phase: Parameters<typeof state.preserve>[0],
    details: Record<string, unknown> = {},
  ) =>
    state.preserve(phase, {
      apiKeyId: input.apiKeyId,
      featureId,
      properties,
      lockId,
      maximumCredits,
      ...details,
    });
  const pending = () =>
    refusal(
      503,
      "Request state needs reconciliation. Retry only with the same x-request-id; the provider will not execute again.",
    );

  const retryable = async (response: Upstream) =>
    (await forget()) ? response : pending();

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
    const calls = "requests" in body ? body.requests : [body];
    const accessError = await authorizeExchangeProviders({
      teamId: input.teamId,
      body,
      requirements: providers =>
        forwardToExchange({
          teamId: input.teamId,
          hasExtendedCatalogAccess: input.flags?.exchangeRetrieve === true,
          method: "POST",
          path: "/v1/provider-terms/requirements",
          body: { providers },
          timeoutMs: Math.max(1, Math.min(10000, deadline - Date.now())),
        }),
    });
    if (accessError)
      return retryable(refusal(accessError.status, accessError.body.error));
    const quote = await forwardToExchange({
      teamId: input.teamId,
      hasExtendedCatalogAccess: input.flags?.exchangeRetrieve === true,
      method: "POST",
      path: "/v1/retrieve/quote",
      body,
      timeoutMs: Math.max(1, Math.min(deadline - Date.now(), 10000)),
    });
    if (quote.status < 200 || quote.status >= 300) {
      return retryable(quote);
    }
    const quoted = z
      .object({
        maximumCredits: z
          .number()
          .int()
          .min(0)
          .max(calls.length * 100),
      })
      .safeParse(quote.body);
    if (!quoted.success) {
      return retryable(
        refusal(502, "Exchange returned an invalid credit quote."),
      );
    }
    maximumCredits = quoted.data.maximumCredits;
    if (billable && maximumCredits > 0) {
      // Both hold services use this caller-chosen ID, including ambiguous responses.
      lockId = `exchange_${chargeId}`;
      await preserve("reserve", { body });
      const hold = await autumnService.lockCredits({
        teamId: input.teamId,
        value: maximumCredits,
        lockId,
        expiresAt: Date.now() + 60 * 60 * 1000,
        featureId,
        properties,
      });
      if (hold.status !== "locked") {
        // A skipped hold can mean a billing outage; it never authorizes paid provider work.
        if (hold.status === "skipped" && !(await release())) return pending();
        return retryable(
          refusal(
            hold.status === "denied" && hold.reason !== "gate_unavailable"
              ? 402
              : 503,
            hold.status === "denied" && hold.reason !== "gate_unavailable"
              ? "Insufficient credits for this provider request."
              : "Credit reservation is unavailable. No provider was executed.",
          ),
        );
      }
    }
    const limit = await getEffectiveConcurrencyLimit(input.teamId, input.orgId);
    upstream = await teamConcurrencySemaphore.withSemaphore(
      input.teamId,
      randomUUID(),
      limit,
      AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      Math.max(1, deadline - Date.now()),
      async () => {
        if (deadline <= Date.now()) throw new ConcurrencyQueueTimeoutError();
        await preserve("executing", { body });
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
      if (!(await release()) || !(await forget())) return pending();
    } else {
      input.logger.error("Exchange execution outcome needs reconciliation", {
        chargeId,
        lockId,
      });
    }
    if (error instanceof ConcurrencyQueueTimeoutError)
      return refusal(
        429,
        "Provider concurrency limit reached. Retry with the same x-request-id.",
      );
    throw error;
  }
  if (upstream.status < 200 || upstream.status >= 300) {
    if (!(await release())) return pending();
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
    if (!(await release())) return pending();
    return finish(
      refusal(
        502,
        "Exchange returned an invalid response or exceeded its reserved credit budget.",
      ),
    );
  }
  if (billable) {
    const credits = answer.data.creditsCost;
    try {
      await preserve("confirm", {
        credits,
        response:
          Buffer.byteLength(JSON.stringify(upstream)) <= MAX_REPLAY_BYTES
            ? upstream
            : undefined,
        billing: { endpoint: "scrape", chargeId: `exchange:${chargeId}` },
        receipt: {
          usageRequestId: chargeId,
          billingReference: `exchange:${chargeId}`,
        },
      });
    } catch (error) {
      input.logger.error("Exchange reconciliation storage failed", {
        chargeId,
        error,
      });
      return pending();
    }
    if (lockId) {
      let confirmed = false;
      try {
        confirmed = await autumnService.finalizeCreditsLock({
          lockId,
          teamId: input.teamId,
          featureId,
          heldValue: maximumCredits,
          action: "confirm",
          overrideValue: credits,
          properties,
        });
      } catch (error) {
        input.logger.error("Exchange hold confirmation failed", {
          chargeId,
          error,
        });
      }
      if (!confirmed) return pending();
    }
    try {
      await preserve("enqueue", { holdConfirmed: Boolean(lockId) });
    } catch (error) {
      input.logger.error("Exchange confirmed hold storage failed", {
        chargeId,
        error,
      });
      // The earlier confirm checkpoint can recover this idempotent handoff.
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
    if (!queued.success) return pending();
  }
  return finish(upstream);
}
