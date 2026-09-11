import { finalizeExchangeHold } from "./finalize";
import { z } from "zod";
import { logger } from "../../lib/logger";
import { queueBillingOperation } from "../billing/batch_billing";
import { getRedisConnection } from "../queue-service";
import {
  RECONCILIATION_KEY,
  MANUAL_RECONCILIATION_KEY,
  REQUEST_RETENTION_SECONDS,
  markExchangeRequestForReview,
  RECOVERY_DELAY_MS,
  saveExchangeRequest,
  forgetExchangeRequest,
} from "./request-state";

const receiptSchema = z.object({
  teamId: z.string(),
  chargeId: z.string(),
  apiKeyId: z.number().nullable(),
  featureId: z.string(),
  properties: z.record(z.string(), z.unknown()),
  maximumCredits: z.number().nonnegative(),
  lockId: z.string().optional(),
  operationToken: z.string().optional(),
  holdIdentityPending: z.boolean().optional(),
  phase: z.enum(["reserve", "executing", "confirm", "enqueue"]),
  credits: z.number().nonnegative().optional(),
  response: z.unknown().optional(),
  holdConfirmed: z.boolean().optional(),
});

let running = false;
export async function reconcileExchangeRequests() {
  if (running) return;
  running = true;
  const redis = getRedisConnection();
  try {
    await redis.zremrangebyscore(
      MANUAL_RECONCILIATION_KEY,
      "-inf",
      Date.now() - REQUEST_RETENTION_SECONDS * 1000,
    );
    const keys = await redis.zrangebyscore(
      RECONCILIATION_KEY,
      "-inf",
      Date.now(),
      "LIMIT",
      0,
      50,
    );
    for (const key of keys) {
      const claimed = await redis.eval(
        `
        local due = redis.call('ZSCORE', KEYS[1], ARGV[1])
        if not due or tonumber(due) > tonumber(ARGV[2]) then return 0 end
        redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
        return 1
      `,
        1,
        RECONCILIATION_KEY,
        key,
        Date.now(),
        Date.now() + RECOVERY_DELAY_MS,
      );
      if (!claimed) continue;
      try {
        const raw = await redis.get(key);
        if (!raw) {
          await redis.zrem(RECONCILIATION_KEY, key);
          continue;
        }
        let record;
        try {
          record = JSON.parse(raw);
          if (!record || typeof record !== "object" || Array.isArray(record))
            throw new Error("Invalid request record");
        } catch {
          await markExchangeRequestForReview(key, { unparsed: raw });
          continue;
        }
        if (record.state !== "pending") {
          await redis.zrem(RECONCILIATION_KEY, key);
          continue;
        }
        // Before the first checkpoint no credit hold or provider call can have started.
        if (!record.reconciliation) {
          await forgetExchangeRequest(key);
          continue;
        }
        const parsed = receiptSchema.safeParse(record.reconciliation);
        if (!parsed.success) {
          await markExchangeRequestForReview(key, record);
          continue;
        }
        const receipt = parsed.data;
        if (receipt.phase === "executing" || receipt.holdIdentityPending) {
          logger.error(
            "Exchange execution or hold identity requires manual reconciliation",
            { key, teamId: receipt.teamId, chargeId: receipt.chargeId },
          );
          await markExchangeRequestForReview(key, record);
          continue;
        }
        if (receipt.phase === "reserve") {
          if (
            receipt.lockId &&
            !(await finalizeExchangeHold({
              lockId: receipt.lockId,
              teamId: receipt.teamId,
              featureId: receipt.featureId,
              heldValue: receipt.maximumCredits,
              action: "release",
              externalRequestId: receipt.operationToken,
              properties: receipt.properties,
            }))
          )
            continue;
          await forgetExchangeRequest(key);
          continue;
        }
        if (receipt.credits === undefined)
          throw new Error("Missing confirmed cost");
        if (receipt.lockId && !receipt.holdConfirmed) {
          if (
            !(await finalizeExchangeHold({
              lockId: receipt.lockId,
              teamId: receipt.teamId,
              featureId: receipt.featureId,
              heldValue: receipt.maximumCredits,
              action: "confirm",
              overrideValue: receipt.credits,
              externalRequestId: receipt.operationToken,
              properties: receipt.properties,
            }))
          )
            continue;
          receipt.holdConfirmed = true;
        }
        // Enqueue is idempotent, including an uncertain Redis acknowledgement.
        const queued = await queueBillingOperation(
          receipt.teamId,
          receipt.credits,
          receipt.apiKeyId,
          { endpoint: "scrape", chargeId: `exchange:${receipt.chargeId}` },
          false,
          Boolean(receipt.lockId),
          {
            usageRequestId: receipt.chargeId,
            billingReference: `exchange:${receipt.chargeId}`,
          },
        );
        if (!queued.success) {
          await saveExchangeRequest(
            key,
            { ...record, reconciliation: { ...receipt, phase: "enqueue" } },
            true,
          );
          continue;
        }
        await saveExchangeRequest(
          key,
          {
            payloadHash: record.payloadHash,
            state: "complete",
            ...(receipt.response
              ? {
                  response: {
                    ...(receipt.response as object),
                    requestId: record.requestId,
                  },
                }
              : {}),
          },
          false,
        );
      } catch (error) {
        logger.error("Exchange request recovery will retry", { key, error });
      }
    }
  } catch (error) {
    logger.error("Exchange recovery storage unavailable", { error });
  } finally {
    running = false;
  }
}
