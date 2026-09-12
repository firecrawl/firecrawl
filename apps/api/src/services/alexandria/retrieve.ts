import { createHash } from "node:crypto";
import { z } from "zod";
import { config } from "../../config";
import type { TeamFlags } from "../../controllers/v2/types";
import { reportExchangeUsageBilling } from "../../lib/exchange";
import { logger } from "../../lib/logger";
import {
  autumnService,
  featureIdForBillingEndpoint,
} from "../autumn/autumn.service";
import { getBillingQueue } from "../queue-service";
import { redisRateLimitClient } from "../rate-limiter";
import { authorizeProviders } from "./access";
import { exchangeRequest } from "./client";
import {
  answerSchema,
  refusal,
  type ExchangeResponse,
  type ProviderCall,
} from "./contracts";

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const RETENTION_SECONDS = 7 * 86400;
const GRACE_MS = 30_000;
const HOLD_GRACE_MS = 15 * 60_000;

// One record per charge id (team + x-request-id), written before the provider
// call so a crash is found as unresolved instead of re-executed, and rewritten
// with the response so replays never execute twice.
type Retrieval = {
  fingerprint: string;
  phase: "executing" | "done";
  deadline: number;
  scrapeId: string;
  lockId?: string;
  maximumCredits?: number;
  response?: ExchangeResponse;
  failure?: string;
};

type ProviderRetrieval = ExchangeResponse & {
  /** Whether this request reached the provider call; false for replays and pre-execution refusals. */
  executed: boolean;
  scrapeId: string;
};

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

const unresolved = (chargeId: string) =>
  refusal(
    503,
    "The provider request did not complete and its outcome is uncertain. Keep this x-request-id for reconciliation; do not create a new request.",
    { code: "request_unresolved", chargeId },
  );
const relay = (response: ExchangeResponse): ExchangeResponse => {
  const body = (response.body ?? {}) as Record<string, unknown>;
  return refusal(
    response.status,
    typeof body.error === "string"
      ? body.error
      : "The provider request was refused.",
    typeof body.code === "string" ? { code: body.code } : {},
  );
};

export async function retrieveProviders(input: {
  teamId: string;
  apiKeyId: number | null;
  flags: TeamFlags | null | undefined;
  calls: ProviderCall[];
  requestId: string;
  scrapeId: string;
  timeoutMs: number;
  bypassBilling?: boolean;
}): Promise<ProviderRetrieval> {
  const notExecuted = (response: ExchangeResponse): ProviderRetrieval => ({
    ...response,
    executed: false,
    scrapeId: input.scrapeId,
  });
  if (!REQUEST_ID_PATTERN.test(input.requestId))
    return notExecuted(
      refusal(
        400,
        "Invalid x-request-id; use 1-128 letters, digits, dots, underscores, colons or hyphens.",
      ),
    );
  if (Buffer.byteLength(JSON.stringify(input.calls)) > 256 * 1024)
    return notExecuted(refusal(400, "Provider options exceed 256 KB."));

  const billable = !input.bypassBilling;
  const id = hash([input.teamId, input.requestId]);
  const key = `alexandria:retrieve:${id}`;
  const fingerprint = hash([input.calls, billable]);
  const record: Retrieval = {
    fingerprint,
    phase: "executing",
    deadline: Date.now() + input.timeoutMs,
    scrapeId: input.scrapeId,
  };
  const write = (next: Retrieval) =>
    redisRateLimitClient.set(
      key,
      JSON.stringify(next),
      "EX",
      RETENTION_SECONDS,
    );

  const claimed = await redisRateLimitClient.set(
    key,
    JSON.stringify(record),
    "EX",
    RETENTION_SECONDS,
    "NX",
  );
  if (claimed !== "OK") {
    const raw = await redisRateLimitClient.get(key);
    const existing: Retrieval | null = raw ? JSON.parse(raw) : null;
    if (existing?.phase === "done" && existing.fingerprint === fingerprint)
      return {
        ...existing.response!,
        executed: false,
        scrapeId: existing.scrapeId ?? input.scrapeId,
      };
    if (existing && existing.fingerprint !== fingerprint)
      return notExecuted(
        refusal(
          409,
          "This x-request-id already belongs to a different provider request.",
          { code: "duplicate_request", chargeId: id },
        ),
      );
    if (
      existing &&
      !existing.failure &&
      Date.now() <= existing.deadline + GRACE_MS
    )
      return notExecuted(
        refusal(
          409,
          "This provider request is still running. Retry with the same x-request-id once it has finished.",
          { code: "request_in_flight", chargeId: id },
        ),
      );
    return notExecuted(unresolved(id));
  }

  const featureId = featureIdForBillingEndpoint("scrape");
  const properties = {
    source: "alexandria",
    endpoint: "scrape",
    chargeId: id,
    apiKeyId: input.apiKeyId,
  };
  const remaining = () => Math.max(1, record.deadline - Date.now());
  // Nothing reserved or executed yet: drop the claim so the same id can retry.
  const refuse = async (response: ExchangeResponse, executed = false) => {
    await redisRateLimitClient.del(key);
    return { ...response, executed, scrapeId: input.scrapeId };
  };

  let lockId: string | undefined;
  let maximumCredits: number;
  try {
    const denied = await authorizeProviders(
      input.teamId,
      input.calls,
      input.flags,
    );
    if (denied) return refuse(denied);

    const quote = await exchangeRequest({
      teamId: input.teamId,
      path: "/v1/retrieve/quote",
      body: { requests: input.calls },
      timeoutMs: Math.min(10000, remaining()),
    }).catch(error => {
      logger.warn("Provider quote unavailable", { error, chargeId: id });
      return undefined;
    });
    if (!quote || quote.status >= 500 || quote.status < 200)
      return refuse(
        refusal(
          503,
          "Provider quote is unavailable. No provider was executed.",
        ),
      );
    if (quote.status !== 200) return refuse(relay(quote));
    const parsedQuote = z
      .object({ maximumCredits: z.number().int().nonnegative().safe() })
      .safeParse(quote.body);
    if (!parsedQuote.success)
      return refuse(
        refusal(502, "Provider quote was malformed. No provider was executed."),
      );
    maximumCredits = parsedQuote.data.maximumCredits;

    if (billable && maximumCredits > 0) {
      if (!config.USE_DB_AUTHENTICATION)
        return refuse(
          refusal(
            503,
            "Paid provider billing is not configured. No provider was executed.",
          ),
        );
      const hold = await autumnService.lockCredits({
        teamId: input.teamId,
        value: maximumCredits,
        lockId: `alexandria_${id}`,
        expiresAt: record.deadline + HOLD_GRACE_MS,
        featureId,
        properties,
      });
      if (hold.status === "denied")
        return refuse(
          hold.reason === "gate_unavailable"
            ? refusal(
                503,
                "Credit reservation is unavailable. No provider was executed.",
                { code: "billing_unavailable" },
              )
            : refusal(
                402,
                `This request needs up to ${maximumCredits} credits reserved. No provider was executed.`,
                { code: "insufficient_credits" },
              ),
        );
      if (hold.status === "skipped")
        return refuse(
          refusal(
            503,
            "Credit reservation is unavailable. No provider was executed.",
          ),
        );
      lockId = hold.lockId;
    }
  } catch (error) {
    await redisRateLimitClient.del(key).catch(() => {});
    throw error;
  }

  // Point of no return: persist the hold before the provider call.
  record.lockId = lockId;
  record.maximumCredits = maximumCredits;
  const fail = async (reason: string): Promise<ProviderRetrieval> => {
    logger.error(
      "Provider request outcome is uncertain; needs reconciliation",
      {
        chargeId: id,
        teamId: input.teamId,
        lockId,
        maximumCredits,
        reason,
      },
    );
    await write({ ...record, failure: reason }).catch(() => {});
    return { ...unresolved(id), executed: true, scrapeId: input.scrapeId };
  };
  const finalize = async (credits: number) => {
    if (!lockId) return true;
    const settled = await autumnService.finalizeCreditsLock({
      teamId: input.teamId,
      lockId,
      action: credits > 0 ? "confirm" : "release",
      ...(credits > 0 ? { overrideValue: credits } : {}),
      heldValue: maximumCredits,
      featureId,
      properties,
    });
    if (!settled)
      logger.error("Provider credits were not settled; hold expires unbilled", {
        chargeId: id,
        teamId: input.teamId,
        lockId,
        credits,
      });
    return settled;
  };

  try {
    await write(record);
    const response = await exchangeRequest({
      teamId: input.teamId,
      path: "/v1/retrieve",
      body: { requests: input.calls },
      timeoutMs: remaining(),
      requestId: id,
      maximumCredits,
    }).catch(error => {
      throw new Error(`Exchange did not answer: ${error?.message ?? error}`);
    });

    const body = (response.body ?? {}) as Record<string, unknown>;
    // A refusal or a deadline already passed on arrival bought no provider work.
    if (
      (response.status >= 400 && response.status < 500) ||
      (response.status === 504 && body.code === "deadline_exceeded")
    ) {
      await finalize(0);
      return refuse(relay(response), true);
    }
    if (response.status < 200 || response.status >= 300)
      return fail(`Exchange answered ${response.status}`);

    const parsed = answerSchema.safeParse(response.body);
    if (!parsed.success) return fail("Exchange answer was malformed");
    const answer = parsed.data;
    const receiptMatches =
      answer.results.length === input.calls.length &&
      answer.creditsCost <= maximumCredits &&
      answer.results.reduce((sum, item) => sum + (item.creditsCost ?? 0), 0) ===
        answer.creditsCost &&
      answer.results.every(
        (item, i) =>
          (item.provider ?? input.calls[i].provider) ===
            input.calls[i].provider &&
          (item.capability ?? input.calls[i].capability) ===
            input.calls[i].capability,
      );
    if (!receiptMatches)
      return fail("Exchange receipt did not match the request");

    const credits = answer.creditsCost;
    const settled = await finalize(credits);
    if (settled && billable && credits > 0)
      await recordLedgerUsage(id, input.teamId, input.apiKeyId, credits);
    // An unsettled confirm stays pending on the Exchange, where reconciliation finds it.
    if (settled || !billable)
      void reportExchangeUsageBilling({
        requestId: id,
        status: billable ? "confirmed" : "void",
        billingReference: `alexandria:${id}`,
      });

    const done: ExchangeResponse = { status: 200, body: answer };
    await write({ ...record, phase: "done", response: done });
    return { ...done, executed: true, scrapeId: input.scrapeId };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// The same idempotent billing queue every billed path uses. Autumn was already
// debited by the confirm; on the direct route a failed ledger commit refunds it,
// while on the firebill route the durable charge stands pending reconciliation.
async function recordLedgerUsage(
  id: string,
  teamId: string,
  apiKeyId: number | null,
  credits: number,
) {
  const refundable = !(await autumnService.isRoutedThroughFirebill(teamId));
  for (let attempt = 1; ; attempt++) {
    try {
      await getBillingQueue().add(
        "bill_team",
        {
          team_id: teamId,
          credits,
          billing: { endpoint: "scrape", chargeId: id },
          is_extract: false,
          timestamp: new Date().toISOString(),
          originating_job_id: id,
          api_key_id: apiKeyId,
          autumnTrackInRequest: refundable,
        },
        { jobId: `alexandria-bill-${id}`, priority: 10 },
      );
      return;
    } catch (error) {
      if (attempt >= 3)
        return logger.error(
          "Provider usage could not be queued for the ledger; charge stands pending reconciliation",
          { chargeId: id, teamId, credits, error },
        );
      await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    }
  }
}
