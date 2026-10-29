import { createHash } from "node:crypto";
import { z } from "zod";
import { config } from "../../config";
import type { TeamFlags } from "../../controllers/v2/types";
import { reportExchangeUsageBilling } from "../../lib/exchange";
import {
  indexDailyLimitRefusal,
  reserveIndexCalls,
  type IndexName,
} from "../../lib/index-daily-limit";
import { logger } from "../../lib/logger";
import {
  autumnService,
  featureIdForBillingEndpoint,
  MCP_CREDITS_FEATURE_ID,
} from "../autumn/autumn.service";
import { tallyAgentMcpCredits } from "../billing/agent-mcp-credits";
import type { LockCreditsResult } from "../autumn/types";
import {
  AGENT_REQUEST_CREDITS_SHARDS,
  initializeRequestCredits,
  recordRequestCredits,
} from "../../lib/request-credits-store";
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

// The providers served by the free Firecrawl indexes, each reserving from that
// index's daily budget. Matched on the exact provider slug.
const INDEX_PROVIDERS: [IndexName, string][] = [
  ["gov", "firecrawl-gov-index"],
  ["research", "firecrawl-research-index"],
];

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
  // The part of the hold a hosted MCP call's MCP credits took, under its own
  // lock; the rest of maximumCredits is held under lockId.
  mcpLockId?: string;
  mcpHeldCredits?: number;
  response?: ExchangeResponse;
  // Set instead of response under zero data retention.
  responseWithheld?: boolean;
  failure?: string;
};

type ProviderRetrieval = ExchangeResponse & {
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
  /** The team's org — the Autumn customer this bills against. Null when none
   *  can be named, which is a skipped hold, the same as an unresolvable org. */
  orgId: string | null;
  apiKeyId: number | null;
  apiKeyIdText?: string | null;
  flags: TeamFlags | null | undefined;
  calls: ProviderCall[];
  requestId: string;
  /** The agent run this call belongs to: its credits join that run's call credits. */
  agentRequestId?: string;
  /** A verified hosted MCP call: its MCP credits are held and spent first. */
  hostedMcp?: boolean;
  scrapeId: string;
  timeoutMs: number;
  bypassBilling?: boolean;
  resultAuthorization?: string;
  zeroDataRetention?: boolean;
  clientIp?: string;
  billingCountry?: string;
  /** The team's Autumn rate-limit multiplier, which sizes its index budgets. */
  rateLimitMultiplier: number;
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

  const usesSql = input.calls.some(
    call => call.provider === "firecrawl" && call.capability === "sql",
  );
  if (usesSql && input.calls.length !== 1)
    return notExecuted(
      refusal(
        400,
        "SQL must be sent as a separate request; do not batch it with other calls.",
      ),
    );

  const usesEnrichment = input.calls.some(
    call => call.provider === "firecrawl" && call.capability === "enrich",
  );
  if (usesEnrichment && input.calls.length !== 1)
    return notExecuted(
      refusal(
        400,
        "Enrichment must be sent as a separate request; do not batch it with other calls.",
      ),
    );

  const loadsSavedResult = input.calls.some(
    call =>
      call.provider === "firecrawl" &&
      (call.capability === "bash" || call.capability === "jev") &&
      typeof call.options?.requestId === "string",
  );
  if (loadsSavedResult && input.calls.length !== 1)
    return notExecuted(
      refusal(
        400,
        "Saved-result loading must be sent as a separate request; do not batch it with other calls.",
      ),
    );

  const termsOnly =
    input.calls.length > 0 &&
    input.calls.every(
      call =>
        call.provider === "firecrawl" &&
        (call.capability === "terms/show" ||
          call.capability === "terms/accept"),
    );
  const termsIdentity =
    termsOnly && input.orgId && input.apiKeyIdText
      ? { organizationId: input.orgId, apiKeyId: input.apiKeyIdText }
      : undefined;
  const billable = !input.bypassBilling;
  const id = hash([input.teamId, input.requestId]);
  const key = `alexandria:retrieve:${id}`;
  const zeroDataRetention = input.zeroDataRetention === true;
  // Appended only when set so existing non-ZDR fingerprints stay stable.
  const fingerprint = hash([
    ...(termsOnly
      ? [input.calls, billable, termsIdentity ?? null]
      : [input.calls, billable]),
    ...(zeroDataRetention ? [{ zeroDataRetention }] : []),
  ]);
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
    if (
      existing?.phase === "done" &&
      existing.fingerprint === fingerprint &&
      existing.responseWithheld
    )
      return notExecuted(
        refusal(
          409,
          "This provider request already completed. Its response is not kept under zero data retention.",
          { code: "response_not_retained", chargeId: id },
        ),
      );
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
  const indexReleases: (() => Promise<void>)[] = [];
  const releaseIndexCalls = async () => {
    for (const release of indexReleases) await release();
  };
  const refuse = async (response: ExchangeResponse, executed = false) => {
    if (!executed) await releaseIndexCalls();
    await redisRateLimitClient.del(key);
    return { ...response, executed, scrapeId: input.scrapeId };
  };

  let lockId: string | undefined;
  let mcpLockId: string | undefined;
  let mcpHeldCredits = 0;
  let maximumCredits: number;
  let refundable = false;
  const settle = async (
    lock: string,
    heldValue: number,
    credits: number,
    lockFeatureId: string,
  ) => {
    const settled = await autumnService.finalizeCreditsLock({
      // Omitted without an org: the settle goes straight to Autumn, the route
      // an unnameable org already took.
      team:
        input.orgId !== null
          ? { teamId: input.teamId, orgId: input.orgId }
          : undefined,
      lockId: lock,
      action: credits > 0 ? "confirm" : "release",
      ...(credits > 0 ? { overrideValue: credits } : {}),
      heldValue,
      featureId: lockFeatureId,
      properties,
    });
    if (!settled)
      logger.error("Provider credits were not settled; hold expires unbilled", {
        chargeId: id,
        teamId: input.teamId,
        lockId: lock,
        credits,
      });
    return settled;
  };
  // The MCP credits pay first, up to what they hold; the rest settles on the
  // scrape feature's hold.
  const mcpPart = (credits: number) => Math.min(credits, mcpHeldCredits);
  const finalizeParts = (credits: number) =>
    Promise.all([
      mcpLockId
        ? settle(
            mcpLockId,
            mcpHeldCredits,
            mcpPart(credits),
            MCP_CREDITS_FEATURE_ID,
          )
        : true,
      lockId
        ? settle(
            lockId,
            maximumCredits - mcpHeldCredits,
            credits - mcpPart(credits),
            featureId,
          )
        : true,
    ]);
  const finalize = async (credits: number) =>
    (await finalizeParts(credits)).every(Boolean);

  try {
    const denied = await authorizeProviders(
      input.teamId,
      input.calls,
      input.flags,
      input.orgId,
      input.clientIp,
      input.billingCountry,
    );
    if (denied) return refuse(denied);

    for (const [index, provider] of INDEX_PROVIDERS) {
      const indexBudget = await reserveIndexCalls(
        index,
        input.teamId,
        input.rateLimitMultiplier,
        input.calls.filter(call => call.provider === provider).length,
      );
      if (!indexBudget.ok) {
        const { error, ...limitFields } = indexDailyLimitRefusal(
          index,
          input.teamId,
          indexBudget,
        );
        return refuse(
          refusal(429, error, {
            code: "index_daily_limit",
            retryAfterSeconds: indexBudget.retryAfterSeconds,
            ...limitFields,
          }),
        );
      }
      indexReleases.push(indexBudget.release);
    }

    const quote = await exchangeRequest({
      teamId: input.teamId,
      path: "/v1/retrieve/quote",
      body: { requests: input.calls },
      timeoutMs: Math.min(10000, remaining()),
      clientIp: input.clientIp,
      billingCountry: input.billingCountry,
      connectors: input.flags?.exchangeRetrieve === true,
      ...(zeroDataRetention ? { zeroDataRetention } : {}),
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
      // No org, no Autumn customer to hold against — the skipped hold the
      // service already answered when it could not name one.
      let hold: LockCreditsResult = { status: "skipped" };
      if (input.orgId !== null) {
        refundable = !(await autumnService.isRoutedThroughFirebill(
          input.teamId,
          input.orgId,
        ));
        if (input.hostedMcp) {
          const mcpCredits = await autumnService.mcpCreditsAvailable({
            teamId: input.teamId,
            orgId: input.orgId,
            value: maximumCredits,
            properties,
          });
          const mcpHold =
            mcpCredits > 0
              ? await autumnService.lockCredits({
                  teamId: input.teamId,
                  orgId: input.orgId,
                  value: mcpCredits,
                  lockId: `alexandria_${id}_mcp`,
                  expiresAt: record.deadline + HOLD_GRACE_MS,
                  featureId: MCP_CREDITS_FEATURE_ID,
                  properties,
                })
              : undefined;
          if (mcpHold?.status === "locked") {
            mcpLockId = mcpHold.lockId;
            mcpHeldCredits = mcpCredits;
          }
        }
        // Held in full on the MCP credits, nothing is left to hold here.
        hold =
          mcpHeldCredits < maximumCredits
            ? await autumnService.lockCredits({
                teamId: input.teamId,
                orgId: input.orgId,
                value: maximumCredits - mcpHeldCredits,
                lockId: `alexandria_${id}`,
                expiresAt: record.deadline + HOLD_GRACE_MS,
                featureId,
                properties,
              })
            : { status: "locked", lockId: "" };
      }
      if (hold.status !== "locked" && mcpLockId) await finalize(0);
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
      lockId = hold.lockId || undefined;
    }

    // The record is written before the provider runs, so a failed write means
    // nothing ran: the catch below hands back the index calls and the hold.
    record.lockId = lockId;
    record.maximumCredits = maximumCredits;
    if (mcpLockId) {
      record.mcpLockId = mcpLockId;
      record.mcpHeldCredits = mcpHeldCredits;
    }
    await write(record);
  } catch (error) {
    if (lockId || mcpLockId) await finalize(0).catch(() => false);
    await releaseIndexCalls();
    await redisRateLimitClient.del(key).catch(() => {});
    throw error;
  }
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

  try {
    const response = await exchangeRequest({
      teamId: input.teamId,
      path: "/v1/retrieve",
      body: { requests: input.calls },
      timeoutMs: remaining(),
      requestId: id,
      clientIp: input.clientIp,
      billingCountry: input.billingCountry,
      // The team's own MCP connectors (mcp-...) resolve only when Exchange is told it may use them.
      connectors: input.flags?.exchangeRetrieve === true,
      // Sent with every execution so Exchange tools that call Firecrawl as the caller
      // (the caller pays) can authenticate upstream. Exchange decides which tools read it.
      ...(input.resultAuthorization
        ? { resultAuthorization: input.resultAuthorization }
        : {}),
      ...(termsIdentity ? { termsIdentity } : {}),
      ...(zeroDataRetention ? { zeroDataRetention } : {}),
      maximumCredits,
    }).catch(error => {
      throw new Error(`Alexandria did not answer: ${error?.message ?? error}`);
    });

    const body = (response.body ?? {}) as Record<string, unknown>;
    if (
      (response.status >= 400 && response.status < 500) ||
      (response.status === 504 && body.code === "deadline_exceeded")
    ) {
      await finalize(0);
      return refuse(relay(response), true);
    }
    if (response.status < 200 || response.status >= 300)
      return fail(`Alexandria answered ${response.status}`);

    const parsed = answerSchema.safeParse(response.body);
    if (!parsed.success) return fail("Alexandria answer was malformed");
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
      return fail("Alexandria receipt did not match the request");

    const [mcpSettled, restSettled] = await finalizeParts(answer.creditsCost);
    const settled = mcpSettled && restSettled;
    // A split settle that landed in part records the part that landed; the
    // rest goes unbilled, as a whole settle that does not land does.
    const mcpCredits = mcpSettled ? mcpPart(answer.creditsCost) : 0;
    const credits =
      mcpCredits +
      (restSettled ? answer.creditsCost - mcpPart(answer.creditsCost) : 0);
    const recorded =
      billable && credits > 0
        ? await recordLedgerUsage(
            id,
            input.teamId,
            input.orgId,
            input.apiKeyId,
            credits,
            refundable,
            mcpCredits,
          )
        : settled;
    const charged = billable && credits > 0 && (recorded || !refundable);
    if (charged && input.agentRequestId) {
      await recordAgentCredits(input.agentRequestId, id, credits);
      await tallyAgentMcpCredits(
        { endpoint: "agent", agentRequestId: input.agentRequestId },
        `alexandria:${id}`,
        mcpCredits,
      );
    }
    if (!billable || (settled && recorded))
      void reportExchangeUsageBilling({
        requestId: id,
        status: billable ? "confirmed" : "void",
        billingReference: `alexandria:${id}`,
      });

    const done: ExchangeResponse = { status: 200, body: answer };
    await write(
      zeroDataRetention
        ? { ...record, phase: "done", responseWithheld: true }
        : { ...record, phase: "done", response: done },
    );
    return { ...done, executed: true, scrapeId: input.scrapeId };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

async function recordAgentCredits(
  agentRequestId: string,
  chargeId: string,
  credits: number,
) {
  const record = () =>
    recordRequestCredits({
      requestId: agentRequestId,
      jobId: `alexandria:${chargeId}`,
      credits,
    });
  try {
    if (await record()) return;
    if (
      !(await initializeRequestCredits(
        agentRequestId,
        AGENT_REQUEST_CREDITS_SHARDS,
      ))
    )
      throw new Error("Request credits store is unavailable");
    await record();
  } catch (error) {
    logger.error("Provider credits were not recorded on the agent run", {
      chargeId,
      agentRequestId,
      credits,
      error,
    });
  }
}

async function recordLedgerUsage(
  id: string,
  teamId: string,
  orgId: string | null,
  apiKeyId: number | null,
  credits: number,
  refundable: boolean,
  mcpCredits: number,
): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      await getBillingQueue().add(
        "bill_team",
        {
          team_id: teamId,
          org_id: orgId,
          credits,
          billing: {
            endpoint: "scrape",
            chargeId: id,
            ...(mcpCredits > 0 ? { hostedMcp: true, mcpCredits } : {}),
          },
          is_extract: false,
          timestamp: new Date().toISOString(),
          originating_job_id: id,
          api_key_id: apiKeyId,
          autumnTrackInRequest: refundable,
        },
        { jobId: `alexandria-bill-${id}`, priority: 10 },
      );
      return true;
    } catch (error) {
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 250 * attempt));
        continue;
      }
      logger.error(
        refundable
          ? "Provider usage could not be queued for the ledger; refunding the Autumn charge and leaving the Exchange usage pending for reconciliation"
          : "Provider usage could not be queued for the ledger; the firebill charge stands and the Exchange usage stays pending for reconciliation",
        { chargeId: id, teamId, credits, error },
      );
      // refundable is only ever set with an org in hand; named again so the
      // type says so.
      if (refundable && orgId !== null) {
        const refund = {
          teamId,
          orgId,
          value: credits,
          featureId: featureIdForBillingEndpoint("scrape"),
          properties: {
            source: "alexandria",
            endpoint: "scrape",
            chargeId: id,
          },
          idempotencyKey: `fc:refund:scrape:${id}`,
        };
        // A split charge refunds each part to the balance it was settled on.
        await (mcpCredits > 0
          ? autumnService.refundHostedMcpCredits({ ...refund, mcpCredits })
          : autumnService.refundCredits(refund));
      }
      return false;
    }
  }
}
